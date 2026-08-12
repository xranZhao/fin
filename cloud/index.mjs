/**
 * 阿里云函数计算 FC 3.0 入口。
 * 以 Node.js 20 事件函数 + HTTP 触发器运行，静态 PWA 与 /api 同源。
 * 不依赖第三方 SDK：FC 绑定 RAM 角色后自动注入临时凭证。
 */
import { createHmac, pbkdf2Sync, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const maxBodyBytes = 256 * 1024;
const loginAttempts = new Map();
const mimeTypes = {
  ".css": "text/css; charset=utf-8", ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8",
};

function header(headers, name) {
  const wanted = name.toLowerCase();
  return Object.entries(headers || {}).find(([key]) => key.toLowerCase() === wanted)?.[1] || "";
}

function json(statusCode, payload, extra = {}) {
  return {
    statusCode,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
      ...extra,
    },
    body: JSON.stringify(payload),
  };
}

function securityHeaders() {
  return {
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  };
}

function base64url(value) {
  return Buffer.from(value).toString("base64url");
}

function unbase64url(value) {
  return Buffer.from(value, "base64url").toString("utf8");
}

function sessionSecret() {
  const secret = process.env.SESSION_SECRET || "";
  if (Buffer.byteLength(secret) < 32) throw new Error("SESSION_SECRET 未配置或长度不足 32 字节");
  return secret;
}

function signSession(payload) {
  const body = base64url(JSON.stringify(payload));
  const signature = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function readSession(request) {
  const cookie = header(request.headers, "cookie");
  const token = cookie.split(";").map((item) => item.trim()).find((item) => item.startsWith("ff_session="))?.slice(11);
  if (!token || !token.includes(".")) return null;
  const [body, signature] = token.split(".");
  const expected = createHmac("sha256", sessionSecret()).update(body).digest("base64url");
  if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(unbase64url(body));
    return payload.exp > Math.floor(Date.now() / 1000) && ["manager", "viewer"].includes(payload.role) ? payload : null;
  } catch {
    return null;
  }
}

function hashMatches(password, stored) {
  // 格式：pbkdf2-sha256$210000$base64盐$base64哈希
  const [algorithm, iterationsText, salt, expected] = String(stored || "").split("$");
  const iterations = Number(iterationsText);
  if (algorithm !== "pbkdf2-sha256" || !Number.isInteger(iterations) || iterations < 100000 || !salt || !expected) return false;
  const actual = pbkdf2Sync(String(password), Buffer.from(salt, "base64"), iterations, 32, "sha256").toString("base64");
  const expectedBuffer = Buffer.from(expected);
  const actualBuffer = Buffer.from(actual);
  return expectedBuffer.length === actualBuffer.length && timingSafeEqual(expectedBuffer, actualBuffer);
}

function requestBody(event) {
  const raw = event.body || "";
  const text = event.isBase64Encoded ? Buffer.from(raw, "base64").toString("utf8") : raw;
  if (Buffer.byteLength(text) > maxBodyBytes) throw new Error("请求内容过大");
  return text;
}

function requestInfo(event) {
  const parsed = typeof event === "string" ? JSON.parse(event) : event;
  return {
    event: parsed,
    method: String(parsed.requestContext?.http?.method || "GET").toUpperCase(),
    path: parsed.requestContext?.http?.path || parsed.rawPath || "/",
    headers: parsed.headers || {},
    sourceIp: parsed.requestContext?.http?.sourceIp || "unknown",
    host: header(parsed.headers, "host"),
  };
}

function requireSession(request, requiredRole = "viewer") {
  const session = readSession(request);
  if (!session) return { error: json(401, { error: "请先登录" }) };
  if (requiredRole === "manager" && session.role !== "manager") return { error: json(403, { error: "此操作需要管理权限" }) };
  return { session };
}

function credentialConfig() {
  const accessKeyId = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || "";
  const accessKeySecret = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || "";
  const securityToken = process.env.ALIBABA_CLOUD_SECURITY_TOKEN || "";
  const region = process.env.OSS_REGION || process.env.FC_REGION || "";
  const bucket = process.env.OSS_BUCKET || "";
  if (!accessKeyId || !accessKeySecret || !securityToken || !region || !bucket) {
    throw new Error("OSS 运行环境未配置：请绑定 FC RAM 角色并设置 OSS_REGION、OSS_BUCKET");
  }
  return { accessKeyId, accessKeySecret, securityToken, region, bucket, key: process.env.OSS_STATE_KEY || "household/monthly-data.json" };
}

function ossHeaders(method, config, contentType = "") {
  const date = new Date().toUTCString();
  const oss = { "x-oss-security-token": config.securityToken };
  const canonicalHeaders = Object.entries(oss).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => `${key}:${value}\n`).join("");
  const canonicalResource = `/${config.bucket}/${config.key}`;
  const stringToSign = `${method}\n\n${contentType}\n${date}\n${canonicalHeaders}${canonicalResource}`;
  const signature = createHmac("sha1", config.accessKeySecret).update(stringToSign).digest("base64");
  return {
    Date: date,
    "x-oss-security-token": config.securityToken,
    Authorization: `OSS ${config.accessKeyId}:${signature}`,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

function ossUrl(config) {
  return `https://${config.bucket}.${config.region}.aliyuncs.com/${config.key.split("/").map(encodeURIComponent).join("/")}`;
}

async function ossRequest(method, options = {}) {
  const config = credentialConfig();
  const contentType = options.contentType || "";
  const response = await fetch(ossUrl(config), {
    method,
    headers: ossHeaders(method, config, contentType),
    body: options.body,
  });
  return response;
}

async function readCloudState() {
  const response = await ossRequest("GET");
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`OSS 读取失败：${response.status}`);
  const text = await response.text();
  if (Buffer.byteLength(text) > maxBodyBytes) throw new Error("云端数据异常过大");
  return { data: JSON.parse(text), etag: response.headers.get("etag") || "" };
}

function containsSensitive(value, depth = 0) {
  if (depth > 12) return true;
  if (Array.isArray(value)) return value.some((item) => containsSensitive(item, depth + 1));
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(([key, item]) => /password|accesskey|secret|token|cardnumber|transaction/i.test(key) || containsSensitive(item, depth + 1));
}

function validateState(state) {
  if (!state || typeof state !== "object" || ![1, 2].includes(Number(state.schemaVersion))) throw new Error("数据版本不支持");
  if (!Array.isArray(state.snapshots) || state.snapshots.length > 240) throw new Error("月度记录格式不正确");
  const seen = new Set();
  for (const snapshot of state.snapshots) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(snapshot?.month || "") || seen.has(snapshot.month)) throw new Error("月份必须唯一且格式正确");
    seen.add(snapshot.month);
  }
  if (containsSensitive(state)) throw new Error("数据包含不允许保存的敏感字段");
}

function allowedOrigin(request) {
  const origin = header(request.headers, "origin");
  if (!origin) return true;
  const protocol = header(request.headers, "x-forwarded-proto") || "https";
  return origin === `${protocol}://${request.host}`;
}

async function handleApi(request) {
  if (request.path === "/api/health" && request.method === "GET") return json(200, { ok: true });

  if (request.path === "/api/session" && request.method === "POST") {
    const key = `${request.sourceIp}:${header(request.headers, "user-agent").slice(0, 48)}`;
    const recent = loginAttempts.get(key) || [];
    const now = Date.now();
    const attempts = recent.filter((time) => now - time < 10 * 60 * 1000);
    if (attempts.length >= 8) return json(429, { error: "请稍后再试" });
    let payload;
    try { payload = JSON.parse(requestBody(request.event)); } catch { return json(400, { error: "登录请求格式不正确" }); }
    const role = payload?.role;
    const password = payload?.password;
    const hash = role === "manager" ? process.env.MANAGER_PASSWORD_HASH : role === "viewer" ? process.env.VIEWER_PASSWORD_HASH : "";
    if (!hash || typeof password !== "string" || !hashMatches(password, hash)) {
      attempts.push(now); loginAttempts.set(key, attempts);
      return json(401, { error: "账号或密码不正确" });
    }
    loginAttempts.delete(key);
    const ttl = Math.min(Math.max(Number(process.env.SESSION_TTL_SECONDS) || 86400, 900), 604800);
    const exp = Math.floor(Date.now() / 1000) + ttl;
    const secure = "Secure; HttpOnly; SameSite=Strict; Path=/";
    return json(200, { role, expiresAt: new Date(exp * 1000).toISOString() }, { "Set-Cookie": `ff_session=${signSession({ role, exp })}; Max-Age=${ttl}; ${secure}` });
  }

  if (request.path === "/api/session" && request.method === "DELETE") {
    return json(204, {}, { "Set-Cookie": "ff_session=; Max-Age=0; Secure; HttpOnly; SameSite=Strict; Path=/" });
  }

  const auth = requireSession(request, request.path === "/api/state" && request.method === "PUT" ? "manager" : "viewer");
  if (auth.error) return auth.error;

  if (request.path === "/api/session" && request.method === "GET") {
    return json(200, { role: auth.session.role, expiresAt: new Date(auth.session.exp * 1000).toISOString() });
  }

  if (request.path === "/api/state" && request.method === "GET") {
    const cloud = await readCloudState();
    if (!cloud) return json(404, { code: "STATE_NOT_FOUND" });
    return json(200, cloud.data, { ETag: cloud.etag });
  }

  if (request.path === "/api/state" && request.method === "PUT") {
    if (!allowedOrigin(request)) return json(403, { error: "来源校验失败" });
    let state;
    try { state = JSON.parse(requestBody(request.event)); validateState(state); } catch (error) { return json(400, { error: error.message || "数据校验失败" }); }
    const clientEtag = header(request.headers, "if-match");
    const current = await readCloudState();
    if (current && (!clientEtag || clientEtag !== current.etag)) return json(409, { error: "云端数据已被另一台设备修改，请重新加载" });
    if (!current && clientEtag) return json(409, { error: "云端数据状态已变化，请重新加载" });
    const body = JSON.stringify(state);
    const response = await ossRequest("PUT", { body, contentType: "application/json; charset=utf-8" });
    if (!response.ok) throw new Error(`OSS 保存失败：${response.status}`);
    return json(200, state, { ETag: response.headers.get("etag") || "" });
  }

  return json(404, { error: "接口不存在" });
}

async function serveStatic(request) {
  if (request.method !== "GET" && request.method !== "HEAD") return json(405, { error: "请求方法不允许" });
  const requested = decodeURIComponent(request.path === "/" ? "index.html" : request.path.replace(/^\/+/, ""));
  const filePath = resolve(projectRoot, normalize(requested));
  if (!filePath.startsWith(projectRoot)) return json(404, { error: "资源不存在" });
  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not file");
    const content = request.method === "HEAD" ? "" : await readFile(filePath);
    return {
      statusCode: 200,
      headers: { "Content-Type": mimeTypes[extname(filePath)] || "application/octet-stream", "Cache-Control": requested === "index.html" ? "no-cache" : "public, max-age=300", ...securityHeaders() },
      body: content.toString("base64"),
      isBase64Encoded: true,
    };
  } catch {
    return json(404, { error: "资源不存在" });
  }
}

export const handler = async (event, context) => {
  try {
    const request = requestInfo(event);
    return request.path.startsWith("/api/") ? await handleApi(request) : await serveStatic(request);
  } catch (error) {
    // 不输出密码、Cookie、请求正文或财务数据。
    console.error(JSON.stringify({ requestId: context?.requestId || "", message: error.message || "未知错误" }));
    return json(500, { error: "服务暂时不可用，请稍后重试" });
  }
};
