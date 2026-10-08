"use strict";

// Dedicated Worker: owns every fetch loop, the adaptive-tuning brain, and
// source weighting/quarantine. Runs off the main thread so that 60-90
// concurrent streams reading response bodies never compete with the UI
// thread for event-loop time - stat DOM writes, layout, and repaints on the
// page can no longer stall or jitter a chunk's `reader.read()` loop.
//
// This worker is the single "brain" for the whole flood: it still does its
// own source picking/weighting/adaptive tuning internally (that logic isn't
// parallelized across multiple worker threads, because the bottleneck here
// is network bandwidth-delay product and server throughput, not JS/CPU time -
// reading a stream and incrementing a byte counter is cheap. What was
// actually expensive was sharing a thread with the DOM. One dedicated worker
// fixes that; a pool of workers would only add source-picking coordination
// overhead for no real throughput gain.
//
// Protocol (see script.js for the other side):
//   main -> worker: { type: "start" | "stop" | "resetStats" }
//                   { type: "setAggression", payload: { presetId } }
//   worker -> main: { type: "stats", payload: {...formatted display strings} }
//                   { type: "log", payload: { message, tone } }
//
// 2026 update: dropped Tailscale/Pi support entirely (was a manual "Home
// server priority" mode plus auto-probing of a personal server). With it
// gone there's only one source strategy left - performance-weighted across
// every registered source - so the whole source-profile abstraction that
// used to switch between "auto" and "tailnet" mixes is gone too. Every
// registered source is always in play; pickSource() just weighs them by
// measured real-world throughput.

const KB = 1024;
const MB = KB * KB;
const GB = MB * KB;

// Exact-byte downloads use the legacy 100 MiB request ceiling.
const DOWNLOAD_ENDPOINT = "https://data.totob12.com/__down";
const STATIC_SOURCES = [
  {
    id: "own-speedtest",
    label: "TotoB12 speed test",
    url: DOWNLOAD_ENDPOINT,
    mode: "exact",
    maxRequestBytes: 100 * MB,
    weight: 5,
    tier: "primary"
  }
];

const SOURCE_LOOKUP = {};
STATIC_SOURCES.forEach(registerSource);

// 2026 update: raised the ceiling now that this runs on desktops as well as
// phones, and now that there are 7 real download origins to spread workers
// across instead of 2. "Ludicrous" also got more headroom for the same
// reason - more origins means more workers actually have somewhere useful to
// go instead of queueing behind the same couple of sockets.
const AGGRESSION_PRESETS = [
  { id: "eco", label: "Calm drain", minWorkers: 4, maxWorkers: 14, minChunkMB: 8, maxChunkMB: 64 },
  { id: "balanced", label: "Balanced burn", minWorkers: 12, maxWorkers: 40, minChunkMB: 16, maxChunkMB: 160 },
  { id: "ludicrous", label: "Ludicrous flood", minWorkers: 24, maxWorkers: 72, minChunkMB: 48, maxChunkMB: 320 }
];

const CONFIG = {
  statsInterval: 1000,
  adaptInterval: 5000,
  workerMaintainInterval: 900,
  chunkHistoryLimit: 80,
  speedHistoryLimit: 160,
  chunkStepMB: 16,
  trendThreshold: 0.2,
  logLimit: 40,
  absoluteWorkerCap: 96,
  absoluteChunkCap: 768,
  burstExtraWorkers: 10,
  burstChunkBoost: 128,
  burstDuration: 20000,
  burstCooldown: 45000,
  burstSpeedDrop: 0.55,
  // A source gets permanently dropped for the rest of the session after this
  // many *consecutive* failures (a success resets the counter to 0). Before
  // this, a dead/CORS-blocked source would sit in an infinite 60s-capped
  // backoff loop forever, occasionally eating a worker's turn for nothing.
  maxConsecutiveFailuresBeforeDisable: 6
};

const workers = new Map();
let workerCounter = 0;
let statsTimer;
let adaptiveTimer;
let workerTicker;
let running = false;

const state = {
  running: false,
  workerTarget: AGGRESSION_PRESETS[2].minWorkers,
  limits: { ...AGGRESSION_PRESETS[2] },
  chunkMB: AGGRESSION_PRESETS[2].minChunkMB,
  totalNetworkBytes: 0,
  totalLogicalBytes: 0,
  lastNetworkBytes: 0,
  lastSampleTime: Date.now(),
  lastComputedSpeed: 0,
  peakSpeed: 0,
  speedSamples: [],
  chunkHistory: [],
  sourceStats: new Map(),
  sessionStart: null,
  sessionElapsed: 0,
  bestSpeed: 0,
  bestSnapshot: null,
  hasRecordedStats: false,
  statusText: "Idle",
  burst: {
    active: false,
    until: 0,
    lastTriggered: 0
  },
  connectionDownlink: null,
  sourceFailures: new Map(),
  sourcePerf: new Map()
};

self.onmessage = event => {
  const { type, payload } = event.data || {};
  switch (type) {
    case "start":
      startConsumption();
      break;
    case "stop":
      stopConsumption();
      break;
    case "resetStats":
      resetStats();
      break;
    case "setAggression": {
      const preset = AGGRESSION_PRESETS.find(p => p.id === payload?.presetId) || AGGRESSION_PRESETS[0];
      applyAggressionPreset(preset);
      break;
    }
    default:
      break;
  }
};

applyAggressionPreset(AGGRESSION_PRESETS[2]);
updateStatus("Idle");
postStats();

seedFromConnectionHints();
seedFromHardwareHints();

function startConsumption() {
  if (state.running) return;
  state.running = true;
  running = true;
  state.sessionStart = Date.now();
  state.lastNetworkBytes = state.totalNetworkBytes;
  state.lastSampleTime = Date.now();
  state.speedSamples = [];
  state.chunkHistory = [];
  state.hasRecordedStats = false;
  updateStatus("Calibrating");
  logEvent("Streams spooling up...");

  maintainWorkers();
  workerTicker = setInterval(maintainWorkers, CONFIG.workerMaintainInterval);
  statsTimer = setInterval(updateStats, CONFIG.statsInterval);
  adaptiveTimer = setInterval(runAdaptiveTuning, CONFIG.adaptInterval);
  updateStats();
}

function stopConsumption() {
  if (!state.running) return;
  state.running = false;
  running = false;
  if (state.sessionStart) {
    state.sessionElapsed += Date.now() - state.sessionStart;
  }
  state.sessionStart = null;
  state.hasRecordedStats = false;
  clearInterval(statsTimer);
  clearInterval(adaptiveTimer);
  clearInterval(workerTicker);
  workers.forEach(worker => {
    worker.retiring = true;
    worker.controller?.abort();
  });
  updateStats();
  updateStatus("Paused");
  logEvent("Streams paused.");
}

function resetStats() {
  state.totalNetworkBytes = 0;
  state.totalLogicalBytes = 0;
  state.lastNetworkBytes = 0;
  state.peakSpeed = 0;
  state.bestSpeed = 0;
  state.bestSnapshot = null;
  state.sourceStats.clear();
  state.speedSamples = [];
  state.chunkHistory = [];
  state.sessionElapsed = 0;
  state.sessionStart = state.running ? Date.now() : null;
  state.hasRecordedStats = false;
  state.lastComputedSpeed = 0;
  logEvent("Counters reset.");
  postStats();
}

function maintainWorkers() {
  if (!state.running) return;
  const cap = currentMaxWorkers();
  const chunkCap = currentMaxChunkMB();
  state.workerTarget = clamp(state.workerTarget, state.limits.minWorkers, cap);
  state.chunkMB = clamp(state.chunkMB, state.limits.minChunkMB, chunkCap);

  const active = getActiveWorkers();
  const deficit = state.workerTarget - active.length;
  if (deficit > 0) {
    for (let i = 0; i < deficit; i++) {
      spawnWorker();
    }
  } else if (deficit < 0) {
    for (let i = 0; i < Math.abs(deficit); i++) {
      retireWorker();
    }
  }
}

function spawnWorker() {
  const id = ++workerCounter;
  const worker = { id, retiring: false, controller: null };
  workers.set(id, worker);
  runWorker(worker);
}

function retireWorker() {
  const active = getActiveWorkers();
  if (!active.length) return;
  const worker = active[active.length - 1];
  worker.retiring = true;
  worker.controller?.abort();
}

async function runWorker(worker) {
  while (state.running && !worker.retiring) {
    const controller = new AbortController();
    worker.controller = controller;
    const descriptor = buildRequestDescriptor();
    try {
      await downloadChunk(worker, controller.signal, descriptor);
      recordSourceSuccess(descriptor.source.id);
    } catch (error) {
      if (error.name !== "AbortError" && state.running) {
        recordSourceFailure(descriptor.source.id);
        logEvent(`Worker ${worker.id} error on ${descriptor.source.label}: ${error.message}`, "warn");
      }
      await wait(400);
    } finally {
      worker.controller = null;
    }
  }
  workers.delete(worker.id);
}

async function downloadChunk(worker, signal, descriptor) {
  const startStamp = performance.now();
  const response = await fetch(descriptor.url, {
    method: "GET",
    cache: "no-store",
    redirect: "error",
    credentials: "omit",
    mode: "cors",
    signal,
    headers: descriptor.headers,
    // Fetch Priority hint: tells supporting browsers (Chromium, Firefox) not
    // to deprioritize these behind other page activity. Safe to pass even
    // where unsupported - it's just an ignored extra field there.
    priority: "high"
  });

  if (response.status !== 200 || response.redirected || response.url !== descriptor.url ||
      response.headers.get("content-type") !== "application/octet-stream" ||
      response.headers.get("content-length") !== String(descriptor.chunkBytes) ||
      response.headers.get("content-encoding") !== null) {
    throw new Error(`Invalid download response (HTTP ${response.status})`);
  }

  const reader = response.body?.getReader();
  let logicalBytes = 0;
  if (reader) {
    while (state.running && !worker.retiring) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        logicalBytes += value.byteLength;
      }
    }
  } else {
    const buffer = await response.arrayBuffer();
    logicalBytes = buffer.byteLength;
  }

  const encodedHeader = Number(response.headers.get("content-length"));
  const encodedBytes = Number.isFinite(encodedHeader) && encodedHeader > 0 ? encodedHeader : logicalBytes;
  const duration = (performance.now() - startStamp) / 1000;

  recordChunkStats({
    encodedBytes,
    logicalBytes,
    duration,
    sourceId: descriptor.source.id
  });
}

function buildRequestDescriptor() {
  const source = pickSource();
  if (source.url !== DOWNLOAD_ENDPOINT || typeof state.chunkMB !== "number" ||
      !Number.isFinite(state.chunkMB) || state.chunkMB <= 0) {
    throw new Error("Invalid download request");
  }
  const chunkBytes = Math.round(Math.min(state.chunkMB * MB, source.maxRequestBytes));
  const cacheBust = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const url = `${DOWNLOAD_ENDPOINT}?cb=${cacheBust}&bytes=${chunkBytes}`;
  return { source, url, headers: {}, chunkBytes };
}

function pickSource() {
  const pool = Object.values(SOURCE_LOOKUP).filter(source => !source.permanentlyDisabled);
  if (!pool.length) {
    // Every source has been permanently disabled - extremely unlikely with 7
    // independent origins, but better to retry against *something* than
    // throw and kill the worker's loop.
    return Object.values(SOURCE_LOOKUP)[0];
  }
  const available = pool.filter(source => !isQuarantined(source.id));
  const candidates = available.length ? available : pool; // don't fully starve if everything's backing off
  const desiredBytes = state.chunkMB * MB || MB * 8;
  const weights = candidates.map(source => computeSourceWeight(source, desiredBytes));
  let totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
  if (totalWeight <= 0) {
    return candidates[Math.floor(Math.random() * candidates.length)];
  }
  let roll = Math.random() * totalWeight;
  for (let i = 0; i < candidates.length; i++) {
    roll -= weights[i];
    if (roll <= 0) {
      return candidates[i];
    }
  }
  return candidates[candidates.length - 1];
}

function computeSourceWeight(source, desiredBytes) {
  // Real measured throughput (perf) is what actually moves the needle - no
  // source gets a manual thumb on the scale.
  const perf = state.sourcePerf.get(source.id) || 1;
  const rangeFactor = source.mode === "exact" ? 1.3 : source.supportsRange ? 1.1 : 0.8;
  const size = source.sizeBytes || desiredBytes;
  const ratio = size && desiredBytes ? Math.min(desiredBytes, size) / Math.max(desiredBytes, size) : 1;
  const chunkFactor = source.mode === "range" ? 0.9 + ratio : 1;
  return Math.max((source.weight || 1) * rangeFactor * chunkFactor * (1 + perf / 10), 0.05);
}

function isQuarantined(id) {
  const record = state.sourceFailures.get(id);
  return Boolean(record && record.until > Date.now());
}

function recordSourceFailure(id) {
  const source = SOURCE_LOOKUP[id];
  const record = state.sourceFailures.get(id) || { count: 0, until: 0 };
  record.count += 1;
  const backoffMs = Math.min(2000 * 2 ** (record.count - 1), 60000);
  record.until = Date.now() + backoffMs;
  state.sourceFailures.set(id, record);
  if (record.count === 3) {
    const label = source?.label || id;
    logEvent(`${label} backing off ${Math.round(backoffMs / 1000)}s after repeated errors`, "warn");
  }
  if (source && !source.permanentlyDisabled && record.count >= CONFIG.maxConsecutiveFailuresBeforeDisable) {
    source.permanentlyDisabled = true;
    logEvent(`${source.label} disabled for this session after ${record.count} consecutive failures`, "warn");
  }
}

function recordSourceSuccess(id) {
  if (state.sourceFailures.has(id)) {
    state.sourceFailures.delete(id);
  }
}

function recordChunkStats(chunk) {
  state.totalNetworkBytes += chunk.encodedBytes;
  state.totalLogicalBytes += chunk.logicalBytes;
  state.chunkHistory.push(chunk);
  if (state.chunkHistory.length > CONFIG.chunkHistoryLimit) {
    state.chunkHistory.shift();
  }
  const current = state.sourceStats.get(chunk.sourceId) || { bytes: 0, hits: 0 };
  current.bytes += chunk.encodedBytes;
  current.hits += 1;
  state.sourceStats.set(chunk.sourceId, current);
  updateSourcePerformance(chunk.sourceId, chunk.encodedBytes, chunk.duration);
}

function updateSourcePerformance(sourceId, bytes, duration) {
  if (!duration || duration <= 0) return;
  const throughput = bytes / duration / MB;
  const previous = state.sourcePerf.get(sourceId);
  const alpha = 0.3;
  const next = previous ? previous + alpha * (throughput - previous) : throughput;
  state.sourcePerf.set(sourceId, next);
}

function updateStats() {
  const now = Date.now();
  const elapsed = Math.max((now - state.lastSampleTime) / 1000, 0.001);
  const bytesSince = state.totalNetworkBytes - state.lastNetworkBytes;
  const mbPerSec = bytesSince / MB / elapsed;
  state.lastComputedSpeed = mbPerSec;
  state.peakSpeed = Math.max(state.peakSpeed, mbPerSec);

  state.lastSampleTime = now;
  state.lastNetworkBytes = state.totalNetworkBytes;

  if (state.running) {
    if (!state.hasRecordedStats) {
      state.hasRecordedStats = true;
      updateStatus("Running");
    }
    state.speedSamples.push({ time: now, speed: mbPerSec, workers: state.workerTarget });
    if (state.speedSamples.length > CONFIG.speedHistoryLimit) {
      state.speedSamples.shift();
    }
  }

  postStats();
}

function runAdaptiveTuning() {
  if (!state.running) return;
  tickBurstState();

  const recentSpeeds = state.speedSamples.slice(-8);
  if (recentSpeeds.length < 4) return;

  const avgSpeed = recentSpeeds.reduce((sum, sample) => sum + sample.speed, 0) / recentSpeeds.length;
  if (avgSpeed > state.bestSpeed) {
    state.bestSpeed = avgSpeed;
    state.bestSnapshot = { workers: state.workerTarget, chunkMB: state.chunkMB };
  }

  if (state.bestSnapshot && !state.burst.active && avgSpeed < state.bestSpeed * 0.8) {
    const { workers: bestWorkers, chunkMB: bestChunk } = state.bestSnapshot;
    let steered = false;
    if (state.workerTarget !== bestWorkers) {
      adjustWorkers(state.workerTarget < bestWorkers ? 1 : -1, "steering to best-known mix");
      steered = true;
    }
    if (state.chunkMB !== bestChunk) {
      adjustChunk(state.chunkMB < bestChunk ? CONFIG.chunkStepMB : -CONFIG.chunkStepMB, "steering to best-known mix");
      steered = true;
    }
    if (steered) return;
  }

  const trend = recentSpeeds[recentSpeeds.length - 1].speed - recentSpeeds[0].speed;
  if (trend > CONFIG.trendThreshold && state.workerTarget < currentMaxWorkers()) {
    adjustWorkers(2, "trend up");
    return;
  }
  if (trend < -CONFIG.trendThreshold && state.workerTarget > state.limits.minWorkers) {
    adjustWorkers(-1, "trend dip");
  }

  const slowestSample = recentSpeeds.reduce((min, sample) => Math.min(min, sample.speed), Number.POSITIVE_INFINITY);
  if (state.bestSpeed > 0 && slowestSample < state.bestSpeed * CONFIG.burstSpeedDrop) {
    if (maybeStartBurst("throughput sag")) {
      return;
    }
  }

  const chunkStats = getChunkAverages();
  if (chunkStats.avgDuration && chunkStats.avgDuration < 0.8 && state.chunkMB < currentMaxChunkMB()) {
    adjustChunk(CONFIG.chunkStepMB, "chunks finishing fast");
  } else if (chunkStats.avgDuration && chunkStats.avgDuration > 8 && state.chunkMB > state.limits.minChunkMB) {
    adjustChunk(-CONFIG.chunkStepMB, "chunks dragging");
  }
}

function getChunkAverages() {
  if (!state.chunkHistory.length) {
    return { avgDuration: 0, avgSizeMB: 0 };
  }
  const recent = state.chunkHistory.slice(-10);
  const avgDuration = recent.reduce((sum, chunk) => sum + chunk.duration, 0) / recent.length;
  const avgSizeMB = recent.reduce((sum, chunk) => sum + chunk.encodedBytes, 0) / recent.length / MB;
  return { avgDuration, avgSizeMB };
}

function adjustWorkers(delta, reason) {
  const next = clamp(state.workerTarget + delta, state.limits.minWorkers, currentMaxWorkers());
  if (next === state.workerTarget) return;
  state.workerTarget = next;
  maintainWorkers();
  logEvent(`Active stream target -> ${state.workerTarget}${reason ? ` (${reason})` : ""}`);
}

function adjustChunk(delta, reason) {
  const next = clamp(state.chunkMB + delta, state.limits.minChunkMB, currentMaxChunkMB());
  if (next === state.chunkMB) return;
  state.chunkMB = next;
  logEvent(`Chunk size -> ${state.chunkMB} MB${reason ? ` (${reason})` : ""}`);
  postStats();
}

function applyAggressionPreset(preset) {
  state.limits = { ...preset };
  state.workerTarget = clamp(state.workerTarget, state.limits.minWorkers, state.limits.maxWorkers);
  state.chunkMB = clamp(state.chunkMB, state.limits.minChunkMB, state.limits.maxChunkMB);
  if (state.running) {
    maintainWorkers();
    logEvent(`Preset switched to ${preset.label}`);
  }
  postStats();
}

function updateStatus(text) {
  state.statusText = text;
  postStats();
}

function getActiveWorkers() {
  return Array.from(workers.values()).filter(worker => !worker.retiring);
}

function logEvent(message, tone = "info") {
  postMessage({ type: "log", payload: { message, tone } });
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatDuration(ms) {
  const totalSeconds = Math.max(Math.floor(ms / 1000), 0);
  const hours = String(Math.floor(totalSeconds / 3600)).padStart(2, "0");
  const minutes = String(Math.floor((totalSeconds % 3600) / 60)).padStart(2, "0");
  const seconds = String(totalSeconds % 60).padStart(2, "0");
  return `${hours}:${minutes}:${seconds}`;
}

function currentMaxWorkers() {
  const burstAllowance = state.burst.active ? CONFIG.burstExtraWorkers : 0;
  return Math.min(state.limits.maxWorkers + burstAllowance, CONFIG.absoluteWorkerCap);
}

function currentMaxChunkMB() {
  const burstAllowance = state.burst.active ? CONFIG.burstChunkBoost : 0;
  return Math.min(state.limits.maxChunkMB + burstAllowance, CONFIG.absoluteChunkCap);
}

function tickBurstState() {
  if (state.burst.active && Date.now() > state.burst.until) {
    state.burst.active = false;
    state.workerTarget = clamp(state.workerTarget, state.limits.minWorkers, state.limits.maxWorkers);
    state.chunkMB = clamp(state.chunkMB, state.limits.minChunkMB, state.limits.maxChunkMB);
    logEvent("Burst cooled down");
    maintainWorkers();
  }
}

function maybeStartBurst(reason) {
  const now = Date.now();
  if (state.burst.active || now - state.burst.lastTriggered < CONFIG.burstCooldown) {
    return false;
  }
  state.burst.active = true;
  state.burst.until = now + CONFIG.burstDuration;
  state.burst.lastTriggered = now;
  state.workerTarget = clamp(state.workerTarget + 4, state.limits.minWorkers, currentMaxWorkers());
  state.chunkMB = clamp(state.chunkMB + CONFIG.chunkStepMB, state.limits.minChunkMB, currentMaxChunkMB());
  logEvent(`Burst mode engaged (${reason})`);
  maintainWorkers();
  return true;
}

function seedFromConnectionHints() {
  if (typeof navigator === "undefined") return;
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  if (!connection) return;

  const applyHint = (silent = false) => {
    const downlink = connection.downlink || connection.bandwidth;
    if (!downlink) return;
    state.connectionDownlink = downlink;
    const suggested = clamp(Math.round(downlink * 3), state.limits.minWorkers, currentMaxWorkers());
    if (suggested > state.workerTarget) {
      state.workerTarget = suggested;
      if (state.running) {
        maintainWorkers();
      }
      postStats();
      if (!silent) {
        logEvent(`Connection hint set workers to ${state.workerTarget}`);
      }
    }
  };

  applyHint(true);
  const handler = () => applyHint(false);
  if (typeof connection.addEventListener === "function") {
    connection.addEventListener("change", handler, { passive: true });
  } else {
    connection.onchange = handler;
  }
}

// On a many-core desktop, nudge the baseline worker target up so a fast
// wired connection isn't left sitting at the same starting point as a phone.
// Purely a starting point - the adaptive-tuning loop still steers from there
// based on measured throughput, same as it always did.
function seedFromHardwareHints() {
  if (typeof navigator === "undefined") return;
  const cores = navigator.hardwareConcurrency;
  if (!cores || cores < 8) return;
  const suggested = clamp(cores * 4, state.limits.minWorkers, currentMaxWorkers());
  if (suggested > state.workerTarget) {
    state.workerTarget = suggested;
    if (state.running) {
      maintainWorkers();
    }
    postStats();
  }
}

function registerSource(source) {
  SOURCE_LOOKUP[source.id] = source;
}

function buildSourceSummaryText() {
  const stats = Array.from(state.sourceStats.entries())
    .map(([id, data]) => ({ id, bytes: data.bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, 3);
  if (!stats.length) {
    return "Waiting for samples";
  }
  const parts = stats.map(entry => {
    const source = SOURCE_LOOKUP[entry.id];
    const gb = entry.bytes / GB;
    return `${source?.label || entry.id} (${gb.toFixed(2)} GB)`;
  });
  return parts.join(" / ");
}

function postStats() {
  const now = Date.now();
  const activeCount = getActiveWorkers().length;
  const burstSuffix = state.burst.active ? " +burst" : "";
  const activeMillis = state.sessionElapsed + (state.running && state.sessionStart ? now - state.sessionStart : 0);
  const statusState = state.running ? "running" : state.statusText.toLowerCase().replace(/\s+/g, "-");

  postMessage({
    type: "stats",
    payload: {
      downloadedSize: `${(state.totalNetworkBytes / GB).toFixed(3)} GB`,
      downloadSpeed: `${state.lastComputedSpeed.toFixed(2)} MB/s`,
      peakSpeed: `Peak ${state.peakSpeed.toFixed(2)} MB/s`,
      sessionDuration: formatDuration(activeMillis),
      workerCount: `${activeCount} / ${state.workerTarget}${burstSuffix}`,
      chunkSize: `${state.chunkMB} MB`,
      sourceSummary: buildSourceSummaryText(),
      statusText: state.statusText,
      statusState
    }
  });
}
