// Offline endpoint-compatibility tests: unchanged production worker in a VM.
// Fetch and response readers are mocks; no sockets, SDK, or live requests.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const root = new URL('../../../', import.meta.url);
const workerCode = readFileSync(new URL('flood-worker.js', root), 'utf8');
const endpoint = 'https://data.totob12.com/__down';
const sizes = [100000, 1000000, 10000000, 25000000, 100000000, 250000000];
function harness(fetcher = () => { throw Error('unexpected fetch'); }) {
  const calls = [], messages = [];
  const context = vm.createContext({
    self: {}, navigator: {}, AbortController, performance: { now: () => 1000 }, Date,
    postMessage: message => messages.push(message),
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1
  });
  vm.runInContext(workerCode, context);
  return { calls, messages, eval: code => vm.runInContext(code, context),
    send: (type, payload) => context.self.onmessage({ data: { type, payload } }) };
}
function response(url, length, overrides = {}) {
  let reads = 0;
  const headers = { 'content-type': 'application/octet-stream', 'content-length': String(length), ...overrides.headers };
  return { status: 200, ok: true, url, redirected: false,
    body: { getReader: () => ({ async read() { reads++; return { done: true }; } }) },
    ...overrides, headers: { get: name => headers[name.toLowerCase()] ?? null },
    reads: () => reads };
}
function download(h) {
  h.eval('state.running = true; const testWorker = { id: 1, retiring: false };');
  return h.eval('downloadChunk(testWorker, new AbortController().signal, buildRequestDescriptor())');
}

test('initialization stays idle without fetching or starting streams', () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.eval('state.running'), false);
  assert.equal(h.eval('workers.size'), 0);
  assert(h.messages.some(m => m.type === 'stats' && m.payload.statusText === 'Idle'));
});

test('all supported positive sizes map to exact raw URLs; no cachebuster or Range', () => {
  const h = harness();
  for (const size of sizes) {
    for (const desired of [size, size - 1]) {
      h.eval(`state.chunkMB = ${desired} / MB`);
      assert.equal(h.eval('buildRequestDescriptor().url'), `${endpoint}?bytes=${size}`);
      assert.equal(h.eval('buildRequestDescriptor().chunkBytes'), size);
      assert.deepEqual(JSON.parse(h.eval('JSON.stringify(buildRequestDescriptor().headers)')), {});
    }
  }
  assert.doesNotMatch(workerCode, /speed\.cloudflare\.com|hetzner|cacheBust|headers\.Range/i);
});

test('quantization uses legacy MiB target, ceil selection, decimal fixture cap', () => {
  const h = harness();
  for (const [targetMiB, expected] of [[0.01, 100000], [1, 10000000], [8, 10000000],
    [16, 25000000], [48, 100000000], [100, 250000000], [320, 250000000], [768, 250000000]]) {
    h.eval(`state.chunkMB = ${targetMiB}`);
    assert.equal(h.eval('buildRequestDescriptor().url'), `${endpoint}?bytes=${expected}`);
  }
  for (const value of ['NaN', 'Infinity', '-1', '0', '"100000"', 'undefined']) {
    h.eval(`state.chunkMB = ${value}`);
    assert.throws(() => h.eval('buildRequestDescriptor()'));
  }
});

test('aggression settings and existing chunk display remain untouched', () => {
  const h = harness();
  assert.deepEqual(JSON.parse(h.eval('JSON.stringify(AGGRESSION_PRESETS)')), [
    { id: 'eco', label: 'Calm drain', minWorkers: 4, maxWorkers: 14, minChunkMB: 8, maxChunkMB: 64 },
    { id: 'balanced', label: 'Balanced burn', minWorkers: 12, maxWorkers: 40, minChunkMB: 16, maxChunkMB: 160 },
    { id: 'ludicrous', label: 'Ludicrous flood', minWorkers: 24, maxWorkers: 72, minChunkMB: 48, maxChunkMB: 320 }
  ]);
  for (const [preset, target, expected] of [['eco', 8, 10000000], ['balanced', 16, 25000000], ['ludicrous', 48, 100000000]]) {
    h.eval(`state.chunkMB = 1; applyAggressionPreset(AGGRESSION_PRESETS.find(p => p.id === '${preset}'))`);
    assert.equal(h.eval('state.chunkMB'), target);
    assert.equal(h.eval('buildRequestDescriptor().chunkBytes'), expected);
    assert.equal(h.messages.at(-1).payload.chunkSize, `${target} MB`);
  }
});

test('registry/picker including its existing disabled-source fallback is our endpoint only', () => {
  const h = harness();
  assert.equal(h.eval('STATIC_SOURCES.length'), 1);
  assert.equal(h.eval('pickSource().url'), endpoint);
  h.eval('recordSourceFailure(STATIC_SOURCES[0].id)');
  assert.equal(h.eval('pickSource().url'), endpoint);
  h.eval('STATIC_SOURCES[0].permanentlyDisabled = true');
  assert.equal(h.eval('pickSource().url'), endpoint);
});

test('HTML, status, redirect, encoding and mismatched length reject before reading/counting', async () => {
  for (const overrides of [
    { status: 206 }, { status: 500 }, { redirected: true }, { url: 'https://evil.invalid/__down' },
    { headers: { 'content-type': 'text/html' } }, { headers: { 'content-length': null } },
    { headers: { 'content-length': '42' } }, { headers: { 'content-length': '0100000000' } },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-encoding': '' } }
  ]) {
    let res;
    const h = harness(url => (res = response(url, 100000000, overrides)));
    await assert.rejects(download(h));
    assert.equal(h.eval('state.totalNetworkBytes'), 0);
    assert.equal(h.eval('state.totalLogicalBytes'), 0);
    assert.equal(res.reads(), 0);
  }
});

test('valid endpoint response preserves current accounting and fetches with no-store', async () => {
  const h = harness(url => response(url, 100000000));
  await download(h);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${endpoint}?bytes=100000000`);
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.cache, 'no-store');
  assert.equal(h.calls[0].options.redirect, 'error');
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.eval('state.totalNetworkBytes'), 100000000); // existing header accounting, intentionally unchanged
  assert.equal(h.eval('state.totalLogicalBytes'), 0);
});
