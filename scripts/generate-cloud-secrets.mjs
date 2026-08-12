import { pbkdf2Sync, randomBytes } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const rl = createInterface({ input, output });
try {
  const password = await rl.question("输入要生成哈希的密码（不会保存）：");
  if (password.length < 12) throw new Error("密码至少使用 12 个字符");
  const salt = randomBytes(16);
  const iterations = 210000;
  const hash = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  console.log(`pbkdf2-sha256$${iterations}$${salt.toString("base64")}$${hash.toString("base64")}`);
  console.log(`SESSION_SECRET=${randomBytes(48).toString("base64url")}`);
} finally {
  rl.close();
}
