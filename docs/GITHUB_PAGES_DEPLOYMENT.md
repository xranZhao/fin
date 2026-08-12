# GitHub Pages 部署说明

GitHub Pages 只发布 PWA 前端文件。家庭账本仍只保存在私有 OSS，密码哈希和会话密钥仍只在阿里云函数计算环境变量中。

## 一次性设置

1. 在 GitHub 创建一个**私有仓库**，名称建议 `family-finance-pwa`。
2. 将本项目推送到该仓库的 `main` 分支。
3. GitHub 仓库进入 **Settings → Pages**，在 **Build and deployment** 中选择 **GitHub Actions**。
4. 等待 Actions 中“发布家庭财务 PWA”完成。页面地址会是：
   `https://你的GitHub用户名.github.io/family-finance-pwa/`
5. 复制这个完整地址，到阿里云 FC 函数的环境变量新增：
   `ALLOWED_ORIGINS=https://你的GitHub用户名.github.io`
   注意：此处不带仓库名结尾的路径，不加斜杠。
6. 保存并部署 FC 代码，使跨域白名单生效。

## 日常使用

- 酥梨和陈前都打开 GitHub Pages 页面；选择各自身份并输入家庭密码。
- 登录令牌仅保存于浏览器当前会话，关闭浏览器后需重新登录。
- GitHub 不保存任何账单、密码或 OSS 凭证。

## 更新前端

以后只要将前端改动推送到 `main`，GitHub Actions 会自动更新网页。修改阿里云后端时，则按函数计算控制台重新上传 FC 部署包。
