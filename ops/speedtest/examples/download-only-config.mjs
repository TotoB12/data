// For @cloudflare/speedtest@1.14.1 only. Example configuration, NOT a UI,
// published harness, or network-running script. Construct the engine separately
// after explicit user consent and call play() only when ready to spend traffic.
export const downloadOnlyConfig = {
  autoStart: false,
  downloadApiUrl: 'https://data.totob12.com/__down',
  // 1.14.1 requires a truthy upload URL even for download/latency phases.
  // Reserved .invalid targets replace defaults; the schedule never uses them.
  uploadApiUrl: 'https://disabled.invalid/__up',
  turnServerUri: 'disabled.invalid:9',
  turnServerCredsApiUrl: 'https://disabled.invalid/turn-creds',
  turnServerUser: null,
  turnServerPass: null,
  rpkiInvalidHost: 'disabled.invalid',
  logMeasurementApiUrl: null,
  logAimApiUrl: null,
  authorizationEnabled: false,
  authorizationToken: null,
  allowInsecureAuthorizationToken: false,
  includeCredentials: false,
  estimatedServerTime: 0,
  measureDownloadLoadedLatency: true,
  measureUploadLoadedLatency: false,
  measurements: [
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 100000, count: 1, bypassMinDuration: true },
    { type: 'latency', numPackets: 20 },
    { type: 'download', bytes: 100000, count: 9 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 1000000, count: 8 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 10000000, count: 6 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 25000000, count: 4 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 100000000, count: 3 },
    { type: 'latency', numPackets: 2 },
    { type: 'download', bytes: 250000000, count: 2 },
  ],
};

export default downloadOnlyConfig;
