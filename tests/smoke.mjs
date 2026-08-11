import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const puppeteer = require("../../finance-dashboard/node_modules/puppeteer");
const outputDirectory = fileURLToPath(new URL("../test-output/", import.meta.url));
const qianjiFixture = fileURLToPath(new URL("./fixtures/qianji-sample.csv", import.meta.url));
await mkdir(outputDirectory, { recursive: true });

const browser = await puppeteer.launch({ headless: "new" });
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.on("console", (message) => {
  if (message.type() === "error") errors.push(message.text());
});

try {
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  const response = await page.goto("http://127.0.0.1:4173/?demo=1", { waitUntil: "networkidle0" });
  assert.equal(response.status(), 200);
  assert.match(await page.title(), /家庭月度驾驶舱/);
  assert.equal(await page.$eval("#overviewContent", (element) => element.hidden), false);
  assert.match(await page.$eval("#savingsBalance", (element) => element.textContent), /89,100/);
  await page.screenshot({ path: `${outputDirectory}/mobile-overview.png`, fullPage: true });

  await page.click('[data-page-target="entry"]');
  await page.waitForSelector("#entryPage.active");
  assert.equal(await page.$eval("#monthInput", (element) => element.value), "2026-08");
  await page.screenshot({ path: `${outputDirectory}/mobile-entry.png`, fullPage: true });

  await page.click('[data-page-target="trends"]');
  await page.waitForSelector("#trendsPage.active");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.match(await page.$eval("#lifeSummary", (element) => element.textContent), /生命能量/);
  assert.ok(await page.$eval("#cashflowChart", (canvas) => canvas.width > 0));
  await page.screenshot({ path: `${outputDirectory}/mobile-trends.png`, fullPage: true });

  await page.click("#settingsButton");
  await page.click("#toggleRoleButton");
  assert.equal(await page.$eval("body", (element) => element.classList.contains("viewer-mode")), true);
  await page.click('[data-page-target="entry"]');
  assert.equal(await page.$eval("#monthInput", (element) => element.disabled), true);
  await page.click("#settingsButton");
  await page.click("#toggleRoleButton");
  assert.equal(await page.$eval("body", (element) => element.classList.contains("viewer-mode")), false);

  const fileInput = await page.$("#qianjiFileInput");
  await fileInput.uploadFile(qianjiFixture);
  await page.waitForFunction(() => document.querySelector("#familyExpenseConfirmedInput").value === "38.5");
  assert.match(await page.$eval("#uploadResult", (element) => element.textContent), /2 笔/);

  let overwritePrompt = "";
  page.once("dialog", async (dialog) => {
    overwritePrompt = dialog.message();
    await dialog.accept();
  });
  await page.click('button[type="submit"]');
  await page.waitForSelector("#overviewPage.active");
  assert.match(overwritePrompt, /已有记录/);
  const storedState = await page.evaluate(() => localStorage.getItem("family-finance-pwa-v1"));
  assert.doesNotMatch(storedState, /午餐|纸巾|矿泉水/);

  const manifest = await page.evaluate(async () => (await fetch("./manifest.webmanifest")).json());
  assert.equal(manifest.display, "standalone");
  const registration = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope);
  assert.match(registration, /127\.0\.0\.1:4173/);
  await page.reload({ waitUntil: "networkidle0" });
  assert.equal(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)), true);
  await page.setOfflineMode(true);
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.match(await page.title(), /家庭月度驾驶舱/);
  assert.equal(await page.$eval("#overviewContent", (element) => element.hidden), false);
  await page.setOfflineMode(false);

  await page.setViewport({ width: 1024, height: 900, deviceScaleFactor: 1 });
  await page.click('[data-page-target="overview"]');
  await page.screenshot({ path: `${outputDirectory}/desktop-overview.png`, fullPage: true });

  assert.deepEqual(errors, []);
  console.log("真实浏览器核心流程测试通过");
} finally {
  await browser.close();
}
