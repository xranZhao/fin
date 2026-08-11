function validMonth(value) {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function monthSequence(startMonth, endMonth) {
  const [startYear, startNumber] = startMonth.split("-").map(Number);
  const [endYear, endNumber] = endMonth.split("-").map(Number);
  const result = [];
  let year = startYear;
  let month = startNumber;
  while (year < endYear || (year === endYear && month <= endNumber)) {
    result.push(`${year}-${String(month).padStart(2, "0")}`);
    month += 1;
    if (month === 13) {
      month = 1;
      year += 1;
    }
  }
  return result;
}

export function periodDefinition(value) {
  const [kind, token] = String(value || "").split(":");
  if (kind === "month" && validMonth(token)) {
    const [year, month] = token.split("-");
    return {
      value,
      kind,
      year,
      startMonth: token,
      endMonth: token,
      expectedMonths: 1,
      label: `${year}年${Number(month)}月`,
      shortLabel: `${Number(month)}月`,
      summaryTitle: `${year}年${Number(month)}月`,
      optionLabel: `${year}年${Number(month)}月`,
    };
  }
  if (kind === "half" && /^\d{4}-H[12]$/.test(token)) {
    const [year, half] = token.split("-");
    const firstHalf = half === "H1";
    return {
      value,
      kind,
      year,
      half,
      startMonth: `${year}-${firstHalf ? "01" : "07"}`,
      endMonth: `${year}-${firstHalf ? "06" : "12"}`,
      expectedMonths: 6,
      label: `${year}年${firstHalf ? "上" : "下"}半年`,
      shortLabel: firstHalf ? "上半年" : "下半年",
      summaryTitle: `${year}年${firstHalf ? "上" : "下"}半年总结`,
      optionLabel: `${year}年${firstHalf ? "上" : "下"}半年`,
    };
  }
  if (kind === "year" && /^\d{4}$/.test(token)) {
    return {
      value,
      kind,
      year: token,
      startMonth: `${token}-01`,
      endMonth: `${token}-12`,
      expectedMonths: 12,
      label: `${token}年度`,
      shortLabel: `${token}年`,
      summaryTitle: `${token}年终总结`,
      optionLabel: `${token}年终总结`,
    };
  }
  return null;
}

export function buildPeriodOptions(snapshots, currentMonth) {
  const savedMonths = snapshots.map((item) => item.month).filter(validMonth);
  const months = [...new Set([...savedMonths, currentMonth])].sort((a, b) => b.localeCompare(a));
  const years = [...new Set(months.map((month) => month.slice(0, 4)))].sort((a, b) => b.localeCompare(a));
  const currentHalf = Number(currentMonth.slice(5, 7)) <= 6 ? "H1" : "H2";
  const currentYear = currentMonth.slice(0, 4);
  const halves = [];

  years.forEach((year) => {
    ["H2", "H1"].forEach((half) => {
      const hasSavedMonth = savedMonths.some((month) => {
        if (!month.startsWith(`${year}-`)) return false;
        const number = Number(month.slice(5, 7));
        return half === "H1" ? number <= 6 : number >= 7;
      });
      if (hasSavedMonth || (year === currentYear && half === currentHalf)) {
        halves.push(`half:${year}-${half}`);
      }
    });
  });

  return {
    months: months.map((month) => `month:${month}`),
    halves,
    years: years.map((year) => `year:${year}`),
  };
}

function emptyPerson() {
  return { income: 0, householdTransfer: 0, privateKept: 0 };
}

export function aggregatePeriod(snapshots, periodValue) {
  const definition = periodDefinition(periodValue);
  if (!definition) return null;
  const periodSnapshots = [...snapshots]
    .filter((item) => item.month >= definition.startMonth && item.month <= definition.endMonth)
    .sort((a, b) => a.month.localeCompare(b.month));

  const report = {
    definition,
    snapshots: periodSnapshots,
    coverageCount: periodSnapshots.length,
    expectedMonths: monthSequence(definition.startMonth, definition.endMonth),
    latest: periodSnapshots.at(-1) || null,
    first: periodSnapshots[0] || null,
    people: { suli: emptyPerson(), chenqian: emptyPerson() },
    metrics: {
      totalIncome: 0,
      totalTransfer: 0,
      totalPrivateKept: 0,
      expense: 0,
      operatingBalance: 0,
      transferRate: 0,
      allocationGap: 0,
    },
    categoryBreakdown: {},
  };

  periodSnapshots.forEach((snapshot) => {
    ["suli", "chenqian"].forEach((key) => {
      report.people[key].income += snapshot.people[key].income;
      report.people[key].householdTransfer += snapshot.people[key].householdTransfer;
      report.people[key].privateKept += snapshot.people[key].privateKept;
    });
    report.metrics.expense += snapshot.expense.confirmedTotal;
    Object.entries(snapshot.expense.categoryBreakdown || {}).forEach(([category, amount]) => {
      report.categoryBreakdown[category] = (report.categoryBreakdown[category] || 0) + amount;
    });
  });

  report.metrics.totalIncome = report.people.suli.income + report.people.chenqian.income;
  report.metrics.totalTransfer = report.people.suli.householdTransfer + report.people.chenqian.householdTransfer;
  report.metrics.totalPrivateKept = report.people.suli.privateKept + report.people.chenqian.privateKept;
  report.metrics.operatingBalance = report.metrics.totalTransfer - report.metrics.expense;
  report.metrics.transferRate = report.metrics.totalIncome > 0
    ? report.metrics.totalTransfer / report.metrics.totalIncome
    : 0;
  report.metrics.allocationGap = report.metrics.totalIncome
    - report.metrics.totalTransfer
    - report.metrics.totalPrivateKept;
  return report;
}
