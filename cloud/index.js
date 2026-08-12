// 函数计算的 Node.js 入口只能按“文件名.导出函数”解析。
// 保留实际实现为 index.mjs，避免影响本地 ES Module 的开发与测试。
export { handler } from "./index.mjs";
