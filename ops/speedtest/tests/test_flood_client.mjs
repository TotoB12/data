// Offline endpoint-compatibility tests: production worker in a VM.
// Fetch and response readers are mocks; no sockets, SDK, or live requests.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { test } from 'node:test';
const root = new URL('../../../', import.meta.url);
const workerCode = readFileSync(new URL('flood-worker.js', root), 'utf8');
const legacyCode = execFileSync('git', ['show', '48652e9:flood-worker.js'], { cwd: root, encoding: 'utf8' });
const productionCode = execFileSync('git', ['show', '61b066a:flood-worker.js'], { cwd: root, encoding: 'utf8' });
const endpoint = 'https://data.totob12.com/__down';
const MB = 1024 * 1024;
const fixedTime = 1700000000000;
const fixedRandom = 0.5;
const cacheBust = `${fixedTime.toString(36)}-${fixedRandom.toString(36).slice(2)}`;
function harness(fetcher = () => { throw Error('unexpected fetch'); }, code = workerCode) {
  const calls = [], messages = [];
  const context = vm.createContext({
    self: {}, navigator: {}, AbortController, performance: { now: () => 1000 },
    postMessage: message => messages.push(message),
    fetch: async (url, options) => { calls.push({ url, options }); return fetcher(url, options); },
    setInterval: () => 1, clearInterval() {}, setTimeout: () => 1
  });
  vm.runInContext(`Date.now = () => ${fixedTime}; Math.random = () => ${fixedRandom};`, context);
  vm.runInContext(code, context);
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
function descriptor(h) {
  return JSON.parse(h.eval('JSON.stringify(buildRequestDescriptor())'));
}

test('initialization stays idle without fetching or starting streams', () => {
  const h = harness();
  assert.equal(h.calls.length, 0);
  assert.equal(h.eval('state.running'), false);
  assert.equal(h.eval('workers.size'), 0);
  assert(h.messages.some(m => m.type === 'stats' && m.payload.statusText === 'Idle'));
});

test('all reachable MiB targets exactly match the old descriptor on our endpoint', () => {
  const h = harness();
  const legacy = harness(undefined, legacyCode);
  // Keep only the historical exact source; change its identity/URL to our own.
  legacy.eval(`Object.keys(SOURCE_LOOKUP).forEach(id => delete SOURCE_LOOKUP[id]);
    registerSource({ ...STATIC_SOURCES[0], id: 'own-speedtest', label: 'TotoB12 speed test', url: '${endpoint}' });`);
  let targets = 0;
  for (let targetMiB = 8; targetMiB <= 448; targetMiB += 8) {
    targets++;
    for (const time of [fixedTime, fixedTime + 123]) {
      for (const random of [0.125, fixedRandom, 0.875]) {
        for (const worker of [h, legacy]) {
          worker.eval(`state.chunkMB = ${targetMiB}; Date.now = () => ${time}; Math.random = () => ${random};`);
        }
        const actual = descriptor(h);
        const expected = descriptor(legacy);
        assert.equal(actual.chunkBytes, Math.round(Math.min(targetMiB * MB, 100 * MB)), `${targetMiB} MiB`);
        const { chunkBytes, ...legacyShape } = actual;
        assert.deepEqual(legacyShape, expected, `${targetMiB} MiB, time=${time}, random=${random}`);
        assert.equal(actual.source.maxRequestBytes, 104857600);
        assert.deepEqual(actual.headers, {});
      }
    }
  }
  assert.equal(targets, 56);
  assert.doesNotMatch(workerCode, /speed\.cloudflare\.com|hetzner|DOWNLOAD_SIZES|headers\.Range/i);
});

test('exact bytes round without decimal-fixture quantization and retain invalid target guard', () => {
  const h = harness();
  for (const desired of [100000, 1000000, 10000000, 25000000, 100000000,
    8 * MB + 0.4, 8 * MB + 0.6, 100 * MB, 250000000, 768 * MB, Number.MAX_VALUE]) {
    h.eval(`state.chunkMB = ${desired} / MB`);
    const expected = Math.round(Math.min(desired, 100 * MB));
    const actual = descriptor(h);
    assert.equal(actual.url, `${endpoint}?cb=${cacheBust}&bytes=${expected}`);
    assert.equal(actual.chunkBytes, expected);
    assert.deepEqual(actual.headers, {});
  }
  for (const value of ['NaN', 'Infinity', '-Infinity', '-1', '0', '"100000"', 'undefined', 'null']) {
    h.eval(`state.chunkMB = ${value}`);
    assert.throws(() => h.eval('buildRequestDescriptor()'), /Invalid download request/);
  }
  h.eval(`state.chunkMB = 8; STATIC_SOURCES[0].url = 'https://evil.invalid/__down'`);
  assert.throws(() => h.eval('buildRequestDescriptor()'), /Invalid download request/);
});

test('aggression settings and existing chunk display remain untouched', () => {
  const h = harness();
  assert.deepEqual(JSON.parse(h.eval('JSON.stringify(AGGRESSION_PRESETS)')), [
    { id: 'eco', label: 'Calm drain', minWorkers: 4, maxWorkers: 14, minChunkMB: 8, maxChunkMB: 64 },
    { id: 'balanced', label: 'Balanced burn', minWorkers: 12, maxWorkers: 40, minChunkMB: 16, maxChunkMB: 160 },
    { id: 'ludicrous', label: 'Ludicrous flood', minWorkers: 24, maxWorkers: 72, minChunkMB: 48, maxChunkMB: 320 }
  ]);
  for (const [preset, target] of [['eco', 8], ['balanced', 16], ['ludicrous', 48]]) {
    h.eval(`state.chunkMB = 1; applyAggressionPreset(AGGRESSION_PRESETS.find(p => p.id === '${preset}'))`);
    assert.equal(h.eval('state.chunkMB'), target);
    assert.equal(h.eval('buildRequestDescriptor().chunkBytes'), target * MB);
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
    { headers: { 'content-length': '42' } }, { headers: { 'content-length': `0${48 * MB}` } },
    { headers: { 'content-encoding': 'gzip' } }, { headers: { 'content-encoding': '' } }
  ]) {
    let res;
    const h = harness(url => (res = response(url, 48 * MB, overrides)));
    await assert.rejects(download(h));
    assert.equal(h.eval('state.totalNetworkBytes'), 0);
    assert.equal(h.eval('state.totalLogicalBytes'), 0);
    assert.equal(res.reads(), 0);
  }
});

test('valid endpoint response preserves current accounting and fetches with no-store', async () => {
  const h = harness(url => response(url, 48 * MB));
  await download(h);
  assert.equal(h.calls.length, 1);
  assert.equal(h.calls[0].url, `${endpoint}?cb=${cacheBust}&bytes=${48 * MB}`);
  assert.equal(h.calls[0].options.method, 'GET');
  assert.equal(h.calls[0].options.cache, 'no-store');
  assert.equal(h.calls[0].options.redirect, 'error');
  assert.equal(h.calls[0].options.credentials, 'omit');
  assert.equal(h.calls[0].options.mode, 'cors');
  assert.equal(h.calls[0].options.priority, 'high');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[0].options.headers)), {});
  assert.equal(h.eval('state.totalNetworkBytes'), 48 * MB); // existing header accounting, intentionally unchanged
  assert.equal(h.eval('state.totalLogicalBytes'), 0);
});

test('normalized production diff preserves all unrelated code and response validation', () => {
  const normalize = code => code
    .replace(/^\/\/ Only these positive decimal-byte fixtures are routed by our endpoint\.\n/m, '')
    .replace(/^\/\/ Exact-byte downloads use the legacy 100 MiB request ceiling\.\n/m, '')
    .replace(/^const DOWNLOAD_SIZES = .*;\n/m, '')
    .replace(/maxRequestBytes: (?:250000000|100 \* MB),/, 'maxRequestBytes: <request-cap>,')
    .replace(/function buildRequestDescriptor\(\) \{[\s\S]*?(?=\nfunction pickSource\(\))/, '<request-descriptor>\n');
  assert.equal(normalize(workerCode), normalize(productionCode));
});
