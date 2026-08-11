import assert from "node:assert/strict";
import { parseCsvText, summarizeQianjiFile } from "../csv-parser.js";
import { aggregatePeriod, buildPeriodOptions, periodDefinition } from "../period-summary.js";

const quoted = parseCsvText('名称,备注\r\n"便利店,东门","他说""可以"""\r\n');
assert.deepEqual(quoted, [["名称", "备注"], ["便利店,东门", '他说"可以"']]);

const csv = [
  "时间,分类,二级分类,类型,金额(元),是否计入收支,备注",
  "2026-08-02 12:00,好好吃饭,上班点饭,支出,28.5,是,午餐",
  "2026-08-03 18:00,生活成本,日用百货,支出,10,是,纸巾",
  "2026-08-04 09:00,品质生活,知识付费,支出,99,否,不计入测试",
  "2026-08-05 09:00,生活成本,其他杂费,支出,16,是,退款",
  "2026-08-06 09:00,工资,税后工资,收入,8000,是,工资",
  "2026-07-31 09:00,好好吃饭,咕噜饮料,支出,6,是,矿泉水",
].join("\r\n");

const bytes = new TextEncoder().encode(csv);
const file = {
  name: "钱迹_2026-08.csv",
  async arrayBuffer() {
    return bytes.buffer;
  },
};

const result = await summarizeQianjiFile(file, "2026-08");
assert.equal(result.total, 38.5);
assert.equal(result.matchedRows, 2);
assert.deepEqual(result.categoryBreakdown, { 好好吃饭: 28.5, 生活成本: 10 });
assert.deepEqual(result.sourceMonths, ["2026-07", "2026-08"]);
assert.equal(result.encoding, "UTF-8");

const snapshots = [
  {
    month: "2026-06",
    accounts: { familySpendingBalance: 620, familySavingsBalance: 68000 },
    people: {
      suli: { income: 8500, householdTransfer: 6500, privateKept: 2000 },
      chenqian: { income: 9200, householdTransfer: 7000, privateKept: 2200 },
    },
    expense: { confirmedTotal: 2880, categoryBreakdown: { 好好吃饭: 1120, 生活成本: 930, 品质生活: 830 } },
  },
  {
    month: "2026-07",
    accounts: { familySpendingBalance: 480, familySavingsBalance: 78200 },
    people: {
      suli: { income: 8500, householdTransfer: 6400, privateKept: 2100 },
      chenqian: { income: 9400, householdTransfer: 7200, privateKept: 2200 },
    },
    expense: { confirmedTotal: 3140, categoryBreakdown: { 好好吃饭: 1280, 生活成本: 1010, 品质生活: 850 } },
  },
  {
    month: "2026-08",
    accounts: { familySpendingBalance: 1160, familySavingsBalance: 89100 },
    people: {
      suli: { income: 8800, householdTransfer: 6800, privateKept: 2000 },
      chenqian: { income: 9400, householdTransfer: 7200, privateKept: 2200 },
    },
    expense: { confirmedTotal: 2460, categoryBreakdown: { 好好吃饭: 980, 生活成本: 920, 品质生活: 560 } },
  },
];

assert.equal(periodDefinition("half:2026-H2").label, "2026年下半年");
const periodOptions = buildPeriodOptions(snapshots, "2026-08");
assert.deepEqual(periodOptions.months, ["month:2026-08", "month:2026-07", "month:2026-06"]);
assert.deepEqual(periodOptions.halves, ["half:2026-H2", "half:2026-H1"]);
assert.deepEqual(periodOptions.years, ["year:2026"]);

const halfYear = aggregatePeriod(snapshots, "half:2026-H2");
assert.equal(halfYear.coverageCount, 2);
assert.equal(halfYear.definition.expectedMonths, 6);
assert.equal(halfYear.metrics.totalIncome, 36100);
assert.equal(halfYear.metrics.totalTransfer, 27600);
assert.equal(halfYear.metrics.expense, 5600);
assert.equal(halfYear.metrics.allocationGap, 0);
assert.deepEqual(halfYear.categoryBreakdown, { 好好吃饭: 2260, 生活成本: 1930, 品质生活: 1410 });

const annual = aggregatePeriod(snapshots, "year:2026");
assert.equal(annual.coverageCount, 3);
assert.equal(annual.metrics.totalIncome, 53800);
assert.equal(annual.metrics.expense, 8480);

console.log("钱迹 CSV 与周期汇总规则测试通过");
