"use strict";

let socket;
let connecting;
let commandQueue = Promise.resolve();
let waiter;
let abort;
let running = false;
let total = 0;
let started = 0;
let previousBytes = 0;
let previousTime = 0;
let peak = 0;
let lastCommit = 0;
let commitPending = false;
let currentUserId;
const pending = new Map();
const dbPromise = new Promise((resolve, reject) => {
  const request = indexedDB.open("data-transfer-proofs", 1);
  request.onupgradeneeded = () => request.result.createObjectStore("proofs", { keyPath: "key" });
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error);
});

function emit(type, payload) { postMessage({ type, payload }); }
async function database(action, value) {
  const db = await dbPromise;
  return new Promise((resolve, reject) => {
    const tx = db.transaction("proofs", action === "all" ? "readonly" : "readwrite");
    const store = tx.objectStore("proofs");
    const request = action === "all" ? store.getAll() : action === "put" ? store.put(value) : store.delete(value);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
const loaded = (async () => {
  for (const proof of await database("all")) {
    if (proof.redeem < Date.now()) await database("delete", proof.key);
    else pending.set(proof.key, proof);
  }
})();

function tokenData(token) {
  return JSON.parse(atob(token.split(".")[0].replaceAll("-", "+").replaceAll("_", "/")));
}

async function connect() {
  if (socket?.readyState === WebSocket.OPEN) return;
  if (connecting) return connecting;
  connecting = new Promise((resolve, reject) => {
    const url = new URL("/api/control", self.location.origin);
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    socket = new WebSocket(url);
    let ready = false;
    socket.onmessage = event => {
      let message;
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.type === "ready") {
        ready = true;
        currentUserId = message.userId;
        emit("profile", message);
        resolve();
      } else if (waiter && (message.type === waiter.expected || message.type === "error")) {
        const current = waiter; waiter = null; clearTimeout(current.timeout);
        if (message.type === "error") current.reject(new Error(message.message));
        else current.resolve(message);
      }
    };
    socket.onerror = () => { if (!ready) reject(new Error("Sign in again to connect your account.")); };
    socket.onclose = () => {
      if (!ready) reject(new Error("Sign in again to connect your account."));
      if (waiter) { clearTimeout(waiter.timeout); waiter.reject(new Error("Account connection closed. Your saved proofs can be retried.")); waiter = null; }
      if (running) { running = false; abort?.abort(); emit("error", "Account connection closed. Restart to recover accepted progress."); }
    };
  }).finally(() => { connecting = null; });
  return connecting;
}

function command(message, expected) {
  const next = commandQueue.catch(() => {}).then(async () => {
    await connect();
    await new Promise(resolve => setTimeout(resolve, 300));
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { waiter = null; reject(new Error("Account request timed out.")); }, 30000);
      waiter = { expected, resolve, reject, timeout };
      socket.send(JSON.stringify(message));
    });
  });
  commandQueue = next;
  return next;
}

async function checkpoint(force = false) {
  if (commitPending || !pending.size || (!force && Date.now() - lastCommit < 120000)) return;
  commitPending = true;
  try {
    await loaded;
    const proofs = [...pending.values()].filter(p => p.uid === currentUserId && p.redeem >= Date.now()).slice(0, 8);
    if (!proofs.length) return;
    const response = await command({ type: "checkpoint", receipts: proofs.map(p => p.token) }, "accepted");
    lastCommit = Date.now();
    for (const accepted of response.acknowledgements) {
      const key = `${accepted.run}:${accepted.day}`;
      if ((pending.get(key)?.bytes || Infinity) <= accepted.bytes) {
        pending.delete(key); await database("delete", key);
      }
    }
    emit("accepted", response);
  } finally { commitPending = false; }
}

async function readFramed(response) {
  if (!response.ok) {
    let message = "The ranked stream could not start.";
    try { message = (await response.json()).error || message; } catch { /* Keep the HTTP failure readable. */ }
    throw new Error(message);
  }
  const reader = response.body.getReader();
  let buffer = new Uint8Array(0);
  let offset = 0;
  async function readExact(size) {
    const out = new Uint8Array(size);
    let written = 0;
    while (written < size) {
      if (offset >= buffer.length) {
        const next = await reader.read();
        if (next.done) throw new Error("Ranked stream ended before its final record.");
        buffer = next.value; offset = 0;
      }
      const count = Math.min(size - written, buffer.length - offset);
      out.set(buffer.subarray(offset, offset + count), written);
      offset += count; written += count;
    }
    return out;
  }
  async function discardPayload(size) {
    while (size) {
      if (offset >= buffer.length) {
        const next = await reader.read();
        if (next.done) throw new Error("Interrupted payload.");
        buffer = next.value; offset = 0;
      }
      const count = Math.min(size, buffer.length - offset);
      offset += count; size -= count; total += count;
    }
  }
  try {
    while (running) {
      const header = await readExact(5);
      const type = header[0];
      const size = new DataView(header.buffer).getUint32(1);
      if (type === 1 && size > 0 && size <= 1024 ** 2) await discardPayload(size);
      else if (type === 2 && size > 0 && size <= 2048) {
        const token = new TextDecoder().decode(await readExact(size));
        const proof = tokenData(token);
        const key = `${proof.run}:${proof.day}`;
        const record = { key, token, uid: proof.uid, bytes: proof.bytes, redeem: proof.redeem };
        pending.set(key, record);
        await database("put", record);
        if ([...pending.values()].filter(p => p.uid === currentUserId).length > 32) throw new Error("Too many unacknowledged runs. Reconnect to recover them before downloading more.");
      } else if (type === 3 && size === 0) return;
      else if (type === 4 && size === 0) throw new Error("The download source stopped. Completed proofs were retained.");
      else throw new Error("Invalid ranked stream record.");
    }
  } finally { await reader.cancel().catch(() => {}); }
}

async function start() {
  if (running) return;
  await loaded;
  await connect();
  if (pending.size) await checkpoint(true);
  const grant = await command({ type: "start" }, "grant");
  running = true;
  total = 0; peak = 0; started = previousTime = performance.now(); previousBytes = 0;
  abort = new AbortController();
  emit("started", { maxBytes: grant.maxBytes, deadline: grant.deadline });
  let failure;
  try {
    const response = await fetch("/api/download", { headers: { "X-Data-Grant": grant.token }, cache: "no-store", signal: abort.signal, credentials: "same-origin" });
    await readFramed(response);
  } catch (e) { if (e.name !== "AbortError") failure = e.message; }
  finally {
    running = false;
    try { await checkpoint(true); } catch (e) { emit("notice", e.message); }
    stats();
    emit("stopped", { message: failure || "Ranked run finished. Start again for another bounded run." });
  }
}

function stats() {
  const now = performance.now();
  const speed = (total - previousBytes) / Math.max(0.001, (now - previousTime) / 1000);
  previousBytes = total; previousTime = now; peak = Math.max(peak, speed);
  const seconds = started ? Math.floor((now - started) / 1000) : 0;
  emit("stats", {
    downloadedSize: `${(total / 1024 ** 3).toFixed(3)} GiB`, downloadSpeed: `${(speed / 1024 ** 2).toFixed(2)} MiB/s`,
    peakSpeed: `Peak ${(peak / 1024 ** 2).toFixed(2)} MiB/s`, workerCount: running ? "1 ranked stream" : "0 ranked streams",
    chunkSize: "16 MiB", sourceSummary: "Cloudflare / Hetzner relay",
    sessionDuration: [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(x => String(x).padStart(2, "0")).join(":"),
    statusText: running ? "Ranked download" : "Idle", statusState: running ? "running" : "idle"
  });
}
setInterval(() => {
  if (running) {
    stats();
    void checkpoint().catch(e => emit("notice", e.message));
  }
}, 1000);

self.addEventListener("message", event => {
  const { type } = event.data || {};
  if (type === "stop") { running = false; abort?.abort(); }
  else if (type === "close") { running = false; abort?.abort(); socket?.close(); }
  else if (type === "start") void start().catch(e => emit("error", e.message));
  else if (type === "profile") void connect().catch(e => emit("error", e.message));
  else if (type === "boards") void command({ type: "leaderboards" }, "leaderboards").then(r => emit("boards", r.data)).catch(e => emit("notice", e.message));
});
