import {
  clearState,
  exportState,
  importState,
  loadState,
  saveSettings,
  upsertSnapshot,
  calcWorkMetrics,
  calcFamilyWorkMetrics,
  RemoteStateAdapter,
} from "./storage.js";
import { summarizeQianjiFile } from "./csv-parser.js";
import { aggregatePeriod, buildPeriodOptions, periodDefinition } from "./period-summary.js";

// ---- 工具函数 ----
const byId = (id) => document.getElementById(id);
const moneyFmt = new Intl.NumberFormat("zh-CN", { style: "currency", currency: "CNY", minimumFractionDigits: 0, maximumFractionDigits: 2 });
const numFmt = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;

let state = loadState();
let selectedMonth = currentMonth;
let selectedPeriod = "";
let currentPage = "overview";
let uploadedSummary = null;
let deferredInstallPrompt = null;
let toastTimer = null;
let demoMode = false;
let settingsDirty = false;
let cloudMode = false;
let cloudAdapter = null;
let cloudSession = null;
let skipNextSettingsSave = false;
const cloudApiBase = String(window.FAMILY_FINANCE_API_BASE || "").replace(/\/$/, "");
const cloudTokenKey = "family-finance-cloud-session";

function cloudUrl(path) { return `${cloudApiBase}${path}`; }
function readCloudToken() { return sessionStorage.getItem(cloudTokenKey) || ""; }
function clearCloudToken() { sessionStorage.removeItem(cloudTokenKey); }

function money(v) { return moneyFmt.format(Number(v) || 0).replace("CN¥", "¥"); }
function num(v) { return numFmt.format(Number(v) || 0); }
function esc(v) { return String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
function monthLabel(m) { const [y, mn] = String(m).split("-"); return y && mn ? `${y}年${Number(mn)}月` : "未选择月份"; }
function sortedSnapshots() { return [...state.snapshots].sort((a, b) => a.month.localeCompare(b.month)); }
function setText(id, v) { const el = byId(id); if (el) el.textContent = v; }

function showToast(msg) {
  const t = byId("toast"); clearTimeout(toastTimer);
  t.textContent = msg; t.hidden = false;
  toastTimer = setTimeout(() => { t.hidden = true; }, 2800);
}

function applyTheme() {
  const theme = state.settings.theme;
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}
function applyRole() {
  const viewer = cloudMode ? cloudSession?.role === "viewer" : state.settings.role === "viewer";
  document.body.classList.toggle("viewer-mode", viewer);
  setText("roleLabel", cloudMode ? (viewer ? "只读云端" : "管理云端") : (viewer ? "只读预览" : "管理视图"));
  setText("toggleRoleButton", viewer ? "返回管理视图" : "切换为只读预览");
  const logoutButton = byId("logoutButton");
  if (logoutButton) logoutButton.hidden = !cloudMode;
}

async function syncCloudState() {
  if (!cloudMode || !cloudAdapter) return;
  try {
    state = await cloudAdapter.save(state);
    showToast("已同步到家庭云端");
  } catch (error) {
    if (error.status === 409) {
      showToast("另一台设备已更新数据，请重新加载后再保存");
    } else {
      showToast("本机已保存，但云端同步失败，请检查网络后重试");
    }
    throw error;
  }
}

function setCloudRole(role) {
  state.settings.role = role;
  applyRole();
}

function openCloudLogin(message = "") {
  const dialog = byId("cloudLoginDialog");
  if (!dialog) return;
  setText("cloudLoginHint", message || "使用家庭密码进入云端账本");
  byId("cloudPassword").value = "";
  if (!dialog.open) dialog.showModal();
}

async function loadCloudStateAfterLogin() {
  try {
    state = await cloudAdapter.load();
    saveSettings(state, state.settings);
  } catch (error) {
    if (error.status !== 404) throw error;
    if (cloudSession.role !== "manager") {
      throw new Error("家庭云端账本尚未初始化，请由管理者先登录并上传第一份数据");
    }
    const shouldSeed = confirm("云端还是空的。是否把这台设备当前的本地账本上传为家庭第一份云端数据？");
    if (!shouldSeed) throw new Error("云端尚未初始化");
    state = await cloudAdapter.save(state);
  }
  setCloudRole(cloudSession.role);
  selectedMonth = sortedSnapshots().at(-1)?.month || currentMonth;
}

async function setupCloudMode() {
  if (!cloudApiBase || ["127.0.0.1", "localhost"].includes(location.hostname)) return;
  try {
    const health = await fetch(cloudUrl("/api/health"));
    if (!health.ok) return;
  } catch {
    return;
  }
  cloudMode = true;
  const token = readCloudToken();
  if (!token) { openCloudLogin(); return; }
  cloudAdapter = new RemoteStateAdapter(cloudApiBase, token);
  const sessionResponse = await fetch(cloudUrl("/api/session"), { headers: { Authorization: `Bearer ${token}` } });
  if (sessionResponse.ok) {
    cloudSession = await sessionResponse.json();
    try {
      await loadCloudStateAfterLogin();
    } catch (error) {
      openCloudLogin(error.message);
    }
  } else {
    clearCloudToken();
    cloudAdapter = null;
    openCloudLogin();
  }
}

function prevSnapshot(month) {
  return sortedSnapshots().filter(s => s.month < month).at(-1) || null;
}

function getLifeMetrics(snap) {
  // snap: 可选的月度记录，用于覆盖月薪
  const monthlyIncomes = {};
  if (snap) {
    monthlyIncomes.suli = snap.people.suli.income || 0;
    monthlyIncomes.chenqian = snap.people.chenqian.income || 0;
  }
  return calcFamilyWorkMetrics(state.settings, monthlyIncomes);
}

// ---- 演示数据 ----
const demoSnapshots = [
  {
    month: "2026-06",
    accounts: { familySpendingBalance: 620, familySavingsBalance: 68000 },
    people: { suli: { income: 8500, householdTransfer: 6500, privateKept: 2000 }, chenqian: { income: 9200, householdTransfer: 7000, privateKept: 2200 } },
    expense: { autoTotal: 2880, confirmedTotal: 2880, recordCount: 64, categoryBreakdown: { 好好吃饭: 1120, 生活成本: 930, 品质生活: 830 } },
    note: "开始按月记录家庭大数。",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    month: "2026-07",
    accounts: { familySpendingBalance: 480, familySavingsBalance: 78200 },
    people: { suli: { income: 8500, householdTransfer: 6400, privateKept: 2100 }, chenqian: { income: 9400, householdTransfer: 7200, privateKept: 2200 } },
    expense: { autoTotal: 3140, confirmedTotal: 3140, recordCount: 71, categoryBreakdown: { 好好吃饭: 1280, 生活成本: 1010, 品质生活: 850 } },
    note: "本月有一笔培训费用。",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
  {
    month: "2026-08",
    accounts: { familySpendingBalance: 1160, familySavingsBalance: 89100 },
    people: { suli: { income: 8800, householdTransfer: 6800, privateKept: 2000 }, chenqian: { income: 9400, householdTransfer: 7200, privateKept: 2200 } },
    expense: { autoTotal: 2460, confirmedTotal: 2460, recordCount: 58, categoryBreakdown: { 好好吃饭: 980, 生活成本: 920, 品质生活: 560 } },
    note: "家庭支出控制在预算内。",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  },
];

function withDemoData() {
  if (new URLSearchParams(location.search).get("demo") !== "1" || state.snapshots.length) return;
  demoMode = true;
  state = {
    ...state,
    settings: {
      ...state.settings,
      savingsGoal: 150000,
      people: {
        suli: {
          ...state.settings.people.suli,
          name: "欣然",
          workProfile: {
            ...state.settings.people.suli.workProfile,
            referenceMonthlyIncome: 8800, workDaysPerMonth: 22, workHoursPerDay: 8,
            commuteMinutesPerDay: 45, mealCostPerWorkday: 25,
            commuteCostPerMonth: 200, otherWorkCostPerMonth: 100,
            _v1MonthlyIncome: 8800, _v1WorkHours: 176, _v1CommuteHours: 16, _v1WorkCosts: 650,
          },
        },
        chenqian: {
          ...state.settings.people.chenqian,
          name: "陈前",
          workProfile: {
            ...state.settings.people.chenqian.workProfile,
            referenceMonthlyIncome: 9400, workDaysPerMonth: 22, workHoursPerDay: 8,
            commuteMinutesPerDay: 30, mealCostPerWorkday: 20,
            commuteCostPerMonth: 150, otherWorkCostPerMonth: 80,
            _v1MonthlyIncome: 9400, _v1WorkHours: 176, _v1CommuteHours: 11, _v1WorkCosts: 590,
          },
        },
      },
    },
    snapshots: demoSnapshots,
  };
}

// ---- 导航 ----
function navigateTo(pageName) {
  currentPage = pageName;
  document.querySelectorAll(".page").forEach(p => p.classList.remove("active"));
  const pg = document.querySelector(`[data-page="${pageName}"]`);
  if (pg) pg.classList.add("active");
  document.querySelectorAll(".nav-button").forEach(b => {
    const match = b.dataset.page === pageName;
    b.classList.toggle("active", match);
    if (match) b.setAttribute("aria-current", "page");
    else b.removeAttribute("aria-current");
  });

  if (pageName === "overview") { renderOverview(); setText("headerMonthLabel", "家庭经济状况"); }
  else if (pageName === "entry") { renderEntry(); }
  else if (pageName === "life") { renderLife(); setText("headerMonthLabel", "生命能量"); }
  else if (pageName === "analysis") { renderAnalysis(); setText("headerMonthLabel", "支出分析"); }
  else if (pageName === "summary") { renderSummary(); setText("headerMonthLabel", "家庭财务总结"); }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

// ---- 周期选项渲染 ----
function optionGroup(label, vals) {
  if (!vals.length) return "";
  return `<optgroup label="${label}">${vals.map(v => {
    const d = periodDefinition(v);
    return `<option value="${v}">${d ? d.optionLabel : v}</option>`;
  }).join("")}</optgroup>`;
}

function renderPeriodSelect(selectId, defaultVal) {
  const opts = buildPeriodOptions(state.snapshots, currentMonth);
  const all = [...opts.months, ...opts.halves, ...opts.years];
  const sel = byId(selectId);
  sel.innerHTML = [
    optionGroup("按月查看", opts.months),
    optionGroup("半年度总结", opts.halves),
    optionGroup("年终总结", opts.years),
  ].join("");
  const final = all.includes(defaultVal) ? defaultVal : (all[0] || "");
  sel.value = final;
  return final;
}

function monthOnlySelect(selectId, months) {
  const sel = byId(selectId);
  sel.innerHTML = months.length
    ? months.map(m => `<option value="${m}">${monthLabel(m)}</option>`).join("")
    : '<option value="">暂无记录</option>';
  if (months.length && !months.includes(selectedMonth)) selectedMonth = months[0];
  sel.value = selectedMonth;
}

// ---- 分类列表 ----
function renderCategoryList(containerId, breakdown, hourlyRate) {
  const el = byId(containerId);
  if (!el) return;
  if (!breakdown || Object.keys(breakdown).length === 0) {
    el.innerHTML = '<p style="color:var(--ink-faint);font-size:0.74rem;">暂无分类数据</p>';
    return;
  }
  const total = Object.values(breakdown).reduce((a, b) => a + b, 0) || 1;
  const sorted = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  el.innerHTML = sorted.map(([cat, amt]) => {
    const pct = Math.round(amt / total * 100);
    const hr = hourlyRate > 0 ? amt / hourlyRate : 0;
    return `<div class="category-row">
      <div class="category-copy"><span>${esc(cat)}</span><small>${pct}%</small></div>
      <div class="category-bar"><span style="width:${pct}%"></span></div>
      <span style="font-family:var(--font-number);font-size:0.74rem;white-space:nowrap;">${money(amt)}${hourlyRate > 0 ? ` · ${numFmt.format(hr)}h` : ""}</span>
    </div>`;
  }).join("");
}

// ================================================================
// 1. 总览
// ================================================================
function renderOverview() {
  selectedPeriod = renderPeriodSelect("overviewPeriodSelect", selectedPeriod || `month:${selectedMonth}`);
  const report = aggregatePeriod(state.snapshots, selectedPeriod);
  const hasData = report && report.latest;
  const def = report?.definition || periodDefinition(selectedPeriod);
  byId("overviewEmpty").hidden = hasData;
  byId("overviewContent").hidden = !hasData;
  setText("headerMonthLabel", def?.label || "尚未开始记录");
  if (!hasData) return;

  const m = report.metrics;
  const budget = state.settings.monthlyBudget * report.coverageCount;
  const usedPct = budget > 0 ? m.expense / budget * 100 : 0;
  const goalPct = state.settings.savingsGoal > 0 ? (report.latest.accounts.familySavingsBalance / state.settings.savingsGoal * 100) : 0;

  // 储蓄卡
  setText("savingsBalance", money(report.latest.accounts.familySavingsBalance));
  const prev = prevSnapshot(report.definition.startMonth);
  if (prev) {
    const delta = report.latest.accounts.familySavingsBalance - prev.accounts.familySavingsBalance;
    setText("savingsChange", `${delta >= 0 ? "+" : ""}${money(delta)}${def.kind !== "month" ? "（周期变化）" : ""}`);
  } else {
    setText("savingsChange", "首月记录，暂无环比");
  }
  setText("goalPercent", `${numFmt.format(Math.min(goalPct, 999))}%`);
  byId("goalProgress").value = Math.min(goalPct, 100);

  // 指标
  setText("totalIncome", money(m.totalIncome));
  setText("totalTransfer", money(m.totalTransfer));
  setText("totalExpense", money(m.expense));
  setText("operatingBalance", money(m.operatingBalance));

  // 预算
  setText("budgetSummary", `${def.kind === "month" ? "本月" : "已记录月份累计"}预算 ${money(budget)}`);
  setText("budgetUsage", `${numFmt.format(Math.min(usedPct, 999))}%`);
  const budgetLine = byId("budgetLineFill");
  budgetLine.style.width = `${Math.min(usedPct, 100)}%`;
  budgetLine.classList.toggle("over-budget", usedPct > 100);
  setText("spendingCardBalance", `花销卡 ${money(report.latest.accounts.familySpendingBalance)}`);
  setText("budgetRemaining", `剩余 ${money(Math.max(0, budget - m.expense))}`);

  // 双人矩阵
  const su = report.latest.people.suli;
  const cq = report.latest.people.chenqian;
  setText("ovSuliIncome", money(su.income));
  setText("ovSuliTransfer", money(su.householdTransfer));
  setText("ovSuliKept", money(su.privateKept));
  setText("ovSuliGap", money(su.income - su.householdTransfer - su.privateKept));
  setText("ovChenqianIncome", money(cq.income));
  setText("ovChenqianTransfer", money(cq.householdTransfer));
  setText("ovChenqianKept", money(cq.privateKept));
  setText("ovChenqianGap", money(cq.income - cq.householdTransfer - cq.privateKept));
  setText("ovFamilyTotal", `转入 ${money(m.totalTransfer)} · 储蓄率 ${numFmt.format(m.transferRate * 100)}%`);

  // 建议
  const advice = genAdvice(report, budget);
  byId("adviceList").innerHTML = advice.map((a, i) => `<div class="advice-item"><span class="advice-number">${i + 1}</span><p>${esc(a)}</p></div>`).join("");

  // 周期总结（半年度/年度时显示）
  renderPeriodBlock(report);
}

function renderPeriodBlock(report) {
  const sec = byId("periodSummarySection");
  if (!sec) return;
  const visible = report.definition.kind !== "month";
  sec.hidden = !visible;
  if (!visible) return;

  const covPct = report.coverageCount / Math.max(report.definition.expectedMonths, 1) * 100;
  const avgExpense = report.coverageCount > 0 ? report.metrics.expense / report.coverageCount : 0;
  const fm = getLifeMetrics(report.latest);
  const lifeHr = fm.familyHourlyRate > 0 ? report.metrics.expense / fm.familyHourlyRate : 0;

  setText("periodSummaryTitle", report.definition.summaryTitle);
  setText("periodCoverageCopy", `已记录 ${report.coverageCount}/${report.definition.expectedMonths} 个月，数据补齐后自动更新`);
  byId("periodCoverageFill").style.width = `${Math.min(covPct, 100)}%`;
  byId("periodCoverageFill").style.width = `${Math.min(covPct, 100)}%`;
  setText("periodIncome", money(report.metrics.totalIncome));
  setText("periodExpense", money(report.metrics.expense));
  setText("periodAverageExpense", money(avgExpense));
  setText("periodTransfer", money(report.metrics.totalTransfer));

  const prevSnap = prevSnapshot(report.definition.startMonth);
  if (prevSnap && report.latest) {
    const d = report.latest.accounts.familySavingsBalance - prevSnap.accounts.familySavingsBalance;
    setText("periodSavingsChange", `${d >= 0 ? "+" : ""}${money(d)}`);
  } else if (report.first && report.latest && report.snapshots.length > 1) {
    const d = report.latest.accounts.familySavingsBalance - report.first.accounts.familySavingsBalance;
    setText("periodSavingsChange", `${d >= 0 ? "+" : ""}${money(d)}`);
  } else {
    setText("periodSavingsChange", "基线待形成");
  }
  setText("periodLifeHours", fm.familyHourlyRate > 0 ? `${numFmt.format(lifeHr)} 小时` : "待设置");
  renderCategoryList("periodCategoryList", report.categoryBreakdown, fm.familyHourlyRate);
}

function genAdvice(report, budget) {
  const { metrics, definition } = report;
  const pc = definition.kind === "month" ? "本月" : definition.label;
  const adv = [];
  if (budget > 0 && metrics.expense <= budget) {
    adv.push(`${pc}支出比预算少 ${money(budget - metrics.expense)}。保持可持续节奏。`);
  } else if (budget > 0) {
    adv.push(`${pc}支出超出预算 ${money(metrics.expense - budget)}。先确认是一次性还是规律性变化。`);
  }
  adv.push(`两人把收入的 ${Math.round(metrics.transferRate * 100)}% 转入家庭。工资到账后自动转入让储蓄先发生。`);
  if (definition.kind !== "month" && report.coverageCount < definition.expectedMonths) {
    adv.push(`${definition.label}已记录 ${report.coverageCount}/${definition.expectedMonths} 个月。这是阶段性总结，月份补齐后自动更新。`);
  } else if (Math.abs(metrics.gap) > 100) {
    adv.push(`存在 ${money(Math.abs(metrics.gap))} 待说明差额。确认是否有奖金、还款或其他大额流向。`);
  } else {
    adv.push("家庭卡余额变化与转入、支出基本对得上。当前大数记录足够回答家庭经济状况。");
  }
  return adv.slice(0, 3);
}

// ================================================================
// 2. 月度记录
// ================================================================
function renderEntry() {
  byId("entryMonth").value = selectedMonth;
  byId("csvUploadResult").hidden = true;
  uploadedSummary = null;
  const snap = state.snapshots.find(s => s.month === selectedMonth);
  if (snap) {
    byId("spendingBalance").value = snap.accounts.familySpendingBalance || "";
    byId("savingsBalanceEntry").value = snap.accounts.familySavingsBalance || "";
    byId("suliIncome").value = snap.people.suli.income || "";
    byId("suliTransfer").value = snap.people.suli.householdTransfer || "";
    byId("suliKept").value = snap.people.suli.privateKept || "";
    byId("chenqianIncome").value = snap.people.chenqian.income || "";
    byId("chenqianTransfer").value = snap.people.chenqian.householdTransfer || "";
    byId("chenqianKept").value = snap.people.chenqian.privateKept || "";
    byId("confirmedExpense").value = snap.expense.confirmedTotal || "";
    byId("monthlyNote").value = snap.note || "";
    if (snap.expense.autoTotal && snap.expense.sourceFileName) showCsvResult(snap);
    setText("headerMonthLabel", "编辑已有记录");
  } else {
    ["spendingBalance","savingsBalanceEntry","suliIncome","suliTransfer","suliKept","chenqianIncome","chenqianTransfer","chenqianKept","confirmedExpense","monthlyNote"].forEach(id => {
      const el = byId(id);
      if (el) { if (el.tagName === "TEXTAREA") el.value = ""; else el.value = ""; }
    });
    setText("headerMonthLabel", "新建月度记录");
  }
}

function showCsvResult(snap) {
  const el = byId("csvUploadResult");
  el.hidden = false;
  el.className = "upload-result";
  const cats = snap.expense.categoryBreakdown || {};
  const top3 = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${money(v)}`).join(" · ");
  el.innerHTML = `已解析 ${snap.expense.sourceFileName || ""}<br>${snap.expense.recordCount} 笔 · 合计 ${money(snap.expense.confirmedTotal)}<br>${top3 || "无分类数据"}`;
  byId("confirmedExpense").value = snap.expense.confirmedTotal;
}

async function handleCsvUpload(file) {
  try {
    const summary = await summarizeQianjiFile(file, selectedMonth);
    uploadedSummary = summary;
    const cats = summary.categoryBreakdown || {};
    const top3 = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${money(v)}`).join(" · ");
    const el = byId("csvUploadResult");
    el.hidden = false;
    el.className = "upload-result";
    el.innerHTML = `${file.name}<br>${summary.matchedRows} 笔 · 合计 ${money(summary.total)}<br>${top3 || "无分类数据"}`;
    byId("confirmedExpense").value = summary.total;
  } catch (err) {
    const el = byId("csvUploadResult");
    el.hidden = false;
    el.className = "upload-result error";
    el.textContent = err.message;
    uploadedSummary = null;
  }
}

async function saveSnapshot(e) {
  e.preventDefault();
  const month = byId("entryMonth").value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { showToast("月份格式不正确"); return; }
  const existing = state.snapshots.find(s => s.month === month);
  if (existing && !confirm(`${monthLabel(month)} 已有记录，覆盖吗？`)) return;

  const snap = {
    month,
    accounts: {
      familySpendingBalance: safeNum(byId("spendingBalance").value),
      familySavingsBalance: safeNum(byId("savingsBalanceEntry").value),
    },
    people: {
      suli: { income: safeNum(byId("suliIncome").value), householdTransfer: safeNum(byId("suliTransfer").value), privateKept: safeNum(byId("suliKept").value) },
      chenqian: { income: safeNum(byId("chenqianIncome").value), householdTransfer: safeNum(byId("chenqianTransfer").value), privateKept: safeNum(byId("chenqianKept").value) },
    },
    expense: {
      autoTotal: uploadedSummary?.total,
      confirmedTotal: safeNum(byId("confirmedExpense").value),
      recordCount: uploadedSummary?.matchedRows || (existing?.expense?.recordCount || 0),
      categoryBreakdown: uploadedSummary?.categoryBreakdown || (existing?.expense?.categoryBreakdown || {}),
      sourceFileName: uploadedSummary?.sourceFileName || (existing?.expense?.sourceFileName || ""),
      sourceMonths: uploadedSummary?.sourceMonths || (existing?.expense?.sourceMonths || []),
      importedAt: uploadedSummary?.importedAt || (existing?.expense?.importedAt || ""),
    },
    note: (byId("monthlyNote").value || "").trim().slice(0, 200),
  };

  state = upsertSnapshot(state, snap);
  try { await syncCloudState(); } catch { return; }
  showToast(`${monthLabel(month)} 已保存`);
  navigateTo("overview");
}

async function deleteSnapshot() {
  const month = byId("entryMonth").value;
  if (!state.snapshots.find(s => s.month === month)) { showToast("该月份没有记录"); return; }
  if (!confirm(`确定删除 ${monthLabel(month)} 记录？`)) return;
  state = { ...state, snapshots: state.snapshots.filter(s => s.month !== month), metadata: { ...state.metadata, updatedAt: new Date().toISOString() } };
  state = saveSettings(state, state.settings);
  try { await syncCloudState(); } catch { return; }
  showToast(`${monthLabel(month)} 已删除`);
  renderEntry();
}

// ================================================================
// 3. 生命能量
// ================================================================
function renderLife() {
  const snaps = sortedSnapshots();
  const months = [...new Set(snaps.map(s => s.month))].sort((a, b) => b.localeCompare(a));
  monthOnlySelect("lifeMonthSelect", months);

  const sn = state.snapshots.find(s => s.month === selectedMonth);
  byId("lifeEmpty").hidden = Boolean(sn);
  byId("lifeContent").hidden = !sn;
  if (!sn) return;

  const fm = getLifeMetrics(sn);
  const exp = sn.expense.confirmedTotal;
  const lifeHr = fm.familyHourlyRate > 0 ? exp / fm.familyHourlyRate : 0;
  const lifeDays = lifeHr / 8;

  setText("lifeTotalHours", fm.familyHourlyRate > 0 ? numFmt.format(lifeHr) : "—");
  setText("lifeWorkDays", fm.familyHourlyRate > 0 ? numFmt.format(lifeDays) : "—");

  // 双人时薪
  const suliInc = sn.people.suli.income || state.settings.people.suli.workProfile.referenceMonthlyIncome;
  const cqInc = sn.people.chenqian.income || state.settings.people.chenqian.workProfile.referenceMonthlyIncome;
  setText("lifeSuliRefIncome", money(suliInc));
  setText("lifeChenqianRefIncome", money(cqInc));
  setText("lifeSuliHourly", fm.suli.complete ? `${money(fm.suli.hourlyRate)}/时` : "待完善资料");
  setText("lifeChenqianHourly", fm.chenqian.complete ? `${money(fm.chenqian.hourlyRate)}/时` : "待完善资料");
  setText("lifeSuli10Min", fm.suli.complete ? `${numFmt.format(fm.suli.minutesPer10)} 分钟` : "—");
  setText("lifeChenqian10Min", fm.chenqian.complete ? `${numFmt.format(fm.chenqian.minutesPer10)} 分钟` : "—");
  setText("lifeFamilyHourly", fm.familyHourlyRate > 0 ? `${money(fm.familyHourlyRate)}/时` : "待完善计算资料");

  // 分类生命时间
  renderCategoryList("lifeCategoryList", sn.expense.categoryBreakdown, fm.familyHourlyRate);

  // 可换回时间
  const tradeAmt = safeNum(byId("lifeTradeoffAmount")?.value) || 100;
  const tradeHr = fm.familyHourlyRate > 0 ? tradeAmt / fm.familyHourlyRate : 0;
  if (byId("lifeTradeoffResult")) {
    setText("lifeTradeoffResult", fm.familyHourlyRate > 0
      ? `¥${num(tradeAmt)} ≈ ${numFmt.format(tradeHr)} 小时 · 约 ${numFmt.format(tradeHr / 8)} 个工作日`
      : "请先在设置中填写计算口径");
  }

  byId("lifeIncomplete").hidden = fm.suli.complete || fm.chenqian.complete;
}

// ================================================================
// 4. 支出分析
// ================================================================
function renderAnalysis() {
  const snaps = sortedSnapshots();
  const months = [...new Set(snaps.map(s => s.month))].sort((a, b) => b.localeCompare(a));
  monthOnlySelect("analysisMonthSelect", months);

  const sn = state.snapshots.find(s => s.month === selectedMonth);
  const hasExpense = sn && sn.expense.confirmedTotal > 0;
  byId("analysisEmpty").hidden = hasExpense;
  byId("analysisContent").hidden = !hasExpense;
  if (!hasExpense) return;

  const exp = sn.expense.confirmedTotal;
  const budget = state.settings.monthlyBudget;
  const usedPct = budget > 0 ? exp / budget * 100 : 0;
  const fm = getLifeMetrics(sn);
  const lifeHr = fm.familyHourlyRate > 0 ? exp / fm.familyHourlyRate : 0;

  setText("analysisTotalExpense", money(exp));
  setText("analysisBudgetUsage", `${numFmt.format(usedPct)}%`);
  setText("analysisLifeHours", fm.familyHourlyRate > 0 ? `${numFmt.format(lifeHr)} 小时` : "待完善资料");
  setText("analysisRecordCount", String(sn.expense.recordCount || 0));

  renderCategoryList("analysisCategoryList", sn.expense.categoryBreakdown, fm.familyHourlyRate);

  // 关键项目
  const cats = sn.expense.categoryBreakdown || {};
  const sorted = Object.entries(cats).sort((a, b) => b[1] - a[1]);
  if (sorted.length) {
    byId("analysisKeyItems").hidden = false;
    const top3 = sorted.slice(0, 3).map(([k, v]) => `${k}（${money(v)}，${numFmt.format(v / exp * 100)}%）`).join(" · ");
    setText("analysisKeyText", `最大三项：${top3}`);
  } else {
    byId("analysisKeyItems").hidden = true;
  }

  // 一句话
  let adv = "";
  if (usedPct <= 100) adv = `支出在预算内（比预算少 ${money(budget - exp)}）。节奏可持续。`;
  else adv = `支出超出预算 ${money(exp - budget)}。是临时性支出还是需要调整预算？`;
  const food = cats["好好吃饭"] || 0;
  if (food > exp * 0.4) adv += " 饮食占比超四成——正常的，只要你觉得花得值。";
  setText("analysisAdviceText", adv);
}

// ================================================================
// 5. 家庭财务总结
// ================================================================
function renderSummary() {
  selectedPeriod = renderPeriodSelect("summaryPeriodSelect", selectedPeriod || `month:${selectedMonth}`);
  const report = aggregatePeriod(state.snapshots, selectedPeriod);
  const hasData = report && report.latest;
  byId("summaryEmpty").hidden = hasData;
  byId("summaryContent").hidden = !hasData;
  if (!hasData) return;

  const m = report.metrics;
  const covPct = report.coverageCount / Math.max(report.definition.expectedMonths, 1) * 100;
  byId("summaryCoverageFill").style.width = `${Math.min(covPct, 100)}%`;
  setText("summaryCoverageCopy", `${report.definition.label} · 已记录 ${report.coverageCount}/${report.definition.expectedMonths} 个月`);

  setText("summaryIncome", money(m.totalIncome));
  setText("summaryExpense", money(m.expense));
  setText("summaryTransfer", money(m.totalTransfer));
  setText("summaryOperatingBalance", money(m.operatingBalance));

  // 储蓄变化
  const startBal = report.snapshots[0]?.accounts?.familySavingsBalance;
  const endBal = report.latest?.accounts?.familySavingsBalance;
  setText("summarySavingsStart", startBal !== undefined ? money(startBal) : "—");
  setText("summarySavingsEnd", endBal !== undefined ? money(endBal) : "—");
  if (startBal !== undefined && endBal !== undefined) {
    const d = endBal - startBal;
    setText("summarySavingsDelta", `${d >= 0 ? "+" : ""}${money(d)}`);
  } else {
    setText("summarySavingsDelta", "—");
  }
  setText("summarySavingsRate", `${numFmt.format(m.transferRate * 100)}%`);
  const goalPct = state.settings.savingsGoal > 0 ? ((endBal || 0) / state.settings.savingsGoal * 100) : 0;
  setText("summaryGoalProgress", `${numFmt.format(goalPct)}%（目标 ${money(state.settings.savingsGoal)}）`);

  // 双人贡献
  setText("sumSuliIncome", money(report.people.suli.income));
  setText("sumSuliTransfer", money(report.people.suli.householdTransfer));
  setText("sumSuliKept", money(report.people.suli.privateKept));
  setText("sumChenqianIncome", money(report.people.chenqian.income));
  setText("sumChenqianTransfer", money(report.people.chenqian.householdTransfer));
  setText("sumChenqianKept", money(report.people.chenqian.privateKept));

  const fm = getLifeMetrics(report.latest);
  renderCategoryList("summaryCategoryList", report.categoryBreakdown, fm.familyHourlyRate);

  const lifeHr = fm.familyHourlyRate > 0 ? m.expense / fm.familyHourlyRate : 0;
  setText("summaryLifeHours", fm.familyHourlyRate > 0 ? `${numFmt.format(lifeHr)} 小时` : "待完善资料");
  setText("summaryLifeDays", fm.familyHourlyRate > 0 ? `${numFmt.format(lifeHr / 8)} 天` : "—");

  // 总结
  const adv = [];
  if (covPct < 100) adv.push(`${report.definition.label}覆盖 ${report.coverageCount} 个月。补齐后自动更新。`);
  if (m.operatingBalance >= 0) adv.push(`经营结余 ${money(m.operatingBalance)}，财务状况健康。`);
  else adv.push(`经营赤字 ${money(Math.abs(m.operatingBalance))}，确认是否有大额一次性支出。`);
  adv.push(`家庭储蓄率 ${numFmt.format(m.transferRate * 100)}%，两人共转入 ${money(m.totalTransfer)}。`);
  byId("summaryAdviceList").innerHTML = adv.map((a, i) => `<div class="advice-item"><span class="advice-number">${i + 1}</span><p>${esc(a)}</p></div>`).join("");
}

// ================================================================
// 6. 设置对话框
// ================================================================
function openSettings() {
  const s = state.settings;
  const su = s.people.suli;
  const cq = s.people.chenqian;
  const isViewer = cloudMode ? cloudSession?.role === "viewer" : s.role === "viewer";
  const d = isViewer ? " disabled" : "";
  const body = byId("settingsBody");

  body.innerHTML = `
    <div class="settings-group">
      <h3>家庭默认值</h3>
      <div class="field-grid two-columns">
        <div class="field"><span>月度花费预算</span><div class="money-input"><b>¥</b><input type="number" id="setBudget" value="${s.monthlyBudget}"${d} inputmode="decimal" step="100" min="0"></div></div>
        <div class="field"><span>家庭储蓄目标</span><div class="money-input"><b>¥</b><input type="number" id="setSavingsGoal" value="${s.savingsGoal}"${d} inputmode="decimal" step="1000" min="0"></div></div>
      </div>
    </div>
    <div class="settings-group">
      <h3>显示名称</h3>
      <div class="field-grid dual-input">
        <div class="field"><span>欣然</span><input type="text" id="setSuliName" value="${esc(su.name)}"${d} maxlength="20"></div>
        <div class="field"><span>陈前</span><input type="text" id="setChenqianName" value="${esc(cq.name)}"${d} maxlength="20"></div>
      </div>
    </div>
    <div class="settings-group">
      <h3>欣然 · 工作资料</h3>
      ${wpFields("suli", su.workProfile, d)}
      <div class="calc-preview" id="calcPreviewSuli"></div>
    </div>
    <div class="settings-group">
      <h3>陈前 · 工作资料</h3>
      ${wpFields("chenqian", cq.workProfile, d)}
      <div class="calc-preview" id="calcPreviewChenqian"></div>
    </div>
    <div class="settings-group">
      <h3>备份与恢复</h3>
      <div class="stacked-actions">
        ${isViewer ? '' : '<button class="secondary-button" type="button" id="exportBackupBtn">导出 JSON 备份</button>'}
        ${isViewer ? '' : '<label class="secondary-button file-button" style="cursor:pointer;">从备份恢复<input type="file" id="importBackupFile" accept=".json" hidden></label>'}
        ${isViewer ? '' : '<button class="danger-button" type="button" id="clearDataBtn">清空本地数据</button>'}
        ${isViewer ? '<p style="color:var(--ink-soft);font-size:0.74rem;padding:0.5rem;">只读模式，设置仅供查看。</p>' : ''}
      </div>
    </div>
  `;

  // 绑定事件（仅管理员）
  if (!isViewer) {
    byId("exportBackupBtn").onclick = () => {
      const blob = new Blob([exportState(state)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a"); a.href = url; a.download = `家里有前备份_${new Date().toISOString().slice(0, 10)}.json`; a.click();
      URL.revokeObjectURL(url);
      showToast("备份已下载");
    };
    byId("importBackupFile").onchange = async (e) => {
      try {
        const text = await e.target.files[0].text();
        state = importState(text);
        await syncCloudState();
        skipNextSettingsSave = true;
        byId("settingsDialog").close();
        showToast("备份已恢复");
        setTimeout(() => location.reload(), 500);
      } catch (err) { showToast(err.message); }
    };
    byId("clearDataBtn").onclick = async () => {
      if (!confirm("确定清空全部数据？此操作不可恢复。")) return;
      state = clearState();
      await syncCloudState();
      byId("settingsDialog").close();
      location.reload();
    };
  }

  // 关闭按钮
  byId("closeSettingsButton").onclick = async () => {
    if (!isViewer) await saveSettingsFromDialog();
    byId("settingsDialog").close();
  };
  byId("toggleRoleButton").onclick = toggleRole;

  // 实时预览
  if (!isViewer) {
    ["suli", "chenqian"].forEach(k => updateCalcPreview(k));
    settingsDirty = false;
  }
  byId("settingsDialog").showModal();
}

function wpFields(key, wp, disabled) {
  const pfx = key === "suli" ? "setSuli" : "setChenqian";
  const d = disabled || "";
  return `
    <div class="field-grid two-columns">
      <div class="field"><span>参考税后月薪</span><div class="money-input"><b>¥</b><input type="number" id="${pfx}RefIncome" value="${wp.referenceMonthlyIncome || ""}"${d} inputmode="decimal" step="100" min="0"></div></div>
      <div class="field"><span>每月工作天数</span><input type="number" id="${pfx}WorkDays" value="${wp.workDaysPerMonth || 22}"${d} inputmode="numeric" min="1" max="31"></div>
      <div class="field"><span>每天工作小时</span><input type="number" id="${pfx}WorkHours" value="${wp.workHoursPerDay || 8}"${d} inputmode="numeric" min="1" max="16" step="0.5"></div>
      <div class="field"><span>每日通勤（分钟）</span><input type="number" id="${pfx}CommuteMin" value="${wp.commuteMinutesPerDay || ""}"${d} inputmode="numeric" min="0"></div>
      <div class="field"><span>每日工作餐成本</span><div class="money-input"><b>¥</b><input type="number" id="${pfx}MealCost" value="${wp.mealCostPerWorkday || ""}"${d} inputmode="decimal" step="1" min="0"></div></div>
      <div class="field"><span>每月通勤成本</span><div class="money-input"><b>¥</b><input type="number" id="${pfx}CommuteCost" value="${wp.commuteCostPerMonth || ""}"${d} inputmode="decimal" step="10" min="0"></div></div>
      <div class="field"><span>每月其他工作成本</span><div class="money-input"><b>¥</b><input type="number" id="${pfx}OtherCost" value="${wp.otherWorkCostPerMonth || ""}"${d} inputmode="decimal" step="10" min="0"></div></div>
    </div>`;
}

function updateCalcPreview(key) {
  const r = key === "suli" ? "setSuli" : "setChenqian";
  const wp = {
    referenceMonthlyIncome: safeNum(byId(`${r}RefIncome`)?.value),
    workDaysPerMonth: safeNum(byId(`${r}WorkDays`)?.value) || 22,
    workHoursPerDay: safeNum(byId(`${r}WorkHours`)?.value) || 8,
    commuteMinutesPerDay: safeNum(byId(`${r}CommuteMin`)?.value),
    mealCostPerWorkday: safeNum(byId(`${r}MealCost`)?.value),
    commuteCostPerMonth: safeNum(byId(`${r}CommuteCost`)?.value),
    otherWorkCostPerMonth: safeNum(byId(`${r}OtherCost`)?.value),
    _v1MonthlyIncome: 0, _v1WorkHours: 0, _v1CommuteHours: 0, _v1WorkCosts: 0,
  };
  const m = calcWorkMetrics(wp, wp.referenceMonthlyIncome);
  const el = byId(`calcPreview${key === "suli" ? "Suli" : "Chenqian"}`);
  if (!el) return;
  if (m.complete) {
    el.innerHTML = `实际时薪 <strong>${money(m.hourlyRate)}/时</strong> · 每赚 10 元需 <strong>${numFmt.format(m.minutesPer10)} 分钟</strong>`;
  } else {
    el.innerHTML = '<span style="color:var(--warning);">填写月薪和工作资料后自动计算</span>';
  }
}

async function saveSettingsFromDialog() {
  if (cloudMode && cloudSession?.role === "viewer") return;
  const ns = {
    ...state.settings,
    monthlyBudget: safeNum(byId("setBudget")?.value) || 3000,
    savingsGoal: safeNum(byId("setSavingsGoal")?.value) || 100000,
    people: {
      suli: {
        name: (byId("setSuliName")?.value || "").trim().slice(0, 20) || "欣然",
        workProfile: readWorkProfile("suli"),
      },
      chenqian: {
        name: (byId("setChenqianName")?.value || "").trim().slice(0, 20) || "陈前",
        workProfile: readWorkProfile("chenqian"),
      },
    },
  };
  state = saveSettings(state, ns);
  try { await syncCloudState(); } catch { return; }
  applyTheme();
  applyRole();
}

function readWorkProfile(key) {
  const r = key === "suli" ? "setSuli" : "setChenqian";
  const old = state.settings.people[key].workProfile;
  return {
    referenceMonthlyIncome: safeNum(byId(`${r}RefIncome`)?.value),
    workDaysPerMonth: safeNum(byId(`${r}WorkDays`)?.value) || 22,
    workHoursPerDay: safeNum(byId(`${r}WorkHours`)?.value) || 8,
    commuteMinutesPerDay: safeNum(byId(`${r}CommuteMin`)?.value),
    mealCostPerWorkday: safeNum(byId(`${r}MealCost`)?.value),
    commuteCostPerMonth: safeNum(byId(`${r}CommuteCost`)?.value),
    otherWorkCostPerMonth: safeNum(byId(`${r}OtherCost`)?.value),
    _v1MonthlyIncome: old._v1MonthlyIncome,
    _v1WorkHours: old._v1WorkHours,
    _v1CommuteHours: old._v1CommuteHours,
    _v1WorkCosts: old._v1WorkCosts,
  };
}

function toggleRole() {
  if (cloudMode) {
    byId("settingsDialog").close();
    logoutCloud();
    return;
  }
  const ns = { ...state.settings, role: state.settings.role === "manager" ? "viewer" : "manager" };
  state = saveSettings(state, ns);
  applyRole();
  byId("settingsDialog").close();
  navigateTo("overview");
}

async function logoutCloud() {
  const token = readCloudToken();
  try { await fetch(cloudUrl("/api/session"), { method: "DELETE", headers: token ? { Authorization: `Bearer ${token}` } : {} }); } catch { /* 本地清理仍可继续 */ }
  clearCloudToken();
  cloudSession = null;
  cloudAdapter = null;
  cloudMode = false;
  applyRole();
  openCloudLogin("已退出云端账本");
}

// ================================================================
// 初始化
// ================================================================
async function init() {
  await setupCloudMode();
  if (!cloudMode) withDemoData();
  applyTheme();
  applyRole();

  // 导航按钮
  document.querySelectorAll(".nav-button").forEach(btn => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.page));
  });

  // 快捷入口
  document.querySelectorAll("[data-go]").forEach(btn => {
    btn.addEventListener("click", () => {
      const t = btn.dataset.go;
      if (t === "entry") navigateTo("entry");
      else if (t === "analysis") navigateTo("analysis");
      else if (t === "summary") navigateTo("summary");
    });
  });

  // 设置
  byId("settingsButton").addEventListener("click", openSettings);
  byId("logoutButton")?.addEventListener("click", logoutCloud);
  byId("cloudLoginForm")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = byId("cloudLoginSubmit");
    button.disabled = true;
    try {
      const response = await fetch(cloudUrl("/api/session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: byId("cloudRole").value, password: byId("cloudPassword").value }),
      });
      if (!response.ok) throw new Error("密码不正确，请重试");
      cloudMode = true;
      cloudSession = await response.json();
      sessionStorage.setItem(cloudTokenKey, cloudSession.token);
      cloudAdapter = new RemoteStateAdapter(cloudApiBase, cloudSession.token);
      await loadCloudStateAfterLogin();
      byId("cloudLoginDialog").close();
      renderOverview();
      showToast(cloudSession.role === "manager" ? "已进入管理云端" : "已进入只读云端");
    } catch (error) {
      setText("cloudLoginHint", error.message || "登录失败，请重试");
    } finally {
      button.disabled = false;
    }
  });

  // 周期选择器
  byId("overviewPeriodSelect").addEventListener("change", (e) => { selectedPeriod = e.target.value; renderOverview(); });
  byId("lifeMonthSelect").addEventListener("change", (e) => { selectedMonth = e.target.value; renderLife(); });
  byId("analysisMonthSelect").addEventListener("change", (e) => { selectedMonth = e.target.value; renderAnalysis(); });
  byId("summaryPeriodSelect").addEventListener("change", (e) => { selectedPeriod = e.target.value; renderSummary(); });

  // 月度录入
  byId("entryMonth").addEventListener("change", (e) => { selectedMonth = e.target.value; renderEntry(); });
  byId("monthlyForm").addEventListener("submit", saveSnapshot);
  byId("deleteSnapshotButton").addEventListener("click", deleteSnapshot);
  byId("csvFile").addEventListener("change", (e) => { if (e.target.files[0]) handleCsvUpload(e.target.files[0]); });

  // 生命能量交互
  byId("lifeTradeoffAmount")?.addEventListener("input", renderLife);
  byId("openLifeCalc")?.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });

  // 设置对话框关闭时保存并刷新
  byId("settingsDialog").addEventListener("close", async () => {
    if (skipNextSettingsSave) {
      skipNextSettingsSave = false;
      if (currentPage === "overview") renderOverview();
      else if (currentPage === "life") renderLife();
      else if (currentPage === "analysis") renderAnalysis();
      else if (currentPage === "summary") renderSummary();
      return;
    }
    await saveSettingsFromDialog();
    if (currentPage === "overview") renderOverview();
    else if (currentPage === "life") renderLife();
    else if (currentPage === "analysis") renderAnalysis();
    else if (currentPage === "summary") renderSummary();
  });

  // PWA
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstallPrompt = e; });

  // 初始渲染
  renderOverview();
}

init();
