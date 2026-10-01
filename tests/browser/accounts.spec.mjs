import { test, expect } from "@playwright/test";

const periods = { daily: [{ alias: "Alice", bytes: 1024 ** 3 }], weekly: [{ alias: "Bob", bytes: 2 * 1024 ** 3 }], monthly: [], allTime: [{ alias: "Alice", bytes: 3 * 1024 ** 3 }] };

test("login uses two calls and all four boards share one lazy request", async ({ page, context }, testInfo) => {
  let sends = 0; let verifies = 0; let boardRequests = 0;
  await context.route("**/app-config.json", route => route.fulfill({ json: { api: true, rankedEnabled: false, turnstileSiteKey: "local" } }));
  await context.route("https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit", route => route.fulfill({ contentType: "application/javascript", body: "window.turnstile = { render: () => 1, reset: () => {}, getResponse: () => 'mock-local-verification' };" }));
  await context.route("**/api/auth/email-otp/send-verification-otp", async route => { sends++; await route.fulfill({ json: { success: true } }); });
  await context.route("**/api/auth/sign-in/email-otp", async route => { verifies++; await route.fulfill({ json: { profile: { alias: "Flood-Alice", totalBytes: 0 } } }); });
  await context.route("**/api/leaderboards", async route => { boardRequests++; await route.fulfill({ json: { generatedAt: new Date().toISOString(), periods } }); });
  const requests = [];
  page.on("request", request => { if (request.url().includes("/api/")) requests.push(request.url()); });
  await page.goto("/");
  await expect(page.locator("#rankedMode")).toBeDisabled();
  expect(boardRequests).toBe(0);
  await page.getByRole("button", { name: "Sign in with email" }).click();
  await page.getByLabel("Email address").fill("alice@example.com");
  await page.getByRole("button", { name: "Send sign-in code" }).click();
  await page.getByLabel("Sign-in code", { exact: true }).fill("123456");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.locator("#accountName")).toHaveText("Flood-Alice");
  expect(sends).toBe(1); expect(verifies).toBe(1);
  await page.getByText("Leaderboard", { exact: true }).click();
  await expect(page.getByRole("cell", { name: "Alice", exact: true })).toBeVisible();
  await page.getByLabel("Period", { exact: true }).selectOption("weekly");
  await expect(page.getByRole("cell", { name: "Bob", exact: true })).toBeVisible();
  await page.getByLabel("Period", { exact: true }).selectOption("allTime");
  expect(boardRequests).toBe(1);
  expect(requests).toHaveLength(3);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath("accounts-and-board.png"), fullPage: true });
});

test("ranked worker uses a control socket and one framed download", async ({ page, context }, testInfo) => {
  await context.addInitScript(() => localStorage.setItem("data-profile", JSON.stringify({ alias: "Flood-Alice", totalBytes: 0 })));
  await context.route("**/app-config.json", route => route.fulfill({ json: { api: true, rankedEnabled: true, turnstileSiteKey: "local" } }));
  let downloads = 0;
  await context.addCookies([{ name: "data-test", value: testInfo.project.name, url: "http://127.0.0.1:8787" }]);
  const at = Date.now();
  const proof = { v: 1, uid: "alice", run: "local-run", day: new Date(at).toISOString().slice(0, 10), bytes: 16384, at, redeem: at + 86400000 };
  const token = Buffer.from(JSON.stringify(proof)).toString("base64url") + ".test-signature";
  function frame(type, bytes) { const h = Buffer.alloc(5); h[0] = type; h.writeUInt32BE(bytes.length, 1); return Buffer.concat([h, bytes]); }
  await context.route("**/api/download", async route => {
    downloads++;
    expect(route.request().headers()["x-data-grant"]).toBe("bounded-test-grant");
    await route.fulfill({ contentType: "application/octet-stream", body: Buffer.concat([frame(1, Buffer.alloc(16384)), frame(2, Buffer.from(token)), frame(3, Buffer.alloc(0))]) });
  });
  await page.goto("/");
  await page.getByLabel("Ranked downloads").check();
  await page.getByLabel("Data storm toggle").check({ force: true });
  await expect(page.locator("#accountNotice")).toContainText("Ranked run finished", { timeout: 10000 });
  const state = await (await page.request.get(`/__test/state?key=${testInfo.project.name}`)).json();
  expect(state.sockets).toBe(1); expect(downloads).toBe(1); expect(state.checkpoints).toBe(1);
  await expect(page.locator("#toggleButton")).not.toBeChecked();
  await page.screenshot({ path: testInfo.outputPath("ranked-complete.png"), fullPage: true });
});
