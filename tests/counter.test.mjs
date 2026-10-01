import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const source = await readFile(new URL("../flood-worker.js", import.meta.url), "utf8");
const functionText = source.slice(source.indexOf("async function downloadChunk("), source.indexOf("function buildRequestDescriptor("));
for (const failure of [false, true]) {
  test(`partial ${failure ? "abort" : "stop"} counts received bytes rather than Content-Length`, async () => {
    const recorded = [];
    let reads = 0;
    const state = { running: true };
    const context = vm.createContext({
      performance, state,
      recordChunkStats: value => recorded.push(value),
      fetch: async () => ({ ok: true, status: 200, headers: new Headers({ "Content-Length": "100" }), body: { getReader: () => ({
        async read() {
          if (!reads++) { if (!failure) state.running = false; return { done: false, value: new Uint8Array(40) }; }
          throw Object.assign(new Error("cancelled"), { name: "AbortError" });
        }, async cancel() {}
      }) } })
    });
    vm.runInContext(functionText, context);
    try { await context.downloadChunk({ retiring: false }, new AbortController().signal, { url: "https://mock.invalid", headers: {}, source: { id: "mock" } }); } catch (e) { assert.equal(e.name, "AbortError"); }
    assert.equal(recorded[0].logicalBytes, 40); assert.equal(recorded[0].encodedBytes, 40);
  });
}
