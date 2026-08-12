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
let syncDirty = false;          // 本地有未同步的修改
let syncStatusTimer = null;     // 定时检查云端连通性
const cloudApiBase = String(window.FAMILY_FINANCE_API_BASE || "").replace(/\/$/, "");
const cloudTokenKey = "family-finance-cloud-session";

function cloudUrl(path) { return `${cloudApiBase}${path}`; }
function readCloudToken() { return localStorage.getItem(cloudTokenKey) || ""; }
function clearCloudToken() { localStorage.removeItem(cloudTokenKey); }

function money(v) { return moneyFmt.format(Number(v) || 0).replace("CN¥", "¥"); }
function num(v) { return numFmt.format(Number(v) || 0); }
function esc(v) { return String(v).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[c]); }
function safeNum(v) { const n = Number(v); return Number.isFinite(n) && n >= 0 ? n : 0; }
function monthLabel(m) { const [y, mn] = String(m).split("-"); return y && mn ? `${y}年${Number(mn)}月` : "未选择月份"; }
function sortedSnapshots() { return [...state.snapshots].sort((a, b) => a.month.localeCompare(b.month)); }
function setText(id, v) { const el = byId(id); if (el) el.textContent = v; }

function showToast(msg, type) {
  const t = byId("toast"); clearTimeout(toastTimer);
  t.textContent = msg; t.hidden = false;
  t.className = "toast" + (type ? " " + type : "");
  toastTimer = setTimeout(() => { t.hidden = true; }, 3200);
}

// 同步状态指示器：synced | pending | offline | local
function updateSyncStatus(status) {
  const el = byId("syncStatus");
  if (!el) return;
  const map = {
    synced:  ["🟢 已同步", "synced"],
    pending: ["🟡 未同步", "pending"],
    offline: ["🔴 离线",   "offline"],
    local:   ["⚪ 仅本地", "local"],
  };
  const entry = map[status] || map.local;
  el.textContent = entry[0];
  el.className = "sync-status " + entry[1];
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

async function syncCloudState(retriesLeft) {
  if (!cloudMode || !cloudAdapter) return;
  const maxRetries = retriesLeft !== undefined ? retriesLeft : 3;
  try {
    state = await cloudAdapter.save(state);
    showToast("已同步到家庭云端", "success");
    syncDirty = false;
    updateSyncStatus("synced");
  } catch (error) {
    if (error.status === 409) {
      showToast("云端已被更新，正在自动合并…", "warning");
      try {
        // ETag 过期：重置 adapter 的缓存 etag，重新拉取
        cloudAdapter.etag = "";
        const fresh = await cloudAdapter.load();
        const mergedMap = new Map(fresh.snapshots.map(s => [s.month, s]));
        for (const localSnap of state.snapshots) {
          mergedMap.set(localSnap.month, localSnap);
        }
        fresh.snapshots = [...mergedMap.values()].sort((a, b) => a.month.localeCompare(b.month));
        state = await cloudAdapter.save(fresh);
        showToast("已自动合并并同步到云端", "success");
        syncDirty = false;
        updateSyncStatus("synced");
      } catch (retryErr) {
        // 二次 409：最后兜底 —— 完全重置后重试一次
        if (retryErr.status === 409 && maxRetries > 0) {
          showToast("合并冲突，再次尝试…", "syncing");
          cloudAdapter.etag = "";
          await new Promise(r => setTimeout(r, 1000));
          try { await syncCloudState(maxRetries - 1); return; } catch { /* fall through */ }
        }
        showToast("合并失败，请稍后重新保存", "error");
        syncDirty = true;
        updateSyncStatus("pending");
      }
    } else if (maxRetries > 0 && (error.message === "Failed to fetch" || error.message === "NetworkError" || (error.status && error.status >= 500))) {
      // 网络错误或服务端错误：指数退避重试
      const delay = Math.pow(2, 4 - maxRetries) * 1000; // 1s → 2s → 4s
      showToast("云端同步失败，" + (delay / 1000) + "秒后重试（" + maxRetries + "次剩余）", "syncing");
      await new Promise(r => setTimeout(r, delay));
      try {
        await syncCloudState(maxRetries - 1);
      } catch {
        syncDirty = true;
        updateSyncStatus("pending");
        showToast("本机已保存，云端同步失败：请检查网络后重试", "error");
      }
    } else {
      syncDirty = true;
      updateSyncStatus("pending");
      showToast("本机已保存，云端同步失败：" + (error.message || "网络异常"), "error");
    }
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
    const cloudState = await cloudAdapter.load();
    // 合并策略：云端有数据 + 本地有数据 → 按月份合并（本地优先）
    if (state.snapshots.length > 0) {
      const mergedMap = new Map(cloudState.snapshots.map(s => [s.month, s]));
      for (const localSnap of state.snapshots) {
        mergedMap.set(localSnap.month, localSnap);
      }
      cloudState.snapshots = [...mergedMap.values()].sort((a, b) => a.month.localeCompare(b.month));
      state = cloudState;
      saveSettings(state, state.settings);
      showToast("本地与云端已合并（月份重复时本地优先）", "warning");
    } else {
      // 本地无数据 → 直接用云端数据
      state = cloudState;
      saveSettings(state, state.settings);
      updateSyncStatus("synced");
    }
  } catch (error) {
    if (error.status !== 404) throw error;
    // 云端空 + 本地有数据 → 上传本地到云端（而非覆盖本地）
    if (state.snapshots.length > 0) {
      state = await cloudAdapter.save(state);
      saveSettings(state, state.settings);
      showToast("已将本地数据上传为家庭第一份云端账本", "success");
      updateSyncStatus("synced");
    } else {
      if (cloudSession.role !== "manager") {
        throw new Error("家庭云端账本尚未初始化，请由管理者先登录并上传第一份数据");
      }
      // 本地也无数据，保持默认空状态（云端已经 404，无需额外操作）
      showToast("云端尚未初始化，录入数据后会自动上传", "warning");
      syncDirty = false;
      updateSyncStatus("synced");
    }
    return; // 不要继续往下抛异常，404 已经处理好了
  }
  setCloudRole(cloudSession.role);
  selectedMonth = sortedSnapshots().at(-1)?.month || currentMonth;
  syncDirty = false;
}

async function setupCloudMode() {
  if (!cloudApiBase || ["127.0.0.1", "localhost"].includes(location.hostname)) {
    updateSyncStatus("local");
    return;
  }
  try {
    const health = await fetch(cloudUrl("/api/health"));
    if (!health.ok) { updateSyncStatus("local"); return; }
  } catch {
    updateSyncStatus("offline");
    showToast("云端服务不可达，仅本地模式运行", "warning");
    return;
  }
  const token = readCloudToken();
  if (!token) { updateSyncStatus("local"); openCloudLogin(); return; }
  cloudAdapter = new RemoteStateAdapter(cloudApiBase, token);
  const sessionResponse = await fetch(cloudUrl("/api/session"), { headers: { Authorization: `Bearer ${token}` } });
  if (sessionResponse.ok) {
    cloudSession = await sessionResponse.json();
    cloudMode = true;
    try {
      await loadCloudStateAfterLogin();
    } catch (error) {
      updateSyncStatus("local");
      openCloudLogin(error.message);
    }
  } else {
    clearCloudToken();
    cloudAdapter = null;
    cloudMode = false;
    updateSyncStatus("local");
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
  else if (pageName === "settings") { renderSettingsPage(); setText("headerMonthLabel", "家庭设置"); }
  else if (pageName === "enjoy") { renderEnjoy(); setText("headerMonthLabel", "享福"); }
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

// ---- 二级分类明细渲染 ----
function renderSubcategoryDetail(containerId, subBreakdown, catBreakdown) {
  const el = byId(containerId);
  if (!el) return;
  if (!subBreakdown || Object.keys(subBreakdown).length === 0) {
    el.innerHTML = '<p style="color:var(--ink-faint);font-size:0.74rem;">暂无二级分类数据。请确认钱迹导出包含"二级分类"列。</p>';
    return;
  }
  const total = catBreakdown ? Object.values(catBreakdown).reduce((a, b) => a + b, 0) : 1;
  let html = "";
  for (const [cat, subs] of Object.entries(subBreakdown)) {
    if (!subs || Object.keys(subs).length === 0) continue;
    const catAmt = catBreakdown?.[cat] || 0;
    html += '<div style="margin-bottom:0.4rem;"><strong style="font-size:0.72rem;">' + esc(cat) + ' · ' + money(catAmt) + '</strong></div>';
    const subTotal = Object.values(subs).reduce((a, b) => a + b, 0);
    html += Object.entries(subs).map(([sub, amt]) => {
      const pct = Math.round(amt / subTotal * 100);
      return '<div class="category-row" style="padding-left:0.5rem;margin-bottom:0.12rem;">' +
        '<span style="font-size:0.68rem;color:var(--ink-soft);width:7rem;">' + esc(sub) + '</span>' +
        '<div class="category-bar" style="flex:1;"><span style="width:' + pct + '%;background:var(--accent-soft);"></span></div>' +
        '<span style="font-family:var(--font-number);font-size:0.7rem;white-space:nowrap;">' + money(amt) + ' (' + pct + '%)</span></div>';
    }).join("");
    html += '<div style="height:0.3rem;"></div>';
  }
  el.innerHTML = html;
}

// ---- AI 智能诊断（基于CSV数据，不做武断判断）----
function renderAIDiagnosis(sn, hourlyRate) {
  const el = byId("analysisAIDiagnosis");
  if (!el) return;
  const cats = sn.expense.categoryBreakdown || {};
  const subCats = sn.expense.subcategoryBreakdown || {};
  const total = Object.values(cats).reduce((a, b) => a + b, 0);
  const diagnoses = [];

  // 1. 找出占比最高的二级分类（它在哪个一级分类下贡献最大）
  const topSubs = [];
  for (const [cat, subs] of Object.entries(subCats)) {
    for (const [sub, amt] of Object.entries(subs)) {
      topSubs.push({ cat, sub, amt, pct: amt / total * 100 });
    }
  }
  topSubs.sort((a, b) => b.amt - a.amt);
  const top3Subs = topSubs.slice(0, 3);
  if (top3Subs.length > 0) {
    diagnoses.push('🔍 <strong>支出前三小类：</strong>' +
      top3Subs.map(s => esc(s.sub) + ' ' + money(s.amt) + '（' + numFmt.format(s.pct) + '%）').join(' · '));
  }

  // 2. 对占比超过30%的一级分类做二级拆解
  for (const [cat, amt] of Object.entries(cats)) {
    const pct = amt / total * 100;
    if (pct > 30) {
      const subs = subCats[cat] || {};
      const subEntries = Object.entries(subs).sort((a, b) => b[1] - a[1]).slice(0, 3);
      if (subEntries.length > 0) {
        const subDetails = subEntries.map(([s, v]) => esc(s) + ' ' + money(v)).join(' · ');
        diagnoses.push('📊 <strong>' + esc(cat) + '</strong> 占 ' + numFmt.format(pct) + '%——主要花在：' + subDetails);
      } else {
        diagnoses.push('📊 <strong>' + esc(cat) + '</strong> 占 ' + numFmt.format(pct) + '%——暂无二级分类明细，建议在钱迹里细化分类');
      }
    }
  }

  // 3. 同比上月
  const [y, m] = sn.month.split("-").map(Number);
  const prevM = m - 1 > 0 ? m - 1 : 12;
  const prevY = m - 1 > 0 ? y : y - 1;
  const prevMonth = prevY + "-" + String(prevM).padStart(2, "0");
  const prevSn = state.snapshots.find(s => s.month === prevMonth);
  if (prevSn && prevSn.expense.confirmedTotal > 0) {
    const prevTotal = prevSn.expense.confirmedTotal;
    const delta = total - prevTotal;
    const deltaPct = prevTotal > 0 ? delta / prevTotal * 100 : 0;
    const dir = delta >= 0 ? "增加" : "减少";
    diagnoses.push('📈 相比上月（' + monthLabel(prevMonth) + '）：支出' + dir + '了 ' + money(Math.abs(delta)) + '（' + numFmt.format(Math.abs(deltaPct)) + '%）');

    // 变化>5%的分类
    const allCats = new Set([...Object.keys(cats), ...Object.keys(prevSn.expense.categoryBreakdown || {})]);
    for (const cat of allCats) {
      const cur = cats[cat] || 0;
      const prev = (prevSn.expense.categoryBreakdown || {})[cat] || 0;
      if (Math.abs(cur - prev) > Math.max(total * 0.05, 200)) {
        const d = cur - prev;
        diagnoses.push('  → ' + esc(cat) + '：' + money(prev) + ' → ' + money(cur) + '（' + (d >= 0 ? '↑' : '↓') + money(Math.abs(d)) + '）');
      }
    }
  }

  // 4. 同比去年同月
  const lyMonth = (y - 1) + "-" + String(m).padStart(2, "0");
  const lySn = state.snapshots.find(s => s.month === lyMonth);
  if (lySn && lySn.expense.confirmedTotal > 0) {
    const lyTotal = lySn.expense.confirmedTotal;
    const delta = total - lyTotal;
    const deltaPct = lyTotal > 0 ? delta / lyTotal * 100 : 0;
    diagnoses.push('🗓 相比去年同月（' + monthLabel(lyMonth) + '）：支出' + (delta >= 0 ? '增加' : '减少') + '了 ' + money(Math.abs(delta)) + '（' + numFmt.format(Math.abs(deltaPct)) + '%）');
  }

  // 5. 生命时间
  if (hourlyRate > 0) {
    const lifeHr = total / hourlyRate;
    diagnoses.push('⏳ 本月支出换走约 <strong>' + numFmt.format(lifeHr) + ' 小时</strong>生命时间（≈' + numFmt.format(lifeHr / 8) + ' 个工作日）');
  }

  if (diagnoses.length === 0) diagnoses.push("✅ 暂无足够数据进行分析。至少需要一个月的数据。");

  el.innerHTML = diagnoses.map(d => '<div class="advice-item"><span class="advice-number">💡</span><p style="font-size:0.76rem;line-height:1.55;">' + d + '</p></div>').join("");
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
  setText("budgetActual", `实际 ${money(m.expense)}`);
  setText("budgetRemaining", `${m.expense > budget ? "超出" : "剩余"} ${money(Math.max(0, budget - m.expense))}`);

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

// 累进转入计算（协议第2.2条）
function calcTransferRule(income) {
  const i = Number(income) || 0;
  if (i <= 10000) return { transfer: Math.round(i * 0.8 * 100) / 100, rate: 80 };
  if (i <= 20000) return { transfer: Math.round((8000 + (i - 10000) * 0.9) * 100) / 100, rate: 90 };
  if (i <= 30000) return { transfer: Math.round((17000 + (i - 20000) * 0.95) * 100) / 100, rate: 95 };
  return { transfer: Math.round((26500 + (i - 30000) * 0.98) * 100) / 100, rate: 98 };
}

function autoFillTransfers() {
  const suliIncome = safeNum(byId("suliIncome")?.value);
  const chenqianIncome = safeNum(byId("chenqianIncome")?.value);
  if (suliIncome > 0) {
    const r = calcTransferRule(suliIncome);
    byId("suliTransfer").value = r.transfer;
    byId("suliKept").value = Math.round((suliIncome - r.transfer) * 100) / 100;
  }
  if (chenqianIncome > 0) {
    const r = calcTransferRule(chenqianIncome);
    byId("chenqianTransfer").value = r.transfer;
    byId("chenqianKept").value = Math.round((chenqianIncome - r.transfer) * 100) / 100;
  }
}
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
    if (snap.expense.rawCsvBase64) {
      byId("csvUploadResult").hidden = false;
      byId("csvUploadResult").className = "upload-result";
      byId("csvUploadResult").innerHTML = '已存档原始CSV：' + esc(snap.expense.sourceFileName || "未知文件") + '<br><small style="color:var(--ink-faint)">点击上传可覆盖</small>';
    }
    // 恢复旅游标记
    const legs = snap.travel?.legs || [{ start: snap.travel?.start || "", end: snap.travel?.end || "", dest: snap.travel?.dest || "" }];
    restoreTravelLegs(legs);
    setText("headerMonthLabel", "编辑已有记录");
  } else {
    ["spendingBalance","savingsBalanceEntry","suliIncome","suliTransfer","suliKept","chenqianIncome","chenqianTransfer","chenqianKept","confirmedExpense","monthlyNote"].forEach(id => {
      const el = byId(id);
      if (el) { if (el.tagName === "TEXTAREA") el.value = ""; else el.value = ""; }
    });
    restoreTravelLegs([{ start: "", end: "", dest: "" }]);
    setText("headerMonthLabel", "新建月度记录");
  }
}

function showCsvResult(snap) {
  const el = byId("csvUploadResult");
  el.hidden = false;
  el.className = "upload-result";
  const cats = snap.expense.categoryBreakdown || {};
  const top3 = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${money(v)}`).join(" · ");
  el.innerHTML = `已解析 ${snap.expense.sourceFileName || ""}<br>${snap.expense.recordCount} 笔 · 合计 ${money(snap.expense.confirmedTotal)}<br>${top3 || "无分类数据"}${snap.expense.rawCsvBase64 ? '<br><small style="color:var(--ink-faint)">原始CSV已存档</small>' : ''}`;
  byId("confirmedExpense").value = snap.expense.confirmedTotal;
}

async function handleCsvUpload(file) {
  // 立即反馈
  const el = byId("csvUploadResult");
  el.hidden = false;
  el.className = "upload-result";
  el.innerHTML = `<em>正在解析 ${file.name}…</em>`;

  try {
    const summary = await summarizeQianjiFile(file, selectedMonth);
    uploadedSummary = summary;

    // 保存原始CSV base64
    const rawBuffer = await file.arrayBuffer();
    const rawBase64 = btoa(String.fromCharCode(...new Uint8Array(rawBuffer)));
    uploadedSummary.rawCsvBase64 = rawBase64;
    uploadedSummary.rawCsvFileName = file.name;

    const cats = summary.categoryBreakdown || {};
    const total = Object.values(cats).reduce((a, b) => a + b, 0) || 0;
    const top3 = Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${k} ${money(v)}`).join(" · ");
    const pctStr = summary.skippedRows > 0 ? `（跳过 ${summary.skippedRows} 条收入/退款/其他月份）` : "";

    el.className = "upload-result";
    el.innerHTML = `✅ ${file.name}<br>${summary.matchedRows} 笔有效支出 · 合计 <strong>${money(summary.total)}</strong><br>${top3 || "无分类数据"}${pctStr ? '<br>' + pctStr : ''}`;
    byId("confirmedExpense").value = summary.total;
    showToast(`CSV解析完成：${summary.matchedRows} 笔 · ${money(summary.total)}`, "success");
  } catch (err) {
    el.className = "upload-result error";
    el.innerHTML = `❌ ${file.name}<br>${err.message}<br><small>请确认文件是钱迹导出的有效CSV，且包含目标月份的支出记录。</small>`;
    uploadedSummary = null;
  }
}

async function saveSnapshot(e) {
  e.preventDefault();
  const month = byId("entryMonth").value;
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) { showToast("月份格式不正确", "error"); return; }
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
      subcategoryBreakdown: uploadedSummary?.subcategoryBreakdown || (existing?.expense?.subcategoryBreakdown || {}),
      sourceFileName: uploadedSummary?.sourceFileName || (existing?.expense?.sourceFileName || ""),
      sourceMonths: uploadedSummary?.sourceMonths || (existing?.expense?.sourceMonths || []),
      importedAt: uploadedSummary?.importedAt || (existing?.expense?.importedAt || ""),
      rawCsvBase64: uploadedSummary?.rawCsvBase64 || (existing?.expense?.rawCsvBase64 || ""),
      rawCsvFileName: uploadedSummary?.rawCsvFileName || (existing?.expense?.rawCsvFileName || ""),
    },
    travel: {
      legs: collectTravelLegs(),
    },
    note: (byId("monthlyNote").value || "").trim().slice(0, 200),
  };

  state = upsertSnapshot(state, snap);
  syncDirty = true;
  let synced = false;
  try { await syncCloudState(); synced = true; } catch { /* syncCloudState 已 toast */ }
  if (synced) showToast(`${monthLabel(month)} 已保存`, "success");
  else showToast(`${monthLabel(month)} 已保存到本机（云端未同步）`, "warning");
  navigateTo("overview");
}

async function deleteSnapshot() {
  const month = byId("entryMonth").value;
  if (!state.snapshots.find(s => s.month === month)) { showToast("该月份没有记录", "warning"); return; }
  if (!confirm(`确定删除 ${monthLabel(month)} 记录？`)) return;
  state = { ...state, snapshots: state.snapshots.filter(s => s.month !== month), metadata: { ...state.metadata, updatedAt: new Date().toISOString() } };
  state = saveSettings(state, state.settings);
  syncDirty = true;
  try { await syncCloudState(); } catch { return; }
  showToast(`${monthLabel(month)} 已删除`, "success");
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

  // 二级分类明细
  renderSubcategoryDetail("analysisSubcategoryList", sn.expense.subcategoryBreakdown, sn.expense.categoryBreakdown);
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

  // AI 诊断
  renderAIDiagnosis(sn, fm.familyHourlyRate);

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
  byId("summaryAdviceList").innerHTML = adv.map((a, i) => '<div class="advice-item"><span class="advice-number">' + (i + 1) + '</span><p>' + esc(a) + '</p></div>').join("");
}

// ---- 享福辅助函数 ----
function collectTravelLegs() {
  const starts = document.querySelectorAll(".travel-start");
  const ends = document.querySelectorAll(".travel-end");
  const dests = document.querySelectorAll(".travel-dest");
  const legs = [];
  for (let i = 0; i < starts.length; i++) {
    const s = (starts[i]?.value || "").trim();
    const e = (ends[i]?.value || "").trim();
    const d = (dests[i]?.value || "").trim().slice(0, 60);
    if (s || e || d) legs.push({ start: s, end: e, dest: d });
  }
  return legs;
}

function restoreTravelLegs(legs) {
  const container = byId("travelLegsContainer");
  if (!container) return;
  const existing = container.querySelectorAll(".travel-leg");
  existing.forEach((el, i) => { if (i > 0) el.remove(); });
  const valid = (legs || []).filter(l => l.start || l.end || l.dest);
  const data = valid.length ? valid : [{ start: "", end: "", dest: "" }];
  data.forEach((leg, i) => {
    if (i === 0) {
      const first = existing[0];
      if (first) {
        first.querySelector(".travel-start").value = leg.start || "";
        first.querySelector(".travel-end").value = leg.end || "";
        first.querySelector(".travel-dest").value = leg.dest || "";
      }
    } else {
      addTravelLegRow(leg);
    }
  });
}

function addTravelLegRow(leg) {
  const container = byId("travelLegsContainer");
  if (!container) return;
  const row = document.createElement("div");
  row.className = "travel-leg";
  row.style.cssText = "display:grid;grid-template-columns:1fr 1fr 1fr auto;gap:0.4rem;align-items:end;margin-bottom:0.4rem;";
  row.innerHTML =
    '<div class="field"><input type="date" class="travel-start" value="' + esc(leg?.start || "") + '" aria-label="旅游开始日期"></div>' +
    '<div class="field"><input type="date" class="travel-end" value="' + esc(leg?.end || "") + '" aria-label="旅游结束日期"></div>' +
    '<div class="field"><input type="text" class="travel-dest" maxlength="60" value="' + esc(leg?.dest || "") + '" placeholder="莫干山" aria-label="目的地"></div>' +
    '<button type="button" class="icon-button remove-travel-btn" style="align-self:flex-end;margin-bottom:0.15rem;" title="删除此行">✕</button>';
  container.appendChild(row);
  row.querySelector(".remove-travel-btn").addEventListener("click", function () {
    const all = container.querySelectorAll(".travel-leg");
    if (all.length <= 1) return;
    row.remove();
  });
}

// ================================================================
// 7. 享福
// ================================================================
// 享福页渲染
function renderEnjoy() {
  const snaps = sortedSnapshots();
  const months = [...new Set(snaps.map(s => s.month))].sort((a, b) => b.localeCompare(a));
  monthOnlySelect("enjoyMonthSelect", months);

  const sn = state.snapshots.find(s => s.month === selectedMonth);
  const legs = (sn?.travel?.legs && sn.travel.legs.length)
    ? sn.travel.legs
    : (sn?.travel?.start ? [{ start: sn.travel.start, end: sn.travel.end, dest: sn.travel.dest }] : []);
  const hasTravel = sn && legs.length > 0 && legs.some(l => l.start && l.end);
  byId("enjoyEmpty").hidden = hasTravel;
  byId("enjoyContent").hidden = !hasTravel;
  if (!hasTravel) return;

  // 遍历所有行程，从 CSV 提取消费
  const allCat = {};
  const allSub = {};
  let allTotal = 0;
  let allDays = 0;

  if (sn.expense.rawCsvBase64) {
    try {
      const csvText = atob(sn.expense.rawCsvBase64);
      const rows = [];
      let row = [], field = "", quoted = false;
      for (let i = 0; i < csvText.length; i++) {
        const ch = csvText[i];
        if (quoted) {
          if (ch === '"' && csvText[i + 1] === '"') { field += '"'; i++; }
          else if (ch === '"') { quoted = false; }
          else { field += ch; }
        } else if (ch === '"') { quoted = true; }
        else if (ch === ",") { row.push(field); field = ""; }
        else if (ch === "\n") { row.push(field.replace(/\r$/, "")); if (row.some(x => x.trim())) rows.push(row); row = []; field = ""; }
        else { field += ch; }
      }
      const hdrs = rows[0].map(h => String(h || "").replace(/^﻿/, "").trim());
      const dIdx = hdrs.findIndex(h => ["时间","日期","交易时间","记账时间"].includes(h));
      const tIdx = hdrs.findIndex(h => ["类型","收支类型","账单类型"].includes(h));
      const aIdx = hdrs.findIndex(h => ["金额","金额(元)","金额（元）","交易金额"].includes(h));
      const cIdx = hdrs.findIndex(h => ["分类","一级分类"].includes(h));
      const sIdx = hdrs.findIndex(h => ["二级分类","子分类"].includes(h));

      for (const leg of legs) {
        if (!leg.start || !leg.end) continue;
        const st = new Date(leg.start), en = new Date(leg.end);
        const dCount = Math.round((en - st) / (1000 * 60 * 60 * 24)) + 1;
        allDays += dCount;
        rows.slice(1).forEach(r => {
          if (dIdx < 0 || tIdx < 0 || aIdx < 0) return;
          const dm = String(r[dIdx] || "").match(/(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})/);
          if (!dm) return;
          const rd = new Date(dm[1] + "-" + dm[2] + "-" + dm[3]);
          if (rd < st || rd > en) return;
          if (String(r[tIdx] || "").trim() !== "支出") return;
          const amt = Number(String(r[aIdx] || "0").replace(/[¥￥,\s]/g, ""));
          if (amt <= 0) return;
          const cat = String(r[cIdx] || "未分类").trim() || "未分类";
          const sub = sIdx >= 0 ? String(r[sIdx] || "").trim() : "";
          allTotal += amt;
          allCat[cat] = (allCat[cat] || 0) + amt;
          if (sub) { if (!allSub[cat]) allSub[cat] = {}; allSub[cat][sub] = (allSub[cat][sub] || 0) + amt; }
        });
      }
      allTotal = Math.round(allTotal * 100) / 100;
      for (const k of Object.keys(allCat)) allCat[k] = Math.round(allCat[k] * 100) / 100;
    } catch (e) { /* CSV 解码失败 */ }
  }

  const destNames = legs.filter(l => l.dest).map(l => l.dest).join(" · ") || "未指定目的地";
  byId("enjoyDest").textContent = destNames;
  byId("enjoyTotal").textContent = money(allTotal);
  byId("enjoyAvg").textContent = allDays > 0 ? money(allTotal / allDays) : money(0);

  renderCategoryList("enjoyCategoryList", allCat, 0);
  if (byId("enjoyDetailList")) renderSubcategoryDetail("enjoyDetailList", allSub, allCat);

  const fm = getLifeMetrics(sn);
  const hourly = fm.familyHourlyRate;
  if (hourly > 0) {
    const lifeHr = allTotal / hourly;
    setText("enjoyLifeHours", numFmt.format(lifeHr));
    setText("enjoyLifeDays", numFmt.format(lifeHr / 8));
    const lostWage = hourly * 8 * allDays;
    setText("enjoyLostWage", money(lostWage));
    const avgPerDay = allTotal / Math.max(allDays, 1);
    const verdictEl = byId("enjoyVerdict");
    if (avgPerDay < hourly * 3) {
      verdictEl.innerHTML = '这' + legs.length + '趟旅行日均 ' + money(avgPerDay) + '，不到半天工资——<strong>太值了。</strong>';
    } else if (avgPerDay < hourly * 8) {
      verdictEl.innerHTML = '这' + legs.length + '趟旅行日均 ' + money(avgPerDay) + '，差不多一天工资——<strong>值。</strong>';
    } else {
      verdictEl.innerHTML = '这' + legs.length + '趟旅行日均 ' + money(avgPerDay) + '，超过一天工资。回忆无价——<strong>只要两个人都开心就值。</strong>';
    }
  } else {
    setText("enjoyLifeHours", "—（请先在设置中填写工作资料）");
  }
}

// ================================================================
// 6. 设置独立页面
// ================================================================
function renderSettingsPage() {
  const s = state.settings;
  const su = s.people.suli;
  const cq = s.people.chenqian;
  const isViewer = cloudMode ? cloudSession?.role === "viewer" : s.role === "viewer";
  const d = isViewer ? " disabled" : "";
  const body = byId("settingsPageBody");
  const saveBtn = byId("saveSettingsBtn");

  if (isViewer) {
    body.innerHTML = '<p style="color:var(--ink-soft);">只读模式下设置仅供查看，不能修改。</p>' +
      '<div class="card card-spacious"><h2>当前设置</h2><p style="color:var(--ink-soft);font-size:0.78rem;">月度预算：' + money(s.monthlyBudget) + ' · 储蓄目标：' + money(s.savingsGoal) + '</p></div>';
    if (saveBtn) saveBtn.style.display = "none";
    return;
  }

  body.innerHTML = `
    <div class="card card-spacious">
      <h2>家庭默认值</h2>
      <br>
      <div class="field-grid two-columns">
        <div class="field"><span>月度花费预算</span><div class="money-input"><b>¥</b><input type="number" id="setBudget" value="${s.monthlyBudget}"${d} inputmode="decimal" step="100" min="0"></div></div>
        <div class="field"><span>家庭储蓄目标</span><div class="money-input"><b>¥</b><input type="number" id="setSavingsGoal" value="${s.savingsGoal}"${d} inputmode="decimal" step="1000" min="0"></div></div>
      </div>
    </div>
    <div class="card card-spacious">
      <h2>欣然 · 工作资料</h2>
      <br>
      ${wpFields("suli", su.workProfile, d)}
      <div class="calc-preview" id="calcPreviewSuli"></div>
    </div>
    <div class="card card-spacious">
      <h2>陈前 · 工作资料</h2>
      <br>
      ${wpFields("chenqian", cq.workProfile, d)}
      <div class="calc-preview" id="calcPreviewChenqian"></div>
    </div>
    <div class="card card-spacious">
      <h2>备份与恢复</h2>
      <br>
      <div class="stacked-actions">
        <button class="secondary-button" type="button" id="exportBackupBtn">导出 JSON 备份</button>
        <label class="secondary-button file-button" style="cursor:pointer;">从备份恢复<input type="file" id="importBackupFile" accept=".json" hidden></label>
        <button class="danger-button" type="button" id="clearDataBtn">清空本地数据</button>
      </div>
    </div>
  `;

  if (saveBtn) saveBtn.style.display = "";

  // 事件绑定
  byId("exportBackupBtn").onclick = () => {
    const blob = new Blob([exportState(state)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = '家里有前备份_' + new Date().toISOString().slice(0, 10) + '.json'; a.click();
    URL.revokeObjectURL(url);
    showToast("备份已下载", "success");
  };
  byId("importBackupFile").onchange = async (e) => {
    try {
      const text = await e.target.files[0].text();
      state = importState(text);
      await syncCloudState();
      showToast("备份已恢复", "success");
      setTimeout(() => location.reload(), 500);
    } catch (err) { showToast(err.message, "error"); }
  };
  byId("clearDataBtn").onclick = async () => {
    if (!confirm("确定清空全部数据？此操作不可恢复。")) return;
    state = clearState();
    await syncCloudState();
    location.reload();
  };

  // 实时预览
  ["suli", "chenqian"].forEach(k => updateCalcPreview(k));
}

// 保存按钮 handler
function saveSettingsFromPage() {
  const ns = {
    ...state.settings,
    monthlyBudget: safeNum(byId("setBudget")?.value) || 3000,
    savingsGoal: safeNum(byId("setSavingsGoal")?.value) || 100000,
    people: {
      suli: { name: "欣然", workProfile: readWorkProfile("suli") },
      chenqian: { name: "陈前", workProfile: readWorkProfile("chenqian") },
    },
  };
  state = saveSettings(state, ns);
  applyTheme();
  applyRole();
  showToast("设置已保存", "success");
  // 异步同步云端，失败仅 toast 提醒
  syncDirty = true;
  setTimeout(function() { syncCloudState().catch(function() {}); }, 100);
}

// ================================================================
// 旧设置对话框（保留给右上角快速入口兼容）
// ================================================================
function openSettings() { navigateTo("settings"); }

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
        name: "欣然",
        workProfile: readWorkProfile("suli"),
      },
      chenqian: {
        name: "陈前",
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
    logoutCloud();
    return;
  }
  // 本地模式不再支持对话框内切换角色
  showToast("云端模式下登录时选择身份即可切换", "warning");
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
  // 先读本地数据（永远有，不会丢）
  state = loadState();

  // 尝试挂云端
  try {
    await setupCloudMode();
  } catch {
    // 云端连接失败或 token 过期都不要紧——本地数据还在
  }

  // demo 模式：仅当 URL 带了 ?demo=1 才启用
  withDemoData();

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

  // 返回按钮
  document.querySelectorAll("[data-back]").forEach(btn => {
    btn.addEventListener("click", () => navigateTo(btn.dataset.back));
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
      localStorage.setItem(cloudTokenKey, cloudSession.token);
      localStorage.setItem(cloudTokenKey + "-role", cloudSession.role);
      cloudAdapter = new RemoteStateAdapter(cloudApiBase, cloudSession.token);
      await loadCloudStateAfterLogin();
      byId("cloudLoginDialog").close();
      renderOverview();
      showToast(cloudSession.role === "manager" ? "已进入管理云端" : "已进入只读云端", "success");
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
  // CSV上传事件，同时读raw base64
  byId("csvFile").addEventListener("change", (e) => {
    if (!e.target.files[0]) return;
    handleCsvUpload(e.target.files[0]);
    // 重置input，允许重复上传同一文件
    e.target.value = "";
  });

  // 工资自动计算：输入工资后自动填转入和个人留存
  byId("suliIncome").addEventListener("input", autoFillTransfers);
  byId("chenqianIncome").addEventListener("input", autoFillTransfers);

  // 设置页保存按钮
  const saveSettingsBtn = byId("saveSettingsBtn");
  if (saveSettingsBtn) saveSettingsBtn.addEventListener("click", saveSettingsFromPage);

  // 生命能量交互
  byId("lifeTradeoffAmount")?.addEventListener("input", renderLife);
  byId("openLifeCalc")?.addEventListener("click", (e) => { e.preventDefault(); openSettings(); });

  // PWA
  window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); deferredInstallPrompt = e; });

  // 网络状态监听：断网/恢复时更新同步状态指示器
  window.addEventListener("online", () => {
    if (cloudMode) {
      updateSyncStatus(syncDirty ? "pending" : "synced");
      showToast("网络已恢复", "success");
      if (syncDirty) syncCloudState().catch(function() {});
    } else {
      updateSyncStatus("local");
    }
  });
  window.addEventListener("offline", () => {
    if (cloudMode) updateSyncStatus("offline");
  });

  // 定时检查云端连通性（每 5 分钟，仅在云端模式下）
  if (cloudMode) {
    syncStatusTimer = setInterval(async () => {
      try {
        const resp = await fetch(cloudUrl("/api/health"));
        if (resp.ok) {
          updateSyncStatus(syncDirty ? "pending" : "synced");
          // 如果有未同步数据，自动尝试同步
          if (syncDirty) syncCloudState().catch(function() {});
        } else {
          updateSyncStatus("offline");
        }
      } catch {
        updateSyncStatus("offline");
      }
    }, 300000);
  }

  // 享福：添加行程行
  const addTravelBtn = byId("addTravelLegBtn");
  if (addTravelBtn) addTravelBtn.addEventListener("click", () => addTravelLegRow({ start: "", end: "", dest: "" }));

  // 初始渲染
  renderOverview();
}

init();
