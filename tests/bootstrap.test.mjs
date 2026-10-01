import { test } from "node:test";
import assert from "node:assert/strict";
import { ensureDatabase, ensureSecrets } from "../scripts/bootstrap.mjs";

test("repeated provisioning preserves the database and signing/auth secrets", async () => {
  let database;
  const secrets = new Map();
  let creates = 0;
  const api = async (path, options) => {
    if (path.includes("/d1/database")) {
      if (!options) return database ? [database] : [];
      creates++; database = { uuid: "db-1", name: "data-test" }; return database;
    }
    if (!options) return [...secrets.keys()].map(name => ({ name }));
    const value = JSON.parse(options.body); secrets.set(value.name, value.text); return {};
  };
  const supplied = { TURNSTILE_SECRET_KEY: "test-secret-0000000000000000000000000" };
  assert.equal(await ensureDatabase(api, "account", "data-test"), "db-1");
  await ensureSecrets(api, "account", "data-test", supplied);
  const first = [...secrets.entries()];
  assert.equal(await ensureDatabase(api, "account", "data-test"), "db-1");
  await ensureSecrets(api, "account", "data-test", supplied);
  assert.equal(creates, 1); assert.deepEqual([...secrets.entries()], first);
});
