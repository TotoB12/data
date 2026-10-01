import { numberSetting } from "./http";
import { signer, type Grant, type Receipt } from "./receipts";
import { finishRun } from "./scoring";

const MiB = 1024 ** 2;
const sources = [
  { id: "cf", url: "https://speed.cloudflare.com/__down", exact: true },
  ...["speed.hetzner.de", "fsn1-speed.hetzner.com", "nbg1-speed.hetzner.com", "hel1-speed.hetzner.com", "ash-speed.hetzner.com", "sin-speed.hetzner.com"]
    .map(host => ({ id: host, url: `https://${host}/1GB.bin`, exact: false }))
];

export function frameHeader(type: number, length: number): Uint8Array {
  const header = new Uint8Array(5);
  header[0] = type;
  new DataView(header.buffer).setUint32(1, length);
  return header;
}

type Slot = { reader: ReadableStreamDefaultReader<Uint8Array>; remaining: number };

export async function dataStream(env: Env, grant: Grant, ctx: ExecutionContext, fetcher: typeof fetch = fetch): Promise<Response> {
  const proof = await signer(env.RECEIPT_SECRET);
  const abort = new AbortController();
  const concurrency = numberSetting(env.UPSTREAM_CONCURRENCY, 1, 4);
  const slots: Slot[] = [];
  let total = 0;
  let reserved = 0;
  let day = "";
  let dayBytes = 0;
  let receipted = 0;
  let lastReceiptAt = Date.now();
  let requests = 0;
  let failures = 0;
  let cursor = 0;
  let closed = false;
  let streamController: ReadableStreamDefaultController<Uint8Array>;
  let idleTimer: ReturnType<typeof setTimeout>;

  const finalize = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(deadlineTimer);
    clearTimeout(idleTimer);
    abort.abort();
    await Promise.allSettled(slots.map(s => s.reader.cancel()));
    ctx.waitUntil(finishRun(env, grant).catch(() => { console.error("stream_cleanup_failed"); }));
  };
  const timeout = () => {
    streamController?.error(new Error("Stream deadline reached."));
    void finalize();
  };
  const deadlineTimer = setTimeout(timeout, Math.max(1, grant.end - Date.now()));
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(timeout, 30000); };

  async function openSlot(): Promise<Slot | null> {
    if (reserved >= grant.max || requests >= 256) return null;
    const size = Math.min(16 * MiB, grant.max - reserved);
    const source = sources[requests % sources.length];
    requests++;
    const url = new URL(source.url);
    url.searchParams.set("cb", crypto.randomUUID());
    const headers: Record<string, string> = { "Accept-Encoding": "identity", "Cache-Control": "no-cache" };
    if (source.exact) url.searchParams.set("bytes", String(size));
    else headers.Range = `bytes=0-${size - 1}`;
    const response = await fetcher(url, { headers, signal: abort.signal, redirect: "error", cache: "no-store" });
    try {
      const encoding = response.headers.get("Content-Encoding");
      if (encoding && encoding !== "identity") throw new Error("Encoded upstream response.");
      if (response.status !== (source.exact ? 200 : 206)) throw new Error("Unexpected upstream status.");
      const length = response.headers.get("Content-Length");
      if (length !== null && Number(length) !== size) throw new Error("Unexpected upstream length.");
      if (!source.exact) {
        const range = response.headers.get("Content-Range")?.match(/^bytes 0-(\d+)\/(\d+)$/);
        if (!range || Number(range[1]) !== size - 1 || !Number.isSafeInteger(Number(range[2])) || Number(range[2]) < size) throw new Error("Invalid upstream range.");
      }
      if (!response.body) throw new Error("Missing upstream body.");
      reserved += size;
      return { reader: response.body.getReader(), remaining: size };
    } catch (e) { await response.body?.cancel(); throw e; }
  }

  async function receipt(controller: ReadableStreamDefaultController<Uint8Array>) {
    if (!dayBytes || dayBytes === receipted) return;
    const at = Date.now();
    if (at > grant.end) return;
    const receiptDay = new Date(at).toISOString().slice(0, 10);
    if (receiptDay !== day) { dayBytes -= receipted; day = receiptDay; receipted = 0; }
    const value: Receipt = { ...grant, day, bytes: dayBytes, at };
    const token = await proof.sign(value, "receipt");
    const payload = new TextEncoder().encode(token);
    controller.enqueue(frameHeader(2, payload.byteLength));
    controller.enqueue(payload);
    receipted = dayBytes;
    lastReceiptAt = at;
  }

  const body = new ReadableStream<Uint8Array>({
    start(controller) { streamController = controller; resetIdle(); },
    async pull(controller) {
      resetIdle();
      try {
        if (closed) return;
        if (Date.now() >= grant.end) { timeout(); return; }
        const today = new Date().toISOString().slice(0, 10);
        if (day && day !== today) {
          // Unreceipted payload belongs to the day of its eventual receipt.
          dayBytes -= receipted; day = today; receipted = 0;
        }
        if (!day) day = today;
        if (dayBytes > receipted && (dayBytes - receipted >= 64 * MiB || Date.now() - lastReceiptAt >= 5000)) {
          await receipt(controller); return;
        }
        while (slots.length < concurrency && reserved < grant.max && requests < 256) {
          try { const slot = await openSlot(); if (slot) slots.push(slot); }
          catch (e) {
            if (abort.signal.aborted) throw e;
            if (++failures >= sources.length * 2) throw new Error("Download sources are unavailable.");
          }
        }
        if (!slots.length || total >= grant.max) {
          await receipt(controller);
          controller.enqueue(frameHeader(3, 0));
          controller.close(); await finalize(); return;
        }
        const index = cursor++ % slots.length;
        const slot = slots[index];
        const { done, value } = await slot.reader.read();
        if (closed) return;
        if (done) {
          if (slot.remaining !== 0) throw new Error("Incomplete upstream payload.");
          slot.reader.releaseLock(); slots.splice(index, 1); return;
        }
        if (value.byteLength > slot.remaining || value.byteLength > MiB) throw new Error("Invalid upstream chunk.");
        const receiptDay = new Date().toISOString().slice(0, 10);
        if (receiptDay !== day) { dayBytes -= receipted; day = receiptDay; receipted = 0; }
        slot.remaining -= value.byteLength;
        total += value.byteLength;
        dayBytes += value.byteLength;
        controller.enqueue(frameHeader(1, value.byteLength));
        controller.enqueue(value);
        if (total === grant.max) await receipt(controller);
      } catch {
        if (!closed) {
          await receipt(controller).catch(() => {});
          controller.enqueue(frameHeader(4, 0));
          controller.close();
        }
        await finalize();
      }
    },
    async cancel() { await finalize(); }
  }, { highWaterMark: 0 });
  return new Response(body, { headers: {
    "Content-Type": "application/octet-stream",
    "Content-Encoding": "identity",
    "Cache-Control": "private, no-store, no-transform",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer"
  }, encodeBody: "manual" });
}
