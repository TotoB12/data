// Offline config assertions; import never instantiates or runs the engine.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import config from '../examples/download-only-config.mjs';

assert.equal(config.autoStart, false);
assert.equal(config.downloadApiUrl, 'https://data.totob12.com/__down');
// 1.14.1 requires a truthy upload URL even for latency/download engines.
assert.equal(config.uploadApiUrl, 'https://disabled.invalid/__up');
assert.equal(config.turnServerUri, 'disabled.invalid:9');
assert.equal(config.turnServerCredsApiUrl, 'https://disabled.invalid/turn-creds');
assert.equal(config.turnServerUser, null);
assert.equal(config.turnServerPass, null);
assert.equal(config.rpkiInvalidHost, 'disabled.invalid');
assert.equal(config.logMeasurementApiUrl, null);
assert.equal(config.logAimApiUrl, null);
assert.equal(config.authorizationEnabled, false);
assert.equal(config.authorizationToken, null);
assert.equal(config.allowInsecureAuthorizationToken, false);
assert.equal(config.includeCredentials, false);
assert.equal(config.estimatedServerTime, 0);
assert.equal(config.measureDownloadLoadedLatency, true);
assert.equal(config.measureUploadLoadedLatency, false);
assert(config.measurements.every(m => ['download', 'latency'].includes(m.type)));
const download = config.measurements.filter(m => m.type === 'download');
assert.deepEqual(download.map(m => [m.bytes, m.count]), [
  [100000, 1], [100000, 9], [1000000, 8], [10000000, 6],
  [25000000, 4], [100000000, 3], [250000000, 2],
]);
assert.equal(download[0].bypassMinDuration, true);
assert(download.every(m => m.bytes > 0 && m.count > 0));
assert.deepEqual(config.measurements.filter(m => m.type === 'latency').map(m => m.numPackets),
  [2, 20, 2, 2, 2, 2, 2]);
assert.equal(config.measurements[0].type, 'latency');
assert.equal(config.measurements[1].bypassMinDuration, true);
assert.equal(config.measurements[2].numPackets, 20);
const requestedDownloadBytes = download.reduce((sum, m) => sum + m.bytes * m.count, 0);
assert.equal(requestedDownloadBytes, 969000000);
// Optional real SDK compatibility check using an ALREADY cached official npm
// dist file. No install, browser, external requests, or dependency needed in CI.
if (process.argv[2]) {
  const sdkPath = resolve(process.argv[2]);
  const metadata = JSON.parse(readFileSync(resolve(dirname(sdkPath), '../package.json'), 'utf8'));
  assert.equal(metadata.name, '@cloudflare/speedtest');
  assert.equal(metadata.version, '1.14.1');
  const saved = { fetch: globalThis.fetch, window: globalThis.window, performance: globalThis.performance };
  let mockedCalls = 0;
  globalThis.window = { location: { origin: 'https://data.totob12.com' } };
  Object.defineProperty(globalThis, 'performance', { configurable: true, value: {
    now: () => saved.performance.now(), clearResourceTimings() {}, setResourceTimingBufferSize() {},
    getEntriesByName: name => [{ name, transferSize: 300, requestStart: 10, responseStart: 30,
      responseEnd: 30, connectStart: 0, connectEnd: 0, secureConnectionStart: 0, nextHopProtocol: 'h2' }],
  } });
  globalThis.fetch = async (url, options = {}) => {
    mockedCalls++;
    // Even attempted disabled uploads/TURN/logs would fail this offline test.
    assert.equal(url, 'https://data.totob12.com/__down?during=idle&bytes=0');
    assert.equal(options.method || 'GET', 'GET');
    return new Response('', { headers: { 'Content-Length': '0' } });
  };
  try {
    const { default: SpeedTest } = await import(pathToFileURL(sdkPath).href);
    class InspectConfig extends SpeedTest { get merged() { return this.config; } }
    const example = new InspectConfig(config);
    assert.equal(mockedCalls, 0); // autoStart false after the actual SDK merge
    for (const field of ['uploadApiUrl', 'turnServerUri', 'turnServerCredsApiUrl', 'turnServerUser',
      'turnServerPass', 'rpkiInvalidHost', 'logMeasurementApiUrl', 'logAimApiUrl']) {
      assert.equal(example.merged[field], config[field]);
    }
    assert.deepEqual(example.merged.measurements, config.measurements);
    // A latency phase constructs BandwidthEngine and validates the truthy
    // upload URL, but all fetches are intercepted before any transport.
    const engine = new SpeedTest({ ...config, measurements: [{ type: 'latency', numPackets: 1 }] });
    await new Promise((accept, reject) => {
      const timer = setTimeout(() => { engine.pause(); reject(new Error('Mock SDK timed out')); }, 3000);
      engine.onFinish = () => { clearTimeout(timer); accept(); };
      engine.onError = message => { clearTimeout(timer); reject(new Error(message)); };
      engine.play();
    });
    assert.equal(mockedCalls, 1);
    console.log(JSON.stringify({ sdkVersion: metadata.version, mergedConfigVerified: true,
      mockedFetchCalls: mockedCalls, networkRequests: 0 }));
  } finally {
    globalThis.fetch = saved.fetch;
    globalThis.window = saved.window;
    Object.defineProperty(globalThis, 'performance', { configurable: true, value: saved.performance });
  }
}
console.log(JSON.stringify({ ok: true, downloadRounds: download.length, requestedDownloadBytes, networkRequests: 0 }));
