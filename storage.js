const STORAGE_KEY = "family-finance-pwa-v1";

export const DEFAULT_STATE = Object.freeze({
  schemaVersion: 1,
  settings: {
    monthlyBudget: 3000,
    savingsGoal: 100000,
    theme: "system",
    role: "manager",
    people: {
      suli: {
        name: "酥梨",
        workProfile: { monthlyIncome: 0, workHours: 0, commuteHours: 0, workCosts: 0 },
      },
      chenqian: {
        name: "陈前",
        workProfile: { monthlyIncome: 0, workHours: 0, commuteHours: 0, workCosts: 0 },
      },
    },
  },
  snapshots: [],
  metadata: {
    createdAt: "",
    updatedAt: "",
  },
});

function copy(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

function normalizeWorkProfile(profile = {}) {
  return {
    monthlyIncome: finiteNumber(profile.monthlyIncome),
    workHours: finiteNumber(profile.workHours),
    commuteHours: finiteNumber(profile.commuteHours),
    workCosts: finiteNumber(profile.workCosts),
  };
}

function normalizePerson(person = {}, fallbackName) {
  return {
    name: String(person.name || fallbackName).trim().slice(0, 20) || fallbackName,
    workProfile: normalizeWorkProfile(person.workProfile),
  };
}

function normalizeSettings(settings = {}) {
  const allowedThemes = new Set(["system", "light", "dark"]);
  const allowedRoles = new Set(["manager", "viewer"]);
  return {
    monthlyBudget: finiteNumber(settings.monthlyBudget, 3000),
    savingsGoal: finiteNumber(settings.savingsGoal, 100000),
    theme: allowedThemes.has(settings.theme) ? settings.theme : "system",
    role: allowedRoles.has(settings.role) ? settings.role : "manager",
    people: {
      suli: normalizePerson(settings.people?.suli, "酥梨"),
      chenqian: normalizePerson(settings.people?.chenqian, "陈前"),
    },
  };
}

function normalizeCategoryBreakdown(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([key, amount]) => [String(key).trim().slice(0, 40), finiteNumber(amount)])
      .filter(([key, amount]) => key && amount > 0),
  );
}

function normalizeSnapshot(snapshot = {}) {
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(snapshot.month) ? snapshot.month : "";
  if (!month) return null;
  const now = new Date().toISOString();
  return {
    month,
    accounts: {
      familySpendingBalance: finiteNumber(snapshot.accounts?.familySpendingBalance),
      familySavingsBalance: finiteNumber(snapshot.accounts?.familySavingsBalance),
    },
    people: {
      suli: {
        income: finiteNumber(snapshot.people?.suli?.income),
        householdTransfer: finiteNumber(snapshot.people?.suli?.householdTransfer),
        privateKept: finiteNumber(snapshot.people?.suli?.privateKept),
      },
      chenqian: {
        income: finiteNumber(snapshot.people?.chenqian?.income),
        householdTransfer: finiteNumber(snapshot.people?.chenqian?.householdTransfer),
        privateKept: finiteNumber(snapshot.people?.chenqian?.privateKept),
      },
    },
    expense: {
      autoTotal: finiteNumber(snapshot.expense?.autoTotal),
      confirmedTotal: finiteNumber(snapshot.expense?.confirmedTotal),
      recordCount: Math.max(0, Math.trunc(finiteNumber(snapshot.expense?.recordCount))),
      categoryBreakdown: normalizeCategoryBreakdown(snapshot.expense?.categoryBreakdown),
      sourceFileName: String(snapshot.expense?.sourceFileName || "").slice(0, 180),
      sourceMonths: Array.isArray(snapshot.expense?.sourceMonths)
        ? snapshot.expense.sourceMonths.filter((item) => /^\d{4}-(0[1-9]|1[0-2])$/.test(item)).slice(0, 24)
        : [],
      importedAt: snapshot.expense?.importedAt || "",
    },
    note: String(snapshot.note || "").slice(0, 200),
    createdAt: snapshot.createdAt || now,
    updatedAt: snapshot.updatedAt || now,
  };
}

export function normalizeState(input = {}) {
  const now = new Date().toISOString();
  const snapshots = Array.isArray(input.snapshots)
    ? input.snapshots.map(normalizeSnapshot).filter(Boolean)
    : [];
  const latestByMonth = new Map();
  snapshots.forEach((snapshot) => latestByMonth.set(snapshot.month, snapshot));
  return {
    schemaVersion: 1,
    settings: normalizeSettings(input.settings),
    snapshots: [...latestByMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    metadata: {
      createdAt: input.metadata?.createdAt || now,
      updatedAt: input.metadata?.updatedAt || now,
    },
  };
}

export function loadState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return normalizeState(copy(DEFAULT_STATE));
  try {
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    console.warn("本机数据无法读取，已使用空白账本。", error);
    return normalizeState(copy(DEFAULT_STATE));
  }
}

export function saveState(state) {
  const normalized = normalizeState(state);
  normalized.metadata.updatedAt = new Date().toISOString();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
  return normalized;
}

export function upsertSnapshot(state, snapshot) {
  const normalized = normalizeSnapshot(snapshot);
  if (!normalized) throw new Error("月份格式不正确");
  const existing = state.snapshots.find((item) => item.month === normalized.month);
  normalized.createdAt = existing?.createdAt || normalized.createdAt;
  normalized.updatedAt = new Date().toISOString();
  return saveState({
    ...state,
    snapshots: [...state.snapshots.filter((item) => item.month !== normalized.month), normalized],
  });
}

export function saveSettings(state, settings) {
  return saveState({ ...state, settings: normalizeSettings(settings) });
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  return normalizeState(copy(DEFAULT_STATE));
}

export function exportState(state) {
  const payload = {
    product: "家庭月度驾驶舱",
    exportedAt: new Date().toISOString(),
    ...normalizeState(state),
  };
  return JSON.stringify(payload, null, 2);
}

export function importState(jsonText) {
  let parsed;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new Error("备份文件不是有效的 JSON");
  }
  if (parsed.product && parsed.product !== "家庭月度驾驶舱") {
    throw new Error("这不是家庭月度驾驶舱的备份文件");
  }
  return saveState(parsed);
}

// 云端版本使用同一状态结构。接口由阿里云函数计算实现，浏览器不保存 AccessKey。
export class RemoteStateAdapter {
  constructor(apiBase) {
    this.apiBase = String(apiBase || "").replace(/\/$/, "");
    this.etag = "";
  }

  async load() {
    const response = await fetch(`${this.apiBase}/api/state`, { credentials: "include" });
    if (!response.ok) throw new Error(`云端读取失败：${response.status}`);
    this.etag = response.headers.get("ETag") || "";
    return normalizeState(await response.json());
  }

  async save(state) {
    const headers = { "Content-Type": "application/json" };
    if (this.etag) headers["If-Match"] = this.etag;
    const response = await fetch(`${this.apiBase}/api/state`, {
      method: "PUT",
      credentials: "include",
      headers,
      body: JSON.stringify(normalizeState(state)),
    });
    if (response.status === 409) throw new Error("云端数据已经变化，请重新加载后再保存");
    if (!response.ok) throw new Error(`云端保存失败：${response.status}`);
    this.etag = response.headers.get("ETag") || this.etag;
    return normalizeState(await response.json());
  }
}
