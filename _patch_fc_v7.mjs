import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join, basename, relative } from "node:path";
import { execSync } from "node:child_process";

const INPUT = "D:\\CLAUDE\\finance-systerm\\PWA系统\\family-finance-fc-v6.zip";
const OUTPUT = "D:\\CLAUDE\\finance-systerm\\PWA系统\\family-finance-fc-v7.zip";
const WORK = "D:\\CLAUDE\\finance-systerm\\PWA系统\\_fc_build";

// Extract
if (existsSync(WORK)) rmSync(WORK, { recursive: true });
mkdirSync(WORK, { recursive: true });
execSync(`tar -xf "${INPUT}" -C "${WORK}"`, { shell: "powershell.exe", stdio: "inherit" });
// Actually use expand-archive
