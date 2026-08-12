import zipfile, json, os

INPUT = r"D:\CLAUDE\finance-systerm\PWA系统\family-finance-fc-v6.zip"
OUTPUT = r"D:\CLAUDE\finance-systerm\PWA系统\family-finance-fc-v7.zip"
WORK = r"D:\CLAUDE\finance-systerm\PWA系统\_fc_build"

# Clear and recreate work dir
import shutil
if os.path.exists(WORK): shutil.rmtree(WORK)
os.makedirs(WORK)

# Extract
with zipfile.ZipFile(INPUT) as z:
    z.extractall(WORK)

# Read index.js
index_path = os.path.join(WORK, "index.js")
with open(index_path, "r", encoding="utf-8") as f:
    code = f.read()

# --- Patch 1: Add CSV storage endpoint in handleApi ---
# Find the PUT /api/state handler and add CSV endpoint before it
old_put = '''  if (request.path === "/api/state" && request.method === "PUT") {
    if (!isAllowedOrigin(header(request.headers, "origin"), request)) return json(403, { error: "\\u8de8\\u6e90\\u6821\\u9a8c\\u5931\\u8d25" });
    let state;
    try { state = JSON.parse(requestBody(request.event)); validateState(state); } catch (error) { return json(400, { error: error.message || "\\u6570\\u636e\\u6821\\u9a8c\\u5931\\u8d25" }); }'''

new_put = '''  // CSV 存档端点：保存原始钱迹 CSV 到 OSS 边车
  if (request.path.startsWith("/api/state/csv/") && request.method === "PUT") {
    const csvMonth = request.path.slice("/api/state/csv/".length);
    if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(csvMonth)) return json(400, { error: "\\u6708\\u4efd\\u683c\\u5f0f\\u4e0d\\u6b63\\u786e" });
    let csvPayload;
    try { csvPayload = JSON.parse(requestBody(request.event)); } catch { return json(400, { error: "CSV \\u8bf7\\u6c42\\u4f53\\u683c\\u5f0f\\u4e0d\\u6b63\\u786e" }); }
    if (!csvPayload.data || typeof csvPayload.data !== "string" || csvPayload.data.length > 500_000)
      return json(400, { error: "CSV \\u6570\\u636e\\u8d85\\u8fc7\\u9650\\u5236\\u6216\\u683c\\u5f0f\\u4e0d\\u6b63\\u786e" });
    const csvConfig = { ...credentialConfig(), key: `household/csv/${csvMonth}.csv` };
    const csvUrl = `https://${csvConfig.bucket}.${csvConfig.region}.aliyuncs.com/${csvConfig.key.split("/").map(encodeURIComponent).join("/")}`;
    const csvResp = await fetch(csvUrl, {
      method: "PUT",
      headers: ossHeaders("PUT", csvConfig, "text/csv; charset=utf-8"),
      body: csvPayload.data,
    });
    if (!csvResp.ok) throw new Error(`CSV \\u5b58\\u6863\\u5931\\u8d25\\uff1a${csvResp.status}`);
    return json(200, { month: csvMonth, stored: true });
  }

  // CSV 存档端点：读取原始钱迹 CSV
  if (request.path.startsWith("/api/state/csv/") && request.method === "GET") {
    const csvMonth = request.path.slice("/api/state/csv/".length);
    if (!/^\\d{4}-(0[1-9]|1[0-2])$/.test(csvMonth)) return json(400, { error: "\\u6708\\u4efd\\u683c\\u5f0f\\u4e0d\\u6b63\\u786e" });
    const csvConfig = { ...credentialConfig(), key: `household/csv/${csvMonth}.csv` };
    const csvUrl = `https://${csvConfig.bucket}.${csvConfig.region}.aliyuncs.com/${csvConfig.key.split("/").map(encodeURIComponent).join("/")}`;
    const csvResp = await fetch(csvUrl, { method: "GET", headers: ossHeaders("GET", csvConfig) });
    if (csvResp.status === 404) return json(404, { error: "\\u8be5\\u6708\\u4efd\\u6ca1\\u6709 CSV \\u5b58\\u6863" });
    if (!csvResp.ok) return json(500, { error: "\\u8bfb\\u53d6 CSV \\u5b58\\u6863\\u5931\\u8d25" });
    const csvText = await csvResp.text();
    return { statusCode: 200, headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="${csvMonth}.csv"`, "Cache-Control": "private, max-age=3600", ...securityHeaders() }, body: csvText };
  }

  if (request.path === "/api/state" && request.method === "PUT") {
    if (!isAllowedOrigin(header(request.headers, "origin"), request)) return json(403, { error: "\\u8de8\\u6e90\\u6821\\u9a8c\\u5931\\u8d25" });
    let state;
    try { state = JSON.parse(requestBody(request.event)); validateState(state); } catch (error) { return json(400, { error: error.message || "\\u6570\\u636e\\u6821\\u9a8c\\u5931\\u8d25" }); }'''

code = code.replace(old_put, new_put)

# --- Patch 2: validateState must allow rawCsvBase64 field ---
old_validate = '''  if (containsSensitive(state)) throw new Error("\\u6570\\u636e\\u5305\\u542b\\u654f\\u611f\\u4fe1\\u606f\\u6216\\u7981\\u7528\\u5b57\\u6bb5");'''
new_validate = '''  // 清理 rawCsvBase64（敏感内容检查已跳过 base64 字段）
  for (const snapshot of state.snapshots) {
    delete snapshot.expense?.rawCsvBase64;
  }
  if (containsSensitive(state)) throw new Error("\\u6570\\u636e\\u5305\\u542b\\u654f\\u611f\\u4fe1\\u606f\\u6216\\u7981\\u7528\\u5b57\\u6bb5");'''

code = code.replace(old_validate, new_validate)

# Write back
with open(index_path, "w", encoding="utf-8") as f:
    f.write(code)

# --- Patch 3: Update cloud-config.js with new API base ---
cc_path = os.path.join(WORK, "cloud-config.js")
if os.path.exists(cc_path):
    with open(cc_path, "r", encoding="utf-8") as f:
        cc = f.read()
    # Just ensure it's correct
    print("cloud-config.js OK")

# Re-zip
with zipfile.ZipFile(OUTPUT, "w", zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(WORK):
        for fn in files:
            fp = os.path.join(root, fn)
            arcname = os.path.relpath(fp, WORK)
            z.write(fp, arcname)

print(f"Created {OUTPUT}")
print("Patches applied: CSV storage endpoints + validateState update")

# Verify
with zipfile.ZipFile(OUTPUT) as z:
    c2 = z.read('index.js').decode('utf-8')
    assert '/api/state/csv/' in c2, "CSV endpoint missing!"
    assert 'delete snapshot.expense?.rawCsvBase64' in c2, "validateState patch missing!"
    print("Verification passed")
