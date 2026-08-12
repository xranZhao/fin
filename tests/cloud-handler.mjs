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

const missing = await handler(JSON.stringify({
  rawPath: "/api/state",
  headers: {},
  requestContext: { http: { method: "GET", path: "/api/state", sourceIp: "127.0.0.1" } },
}), { requestId: "test-request" });

assert.equal(missing.statusCode, 401, "未登录访问云端状态必须先被拒绝");
assert.deepEqual(JSON.parse(missing.body), { error: "请先登录" });

console.log("FC 云端处理器基础测试通过");
