const STORAGE_KEY = "family-finance-pwa-v2";

// V2 默认状态：WorkProfile 拆分为 7 个明细字段
export const DEFAULT_STATE = Object.freeze({
  schemaVersion: 2,
  settings: {
    monthlyBudget: 3000,
    savingsGoal: 100000,
    theme: "system",
    role: "manager",
    people: {
      suli: {
        name: "欣然",
        workProfile: {
          referenceMonthlyIncome: 0,
          workDaysPerMonth: 22,
          workHoursPerDay: 8,
          commuteMinutesPerDay: 0,
          mealCostPerWorkday: 0,
          commuteCostPerMonth: 0,
          otherWorkCostPerMonth: 0,
          // V1 兼容字段：用户补齐 V2 明细前，计算继续使用以下汇总值
          _v1MonthlyIncome: 0,
          _v1WorkHours: 0,
          _v1CommuteHours: 0,
          _v1WorkCosts: 0,
        },
      },
      chenqian: {
        name: "陈前",
        workProfile: {
          referenceMonthlyIncome: 0,
          workDaysPerMonth: 22,
          workHoursPerDay: 8,
          commuteMinutesPerDay: 0,
          mealCostPerWorkday: 0,
          commuteCostPerMonth: 0,
          otherWorkCostPerMonth: 0,
          _v1MonthlyIncome: 0,
          _v1WorkHours: 0,
          _v1CommuteHours: 0,
          _v1WorkCosts: 0,
        },
      },
    },
  },
  snapshots: [],
  metadata: {
    createdAt: "",
    updatedAt: "",
  },
});

// ---- 工具函数 ----

function copy(value) {
  return typeof structuredClone === "function"
    ? structuredClone(value)
    : JSON.parse(JSON.stringify(value));
}

function finiteNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

// ---- WorkProfile V2 标准化 ----

function normalizeWorkProfileV2(profile = {}) {
  return {
    referenceMonthlyIncome: finiteNumber(profile.referenceMonthlyIncome),
    workDaysPerMonth: finiteNumber(profile.workDaysPerMonth, 22),
    workHoursPerDay: finiteNumber(profile.workHoursPerDay, 8),
    commuteMinutesPerDay: finiteNumber(profile.commuteMinutesPerDay),
    mealCostPerWorkday: finiteNumber(profile.mealCostPerWorkday),
    commuteCostPerMonth: finiteNumber(profile.commuteCostPerMonth),
    otherWorkCostPerMonth: finiteNumber(profile.otherWorkCostPerMonth),
    // V1 兼容字段
    _v1MonthlyIncome: finiteNumber(profile._v1MonthlyIncome),
    _v1WorkHours: finiteNumber(profile._v1WorkHours),
    _v1CommuteHours: finiteNumber(profile._v1CommuteHours),
    _v1WorkCosts: finiteNumber(profile._v1WorkCosts),
  };
}

// ---- V1 → V2 迁移 ----

function migrateWorkProfileV1toV2(oldProfile) {
  // oldProfile 可能是 V1 格式：{ monthlyIncome, workHours, commuteHours, workCosts }
  const mi = finiteNumber(oldProfile.monthlyIncome);
  const wh = finiteNumber(oldProfile.workHours);
  const ch = finiteNumber(oldProfile.commuteHours);
  const wc = finiteNumber(oldProfile.workCosts);
  return {
    referenceMonthlyIncome: mi,
    workDaysPerMonth: 22,
    workHoursPerDay: 8,
    commuteMinutesPerDay: 0,
    mealCostPerWorkday: 0,
    commuteCostPerMonth: 0,
    otherWorkCostPerMonth: 0,
    _v1MonthlyIncome: mi,
    _v1WorkHours: wh,
    _v1CommuteHours: ch,
    _v1WorkCosts: wc,
  };
}

function isV2ProfileFilled(profile) {
  // 当用户至少填写了 referenceMonthlyIncome 或修改了默认的 workDays/ workHours 时，认为 V2 资料已补齐
  return profile.referenceMonthlyIncome > 0
    || profile.workDaysPerMonth !== 22
    || profile.workHoursPerDay !== 8
    || profile.commuteMinutesPerDay > 0
    || profile.mealCostPerWorkday > 0
    || profile.commuteCostPerMonth > 0
    || profile.otherWorkCostPerMonth > 0;
}

// ---- 通用标准化 ----

function normalizePerson(person = {}, fallbackName) {
  const rawProfile = person.workProfile || {};
  return {
    name: String(person.name || fallbackName).trim().slice(0, 20) || fallbackName,
    workProfile: normalizeWorkProfileV2(rawProfile),
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
      suli: normalizePerson(settings.people?.suli, "欣然"),
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
      rawCsvBase64: String(snapshot.expense?.rawCsvBase64 || "").slice(0, 500000),
      rawCsvFileName: String(snapshot.expense?.rawCsvFileName || "").slice(0, 180),
    },
    travel: {
      legs: Array.isArray(snapshot.travel?.legs)
        ? snapshot.travel.legs.map(l => ({
            start: /^\d{4}-\d{2}-\d{2}$/.test(l?.start || "") ? l.start : "",
            end: /^\d{4}-\d{2}-\d{2}$/.test(l?.end || "") ? l.end : "",
            dest: String(l?.dest || "").slice(0, 60),
          })).filter(l => l.start || l.end || l.dest)
        : [],
    },
    note: String(snapshot.note || "").slice(0, 200),
    createdAt: snapshot.createdAt || now,
    updatedAt: snapshot.updatedAt || now,
  };
}

// ---- 状态标准化（含幂等迁移） ----

export function normalizeState(input = {}) {
  const now = new Date().toISOString();
  const rawVersion = input.schemaVersion || 1;

  // 幂等迁移
  let settings;
  if (rawVersion < 2) {
    // V1 → V2：WorkProfile 升级
    const rawSettings = input.settings || {};
    const rawPeople = rawSettings.people || {};
    const v1Suli = rawPeople.suli?.workProfile || {};
    const v1Chenqian = rawPeople.chenqian?.workProfile || {};
    settings = {
      ...rawSettings,
      people: {
        suli: {
          name: rawPeople.suli?.name || "欣然",
          workProfile: migrateWorkProfileV1toV2(v1Suli),
        },
        chenqian: {
          name: rawPeople.chenqian?.name || "陈前",
          workProfile: migrateWorkProfileV1toV2(v1Chenqian),
        },
      },
    };
  } else {
    settings = input.settings || {};
  }

  settings = normalizeSettings(settings);

  const snapshots = Array.isArray(input.snapshots)
    ? input.snapshots.map(normalizeSnapshot).filter(Boolean)
    : [];
  const latestByMonth = new Map();
  snapshots.forEach((snapshot) => latestByMonth.set(snapshot.month, snapshot));

  return {
    schemaVersion: 2,
    settings,
    snapshots: [...latestByMonth.values()].sort((a, b) => a.month.localeCompare(b.month)),
    metadata: {
      createdAt: input.metadata?.createdAt || now,
      updatedAt: input.metadata?.updatedAt || now,
    },
  };
}

// ---- 生命能量计算（纯函数，可独立测试） ----

/**
 * 计算单个成员的实际时薪和每赚 10 元所需分钟。
 * 优先使用 V2 明细公式；当 V2 资料未填写时，回退到 V1 汇总字段。
 */
export function calcWorkMetrics(workProfile, monthlyIncomeOverride = 0) {
  const profile = normalizeWorkProfileV2(workProfile);
  const useV2 = isV2ProfileFilled(profile);

  if (useV2) {
    const calcIncome = monthlyIncomeOverride > 0 ? monthlyIncomeOverride : profile.referenceMonthlyIncome;
    const workHoursPerMonth = profile.workDaysPerMonth * profile.workHoursPerDay;
    const commuteHoursPerMonth = (profile.workDaysPerMonth * profile.commuteMinutesPerDay) / 60;
    const mealCostPerMonth = profile.workDaysPerMonth * profile.mealCostPerWorkday;
    const workCosts = mealCostPerMonth + profile.commuteCostPerMonth + profile.otherWorkCostPerMonth;
    const netIncome = calcIncome - workCosts;
    const totalHours = workHoursPerMonth + commuteHoursPerMonth;

    if (totalHours <= 0 || netIncome <= 0) {
      return { hourlyRate: 0, minutesPer10: 0, useV2: true, complete: false };
    }
    return {
      hourlyRate: netIncome / totalHours,
      minutesPer10: totalHours > 0 && netIncome > 0 ? (10 / (netIncome / totalHours)) * 60 : 0,
      useV2: true,
      complete: true,
    };
  }

  // V1 回退
  const calcIncome = monthlyIncomeOverride > 0 ? monthlyIncomeOverride : profile._v1MonthlyIncome;
  if (calcIncome <= 0 || profile._v1WorkHours <= 0) {
    return { hourlyRate: 0, minutesPer10: 0, useV2: false, complete: false };
  }
  const netIncome = calcIncome - profile._v1WorkCosts;
  const totalHours = profile._v1WorkHours + profile._v1CommuteHours;
  if (totalHours <= 0 || netIncome <= 0) {
    return { hourlyRate: 0, minutesPer10: 0, useV2: false, complete: false };
  }
  return {
    hourlyRate: netIncome / totalHours,
    minutesPer10: (10 / (netIncome / totalHours)) * 60,
    useV2: false,
    complete: true,
  };
}

/**
 * 家庭综合实际时薪。
 */
export function calcFamilyWorkMetrics(settings, monthlyIncomes = {}) {
  const suli = calcWorkMetrics(settings.people.suli.workProfile, monthlyIncomes.suli || 0);
  const chenqian = calcWorkMetrics(settings.people.chenqian.workProfile, monthlyIncomes.chenqian || 0);

  const profiles = [settings.people.suli.workProfile, settings.people.chenqian.workProfile];
  const overrides = [monthlyIncomes.suli || 0, monthlyIncomes.chenqian || 0];

  let totalNetIncome = 0;
  let totalHours = 0;

  profiles.forEach((profile, i) => {
    const override = overrides[i];
    const useV2 = isV2ProfileFilled(profile);
    if (useV2) {
      const calcIncome = override > 0 ? override : profile.referenceMonthlyIncome;
      const workHoursPerMonth = profile.workDaysPerMonth * profile.workHoursPerDay;
      const commuteHoursPerMonth = (profile.workDaysPerMonth * profile.commuteMinutesPerDay) / 60;
      const mealCostPerMonth = profile.workDaysPerMonth * profile.mealCostPerWorkday;
      const workCosts = mealCostPerMonth + profile.commuteCostPerMonth + profile.otherWorkCostPerMonth;
      totalNetIncome += calcIncome - workCosts;
      totalHours += workHoursPerMonth + commuteHoursPerMonth;
    } else {
      if (override > 0) {
        totalNetIncome += override - profile._v1WorkCosts;
      } else {
        totalNetIncome += profile._v1MonthlyIncome - profile._v1WorkCosts;
      }
      totalHours += profile._v1WorkHours + profile._v1CommuteHours;
    }
  });

  const familyHourlyRate = totalHours > 0 && totalNetIncome > 0 ? totalNetIncome / totalHours : 0;

  return { suli, chenqian, familyHourlyRate };
}

// ---- localStorage 操作 ----

export function loadState() {
  // 尝试从 V2 key 读取，失败则尝试 V1 key 并自动迁移
  let raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    raw = localStorage.getItem("family-finance-pwa-v1");
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        const migrated = normalizeState(parsed);
        localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
        localStorage.removeItem("family-finance-pwa-v1");
        return migrated;
      } catch {
        // V1 数据损坏，返回默认值
      }
    }
    return normalizeState(copy(DEFAULT_STATE));
  }
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
  localStorage.removeItem("family-finance-pwa-v1");
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

// 云端适配器（预留）
export class RemoteStateAdapter {
  constructor(apiBase, token) {
    this.apiBase = String(apiBase || "").replace(/\/$/, "");
    this.token = String(token || "");
    this.etag = "";
  }

  authHeaders() {
    return this.token ? { Authorization: `Bearer ${this.token}` } : {};
  }

  async load() {
    const response = await fetch(`${this.apiBase}/api/state`, { headers: this.authHeaders() });
    if (!response.ok) {
      const error = new Error(`云端读取失败：${response.status}`);
      error.status = response.status;
      throw error;
    }
    this.etag = response.headers.get("ETag") || "";
    return normalizeState(await response.json());
  }

  async save(state) {
    const headers = { "Content-Type": "application/json", ...this.authHeaders() };
    if (this.etag) headers["If-Match"] = this.etag;
    const response = await fetch(`${this.apiBase}/api/state`, {
      method: "PUT",
      headers,
      body: JSON.stringify(normalizeState(state)),
    });
    if (response.status === 409) {
      const error = new Error("云端数据已经变化，请重新加载后再保存");
      error.status = 409;
      throw error;
    }
    if (!response.ok) {
      const error = new Error(`云端保存失败：${response.status}`);
      error.status = response.status;
      throw error;
    }
    this.etag = response.headers.get("ETag") || this.etag;
    return normalizeState(await response.json());
  }
}
