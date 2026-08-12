import { pbkdf2Sync } from "node:crypto";

const adminStored = "pbkdf2-sha256$210000$uGuz9sEQhyA1w47bW4meww==$/WSR+mM1uO96lVAiV67xlyeB3Uu9eAdeakjfYd2kRJc=";
const viewerStored = "pbkdf2-sha256$210000$uG9FFbjOHCWGNqndjTJfMQ==$0VWG5z0uvKFQsrZduQIAqktMziZtY3KWFyCZ0RsxNZ0=";

function test(label, stored, password) {
  const parts = stored.split("$");
  const iterations = Number(parts[1]);
  const salt = Buffer.from(parts[2], "base64");
  const expected = parts[3];
  const actual = pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("base64");
  const match = actual === expected;
  console.log(`${label}: "${password}" -> ${match ? "✅ 正确" : "❌ 错误"}`);
  if (!match) console.log(`  期望: ${expected.slice(0, 30)}...`);
  if (!match) console.log(`  实际: ${actual.slice(0, 30)}...`);
}

// 测试你输入的密码和附近拼写变体
test("管理", adminStored, "admin-281115");
test("管理", adminStored, "admin281115");
test("管理", adminStored, "admin-280115");
test("管理", adminStored, "Admin-281115");
test("查看", viewerStored, "chenqian-06151");
test("查看", viewerStored, "chenqian06151");
test("查看", viewerStored, "chenqian-0615");
