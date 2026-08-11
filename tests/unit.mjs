import assert from "node:assert/strict";
import { parseCsvText, summarizeQianjiFile } from "../csv-parser.js";

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

console.log("钱迹 CSV 汇总规则测试通过");
