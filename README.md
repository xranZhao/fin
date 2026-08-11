# 家庭月度驾驶舱

一个面向手机的家庭财务 PWA。它不替代钱迹，只在每月一次的复盘中记录家庭大数、汇总钱迹 CSV、换算生命时间，并给出可执行提醒。

## 当前状态

- 可直接本地运行的 PWA V1
- 数据默认保存在当前浏览器 `localStorage`
- 支持钱迹月度 CSV 导入，只保存汇总结果，不保存原始文件
- 已使用现有真实钱迹导出的编码和表头完成兼容性验证
- 支持管理视图与只读预览
- 支持按月查看，并由月度记录自动生成半年总结和年终总结
- “生命能量”页面集中展示实际时薪、每赚 10 元所需时间和长期趋势
- 已预留阿里云函数计算 API 适配器，部署前不需要提供阿里云账号

## 本地运行

PWA 不能直接通过 `file://` 完整测试，请在本目录启动本地服务器：

```powershell
npm start
```

然后访问：

```text
http://127.0.0.1:4173/?demo=1
```

去掉 `?demo=1` 可进入真实空数据状态。

运行自动检查：

```powershell
npm run check
npm run test:unit
npm run test:smoke
```

浏览器流程测试复用同级旧项目中已经存在的 Puppeteer，不会安装新依赖。

## 目录说明

- `index.html`：应用页面
- `styles.css`：移动端样式与明暗主题
- `app.js`：页面状态、计算规则、表单与趋势图
- `csv-parser.js`：钱迹 CSV 解析与月度汇总
- `storage.js`：本地/云端数据接口
- `manifest.webmanifest`、`sw.js`：PWA 安装与离线缓存
- `PROJECT_SPEC.md`：项目目标、范围与验收标准
- `FUNCTIONAL_SPEC.md`：功能规格
- `FIELD_DEFINITIONS.md`：字段与计算口径
- `CONTEXT.md`：领域词汇
- `docs/ALIYUN_DEPLOYMENT.md`：阿里云部署准备清单
- `docs/API_CONTRACT.md`：管理/只读密码、会话和云端状态接口契约

## 隐私边界

本地版只是功能原型，浏览器里的“只读预览”不构成真正的访问控制。正式共享给陈前前，需要部署函数计算后端，由服务端分别校验管理凭证和只读凭证。
