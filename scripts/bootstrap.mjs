import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { buildAssets } from "./assets.mjs";

export async function ensureDatabase(api, accountId, name) {
  const databases = [];
  for (let page = 1; ; page++) {
    const batch = await api(`/accounts/${accountId}/d1/database?per_page=100&page=${page}`);
    databases.push(...batch);
    if (batch.length < 100) break;
    if (page >= 100) throw new Error("Database listing exceeded the setup safety bound.");
  }
  const existing = databases.filter(db => db.name === name);
  if (existing.length > 1) throw new Error("More than one database has this name. Select a unique DATA_WORKER_NAME.");
  if (existing[0]) return existing[0].uuid;
  return (await api(`/accounts/${accountId}/d1/database`, { method: "POST", body: JSON.stringify({ name }) })).uuid;
}

export async function ensureSecrets(api, accountId, name, supplied) {
  const path = `/accounts/${accountId}/workers/scripts/${name}/secrets`;
  const existing = await api(path);
  for (const key of ["BETTER_AUTH_SECRET", "RECEIPT_SECRET", "OTP_SECRET", "TURNSTILE_SECRET_KEY"]) {
    if (existing.some(secret => secret.name === key)) continue;
    const value = supplied[key] || (key !== "TURNSTILE_SECRET_KEY" ? randomBytes(32).toString("hex") : "");
    if (!value || value.length < 32) throw new Error(`Provide ${key} before initial deployment.`);
    await api(path, { method: "PUT", body: JSON.stringify({ name: key, type: "secret_text", text: value }) });
  }
}

function wrangler(args) {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../node_modules/wrangler/bin/wrangler.js", import.meta.url)), ...args], { stdio: "inherit", env: process.env });
  if (result.status !== 0) throw new Error("Wrangler did not finish successfully.");
}

async function main() {
  if (existsSync(new URL("../.env", import.meta.url))) process.loadEnvFile(fileURLToPath(new URL("../.env", import.meta.url)));
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  if (!accountId || !token) throw new Error("Set CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN in .env or the build environment.");
  const base = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
  let prior;
  try { prior = JSON.parse(await readFile(new URL("../.deploy/wrangler.json", import.meta.url), "utf8")); } catch { /* First setup. */ }
  const name = process.env.DATA_WORKER_NAME || prior?.name || base.name;
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) throw new Error("DATA_WORKER_NAME must use lowercase letters, digits and hyphens.");
  const vars = { ...base.vars, ...prior?.vars };
  for (const key of Object.keys(vars)) if (process.env[key] !== undefined) vars[key] = process.env[key];
  if (!vars.APP_ORIGIN.startsWith("https://") || vars.APP_ORIGIN.includes("localhost")) throw new Error("Set APP_ORIGIN to the HTTPS address of the deployed Worker.");
  if (!vars.TURNSTILE_SITE_KEY || vars.TURNSTILE_SITE_KEY.startsWith("1x000000")) throw new Error("Set a production TURNSTILE_SITE_KEY for this hostname.");
  if (!vars.EMAIL_FROM || vars.EMAIL_FROM.endsWith("@example.com")) throw new Error("Set EMAIL_FROM to an address on the verified sender domain.");
  const api = async (path, options = {}) => {
    const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, { ...options, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });
    const data = await response.json();
    if (!response.ok || !data.success) throw new Error(`Cloudflare request failed (${response.status}): ${data.errors?.[0]?.message || "check account permissions"}`);
    return data.result;
  };
  const secretPath = `/accounts/${accountId}/workers/scripts/${name}/secrets`;
  let oldSecrets = [];
  try { oldSecrets = await api(secretPath); } catch (e) { if (!String(e).includes("404")) throw e; }
  if (!oldSecrets.some(s => s.name === "TURNSTILE_SECRET_KEY") && !process.env.TURNSTILE_SECRET_KEY) throw new Error("Set TURNSTILE_SECRET_KEY for the initial deployment.");
  const databaseId = await ensureDatabase(api, accountId, name);
  const config = {
    ...base, account_id: accountId, name, main: "../src/worker.ts", vars,
    assets: { ...base.assets, directory: "../.output/public" },
    d1_databases: [{ ...base.d1_databases[0], database_name: name, database_id: databaseId, migrations_dir: "../migrations" }]
  };
  delete config.$schema;
  await mkdir(new URL("../.deploy/", import.meta.url), { recursive: true });
  const configPath = fileURLToPath(new URL("../.deploy/wrangler.json", import.meta.url));
  await writeFile(configPath, JSON.stringify(config, null, 2) + "\n");
  await buildAssets(vars);
  wrangler(["d1", "migrations", "apply", "DB", "--remote", "--config", configPath]);
  if (process.argv.includes("--deploy")) {
    wrangler(["deploy", "--config", configPath]);
    await ensureSecrets(api, accountId, name, process.env);
    console.log(`Deployed ${name}. Existing database and secrets were preserved. Ranking: ${vars.RANKED_ENABLED}.`);
  } else console.log("Database and deployment config are ready. Run npm run deploy to publish the Worker.");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
