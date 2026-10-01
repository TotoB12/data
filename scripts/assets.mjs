import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export async function buildAssets(config = {}) {
  await mkdir(new URL("../.output/public/", import.meta.url), { recursive: true });
  for (const file of ["index.html", "style.css", "script.js", "flood-worker.js", "accounts.js", "ranked-worker.js", "manifest.json", "D.png", "fonts", "_headers"]) {
    await cp(new URL(`../${file}`, import.meta.url), new URL(`../.output/public/${file}`, import.meta.url), { recursive: true });
  }
  await writeFile(new URL("../.output/public/app-config.json", import.meta.url), JSON.stringify({
    api: true,
    turnstileSiteKey: config.TURNSTILE_SITE_KEY || "1x00000000000000000000AA",
    rankedEnabled: config.RANKED_ENABLED === "true"
  }));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildAssets(JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8")).vars);
}
