import { writeFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";

// Requires an already signed-in test session. Never creates accounts or sends emails.
const origin = process.env.BENCHMARK_ORIGIN;
const cookie = process.env.BENCHMARK_COOKIE;
const requested = Number(process.env.BENCHMARK_BYTES || 16 * 1024 ** 2);
if (!origin || !cookie || !Number.isSafeInteger(requested) || requested < 1024 || requested > 64 * 1024 ** 2) {
  throw new Error("Set BENCHMARK_ORIGIN and BENCHMARK_COOKIE; BENCHMARK_BYTES must be 1 KiB–64 MiB. Use an isolated benchmark Worker with MAX_RUN_BYTES set to that same value.");
}
const { WebSocket } = await import("ws");
const wsUrl = new URL("/api/control", origin); wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
const socket = new WebSocket(wsUrl, { headers: { Cookie: cookie, Origin: new URL(origin).origin }, perMessageDeflate: false });
const messages = [];
let waiting;
socket.on("message", data => {
  const message = JSON.parse(data.toString());
  if (waiting && (message.type === waiting.type || message.type === "error")) {
    const w = waiting; waiting = null; clearTimeout(w.timer);
    message.type === "error" ? w.reject(new Error(message.message)) : w.resolve(message);
  } else messages.push(message);
});
socket.on("error", error => { if (waiting) waiting.reject(error); });
function wait(type) {
  const existing = messages.findIndex(m => m.type === type);
  if (existing !== -1) return Promise.resolve(messages.splice(existing, 1)[0]);
  return new Promise((resolve, reject) => { waiting = { type, resolve, reject, timer: setTimeout(() => reject(new Error(`Timed out waiting for ${type}`)), 30000) }; });
}
try {
  await wait("ready");
  const grantResponse = wait("grant"); socket.send(JSON.stringify({ type: "start" }));
  const grant = await grantResponse;
  if (grant.maxBytes !== requested) throw new Error("The isolated Worker's MAX_RUN_BYTES must match BENCHMARK_BYTES exactly.");
  const started = performance.now();
  const stream = await fetch(new URL("/api/download", origin), { headers: { Cookie: cookie, "X-Data-Grant": grant.token }, signal: AbortSignal.timeout(60000) });
  if (!stream.ok) throw new Error(`Relay returned HTTP ${stream.status}`);
  const buffer = Buffer.from(await stream.arrayBuffer()); // Explicitly bounded experiment, at most 64 MiB.
  const relaySeconds = (performance.now() - started) / 1000;
  const receipts = new Map(); let payloadBytes = 0; let offset = 0;
  while (offset < buffer.length) {
    const type = buffer[offset]; const size = buffer.readUInt32BE(offset + 1); offset += 5;
    if (size > buffer.length - offset) throw new Error("Incomplete benchmark frame.");
    if (type === 1) payloadBytes += size;
    else if (type === 2) {
      const token = buffer.subarray(offset, offset + size).toString();
      const proof = JSON.parse(Buffer.from(token.split(".")[0], "base64url").toString());
      receipts.set(`${proof.run}:${proof.day}`, token);
    } else if (type === 4) throw new Error("Upstream relay failed.");
    offset += size;
  }
  if (payloadBytes !== requested) throw new Error("Relay payload volume did not match the bounded target.");
  await new Promise(resolve => setTimeout(resolve, 300));
  const ack = wait("accepted"); socket.send(JSON.stringify({ type: "checkpoint", receipts: [...receipts.values()] }));
  const accepted = await ack;
  const directStart = performance.now();
  const direct = await fetch(`https://speed.cloudflare.com/__down?bytes=${requested}&cb=${crypto.randomUUID()}`, { headers: { "Accept-Encoding": "identity" }, signal: AbortSignal.timeout(60000) });
  let directBytes = 0;
  for await (const chunk of direct.body) directBytes += chunk.byteLength;
  const directSeconds = (performance.now() - directStart) / 1000;
  const report = {
    at: new Date().toISOString(), requestedBytes: requested, payloadBytes, directBytes,
    incomingRunRequests: 2, relaySeconds, directSeconds,
    relayMiBs: payloadBytes / 1024 ** 2 / relaySeconds,
    directMiBs: directBytes / 1024 ** 2 / directSeconds,
    checkpointRowsRead: accepted.rowsRead, checkpointRowsWritten: accepted.rowsWritten,
    cpuMs: null, note: "CPU must be obtained from deployed Worker observability for BOTH invocations. This client measurement is not a quota or production throughput claim; repeat desktop/mobile browser comparisons separately."
  };
  await writeFile("benchmark-results.json", JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
} finally { socket.close(); }
