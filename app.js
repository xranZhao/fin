import {
  clearState,
  exportState,
  importState,
  loadState,
  saveSettings,
  upsertSnapshot,
} from "./storage.js";
import { summarizeQianjiFile } from "./csv-parser.js";

const byId = (id) => document.getElementById(id);
const moneyFormatter = new Intl.NumberFormat("zh-CN", {
  style: "currency",
  currency: "CNY",
  minimumFractionDigits: 0,
  maximumFractionDigits: 2,
});
const numberFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 1 });
const now = new Date();
const currentMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
let state = loadState();
let selectedMonth = currentMonth;
let currentPage = "overview";
let uploadedSummary = null;
let deferredInstallPrompt = null;
let toastTimer = null;
let demoMode = false;

const demoSnapshots = [
  {
    month: "2026-06",
    accounts: { familySpendingBalance: 620, familySavingsBalance: 68000 },
    people: {
      suli: { income: 8500, householdTransfer: 6500, privateKept: 2000 },
      chenqian: { income: 9200, householdTransfer: 7000, privateKept: 2200 },
    },
    expense: {
      autoTotal: 2880,
      confirmedTotal: 2880,
      recordCount: 64,
      categoryBreakdown: { 好好吃饭: 1120, 生活成本: 930, 品质生活: 830 },
    },
    note: "开始按月记录家庭大数。",
  },
  {
    month: "2026-07",
    accounts: { familySpendingBalance: 480, familySavingsBalance: 78200 },
    people: {
      suli: { income: 8500, householdTransfer: 6400, privateKept: 2100 },
      chenqian: { income: 9400, householdTransfer: 7200, privateKept: 2200 },
    },
    expense: {
      autoTotal: 3140,
      confirmedTotal: 3140,
      recordCount: 71,
      categoryBreakdown: { 好好吃饭: 1280, 生活成本: 1010, 品质生活: 850 },
    },
    note: "本月有一笔培训费用。",
  },
  {
    month: "2026-08",
    accounts: { familySpendingBalance: 1160, familySavingsBalance: 89100 },
    people: {
      suli: { income: 8800, householdTransfer: 6800, privateKept: 2000 },
      chenqian: { income: 9400, householdTransfer: 7200, privateKept: 2200 },
    },
    expense: {
      autoTotal: 2460,
      confirmedTotal: 2460,
      recordCount: 58,
      categoryBreakdown: { 好好吃饭: 980, 生活成本: 920, 品质生活: 560 },
    },
    note: "家庭支出控制在预算内。",
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
          workProfile: { monthlyIncome: 8800, workHours: 168, commuteHours: 22, workCosts: 450 },
        },
        chenqian: {
          ...state.settings.people.chenqian,
          workProfile: { monthlyIncome: 9400, workHours: 176, commuteHours: 18, workCosts: 500 },
        },
      },
    },
    snapshots: demoSnapshots,
  };
}

function money(value) {
  return moneyFormatter.format(Number(value) || 0).replace("CN¥", "¥");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

function monthLabel(month) {
  const [year, monthNumber] = String(month).split("-");
  return year && monthNumber ? `${year}年${Number(monthNumber)}月` : "未选择月份";
}

function safeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function selectedSnapshot() {
  return state.snapshots.find((item) => item.month === selectedMonth) || null;
}

function sortedSnapshots() {
  return [...state.snapshots].sort((a, b) => a.month.localeCompare(b.month));
}

function calculate(snapshot) {
  const totalIncome = snapshot.people.suli.income + snapshot.people.chenqian.income;
  const totalTransfer = snapshot.people.suli.householdTransfer + snapshot.people.chenqian.householdTransfer;
  const totalPrivateKept = snapshot.people.suli.privateKept + snapshot.people.chenqian.privateKept;
  const expense = snapshot.expense.confirmedTotal;
  const allocationGap = totalIncome - totalTransfer - totalPrivateKept;
  return {
    totalIncome,
    totalTransfer,
    totalPrivateKept,
    expense,
    operatingBalance: totalTransfer - expense,
    transferRate: totalIncome > 0 ? totalTransfer / totalIncome : 0,
    allocationGap,
  };
}

function previousSnapshot(month) {
  const items = sortedSnapshots().filter((item) => item.month < month);
  return items.at(-1) || null;
}

function setText(id, value) {
  const element = byId(id);
  if (element) element.textContent = value;
}

function showToast(message) {
  const toast = byId("toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
}

function applyTheme() {
  const theme = state.settings.theme;
  if (theme === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.dataset.theme = theme;
}

function applyRole() {
  const viewer = state.settings.role === "viewer";
  document.body.classList.toggle("viewer-mode", viewer);
  setText("roleLabel", viewer ? "只读视图" : "管理视图");
  setText("toggleRoleButton", viewer ? "返回管理视图" : "切换为只读预览");
  document.querySelectorAll("#monthlyForm input, #monthlyForm textarea, #monthlyForm button").forEach((element) => {
    element.disabled = viewer;
  });
}

function renderMonthOptions() {
  const options = [...new Set([...state.snapshots.map((item) => item.month), currentMonth])]
    .sort((a, b) => b.localeCompare(a));
  if (!options.includes(selectedMonth)) selectedMonth = options[0] || currentMonth;
  byId("overviewMonthSelect").innerHTML = options
    .map((month) => `<option value="${month}">${monthLabel(month)}</option>`)
    .join("");
  byId("overviewMonthSelect").value = selectedMonth;
}

function adviceFor(snapshot) {
  const metrics = calculate(snapshot);
  const budget = state.settings.monthlyBudget;
  const previous = previousSnapshot(snapshot.month);
  const advice = [];
  if (budget > 0 && metrics.expense <= budget) {
    advice.push(`本月支出比预算少 ${money(budget - metrics.expense)}。先保住这个可持续节奏，不必为了省钱牺牲真正重要的生活。`);
  } else if (budget > 0) {
    advice.push(`本月支出超过预算 ${money(metrics.expense - budget)}。先确认这是一次性大事，还是会重复出现的生活成本。`);
  }
  advice.push(`两人共把收入的 ${Math.round(metrics.transferRate * 100)}% 转入家庭。工资到账后自动转入，能让储蓄先发生。`);

  if (Math.abs(metrics.allocationGap) > 100) {
    advice.push(`工资、家庭转入和当月个人留存之间还有 ${money(Math.abs(metrics.allocationGap))} 的差额。它不一定是错误，但值得确认是否有奖金、还款或其他大额流向。`);
  } else if (previous) {
    const accountDelta = snapshot.accounts.familySavingsBalance
      + snapshot.accounts.familySpendingBalance
      - previous.accounts.familySavingsBalance
      - previous.accounts.familySpendingBalance;
    const expectedDelta = metrics.totalTransfer - metrics.expense;
    const gap = accountDelta - expectedDelta;
    if (Math.abs(gap) > 500) {
      advice.push(`两张家庭卡的余额变化与“转入减支出”相差 ${money(Math.abs(gap))}。可能有卡间转账、未录收入或月末时点差，下月记录时顺手确认。`);
    } else {
      advice.push("家庭卡余额变化与本月转入、支出基本对得上，当前大数记录足够回答家庭经济状况。 ");
    }
  } else {
    advice.push("这是基线月。连续记录三个月后，再用趋势判断预算是否需要调整。 ");
  }
  return advice;
}

function personCard(key, snapshot) {
  const person = snapshot.people[key];
  const configured = state.settings.people[key];
  const alternate = key === "chenqian" ? " alternate" : "";
  const initial = escapeHtml(configured.name.slice(0, 1));
  const name = escapeHtml(configured.name);
  const retainedRate = person.income > 0 ? person.privateKept / person.income : 0;
  const gap = person.income - person.householdTransfer - person.privateKept;
  return `
    <article class="person-card">
      <div class="person-card-header">
        <div class="person-input-title"><span class="avatar${alternate}">${initial}</span><strong>${name}</strong></div>
        <small>留存 ${Math.round(retainedRate * 100)}%</small>
      </div>
      <div class="person-stat-row"><span>到账工资</span><strong>${money(person.income)}</strong></div>
      <div class="person-stat-row"><span>转入家庭</span><strong>${money(person.householdTransfer)}</strong></div>
      <div class="person-stat-row"><span>当月个人留存</span><strong>${money(person.privateKept)}</strong></div>
      <div class="person-stat-row"><span>未分配差额</span><strong>${money(gap)}</strong></div>
    </article>`;
}

function renderOverview() {
  renderMonthOptions();
  const snapshot = selectedSnapshot();
  byId("overviewEmpty").hidden = Boolean(snapshot);
  byId("overviewContent").hidden = !snapshot;
  setText("headerMonthLabel", snapshot ? monthLabel(snapshot.month) : "尚未开始记录");
  if (!snapshot) return;

  const metrics = calculate(snapshot);
  const previous = previousSnapshot(snapshot.month);
  const savingsChange = previous
    ? snapshot.accounts.familySavingsBalance - previous.accounts.familySavingsBalance
    : null;
  const goal = state.settings.savingsGoal;
  const goalPercent = goal > 0 ? Math.min(100, snapshot.accounts.familySavingsBalance / goal * 100) : 0;
  const budget = state.settings.monthlyBudget;
  const budgetUsage = budget > 0 ? metrics.expense / budget * 100 : 0;

  setText("savingsBalance", money(snapshot.accounts.familySavingsBalance));
  setText("savingsChange", savingsChange === null
    ? "首月记录，暂无环比"
    : `较上次${savingsChange >= 0 ? "增加" : "减少"} ${money(Math.abs(savingsChange))}`);
  setText("goalPercent", `${numberFormatter.format(goalPercent)}%`);
  byId("goalProgress").value = goalPercent;
  setText("totalIncome", money(metrics.totalIncome));
  setText("totalTransfer", money(metrics.totalTransfer));
  setText("totalExpense", money(metrics.expense));
  setText("operatingBalance", money(metrics.operatingBalance));
  setText("budgetSummary", `本月预算 ${money(budget)}`);
  setText("budgetUsage", `${numberFormatter.format(budgetUsage)}%`);
  const fill = byId("budgetLineFill");
  fill.style.width = `${Math.min(100, budgetUsage)}%`;
  fill.classList.toggle("over-budget", budgetUsage > 100);
  setText("spendingCardBalance", `花销卡余额 ${money(snapshot.accounts.familySpendingBalance)}`);
  setText("budgetRemaining", budget - metrics.expense >= 0
    ? `预算剩余 ${money(budget - metrics.expense)}`
    : `超出 ${money(metrics.expense - budget)}`);
  byId("peopleGrid").innerHTML = personCard("suli", snapshot) + personCard("chenqian", snapshot);
  byId("adviceList").innerHTML = adviceFor(snapshot)
    .map((item, index) => `<div class="advice-item"><span class="advice-number">${index + 1}</span><p>${item}</p></div>`)
    .join("");
}

function getWorkMetrics(key) {
  const profile = state.settings.people[key].workProfile;
  const hours = profile.workHours + profile.commuteHours;
  const effectiveIncome = Math.max(0, profile.monthlyIncome - profile.workCosts);
  const hourlyRate = hours > 0 ? effectiveIncome / hours : 0;
  const minutesPerTen = hourlyRate > 0 ? 10 / hourlyRate * 60 : 0;
  return { ...profile, hours, effectiveIncome, hourlyRate, minutesPerTen };
}

function lifeCard(key) {
  const metrics = getWorkMetrics(key);
  const person = state.settings.people[key];
  const alternate = key === "chenqian" ? " alternate" : "";
  const name = escapeHtml(person.name);
  const initial = escapeHtml(person.name.slice(0, 1));
  return `
    <article class="life-card">
      <div class="life-card-header">
        <div class="person-input-title"><span class="avatar${alternate}">${initial}</span><strong>${name}</strong></div>
      </div>
      ${metrics.hourlyRate > 0
        ? `<strong>${numberFormatter.format(metrics.minutesPerTen)} 分钟</strong><p>实际时薪 ${money(metrics.hourlyRate)}，已计入工作成本和通勤。</p>`
        : "<strong>待设置</strong><p>填写月薪、工作时长、通勤和工作成本后计算。</p>"}
    </article>`;
}

function getCssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function canvasContext(canvas) {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.round(rect.width * ratio);
  canvas.height = Math.round(rect.height * ratio);
  const context = canvas.getContext("2d");
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, rect.width, rect.height);
  return { context, width: rect.width, height: rect.height };
}

function drawCashflowChart(snapshots) {
  const frame = canvasContext(byId("cashflowChart"));
  if (!frame) return;
  const { context, width, height } = frame;
  const padding = { top: 12, right: 8, bottom: 28, left: 8 };
  const values = snapshots.flatMap((item) => {
    const metrics = calculate(item);
    return [metrics.totalIncome, metrics.totalTransfer, metrics.expense];
  });
  const max = Math.max(...values, 1) * 1.12;
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;
  const groupWidth = plotWidth / snapshots.length;
  const barWidth = Math.min(12, groupWidth / 4.5);
  const colors = [getCssColor("--income"), getCssColor("--transfer"), getCssColor("--expense")];
  context.textAlign = "center";
  context.font = "10px system-ui";
  context.fillStyle = getCssColor("--ink-faint");

  snapshots.forEach((item, index) => {
    const metrics = calculate(item);
    const groupCenter = padding.left + groupWidth * index + groupWidth / 2;
    [metrics.totalIncome, metrics.totalTransfer, metrics.expense].forEach((value, valueIndex) => {
      const barHeight = value / max * plotHeight;
      context.fillStyle = colors[valueIndex];
      context.fillRect(
        groupCenter + (valueIndex - 1) * (barWidth + 2) - barWidth / 2,
        padding.top + plotHeight - barHeight,
        barWidth,
        barHeight,
      );
    });
    context.fillStyle = getCssColor("--ink-faint");
    context.fillText(item.month.slice(5), groupCenter, height - 8);
  });
}

function drawSavingsChart(snapshots) {
  const frame = canvasContext(byId("savingsChart"));
  if (!frame) return;
  const { context, width, height } = frame;
  const padding = { top: 15, right: 12, bottom: 27, left: 12 };
  const values = snapshots.map((item) => item.accounts.familySavingsBalance);
  const minValue = Math.min(...values, 0);
  const maxValue = Math.max(...values, 1);
  const range = Math.max(maxValue - minValue, maxValue * 0.12, 1);
  const x = (index) => snapshots.length === 1
    ? width / 2
    : padding.left + index / (snapshots.length - 1) * (width - padding.left - padding.right);
  const y = (value) => padding.top + (maxValue - value) / range * (height - padding.top - padding.bottom);
  context.beginPath();
  snapshots.forEach((item, index) => {
    if (index === 0) context.moveTo(x(index), y(item.accounts.familySavingsBalance));
    else context.lineTo(x(index), y(item.accounts.familySavingsBalance));
  });
  context.strokeStyle = getCssColor("--accent");
  context.lineWidth = 2.5;
  context.stroke();
  context.fillStyle = getCssColor("--accent");
  snapshots.forEach((item, index) => {
    context.beginPath();
    context.arc(x(index), y(item.accounts.familySavingsBalance), 3.5, 0, Math.PI * 2);
    context.fill();
  });
  context.fillStyle = getCssColor("--ink-faint");
  context.font = "10px system-ui";
  context.textAlign = "center";
  snapshots.forEach((item, index) => context.fillText(item.month.slice(5), x(index), height - 8));
}

function renderCategories(snapshot) {
  const entries = Object.entries(snapshot.expense.categoryBreakdown || {}).sort((a, b) => b[1] - a[1]);
  setText("categoryMonthLabel", monthLabel(snapshot.month));
  if (!entries.length) {
    byId("categoryList").innerHTML = '<p class="life-summary">这个月没有保存钱迹分类汇总。</p>';
    return;
  }
  const total = entries.reduce((sum, [, value]) => sum + value, 0);
  byId("categoryList").innerHTML = entries.map(([category, value]) => {
    const percent = total > 0 ? value / total * 100 : 0;
    return `<div class="category-row">
      <div class="category-copy"><span>${escapeHtml(category)}</span><small>${Math.round(percent)}%</small></div>
      <div class="category-bar"><span style="width:${Math.max(2, percent)}%"></span></div>
      <strong>${money(value)}</strong>
    </div>`;
  }).join("");
}

function renderTrends() {
  const snapshots = sortedSnapshots().slice(-12);
  const hasData = snapshots.length > 0;
  byId("trendsEmpty").hidden = hasData;
  byId("trendsContent").hidden = !hasData;
  if (!hasData) return;

  const latest = snapshots.at(-1);
  const first = snapshots[0];
  const change = latest.accounts.familySavingsBalance - first.accounts.familySavingsBalance;
  const goal = state.settings.savingsGoal;
  const goalPercent = goal > 0 ? latest.accounts.familySavingsBalance / goal * 100 : 0;
  setText("trendSavingsCopy", snapshots.length === 1
    ? "当前只有一个基线月"
    : `${monthLabel(first.month)}至今${change >= 0 ? "增加" : "减少"} ${money(Math.abs(change))}`);
  setText("trendGoalPercent", `目标 ${numberFormatter.format(goalPercent)}%`);
  byId("lifeGrid").innerHTML = lifeCard("suli") + lifeCard("chenqian");

  const suli = getWorkMetrics("suli");
  const chenqian = getWorkMetrics("chenqian");
  const totalHours = suli.hours + chenqian.hours;
  const totalEffectiveIncome = suli.effectiveIncome + chenqian.effectiveIncome;
  const familyHourlyRate = totalHours > 0 ? totalEffectiveIncome / totalHours : 0;
  const expenseLifeHours = familyHourlyRate > 0 ? latest.expense.confirmedTotal / familyHourlyRate : 0;
  setText("lifeSummary", familyHourlyRate > 0
    ? `${monthLabel(latest.month)}的家庭支出 ${money(latest.expense.confirmedTotal)}，约等于两人合计 ${numberFormatter.format(expenseLifeHours)} 小时的生命能量。这个数字用于判断支出是否值得，不是制造内疚。`
    : "完成两人的工作时间设置后，系统会把家庭支出换算为生命时间。 ");
  renderCategories(latest);
  requestAnimationFrame(() => {
    drawCashflowChart(snapshots);
    drawSavingsChart(snapshots);
  });
}

function fillSnapshotForm(month) {
  const snapshot = state.snapshots.find((item) => item.month === month);
  byId("monthInput").value = month;
  const fields = snapshot ? {
    familySpendingBalanceInput: snapshot.accounts.familySpendingBalance,
    familySavingsBalanceInput: snapshot.accounts.familySavingsBalance,
    suliIncomeInput: snapshot.people.suli.income,
    suliTransferInput: snapshot.people.suli.householdTransfer,
    suliPrivateKeptInput: snapshot.people.suli.privateKept,
    chenqianIncomeInput: snapshot.people.chenqian.income,
    chenqianTransferInput: snapshot.people.chenqian.householdTransfer,
    chenqianPrivateKeptInput: snapshot.people.chenqian.privateKept,
    familyExpenseConfirmedInput: snapshot.expense.confirmedTotal,
    noteInput: snapshot.note,
  } : {
    familySpendingBalanceInput: "",
    familySavingsBalanceInput: "",
    suliIncomeInput: "",
    suliTransferInput: "",
    suliPrivateKeptInput: "",
    chenqianIncomeInput: "",
    chenqianTransferInput: "",
    chenqianPrivateKeptInput: "",
    familyExpenseConfirmedInput: "",
    noteInput: "",
  };
  Object.entries(fields).forEach(([id, value]) => { byId(id).value = value; });
  setText("noteCount", String(byId("noteInput").value.length));
  uploadedSummary = snapshot ? {
    total: snapshot.expense.autoTotal,
    matchedRows: snapshot.expense.recordCount,
    categoryBreakdown: snapshot.expense.categoryBreakdown,
    sourceFileName: snapshot.expense.sourceFileName,
    sourceMonths: snapshot.expense.sourceMonths,
    importedAt: snapshot.expense.importedAt,
  } : null;
  renderUploadResult();
}

function renderUploadResult(error = "") {
  const element = byId("uploadResult");
  element.classList.toggle("error", Boolean(error));
  if (error) {
    element.textContent = error;
    element.hidden = false;
  } else if (uploadedSummary?.sourceFileName) {
    const categories = Object.entries(uploadedSummary.categoryBreakdown || {})
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([category, amount]) => `${escapeHtml(category)} ${money(amount)}`)
      .join("、");
    const countCopy = uploadedSummary.matchedRows ? `${uploadedSummary.matchedRows} 笔，` : "";
    element.innerHTML = `已汇总 ${escapeHtml(uploadedSummary.sourceFileName)}：${countCopy}${money(uploadedSummary.total)}${categories ? `<br>前三类：${categories}` : ""}<br>原始流水不会保存。`;
    element.hidden = false;
  } else {
    element.hidden = true;
    element.textContent = "";
  }
}

function switchPage(page) {
  if (!new Set(["overview", "entry", "trends"]).has(page)) return;
  currentPage = page;
  document.querySelectorAll(".page").forEach((element) => {
    element.classList.toggle("active", element.dataset.page === page);
  });
  document.querySelectorAll(".nav-button").forEach((element) => {
    element.classList.toggle("active", element.dataset.pageTarget === page);
  });
  if (page === "entry") fillSnapshotForm(selectedMonth);
  if (page === "trends") renderTrends();
  window.scrollTo({ top: 0, behavior: "smooth" });
}

function fillSettingsForm() {
  const { settings } = state;
  byId("monthlyBudgetInput").value = settings.monthlyBudget;
  byId("savingsGoalInput").value = settings.savingsGoal;
  byId("suliNameInput").value = settings.people.suli.name;
  byId("chenqianNameInput").value = settings.people.chenqian.name;
  byId("themeInput").value = settings.theme;
  ["suli", "chenqian"].forEach((key) => {
    const prefix = key === "suli" ? "suli" : "chenqian";
    const profile = settings.people[key].workProfile;
    byId(`${prefix}WorkIncomeInput`).value = profile.monthlyIncome;
    byId(`${prefix}WorkHoursInput`).value = profile.workHours;
    byId(`${prefix}CommuteHoursInput`).value = profile.commuteHours;
    byId(`${prefix}WorkCostsInput`).value = profile.workCosts;
  });
}

function settingsFromForm() {
  return {
    ...state.settings,
    monthlyBudget: safeNumber(byId("monthlyBudgetInput").value),
    savingsGoal: safeNumber(byId("savingsGoalInput").value),
    theme: byId("themeInput").value,
    people: {
      suli: {
        name: byId("suliNameInput").value.trim() || "酥梨",
        workProfile: {
          monthlyIncome: safeNumber(byId("suliWorkIncomeInput").value),
          workHours: safeNumber(byId("suliWorkHoursInput").value),
          commuteHours: safeNumber(byId("suliCommuteHoursInput").value),
          workCosts: safeNumber(byId("suliWorkCostsInput").value),
        },
      },
      chenqian: {
        name: byId("chenqianNameInput").value.trim() || "陈前",
        workProfile: {
          monthlyIncome: safeNumber(byId("chenqianWorkIncomeInput").value),
          workHours: safeNumber(byId("chenqianWorkHoursInput").value),
          commuteHours: safeNumber(byId("chenqianCommuteHoursInput").value),
          workCosts: safeNumber(byId("chenqianWorkCostsInput").value),
        },
      },
    },
  };
}

async function handleCsvUpload(file) {
  try {
    renderUploadResult("正在读取钱迹账单…");
    byId("uploadResult").classList.remove("error");
    uploadedSummary = await summarizeQianjiFile(file, byId("monthInput").value);
    byId("familyExpenseConfirmedInput").value = uploadedSummary.total;
    renderUploadResult();
    showToast(`已汇总 ${uploadedSummary.matchedRows} 笔有效支出`);
  } catch (error) {
    uploadedSummary = null;
    renderUploadResult(error.message);
  }
}

function snapshotFromForm() {
  const month = byId("monthInput").value;
  const existing = state.snapshots.find((item) => item.month === month);
  const expenseSource = uploadedSummary || existing?.expense || {};
  return {
    month,
    accounts: {
      familySpendingBalance: safeNumber(byId("familySpendingBalanceInput").value),
      familySavingsBalance: safeNumber(byId("familySavingsBalanceInput").value),
    },
    people: {
      suli: {
        income: safeNumber(byId("suliIncomeInput").value),
        householdTransfer: safeNumber(byId("suliTransferInput").value),
        privateKept: safeNumber(byId("suliPrivateKeptInput").value),
      },
      chenqian: {
        income: safeNumber(byId("chenqianIncomeInput").value),
        householdTransfer: safeNumber(byId("chenqianTransferInput").value),
        privateKept: safeNumber(byId("chenqianPrivateKeptInput").value),
      },
    },
    expense: {
      autoTotal: safeNumber(expenseSource.total ?? expenseSource.autoTotal),
      confirmedTotal: safeNumber(byId("familyExpenseConfirmedInput").value),
      recordCount: safeNumber(expenseSource.matchedRows ?? expenseSource.recordCount),
      categoryBreakdown: expenseSource.categoryBreakdown || {},
      sourceFileName: expenseSource.sourceFileName || "",
      sourceMonths: expenseSource.sourceMonths || [],
      importedAt: expenseSource.importedAt || "",
    },
    note: byId("noteInput").value.trim(),
    createdAt: existing?.createdAt,
  };
}

function validateMonthlyForm() {
  const required = [...byId("monthlyForm").querySelectorAll("[required]")];
  if (!required.every((element) => element.value !== "" && element.checkValidity())) {
    required.find((element) => !element.value || !element.checkValidity())?.focus();
    showToast("请把本月的大数填写完整");
    return false;
  }
  return true;
}

function downloadFile(content, fileName, type) {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

function bindEvents() {
  document.querySelectorAll(".nav-button").forEach((button) => {
    button.addEventListener("click", () => switchPage(button.dataset.pageTarget));
  });
  document.querySelectorAll("[data-go]").forEach((button) => {
    button.addEventListener("click", () => switchPage(button.dataset.go));
  });
  byId("overviewMonthSelect").addEventListener("change", (event) => {
    selectedMonth = event.target.value;
    renderOverview();
  });
  byId("monthInput").addEventListener("change", (event) => {
    selectedMonth = event.target.value || currentMonth;
    fillSnapshotForm(selectedMonth);
  });
  byId("noteInput").addEventListener("input", (event) => setText("noteCount", String(event.target.value.length)));
  byId("qianjiFileInput").addEventListener("change", (event) => handleCsvUpload(event.target.files[0]));
  byId("resetFormButton").addEventListener("click", () => {
    if (!confirm(`清空 ${monthLabel(byId("monthInput").value)} 尚未保存的输入吗？`)) return;
    byId("monthlyForm").reset();
    byId("monthInput").value = selectedMonth;
    uploadedSummary = null;
    renderUploadResult();
    setText("noteCount", "0");
  });
  byId("monthlyForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (state.settings.role === "viewer" || !validateMonthlyForm()) return;
    const candidate = snapshotFromForm();
    const existing = state.snapshots.find((item) => item.month === candidate.month);
    if (existing && !confirm(`${monthLabel(candidate.month)}已有记录，确定用当前内容覆盖吗？`)) return;
    state = upsertSnapshot(state, candidate);
    demoMode = false;
    selectedMonth = byId("monthInput").value;
    renderAll();
    switchPage("overview");
    showToast(`${monthLabel(selectedMonth)}已保存`);
  });

  byId("settingsButton").addEventListener("click", () => {
    fillSettingsForm();
    byId("settingsDialog").showModal();
  });
  byId("settingsForm").addEventListener("submit", (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      byId("settingsDialog").close();
      return;
    }
    if (state.settings.role === "viewer") return;
    state = saveSettings(state, settingsFromForm());
    demoMode = false;
    applyTheme();
    renderAll();
    byId("settingsDialog").close();
    showToast("家庭设置已保存");
  });
  byId("toggleRoleButton").addEventListener("click", () => {
    state.settings.role = state.settings.role === "manager" ? "viewer" : "manager";
    if (!demoMode) state = saveSettings(state, state.settings);
    applyRole();
    byId("settingsDialog").close();
    showToast(state.settings.role === "viewer" ? "已进入只读预览" : "已返回管理视图");
  });
  byId("themeInput").addEventListener("change", (event) => {
    const before = state.settings.theme;
    state.settings.theme = event.target.value;
    applyTheme();
    state.settings.theme = before;
  });
  byId("exportButton").addEventListener("click", () => {
    downloadFile(exportState(state), `家庭月度驾驶舱备份_${currentMonth}.json`, "application/json;charset=utf-8");
    showToast("备份已导出");
  });
  byId("importBackupInput").addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      state = importState(await file.text());
      demoMode = false;
      selectedMonth = state.snapshots.at(-1)?.month || currentMonth;
      applyTheme();
      applyRole();
      renderAll();
      byId("settingsDialog").close();
      showToast("备份已导入");
    } catch (error) {
      showToast(error.message);
    } finally {
      event.target.value = "";
    }
  });
  byId("clearDataButton").addEventListener("click", () => {
    if (!confirm("确定清空这台设备上的全部月度记录和设置吗？请先导出备份。")) return;
    state = clearState();
    demoMode = false;
    selectedMonth = currentMonth;
    applyTheme();
    applyRole();
    renderAll();
    byId("settingsDialog").close();
    showToast("本机数据已清空");
  });
  byId("installButton").addEventListener("click", async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    byId("installButton").hidden = true;
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferredInstallPrompt = event;
    byId("installButton").hidden = false;
  });
  window.addEventListener("resize", () => {
    if (currentPage === "trends") renderTrends();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.settings.theme === "system" && currentPage === "trends") renderTrends();
  });
}

function renderNames() {
  setText("suliFormName", state.settings.people.suli.name);
  setText("chenqianFormName", state.settings.people.chenqian.name);
}

function renderAll() {
  renderNames();
  renderOverview();
  renderTrends();
  fillSnapshotForm(selectedMonth);
  applyRole();
}

async function registerServiceWorker() {
  if (!("serviceWorker" in navigator)) return;
  try {
    await navigator.serviceWorker.register("./sw.js");
  } catch (error) {
    console.warn("离线缓存注册失败", error);
  }
}

withDemoData();
applyTheme();
bindEvents();
renderAll();
registerServiceWorker();
