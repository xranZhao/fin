# 字段定义与计算口径

本文档与 `storage.js` 当前保存的 JSON 结构一致，可直接作为前后端数据契约。

## 1. 根对象 `HouseholdFinanceState`

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schemaVersion` | integer | 是 | 当前固定为 `1` |
| `settings` | `HouseholdSettings` | 是 | 家庭目标、成员和工作档案 |
| `snapshots` | `MonthlySnapshot[]` | 是 | 按月份升序保存的月度快照 |
| `metadata.createdAt` | ISO datetime | 是 | 数据集创建时间 |
| `metadata.updatedAt` | ISO datetime | 是 | 数据集最后保存时间 |

## 2. 月度快照 `MonthlySnapshot`

### 基础字段

| 字段路径 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `month` | `YYYY-MM` | 是 | 自然月，也是月度快照唯一键 |
| `note` | string | 否 | 本月大事或异常说明，最多 200 字 |
| `createdAt` | ISO datetime | 是 | 首次创建时间 |
| `updatedAt` | ISO datetime | 是 | 最近更新时间 |

### 家庭账户 `accounts`

| 字段路径 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `accounts.familySpendingBalance` | number | 是 | 记录时家庭花销卡余额 |
| `accounts.familySavingsBalance` | number | 是 | 记录时家庭储蓄卡余额 |

### 双人分配 `people`

`people.suli` 与 `people.chenqian` 使用相同字段：

| 字段路径后缀 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `.income` | number | 是 | 本月实际到账主动劳动收入 |
| `.householdTransfer` | number | 是 | 本月实际转入家庭账户总额 |
| `.privateKept` | number | 是 | 从本月收入中保留的个人可支配金额，不是个人账户总余额 |

### 钱迹支出汇总 `expense`

| 字段路径 | 类型 | 必填 | 口径 |
|---|---|---|---|
| `expense.autoTotal` | number | 否 | 钱迹 CSV 自动汇总的当月支出 |
| `expense.confirmedTotal` | number | 是 | 最终用于分析的家庭总支出，可人工修正 |
| `expense.recordCount` | integer | 否 | 纳入自动汇总的有效支出笔数 |
| `expense.categoryBreakdown` | object | 否 | 钱迹一级分类到金额的映射 |
| `expense.sourceFileName` | string | 否 | 钱迹文件名，仅用于追溯 |
| `expense.sourceMonths` | `YYYY-MM[]` | 否 | 上传文件中识别到的自然月 |
| `expense.importedAt` | ISO datetime | 否 | 最近一次 CSV 汇总时间 |

原始 CSV 行、交易对手、交易备注和明细均不进入状态对象。

### 月度快照示例

```json
{
  "month": "2026-08",
  "accounts": {
    "familySpendingBalance": 1240,
    "familySavingsBalance": 210000
  },
  "people": {
    "suli": {
      "income": 10000,
      "householdTransfer": 7500,
      "privateKept": 2500
    },
    "chenqian": {
      "income": 12000,
      "householdTransfer": 9000,
      "privateKept": 3000
    }
  },
  "expense": {
    "autoTotal": 2860.5,
    "confirmedTotal": 2860.5,
    "recordCount": 76,
    "categoryBreakdown": {
      "好好吃饭": 1180.5,
      "生活成本": 1420,
      "品质生活": 260
    },
    "sourceFileName": "QianJi_2026-08.csv",
    "sourceMonths": ["2026-08"],
    "importedAt": "2026-08-11T10:00:00.000Z"
  },
  "note": "本月无大额支出",
  "createdAt": "2026-08-11T10:00:00.000Z",
  "updatedAt": "2026-08-11T10:00:00.000Z"
}
```

## 3. 家庭设置 `HouseholdSettings`

| 字段路径 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `monthlyBudget` | number | 3000 | 家庭总支出的月度参考预算 |
| `savingsGoal` | number | 100000 | 家庭储蓄卡目标余额，可随时修改 |
| `theme` | enum | `system` | `system`、`light`、`dark` |
| `role` | enum | `manager` | 本地体验角色；正式权限由服务端会话决定 |
| `people.suli.name` | string | 酥梨 | 展示昵称，最多 20 字 |
| `people.chenqian.name` | string | 陈前 | 展示昵称，最多 20 字 |
| `people.*.workProfile` | `WorkProfile` | 见下表 | 用于生命时间换算 |

### 工作档案 `WorkProfile`

| 字段 | 类型 | 默认 | 口径 |
|---|---|---|---|
| `monthlyIncome` | number | 0 | 用于生命时间计算的参考税后月薪 |
| `workHours` | number | 0 | 每月在岗和工作时间 |
| `commuteHours` | number | 0 | 每月上下班通勤时间 |
| `workCosts` | number | 0 | 为工作不可避免支出的交通、餐饮、服装等成本 |

## 4. 派生指标

下表使用简写：`expense = expense.confirmedTotal`。

| 指标 | 公式 |
|---|---|
| 家庭总收入 | `suli.income + chenqian.income` |
| 家庭共同转入 | `suli.householdTransfer + chenqian.householdTransfer` |
| 家庭当月个人留存 | `suli.privateKept + chenqian.privateKept` |
| 个人未分配差额 | `income - householdTransfer - privateKept` |
| 家庭未分配差额 | `家庭总收入 - 家庭共同转入 - 家庭当月个人留存` |
| 家庭经营结余 | `家庭共同转入 - expense` |
| 预算剩余 | `monthlyBudget - expense` |
| 预算使用率 | `expense / monthlyBudget` |
| 储蓄卡净变化 | `本月储蓄卡余额 - 前一条月度记录的储蓄卡余额` |
| 家庭卡实际净变化 | `本月两张家庭卡余额合计 - 前一条记录两张卡余额合计` |
| 家庭卡解释差额 | `家庭卡实际净变化 - (家庭共同转入 - expense)` |
| 储蓄目标进度 | `familySavingsBalance / savingsGoal` |
| 个人实际时薪 | `(monthlyIncome - workCosts) / (workHours + commuteHours)` |
| 每赚 10 元所需分钟 | `10 / 个人实际时薪 * 60` |
| 家庭综合实际时薪 | `两人(monthlyIncome - workCosts)之和 / 两人(workHours + commuteHours)之和` |
| 家庭支出的生命小时 | `expense / 家庭综合实际时薪` |
| 周期累计收入/转入/支出 | 对所选自然月范围内已有 `snapshots` 求和 |
| 周期平均每月支出 | `周期累计支出 / 周期实际记录月份数` |
| 周期数据覆盖率 | `实际记录月份数 / 半年6个月或年度12个月` |
| 周期储蓄变化 | `期末储蓄卡余额 - 周期开始前最近记录的储蓄卡余额`；没有前置记录时使用期内首末记录 |
| 周期累计生命能量 | `周期累计支出 / 家庭综合实际时薪` |
| 周期分类结构 | 对周期内每月 `categoryBreakdown` 按一级分类求和 |

## 5. 校验与隐私边界

- 所有金额使用人民币元，允许两位小数，不允许负数。
- 月份必须唯一；覆盖已有月份前必须让管理者确认。
- 退款和不计收支记录不纳入钱迹汇总。
- 没有前一条记录时不计算环比和储蓄变化。
- 预算或储蓄目标为 `0` 时，对应比例按 `0` 显示。
- 实际时薪分母为 `0` 或扣除工作成本后的月薪不大于 `0` 时不计算生命时间。
- 原始钱迹 CSV、银行卡号、身份证号、阿里云 AccessKey 和访问密码禁止保存到业务状态中。
