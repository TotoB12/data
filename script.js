(() => {
  "use strict";

  const KB = 1024;
  const MB = KB * KB;
  const GB = MB * KB;
  const PI_BASE = "https://data.tahr-vibe.ts.net";

  const STATIC_SOURCES = [
    {
      id: "bbb",
      label: "Big Buck Bunny (158 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4",
      sizeBytes: 158008374,
      supportsRange: true,
      weight: 3
    },
    {
      id: "sintel",
      label: "Sintel (215 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/Sintel.mp4",
      sizeBytes: 215330292,
      supportsRange: true,
      weight: 3
    },
    {
      id: "steel",
      label: "Tears of Steel (177 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/TearsOfSteel.mp4",
      sizeBytes: 185765954,
      supportsRange: true,
      weight: 2
    },
    {
      id: "elephant",
      label: "Elephants Dream (162 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/ElephantsDream.mp4",
      sizeBytes: 169612362,
      supportsRange: true,
      weight: 2
    },
    {
      id: "subaru",
      label: "Subaru Outback (46 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/SubaruOutbackOnStreetAndDirt.mp4",
      sizeBytes: 48051822,
      supportsRange: true,
      weight: 2
    },
    {
      id: "gti",
      label: "VW GTI Review (41 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/VolkswagenGTIReview.mp4",
      sizeBytes: 43780763,
      supportsRange: true,
      weight: 1
    },
    {
      id: "bullrun",
      label: "Bullrun Teaser (12 MB)",
      url: "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/WeAreGoingOnBullrun.mp4",
      sizeBytes: 13183260,
      supportsRange: true,
      weight: 1
    },
    {
      id: "jsdelivr",
      label: "JSDelivr fallback",
      url: "https://cdn.jsdelivr.net/npm/jquery@3.6.4/dist/jquery.min.js",
      sizeBytes: 88145,
      supportsRange: false,
      weight: 1,
      fallback: true
    }
  ];

  const PI_FILES = [
    { id: "pi-50", label: "Tailnet 50 MB", path: "/50M.bin", sizeBytes: 50 * MB },
    { id: "pi-200", label: "Tailnet 200 MB", path: "/200M.bin", sizeBytes: 200 * MB },
    { id: "pi-500", label: "Tailnet 500 MB", path: "/500M.bin", sizeBytes: 500 * MB },
    { id: "pi-1000", label: "Tailnet 1 GB", path: "/1G.bin", sizeBytes: 1000 * MB }
  ];

  const SOURCE_LOOKUP = {};
  STATIC_SOURCES.forEach(registerSource);

  const SOURCE_PROFILES = {
    auto: {
      label: "Auto mix (prefers Tailnet when ready)",
      ids: ["bbb", "sintel", "steel", "elephant", "subaru", "gti", "bullrun"],
      description: "Rotates big public files, but instantly switches to the Pi when reachable.",
      preferPi: "prepend"
    },
    heavy: {
      label: "Heaviest only",
      ids: ["sintel", "steel", "elephant", "bbb"],
      description: "Sticks to the largest clips and adds Tailnet bursts when available.",
      preferPi: "prepend"
    },
    tailnet: {
      label: "Tailnet priority",
      ids: [],
      fallbackIds: ["bbb", "sintel"],
      description: "Use the Pi server whenever it is reachable; remote files kick in only if it drops.",
      preferPi: "exclusive"
    },
    fallback: {
      label: "Remote CDN fallback",
      ids: ["bbb", "sintel", "steel", "elephant", "subaru", "gti", "bullrun", "jsdelivr"],
      description: "Ignore Tailnet and stay on public mirrors only.",
      preferPi: false
    }
  };

  const AGGRESSION_PRESETS = [
    { id: "eco", label: "Calm drain", minWorkers: 4, maxWorkers: 14, minChunkMB: 8, maxChunkMB: 64 },
    { id: "balanced", label: "Balanced burn", minWorkers: 10, maxWorkers: 26, minChunkMB: 16, maxChunkMB: 128 },
    { id: "ludicrous", label: "Ludicrous flood", minWorkers: 18, maxWorkers: 40, minChunkMB: 32, maxChunkMB: 256 }
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
    absoluteWorkerCap: 56,
    absoluteChunkCap: 512,
    burstExtraWorkers: 10,
    burstChunkBoost: 128,
    burstDuration: 20000,
    burstCooldown: 45000,
    burstSpeedDrop: 0.55,
    piProbeInterval: 60000,
    piProbeTimeout: 4500
  };

  const ui = {
    downloadedSize: document.getElementById("downloadedSize"),
    downloadSpeed: document.getElementById("downloadSpeed"),
    status: document.getElementById("status"),
    toggleButton: document.getElementById("toggleButton"),
    workerCount: document.getElementById("workerCount"),
    chunkSize: document.getElementById("chunkSize"),
    peakSpeed: document.getElementById("peakSpeed"),
    sessionDuration: document.getElementById("sessionDuration"),
    sourceSummary: document.getElementById("sourceSummary"),
    log: document.getElementById("activityLog"),
    aggressionSlider: document.getElementById("aggressionSlider"),
    aggressionLabel: document.getElementById("aggressionLabel"),
    sourceSelect: document.getElementById("sourceSelect"),
    clearLog: document.getElementById("clearLog"),
    sourceDescription: document.querySelector("[data-source-description]"),
    resetStats: document.getElementById("resetStats")
  };

  const workers = new Map();
  let workerCounter = 0;
  let statsTimer;
  let adaptiveTimer;
  let workerTicker;
  let piProbeIntervalId;

  const state = {
    running: false,
    workerTarget: AGGRESSION_PRESETS[2].minWorkers,
    limits: { ...AGGRESSION_PRESETS[2] },
    chunkMB: AGGRESSION_PRESETS[2].minChunkMB,
    allowedSourceIds: [],
    activeProfileKey: "auto",
    totalNetworkBytes: 0,
    totalLogicalBytes: 0,
    lastNetworkBytes: 0,
    lastSampleTime: Date.now(),
    peakSpeed: 0,
    speedSamples: [],
    chunkHistory: [],
    sourceStats: new Map(),
    sessionStart: null,
    sessionElapsed: 0,
    bestSpeed: 0,
    bestSnapshot: null,
    hasRecordedStats: false,
    burst: {
      active: false,
      until: 0,
      lastTriggered: 0
    },
    connectionDownlink: null,
    pi: {
      available: false,
      supportsRange: false,
      sourceIds: [],
      probing: false,
      lastError: null
    },
    sourcePerf: new Map()
  };

  ui.toggleButton?.addEventListener("change", () => {
    if (ui.toggleButton.checked) {
      startConsumption();
    } else {
      stopConsumption();
    }
  });

  ui.aggressionSlider?.addEventListener("input", event => {
    const preset = AGGRESSION_PRESETS[Number(event.target.value)] || AGGRESSION_PRESETS[0];
    ui.aggressionLabel.textContent = preset.label;
    applyAggressionPreset(preset);
  });

  ui.sourceSelect?.addEventListener("change", event => {
    setSourceProfile(event.target.value);
  });

  ui.clearLog?.addEventListener("click", () => {
    if (ui.log) {
      ui.log.innerHTML = "";
    }
  });

  ui.resetStats?.addEventListener("click", () => {
    resetStats();
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && state.running) {
      logEvent("Tab hidden - background throttling may occur.", "warn");
    }
  });

  setSourceProfile(ui.sourceSelect?.value || "auto", { silent: true });
  applyAggressionPreset(AGGRESSION_PRESETS[2]);
  if (ui.aggressionSlider) {
    ui.aggressionSlider.value = "2";
  }
  ui.aggressionLabel.textContent = AGGRESSION_PRESETS[2].label;
  updateStatus("Idle");

  seedFromConnectionHints();
  initPiProbing();

  function startConsumption() {
    if (state.running) return;
    state.running = true;
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
    ui.downloadedSize.textContent = "0.000 GB";
    ui.downloadSpeed.textContent = "0.00 MB/s";
    ui.peakSpeed.textContent = "Peak 0.00 MB/s";
    ui.sessionDuration.textContent = "00:00:00";
    renderSourceSummary();
    logEvent("Counters reset.");
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
    updateWorkerCard(active.length);
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
      try {
        await downloadChunk(worker, controller.signal);
      } catch (error) {
        if (error.name !== "AbortError" && state.running) {
          logEvent(`Worker ${worker.id} error: ${error.message}`, "warn");
        }
        await wait(400);
      } finally {
        worker.controller = null;
      }
    }
    workers.delete(worker.id);
  }

  async function downloadChunk(worker, signal) {
    const descriptor = buildRequestDescriptor();
    const startStamp = performance.now();
    const response = await fetch(descriptor.url, {
      cache: "no-store",
      mode: "cors",
      signal,
      headers: descriptor.headers,
      keepalive: true
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
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
    const chunkBytes = Math.min(state.chunkMB * MB, source.sizeBytes || state.chunkMB * MB);
    const headers = {};
    if (source.supportsRange && source.sizeBytes) {
      const maxStart = Math.max(source.sizeBytes - chunkBytes - 1, 0);
      const start = Math.floor(Math.random() * (maxStart || 1));
      const end = Math.min(source.sizeBytes - 1, start + chunkBytes - 1);
      headers.Range = `bytes=${start}-${end}`;
    }
    const cacheBust = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const url = source.url.includes("?") ? `${source.url}&cb=${cacheBust}` : `${source.url}?cb=${cacheBust}`;
    return { source, url, headers };
  }

  function pickSource() {
    const pool = state.allowedSourceIds.map(id => SOURCE_LOOKUP[id]).filter(Boolean);
    if (!pool.length) {
      return SOURCE_LOOKUP.jsdelivr;
    }
    const desiredBytes = state.chunkMB * MB || MB * 8;
    const weights = pool.map(source => computeSourceWeight(source, desiredBytes));
    let totalWeight = weights.reduce((sum, weight) => sum + weight, 0);
    if (totalWeight <= 0) {
      return pool[Math.floor(Math.random() * pool.length)];
    }
    let roll = Math.random() * totalWeight;
    for (let i = 0; i < pool.length; i++) {
      roll -= weights[i];
      if (roll <= 0) {
        return pool[i];
      }
    }
    return pool[pool.length - 1];
  }

  function computeSourceWeight(source, desiredBytes) {
    const perf = state.sourcePerf.get(source.id) || 1;
    const tailnetBoost = source.tailnet ? 3 : 1;
    const rangeFactor = source.supportsRange ? 1.2 : 0.85;
    const size = source.sizeBytes || desiredBytes;
    const ratio = size && desiredBytes ? Math.min(desiredBytes, size) / Math.max(desiredBytes, size) : 1;
    const chunkFactor = source.supportsRange ? 0.9 + ratio : 0.6 + ratio;
    return Math.max((source.weight || 1) * tailnetBoost * rangeFactor * chunkFactor * (1 + perf / 10), 0.1);
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
    ui.downloadSpeed.textContent = `${mbPerSec.toFixed(2)} MB/s`;
    state.peakSpeed = Math.max(state.peakSpeed, mbPerSec);
    ui.peakSpeed.textContent = `Peak ${state.peakSpeed.toFixed(2)} MB/s`;
    ui.downloadedSize.textContent = `${(state.totalNetworkBytes / GB).toFixed(3)} GB`;

    const activeMillis = state.sessionElapsed + (state.running && state.sessionStart ? now - state.sessionStart : 0);
    ui.sessionDuration.textContent = formatDuration(activeMillis);

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

    renderSourceSummary();
    updateWorkerCard();
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
    ui.chunkSize.textContent = `${state.chunkMB} MB`;
    logEvent(`Chunk size -> ${state.chunkMB} MB${reason ? ` (${reason})` : ""}`);
  }

  function applyAggressionPreset(preset) {
    state.limits = { ...preset };
    state.workerTarget = clamp(state.workerTarget, state.limits.minWorkers, state.limits.maxWorkers);
    state.chunkMB = clamp(state.chunkMB, state.limits.minChunkMB, state.limits.maxChunkMB);
    ui.chunkSize.textContent = `${state.chunkMB} MB`;
    if (state.running) {
      maintainWorkers();
      logEvent(`Preset switched to ${preset.label}`);
    }
  }

  function setSourceProfile(profileKey, opts = {}) {
    state.activeProfileKey = profileKey || "auto";
    applyCurrentSourceProfile(opts);
    if (state.running && !opts.silent) {
      const profile = SOURCE_PROFILES[state.activeProfileKey] || SOURCE_PROFILES.auto;
      logEvent(`Source mix -> ${profile.label}`);
    }
  }

  function applyCurrentSourceProfile(opts = {}) {
    const profile = SOURCE_PROFILES[state.activeProfileKey] || SOURCE_PROFILES.auto;
    const piIds = state.pi.sourceIds;
    let ids = [...profile.ids];

    if (state.pi.available && piIds.length) {
      if (profile.preferPi === "exclusive") {
        ids = [...piIds, ...(profile.fallbackIds || [])];
      } else if (profile.preferPi === "prepend") {
        ids = [...piIds, ...ids];
      } else if (profile.preferPi === "append") {
        ids = [...ids, ...piIds];
      }
    } else if (!state.pi.available && profile.preferPi === "exclusive") {
      ids = [...(profile.fallbackIds || []), ...ids];
    }

    if (profile.fallbackIds) {
      ids = [...ids, ...profile.fallbackIds];
    }

    ids.push("jsdelivr");
    state.allowedSourceIds = dedupe(ids).filter(id => SOURCE_LOOKUP[id]);
    if (!state.allowedSourceIds.length) {
      state.allowedSourceIds = ["jsdelivr"];
    }

    if (ui.sourceDescription) {
      const suffix = state.pi.available ? " Tailnet detected." : " Tailnet offline.";
      ui.sourceDescription.textContent = `${profile.description}${suffix}`;
    }

    if (!opts.silent && state.running) {
      maintainWorkers();
    }
  }

  function updateWorkerCard(activeCount = getActiveWorkers().length) {
    const burstSuffix = state.burst.active ? " +burst" : "";
    const tailnetSuffix = state.pi.available ? " tailnet" : "";
    ui.workerCount.textContent = `${activeCount} / ${state.workerTarget}${burstSuffix}${tailnetSuffix}`;
    ui.chunkSize.textContent = `${state.chunkMB} MB`;
  }

  function renderSourceSummary() {
    if (!ui.sourceSummary) return;
    const stats = Array.from(state.sourceStats.entries())
      .map(([id, data]) => ({ id, bytes: data.bytes }))
      .sort((a, b) => b.bytes - a.bytes)
      .slice(0, 3);
    if (!stats.length) {
      ui.sourceSummary.textContent = "Waiting for samples";
      return;
    }
    const parts = stats.map(entry => {
      const source = SOURCE_LOOKUP[entry.id];
      const gb = entry.bytes / GB;
      return `${source?.label || entry.id} (${gb.toFixed(2)} GB)`;
    });
    ui.sourceSummary.textContent = parts.join(" / ");
  }

  function updateStatus(text) {
    if (!ui.status) return;
    ui.status.textContent = text;
    if (ui.status.dataset) {
      ui.status.dataset.state = state.running ? "running" : text.toLowerCase().replace(/\s+/g, "-");
    }
  }

  function getActiveWorkers() {
    return Array.from(workers.values()).filter(worker => !worker.retiring);
  }

  function logEvent(message, tone = "info") {
    if (!ui.log) return;
    const entry = document.createElement("div");
    entry.className = `log-entry log-${tone}`;
    entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    ui.log.prepend(entry);
    while (ui.log.childElementCount > CONFIG.logLimit) {
      ui.log.lastElementChild?.remove();
    }
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
    const tailnetFlex = state.pi.available ? 6 : 0;
    const burstAllowance = state.burst.active ? CONFIG.burstExtraWorkers : 0;
    return Math.min(state.limits.maxWorkers + tailnetFlex + burstAllowance, CONFIG.absoluteWorkerCap);
  }

  function currentMaxChunkMB() {
    const tailnetFlex = state.pi.available ? 64 : 0;
    const burstAllowance = state.burst.active ? CONFIG.burstChunkBoost : 0;
    return Math.min(state.limits.maxChunkMB + tailnetFlex + burstAllowance, CONFIG.absoluteChunkCap);
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
        } else {
          updateWorkerCard();
        }
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

  function initPiProbing() {
    probePiOnce();
    piProbeIntervalId = setInterval(probePiOnce, CONFIG.piProbeInterval);
  }

  async function probePiOnce() {
    if (state.pi.probing) return;
    state.pi.probing = true;
    const testUrl = `${PI_BASE}${PI_FILES[0].path}?probe=${Date.now()}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.piProbeTimeout);
    try {
      const response = await fetch(testUrl, {
        method: "HEAD",
        cache: "no-store",
        mode: "cors",
        signal: controller.signal
      });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const supportsRange = (response.headers.get("accept-ranges") || "").toLowerCase().includes("bytes");
      enablePiSources({ supportsRange });
    } catch (error) {
      disablePiSources(error);
    } finally {
      clearTimeout(timer);
      state.pi.probing = false;
    }
  }

  function enablePiSources(meta = {}) {
    PI_FILES.forEach(file => {
      const sourceDef = {
        id: file.id,
        label: file.label,
        url: `${PI_BASE}${file.path}`,
        sizeBytes: file.sizeBytes,
        supportsRange: Boolean(meta.supportsRange),
        weight: 6,
        tailnet: true
      };
      registerSource(sourceDef);
    });
    if (!state.pi.available) {
      logEvent(`Tailnet server detected (${meta.supportsRange ? "range" : "full"} mode).`);
    }
    state.pi.available = true;
    state.pi.supportsRange = Boolean(meta.supportsRange);
    state.pi.sourceIds = PI_FILES.map(file => file.id);
    state.pi.lastError = null;
    applyCurrentSourceProfile();
    updateWorkerCard();
  }

  function disablePiSources(error) {
    state.pi.lastError = error ? error.message : null;
    if (state.pi.available) {
      state.pi.available = false;
      state.pi.sourceIds = [];
      const suffix = error ? ` (${error.message})` : "";
      logEvent(`Tailnet server unreachable${suffix}`, "warn");
      applyCurrentSourceProfile();
      updateWorkerCard();
    }
  }

  function registerSource(source) {
    SOURCE_LOOKUP[source.id] = source;
  }

  function dedupe(list) {
    return Array.from(new Set(list));
  }
})();
