import assert from "node:assert/strict";
import { handler } from "../index.js";

const response = await handler(JSON.stringify({
  rawPath: "/api/health",
  headers: {},
  requestContext: { http: { method: "GET", path: "/api/health", sourceIp: "127.0.0.1" } },
}), { requestId: "test-request" });

assert.equal(response.statusCode, 200);
assert.deepEqual(JSON.parse(response.body), { ok: true });

const bufferResponse = await handler(Buffer.from(JSON.stringify({
  rawPath: "/api/health",
  headers: {},
  requestContext: { http: { method: "GET", path: "/api/health", sourceIp: "127.0.0.1" } },
})), { requestId: "buffer-test-request" });

assert.equal(bufferResponse.statusCode, 200);
assert.deepEqual(JSON.parse(bufferResponse.body), { ok: true });
assert.equal(bufferResponse.headers["Content-Disposition"], "inline");

const optionsResponse = await handler(JSON.stringify({
  rawPath: "/api/session",
  headers: { origin: "https://xran-zhao.github.io" },
  requestContext: { http: { method: "OPTIONS", path: "/api/session", sourceIp: "127.0.0.1" } },
}), { requestId: "cors-test-request" });

assert.equal(optionsResponse.statusCode, 204);
assert.equal(optionsResponse.headers["Access-Control-Allow-Origin"], undefined, "未配置来源时不应放行跨域");

const pageResponse = await handler(Buffer.from(JSON.stringify({
  rawPath: "/",
  headers: {},
  requestContext: { http: { method: "GET", path: "/", sourceIp: "127.0.0.1" } },
})), { requestId: "page-test-request" });

assert.equal(pageResponse.statusCode, 200);
assert.equal(pageResponse.headers["Content-Disposition"], "inline");
assert.match(pageResponse.body, /家庭月度驾驶舱/);
assert.equal(pageResponse.isBase64Encoded, undefined);

const missing = await handler(JSON.stringify({
  rawPath: "/api/state",
  headers: {},
  requestContext: { http: { method: "GET", path: "/api/state", sourceIp: "127.0.0.1" } },
}), { requestId: "test-request" });

assert.equal(missing.statusCode, 401, "未登录访问云端状态必须先被拒绝");
assert.deepEqual(JSON.parse(missing.body), { error: "请先登录" });

console.log("FC 云端处理器基础测试通过");
