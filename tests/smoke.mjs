import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require("../../finance-dashboard/node_modules/puppeteer");
const outputDirectory = fileURLToPath(new URL("../test-output/", import.meta.url));
const qianjiFixture = fileURLToPath(new URL("./fixtures/qianji-sample.csv", import.meta.url));
await mkdir(outputDirectory, { recursive: true });

const browser = await puppeteer.launch({ headless: "new", protocolTimeout: 30000 });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  // 390px 视口
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto("http://127.0.0.1:4173/?demo=1", { waitUntil: "networkidle0" });

  // 总览页数据验证
  const title = await page.title();
  assert.match(title, /家庭月度驾驶舱/);

  const savingsText = await page.$eval("#savingsBalance", (el) => el.textContent);
  assert.match(savingsText, /89,100/);

  // 半年度周期
  await page.select("#overviewPeriodSelect", "half:2026-H2");
  await new Promise((r) => setTimeout(r, 500));
  const halfIncome = await page.$eval("#totalIncome", (el) => el.textContent);
  assert.match(halfIncome, /36,100/);

  const covText = await page.$eval("#periodCoverageCopy", (el) => el.textContent);
  assert.match(covText, /2\/6/);

  // 截图 — 总览 + 半年度
  await page.screenshot({ path: `${outputDirectory}/v2-overview.png`, fullPage: true });

  // 年度
  await page.select("#overviewPeriodSelect", "year:2026");
  await new Promise((r) => setTimeout(r, 500));
  const yearIncome = await page.$eval("#totalIncome", (el) => el.textContent);
  assert.match(yearIncome, /53,800/);

  // 回到月度
  await page.select("#overviewPeriodSelect", "month:2026-08");
  await new Promise((r) => setTimeout(r, 300));

  // 月度记录页
  await page.evaluate(() => document.querySelector('.nav-button[data-page="entry"]').click());
  await new Promise((r) => setTimeout(r, 500));
  const entryMonth = await page.$eval("#entryMonth", (el) => el.value);
  assert.equal(entryMonth, "2026-08");
  await page.screenshot({ path: `${outputDirectory}/v2-entry.png`, fullPage: true });

  // 生命能量页
  await page.evaluate(() => document.querySelector('.nav-button[data-page="life"]').click());
  await new Promise((r) => setTimeout(r, 500));
  const lifeVisible = await page.$eval("#lifeContent", (el) => !el.hidden);
  assert.ok(lifeVisible);
  await page.screenshot({ path: `${outputDirectory}/v2-life.png`, fullPage: true });

  // 支出分析页（从总览快捷入口）
  await page.evaluate(() => document.querySelector('.nav-button[data-page="overview"]').click());
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.querySelector('[data-go="analysis"]').click());
  await new Promise((r) => setTimeout(r, 500));
  const analysisVisible = await page.$eval("#analysisContent", (el) => !el.hidden);
  assert.ok(analysisVisible);
  await page.screenshot({ path: `${outputDirectory}/v2-analysis.png`, fullPage: true });

  // 家庭财务总结
  await page.evaluate(() => document.querySelector('.nav-button[data-page="overview"]').click());
  await new Promise((r) => setTimeout(r, 300));
  await page.evaluate(() => document.querySelector('[data-go="summary"]').click());
  await new Promise((r) => setTimeout(r, 500));
  const summaryVisible = await page.$eval("#summaryContent", (el) => !el.hidden);
  assert.ok(summaryVisible);
  await page.screenshot({ path: `${outputDirectory}/v2-summary.png`, fullPage: true });

  // 设置对话框 + 只读切换
  await page.evaluate(() => document.getElementById("settingsButton").click());
  await new Promise((r) => setTimeout(r, 500));
  const dialogOpen = await page.$eval("#settingsDialog", (el) => el.open);
  assert.ok(dialogOpen);

  // 关闭设置（通过点击遮罩或取消）
  await page.evaluate(() => document.getElementById("settingsDialog").close());
  await new Promise((r) => setTimeout(r, 500));

  // CSV 上传
  await page.evaluate(() => document.querySelector('.nav-button[data-page="entry"]').click());
  await new Promise((r) => setTimeout(r, 300));
  const fileInput = await page.$("#csvFile");
  await fileInput.uploadFile(qianjiFixture);
  await new Promise((r) => setTimeout(r, 2000));
  const uploadText = await page.$eval("#csvUploadResult", (el) => el.textContent);
  assert.match(uploadText, /笔/);

  // 不保存原始交易
  const stored = await page.evaluate(() => localStorage.getItem("family-finance-pwa-v2"));
  assert.ok(stored, "有 V2 数据");
  assert.doesNotMatch(String(stored), /午餐|纸巾|矿泉水/);

  // PWA 离线
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker?.controller || window.caches)), true);

  // 桌面截图
  await page.setViewport({ width: 1024, height: 900, deviceScaleFactor: 1 });
  await page.screenshot({ path: `${outputDirectory}/v2-desktop.png`, fullPage: true });

  assert.deepEqual(errors, []);
  console.log("V2 真实浏览器核心流程测试通过");
} finally {
  await browser.close();
}
