# 云端 API 契约

此契约用于阶段 B 的阿里云函数计算后端。本地 V1 不会调用这些接口。

## 1. 同源与会话

- PWA 与 API 必须位于同一 HTTPS 域名。
- 登录成功后由服务端设置 `HttpOnly; Secure; SameSite=Strict` 会话 Cookie。
- 密码只出现在登录请求正文中，不放在 URL、本地存储、日志或 Git。
- 管理会话可读写；只读会话只能读取。
- 所有非登录接口未认证时返回 `401`，权限不足时返回 `403`。

## 2. 接口

### `POST /api/session`

请求：

```json
{
  "role": "manager",
  "password": "用户当次输入的密码"
}
```

`role` 允许 `manager` 或 `viewer`。登录成功返回：

```json
{
  "role": "manager",
  "expiresAt": "2026-08-12T10:00:00.000Z"
}
```

密码错误统一返回 `401`，不得说明哪一个角色或字段匹配失败。服务端对 IP 和角色组合限速。

### `GET /api/session`

返回当前角色和过期时间，前端据此进入管理视图或只读视图。

### `DELETE /api/session`

清除当前会话 Cookie。

### `GET /api/state`

管理和只读角色均可调用。返回 `FIELD_DEFINITIONS.md` 定义的 `HouseholdFinanceState`，并附带响应头：

```text
ETag: "对象版本号或内容摘要"
Cache-Control: no-store
```

### `PUT /api/state`

仅管理角色可调用。请求正文为完整 `HouseholdFinanceState`，并携带上一次读取到的：

```text
If-Match: "ETag 值"
```

保存成功返回规范化后的完整状态与新 `ETag`。版本冲突返回 `409`，前端必须提示重新加载，不静默覆盖。

服务端校验：

- 请求正文不超过 256 KB。
- `schemaVersion=1`。
- 月份唯一且格式正确。
- 金额非负，字符串和数组长度受限。
- JSON 中不得出现密码、AccessKey、银行卡号或原始交易行字段。

### `GET /api/health`

不返回业务数据，只用于部署健康检查：

```json
{ "ok": true }
```

## 3. OSS 对象

```text
household/monthly-data.json
```

- Bucket 必须为私有。
- 开启版本控制和服务端加密。
- 函数 RAM 角色只允许读取、写入和查看这个对象的版本。
- 写入采用条件更新，避免两个设备互相覆盖。

## 4. 函数环境变量

| 环境变量 | 含义 |
|---|---|
| `OSS_REGION` | OSS 地域 |
| `OSS_BUCKET` | 私有 Bucket 名称 |
| `OSS_STATE_KEY` | 默认 `household/monthly-data.json` |
| `MANAGER_PASSWORD_HASH` | 管理密码强哈希 |
| `VIEWER_PASSWORD_HASH` | 只读密码强哈希 |
| `SESSION_SECRET` | 至少 32 字节的随机会话签名密钥 |
| `SESSION_TTL_SECONDS` | 建议 86400 |

这些变量只在阿里云控制台或受保护的部署密钥中配置，不写入前端文件。

## 5. 安全响应头

至少设置：

```text
Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'
X-Content-Type-Options: nosniff
Referrer-Policy: no-referrer
Permissions-Policy: camera=(), microphone=(), geolocation=()
Cache-Control: no-store
```

写请求还需要检查 `Origin` 与当前站点完全一致。日志仅记录时间、状态码和随机请求 ID，不记录密码、Cookie 或财务正文。
