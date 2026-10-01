import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest(async () => ({
    wrangler: { configPath: "./wrangler.jsonc" },
    miniflare: { bindings: {
      TEST_MIGRATIONS: await readD1Migrations("./migrations"),
      BETTER_AUTH_SECRET: "test-auth-secret-00000000000000000000",
      RECEIPT_SECRET: "test-receipt-secret-00000000000000000",
      OTP_SECRET: "test-otp-secret-000000000000000000000",
      TURNSTILE_SECRET_KEY: "test-turnstile"
    } }
  }))],
  test: { include: ["tests/**/*.test.ts"], testTimeout: 15000 }
});
