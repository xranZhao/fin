const DATE_HEADERS = ["时间", "日期", "交易时间", "记账时间"];
const TYPE_HEADERS = ["类型", "收支类型", "账单类型"];
const AMOUNT_HEADERS = ["金额", "金额(元)", "金额（元）", "交易金额"];
const CATEGORY_HEADERS = ["分类", "一级分类"];
const SUBCATEGORY_HEADERS = ["二级分类", "子分类"];
const EXCLUDE_HEADERS = ["不计收支", "是否计入收支", "计入收支"];

function normalizeHeader(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim();
}

function findHeader(headers, candidates, required = false) {
  const index = headers.findIndex((header) => candidates.includes(normalizeHeader(header)));
  if (required && index < 0) throw new Error(`缺少字段：${candidates[0]}`);
  return index;
}

export function parseCsvText(text) {
  const rows = [];
  let row = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(field);
      field = "";
    } else if (character === "\n") {
      row.push(field.replace(/\r$/, ""));
      if (row.some((value) => value.trim())) rows.push(row);
      row = [];
      field = "";
    } else {
      field += character;
    }
  }

  if (field || row.length) {
    row.push(field.replace(/\r$/, ""));
    if (row.some((value) => value.trim())) rows.push(row);
  }
  return rows;
}

function parseAmount(value) {
  const cleaned = String(value || "")
    .replace(/[¥￥,\s]/g, "")
    .replace(/^\((.+)\)$/, "-$1");
  const amount = Number(cleaned);
  return Number.isFinite(amount) ? Math.abs(amount) : 0;
}

function extractMonth(value) {
  const match = String(value || "").match(/(20\d{2})[-/.年](\d{1,2})/);
  if (!match) return "";
  const month = Number(match[2]);
  if (month < 1 || month > 12) return "";
  return `${match[1]}-${String(month).padStart(2, "0")}`;
}

function shouldExclude(value, header) {
  const normalized = String(value || "").trim().toLowerCase();
  if (!normalized) return false;
  if (header.includes("不计")) {
    return ["是", "true", "1", "不计收支", "不计入"].includes(normalized);
  }
  return ["否", "false", "0", "不计收支", "不计入"].includes(normalized);
}

function decodeFile(buffer) {
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(buffer), encoding: "UTF-8" };
  } catch {
    try {
      return { text: new TextDecoder("gb18030").decode(buffer), encoding: "GB18030" };
    } catch {
      throw new Error("文件编码无法识别，请从钱迹重新导出 CSV");
    }
  }
}

export async function summarizeQianjiFile(file, selectedMonth) {
  if (!file) throw new Error("请先选择 CSV 文件");
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(selectedMonth)) throw new Error("请先选择记录月份");
  const { text, encoding } = decodeFile(await file.arrayBuffer());
  const rows = parseCsvText(text);
  if (rows.length < 2) throw new Error("CSV 没有可读取的账单数据");

  const headers = rows[0].map(normalizeHeader);
  const dateIndex = findHeader(headers, DATE_HEADERS, true);
  const typeIndex = findHeader(headers, TYPE_HEADERS, true);
  const amountIndex = findHeader(headers, AMOUNT_HEADERS, true);
  const categoryIndex = findHeader(headers, CATEGORY_HEADERS, true);
  const subcategoryIndex = findHeader(headers, SUBCATEGORY_HEADERS);
  const excludeIndex = findHeader(headers, EXCLUDE_HEADERS);

  const sourceMonths = new Set();
  const categoryBreakdown = {};
  let matchedRows = 0;
  let skippedRows = 0;
  let total = 0;

  rows.slice(1).forEach((row) => {
    const rowMonth = extractMonth(row[dateIndex]);
    if (rowMonth) sourceMonths.add(rowMonth);
    if (rowMonth !== selectedMonth) return;

    const type = String(row[typeIndex] || "").trim();
    const category = String(row[categoryIndex] || "未分类").trim() || "未分类";
    const subcategory = subcategoryIndex >= 0 ? String(row[subcategoryIndex] || "").trim() : "";
    const rowText = row.join(" ");
    if (type !== "支出" || (excludeIndex >= 0 && shouldExclude(row[excludeIndex], headers[excludeIndex])) || /退款|不计收支/.test(rowText)) {
      skippedRows += 1;
      return;
    }

    const amount = parseAmount(row[amountIndex]);
    if (amount <= 0) {
      skippedRows += 1;
      return;
    }
    total += amount;
    categoryBreakdown[category] = (categoryBreakdown[category] || 0) + amount;
    matchedRows += 1;

    // 保留读取二级分类这一动作，便于兼容钱迹不同导出模板。
    void subcategory;
  });

  if (matchedRows === 0) {
    const months = [...sourceMonths].sort().join("、") || "无法识别";
    throw new Error(`没有找到 ${selectedMonth} 的有效支出；文件包含月份：${months}`);
  }

  return {
    total: Number(total.toFixed(2)),
    categoryBreakdown: Object.fromEntries(
      Object.entries(categoryBreakdown)
        .sort((a, b) => b[1] - a[1])
        .map(([key, value]) => [key, Number(value.toFixed(2))]),
    ),
    sourceFileName: file.name,
    sourceMonths: [...sourceMonths].sort(),
    matchedRows,
    skippedRows,
    encoding,
    importedAt: new Date().toISOString(),
  };
}
