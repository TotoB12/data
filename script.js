(() => {
  "use strict";

  // 2026 update: this file used to run every fetch loop directly on the main
  // thread, competing with DOM/layout work for the same event loop at 40+
  // concurrent streams. All of that (source picking, adaptive tuning,
  // quarantine) now lives in flood-worker.js, a dedicated Web Worker. This
  // file is a thin controller: it forwards UI events to the worker and
  // renders whatever "stats" snapshots come back. Nothing here touches the
  // network directly anymore.

  const AGGRESSION_PRESETS = [
    { id: "eco", label: "Calm drain" },
    { id: "balanced", label: "Balanced burn" },
    { id: "ludicrous", label: "Ludicrous flood" }
  ];
  const DEFAULT_PRESET_INDEX = 2;

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
    clearLog: document.getElementById("clearLog"),
    resetStats: document.getElementById("resetStats")
  };

  let running = false;
  let worker;

  try {
    worker = new Worker("flood-worker.js");
  } catch (error) {
    logEvent(`Couldn't start the flood worker: ${error.message}`, "warn");
    updateStatusChip("Unavailable", "unavailable");
  }

  if (worker) {
    worker.addEventListener("message", event => {
      const { type, payload } = event.data || {};
      if (type === "stats") {
        renderStats(payload);
      } else if (type === "log") {
        logEvent(payload.message, payload.tone);
      }
    });

    worker.addEventListener("error", event => {
      logEvent(`Flood worker error: ${event.message || "unknown error"}`, "warn");
    });
  }

  function post(type, payload) {
    worker?.postMessage(payload === undefined ? { type } : { type, payload });
  }

  ui.toggleButton?.addEventListener("change", () => {
    running = ui.toggleButton.checked;
    post(running ? "start" : "stop");
  });

  ui.aggressionSlider?.addEventListener("input", event => {
    const preset = AGGRESSION_PRESETS[Number(event.target.value)] || AGGRESSION_PRESETS[0];
    ui.aggressionLabel.textContent = preset.label;
    post("setAggression", { presetId: preset.id });
  });

  ui.clearLog?.addEventListener("click", () => {
    if (ui.log) {
      ui.log.innerHTML = "";
    }
  });

  ui.resetStats?.addEventListener("click", () => {
    post("resetStats");
  });

  document.addEventListener("visibilitychange", () => {
    if (document.hidden && running) {
      logEvent("Tab hidden - background throttling may occur on some browsers.", "warn");
    }
  });

  if (ui.aggressionSlider) {
    ui.aggressionSlider.value = String(DEFAULT_PRESET_INDEX);
  }
  if (ui.aggressionLabel) {
    ui.aggressionLabel.textContent = AGGRESSION_PRESETS[DEFAULT_PRESET_INDEX].label;
  }
  updateStatusChip("Idle", "idle");

  function renderStats(payload) {
    if (!payload) return;
    if (ui.downloadedSize) ui.downloadedSize.textContent = payload.downloadedSize;
    if (ui.downloadSpeed) ui.downloadSpeed.textContent = payload.downloadSpeed;
    if (ui.peakSpeed) ui.peakSpeed.textContent = payload.peakSpeed;
    if (ui.sessionDuration) ui.sessionDuration.textContent = payload.sessionDuration;
    if (ui.workerCount) ui.workerCount.textContent = payload.workerCount;
    if (ui.chunkSize) ui.chunkSize.textContent = payload.chunkSize;
    if (ui.sourceSummary) ui.sourceSummary.textContent = payload.sourceSummary;
    updateStatusChip(payload.statusText, payload.statusState);
  }

  function updateStatusChip(text, stateAttr) {
    if (!ui.status) return;
    ui.status.textContent = text;
    if (ui.status.dataset) {
      ui.status.dataset.state = stateAttr;
    }
  }

  function logEvent(message, tone = "info") {
    if (!ui.log) return;
    const entry = document.createElement("div");
    entry.className = `log-entry log-${tone}`;
    entry.textContent = `${new Date().toLocaleTimeString()} - ${message}`;
    ui.log.prepend(entry);
    while (ui.log.childElementCount > 40) {
      ui.log.lastElementChild?.remove();
    }
  }
})();
