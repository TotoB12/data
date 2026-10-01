import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "tests/browser",
  use: { baseURL: "http://127.0.0.1:8787", browserName: "chromium" },
  webServer: { command: "npm run assets && node tests/browser/server.mjs", url: "http://127.0.0.1:8787", reuseExistingServer: false, timeout: 60000 },
  projects: [{ name: "desktop", use: { viewport: { width: 1280, height: 900 } } }, { name: "mobile", use: { viewport: { width: 390, height: 844 } } }]
});
