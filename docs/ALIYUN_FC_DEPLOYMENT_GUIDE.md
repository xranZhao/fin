# 阿里云函数计算部署操作指南

> 目标：酥梨使用管理密码录入，陈前使用只读密码查看；两部手机访问同一份家庭数据。  
> 前提：本项目已完成本地验证。无需购买域名，也无需创建 AccessKey。

## 0. 先知道什么会被部署

部署包包含 PWA 前端和 FC 后端。后端接口为：

```text
POST   /api/session    管理／只读登录
GET    /api/session    读取当前会话
DELETE /api/session    退出
GET    /api/state      读取家庭汇总数据
PUT    /api/state      管理者保存家庭汇总数据
GET    /api/health     健康检查
```

OSS 中只保存一个对象：

```text
household/monthly-data.json
```

原始钱迹 CSV 只在手机浏览器中读取和汇总，绝不上传到 OSS。

## 1. 创建私有 OSS Bucket

在阿里云控制台进入 **对象存储 OSS** → **Bucket 列表** → **创建 Bucket**。

按以下值创建：

| 项目 | 选择 |
|---|---|
| 地域 | 华东 1（杭州） |
| Bucket 名称 | `suli-family-finance-` 加一段随机小写字母数字，例如 `suli-family-finance-a7k9` |
| 存储类型 | 标准存储 |
| 读写权限 | 私有 |
| 阻止公共访问 | 开启 |
| 版本控制 | 开启 |
| 服务端加密 | OSS 托管加密（AES256） |

创建后记录 Bucket 名称；不要上传任何文件，也不要开启静态网站托管或公共读。

## 2. 创建给函数使用的 RAM 角色

进入 **访问控制 RAM** → **身份管理** → **角色** → **创建角色**。

1. 可信实体类型选择 **阿里云服务**。
2. 受信服务选择 **函数计算 FC**。
3. 角色名称填写：`FamilyFinanceFcRole`。
4. 创建后，给该角色添加一条**内联策略**，将下面 JSON 中的 `YOUR_BUCKET_NAME` 替换成第 1 步 Bucket 名称：

```json
{
  "Version": "1",
  "Statement": [
    {
      "Effect": "Allow",
      "Action": [
        "oss:GetObject",
        "oss:PutObject",
        "oss:GetObjectVersion",
        "oss:ListObjectVersions"
      ],
      "Resource": [
        "acs:oss:*:*:YOUR_BUCKET_NAME/household/monthly-data.json"
      ]
    }
  ]
}
```

不要给 `AliyunOSSFullAccess`，不要创建 RAM 用户 AccessKey。

## 3. 生成两个密码哈希与会话密钥

在你的电脑 PowerShell 中执行：

```powershell
cd "D:\CLAUDE\finance-systerm\PWA系统"
node scripts/generate-cloud-secrets.mjs
```

运行两次：

1. 第一次输入你自己的**管理密码**，复制输出的 `pbkdf2-sha256$...`。
2. 第二次输入给陈前的**只读密码**，复制输出的 `pbkdf2-sha256$...`。
3. 两次都会产生 `SESSION_SECRET=...`；任选一条保存，稍后填写到函数环境变量。

密码建议至少 16 个字符，管理密码和只读密码不能相同。不要把明文密码、哈希或 `SESSION_SECRET` 发到聊天、Git、截图或仓库。

## 4. 打包部署代码

在项目目录执行：

```powershell
cd "D:\CLAUDE\finance-systerm\PWA系统"
Compress-Archive -Path app.js,cloud,csv-parser.js,icon.svg,index.html,manifest.webmanifest,period-summary.js,storage.js,styles.css,sw.js,package.json -DestinationPath family-finance-fc.zip -Force
```

压缩包应位于：

```text
D:\CLAUDE\finance-systerm\PWA系统\family-finance-fc.zip
```

这个压缩包不包含任何家庭账单、密码或 AccessKey。

## 5. 创建函数计算 FC 3.0 函数

进入 **函数计算 FC** → 选择地域 **华东 1（杭州）** → **函数管理** → **函数列表** → **创建函数**。

建议按以下配置：

| 项目 | 选择 |
|---|---|
| 函数类型 | 事件函数（HTTP 触发器调用） |
| 函数名称 | `family-finance-pwa` |
| 运行环境 | Node.js 20 |
| 请求处理程序 | `cloud/index.handler` |
| 内存 | 256 MB |
| 超时时间 | 30 秒 |
| 实例并发度 | 1 |
| 函数角色 | 选择 `FamilyFinanceFcRole` |
| 代码上传方式 | 上传 ZIP 包，选择第 4 步 `family-finance-fc.zip` |

函数创建后，在 **环境变量** 中增加：

| 变量名 | 值 |
|---|---|
| `OSS_REGION` | `oss-cn-hangzhou` |
| `OSS_BUCKET` | 第 1 步的 Bucket 名称 |
| `OSS_STATE_KEY` | `household/monthly-data.json` |
| `MANAGER_PASSWORD_HASH` | 第 3 步管理密码的 `pbkdf2-sha256$...` 输出 |
| `VIEWER_PASSWORD_HASH` | 第 3 步只读密码的 `pbkdf2-sha256$...` 输出 |
| `SESSION_SECRET` | 第 3 步任选一条 `SESSION_SECRET=` 后的值 |
| `SESSION_TTL_SECONDS` | `86400` |

不要手动添加 `ALIBABA_CLOUD_ACCESS_KEY_ID`、`ALIBABA_CLOUD_ACCESS_KEY_SECRET` 或 `ALIBABA_CLOUD_SECURITY_TOKEN`。FC 会在绑定 RAM 角色后自动提供临时凭证。

## 6. 创建 HTTP 触发器

在函数详情页进入 **触发器** → **创建触发器**。

| 项目 | 选择 |
|---|---|
| 触发器类型 | HTTP 触发器 |
| 名称 | `family-finance-http` |
| 认证方式 | 无认证 |
| 请求方法 | GET、POST、PUT、DELETE、HEAD |
| 公网访问 | 开启 |

“无认证”是正确的：家庭密码由项目自己的 `/api/session` 校验；若选择 FC 平台认证，手机网页无法正常完成自己的登录流程。

创建后复制 HTTP 触发器的**公网访问地址**。它通常是 `https://...fcapp.run` 形式。

## 7. 首次初始化和手机验证

1. 用手机浏览器打开第 6 步公网 HTTPS 地址。
2. 页面应出现“进入家庭账本”。
3. 选择“酥梨 · 管理”，输入管理密码。
4. 因云端为空，系统会提示初始化。选择“是”先创建云端账本。
5. **迁移原有本地账本**：在旧本地网址 `http://127.0.0.1:4173/` 打开设置，点击“导出 JSON 备份”；再回到云端网址的设置，点击“从备份恢复”，选中刚下载的 JSON。导入后会自动同步到 OSS。
6. 用陈前手机打开同一地址，选择“陈前 · 只读查看”，输入只读密码。
6. 陈前应能查看总览、趋势和生命能量，但没有上传、保存、删除和设置编辑能力。

保存后，另一台手机刷新页面即可看到最新数据。若两台同时编辑，后保存的一方会收到“重新加载后再保存”提示，避免静默覆盖。

## 8. 常见问题

### 打开地址下载文件而不是显示网页

临时 HTTP 触发器地址在部分场景可能触发下载行为。先确认触发器响应与函数配置无误；若仍如此，后续绑定自定义域名即可作为稳定 Web 地址。自定义域名需要域名及中国内地备案。

### 登录后显示“OSS 运行环境未配置”

检查函数是否绑定 `FamilyFinanceFcRole`，并核对 `OSS_REGION` 与 `OSS_BUCKET`。不要尝试用主账号 AccessKey 修复。

### 登录成功但云端读取失败

检查 RAM 内联策略中的 Bucket 名称和对象路径是否完全一致：`household/monthly-data.json`。

### 管理者首次上传提示冲突

先刷新页面，确认没有另一台设备已初始化云端；再决定以哪台手机的本地账本作为第一份云端数据。

## 9. 域名以后再做

临时 FC HTTPS 地址足够让两部手机同步和安装测试。若持续使用，再购买、备案域名，并在 FC 的**函数管理 → 域名管理**绑定自定义域名与 HTTPS 证书。
