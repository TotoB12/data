import { env } from "cloudflare:workers";
import { applyD1Migrations, createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { authFor, limit, profile } from "../src/auth";
import { signer, type Receipt } from "../src/receipts";
import { claimRun, createRun, credit, boards } from "../src/scoring";
import { dataStream } from "../src/stream";
import worker from "../src/worker";

const e = env as Env;
let now: number;
beforeAll(async () => { await applyD1Migrations(env.DB, env.TEST_MIGRATIONS); });
beforeEach(async () => {
  vi.restoreAllMocks();
  await e.DB.batch(["run_day_highwater", "runs", "user_day_totals", "profiles", "session", "account", "verification", "user", "budgets", "limits"].map(t => e.DB.prepare(`DELETE FROM ${t}`)));
  now = Date.now();
  for (const id of ["alice", "bob"]) {
    await e.DB.prepare("INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) VALUES(?,?,?,1,?,?)")
      .bind(id, id, `${id}@example.com`, new Date(now).toISOString(), new Date(now).toISOString()).run();
    await e.DB.prepare("INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,?,?,?,?,?)")
      .bind(`${id}-session`, new Date(now + 86400000).toISOString(), `${id}-token`, new Date(now).toISOString(), new Date(now).toISOString(), id).run();
    await profile(e.DB, id);
  }
});

async function receipt(bytes: number, overrides: Partial<Receipt> = {}) {
  const grant = await createRun(e, "alice", "alice-session", now);
  await claimRun(e, grant, "alice-session", now);
  const value: Receipt = { ...grant, bytes, day: new Date(now).toISOString().slice(0, 10), at: now, ...overrides };
  const s = await signer(e.RECEIPT_SECRET);
  return { grant, value, token: await s.sign(value, "receipt"), signer: s };
}

describe("proofs and atomic accounting", () => {
  it("credits concurrent, duplicated and out-of-order receipts exactly once", async () => {
    const { value, signer: s } = await receipt(100);
    const tokens = await Promise.all([100, 80, 120, 100].map(bytes => s.sign({ ...value, bytes }, "receipt")));
    await Promise.all(tokens.map(token => credit(e, "alice", "alice-session", [token])));
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(120);
    expect(await e.DB.prepare("SELECT credited_bytes FROM user_day_totals").first("credited_bytes")).toBe(120);
    const duplicate = await credit(e, "alice", "alice-session", [tokens[0]]);
    expect(duplicate.rowsWritten).toBe(0);
  });
  it("rejects altered, cross-account, wrong-purpose and expired tokens", async () => {
    const { token, value, signer: s } = await receipt(100);
    await expect(credit(e, "bob", "bob-session", [token])).rejects.toThrow("Invalid");
    await expect(credit(e, "alice", "alice-session", [token.slice(0, -4) + "aaaa"])).rejects.toThrow("Invalid");
    await expect(credit(e, "alice", "alice-session", [await s.sign(value, "grant")])).rejects.toThrow("Invalid");
    await expect(credit(e, "alice", "alice-session", [token], value.redeem + 1)).rejects.toThrow("expired");
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(0);
  });
  it("rejects unknown runs and revoked sessions without recreating credit", async () => {
    const { token, grant } = await receipt(100);
    await e.DB.prepare("DELETE FROM runs WHERE id = ?").bind(grant.run).run();
    await expect(credit(e, "alice", "alice-session", [token])).rejects.toThrow("unknown");
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(0);
  });
  it("rejects a proof after its session is revoked", async () => {
    const { token } = await receipt(100);
    await e.DB.prepare("DELETE FROM session WHERE id = 'alice-session'").run();
    await expect(credit(e, "alice", "alice-session", [token])).rejects.toThrow("authorized");
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(0);
  });
  it("recovers a lost acknowledgement and reports only public aliases", async () => {
    const { token } = await receipt(100);
    await credit(e, "alice", "alice-session", [token]);
    const retried = await credit(e, "alice", "alice-session", [token]);
    expect(retried.acknowledgements[0].bytes).toBe(100);
    const board = await boards(e);
    expect(JSON.stringify(board)).not.toContain("example.com");
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(100);
  });
  it("uses receipt issuance day for delayed redemption and calendar boards", async () => {
    const at = Date.parse("2026-09-30T23:59:58Z");
    const grant = await createRun(e, "alice", "alice-session", at);
    await claimRun(e, grant, "alice-session", at);
    const s = await signer(e.RECEIPT_SECRET);
    const token = await s.sign({ ...grant, bytes: 100, day: "2026-09-30", at }, "receipt");
    await credit(e, "alice", "alice-session", [token], at + 4000);
    const board = await boards(e, new Date("2026-10-01T00:00:02Z"));
    expect(board.periods.daily).toHaveLength(0);
    expect(board.periods.monthly).toHaveLength(0);
    expect(board.periods.weekly[0].bytes).toBe(100);
    expect(board.periods.allTime[0].bytes).toBe(100);
  });
});

describe("admission and quota protection", () => {
  it("claims a download only once and prevents concurrent account runs", async () => {
    const grant = await createRun(e, "alice", "alice-session");
    await expect(createRun(e, "alice", "alice-session")).rejects.toThrow("still active");
    await claimRun(e, grant, "alice-session");
    await expect(claimRun(e, grant, "alice-session")).rejects.toThrow("already used");
    await expect(createRun(e, "alice", "alice-session")).rejects.toThrow("still active");
  });
  it("reserves quota even when a client never redeems a proof", async () => {
    const low = { ...e, MONTHLY_BYTE_BUDGET: e.MAX_RUN_BYTES };
    await createRun(low, "alice", "alice-session");
    await expect(createRun(low, "bob", "bob-session")).rejects.toThrow("allowance");
  });
  it("enforces shared atomic limits under concurrent attempts", async () => {
    const attempts = await Promise.allSettled(Array.from({ length: 10 }, () => limit(e.DB, "parallel", 3, 60000)));
    expect(attempts.filter(r => r.status === "fulfilled")).toHaveLength(3);
  });
});

describe("bounded payload stream", () => {
  it("puts valid proofs after actual payload and releases the run at completion", async () => {
    const local = { ...e, MAX_RUN_BYTES: "4096", UPSTREAM_CONCURRENCY: "1" };
    const grant = await createRun(local, "alice", "alice-session"); await claimRun(local, grant, "alice-session");
    const ctx = createExecutionContext();
    const fetcher = vi.fn(async () => new Response(new Uint8Array(4096), { headers: { "Content-Length": "4096" } }));
    const response = await dataStream(local, grant, ctx, fetcher);
    expect(response.headers.get("Content-Encoding")).toBe("identity");
    const body = new Uint8Array(await response.arrayBuffer());
    expect(body[0]).toBe(1); expect(new DataView(body.buffer).getUint32(1)).toBe(4096);
    const receiptOffset = 4101;
    expect(body[receiptOffset]).toBe(2);
    const length = new DataView(body.buffer).getUint32(receiptOffset + 1);
    const token = new TextDecoder().decode(body.slice(receiptOffset + 5, receiptOffset + 5 + length));
    await credit(local, "alice", "alice-session", [token]);
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(4096);
    await waitOnExecutionContext(ctx);
    expect(await e.DB.prepare("SELECT state FROM runs WHERE id = ?").bind(grant.run).first("state")).toBe("finished");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("rejects compressed data without awarding or leaking a receipt", async () => {
    const local = { ...e, MAX_RUN_BYTES: "4096", UPSTREAM_CONCURRENCY: "1" };
    const grant = await createRun(local, "alice", "alice-session"); await claimRun(local, grant, "alice-session");
    const ctx = createExecutionContext();
    const response = await dataStream(local, grant, ctx, async () => new Response("short", { headers: { "Content-Encoding": "gzip" } }));
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([4, 0, 0, 0, 0]);
    await waitOnExecutionContext(ctx);
    expect((await profile(e.DB, "alice"))?.totalBytes).toBe(0);
  });
  it("cancels upstream work on downstream cancellation", async () => {
    const local = { ...e, MAX_RUN_BYTES: "4096", UPSTREAM_CONCURRENCY: "1" };
    const grant = await createRun(local, "alice", "alice-session"); await claimRun(local, grant, "alice-session");
    const cancelled = vi.fn(); const ctx = createExecutionContext();
    const upstream = new ReadableStream({ pull(c) { c.enqueue(new Uint8Array(128)); }, cancel: cancelled }, { highWaterMark: 0 });
    const response = await dataStream(local, grant, ctx, async () => new Response(upstream));
    const reader = response.body!.getReader(); await reader.read(); await reader.cancel();
    await waitOnExecutionContext(ctx);
    expect(cancelled).toHaveBeenCalledTimes(1);
  });
  it("does not read ahead of a stalled downstream consumer", async () => {
    const local = { ...e, MAX_RUN_BYTES: "4096", UPSTREAM_CONCURRENCY: "1" };
    const grant = await createRun(local, "alice", "alice-session"); await claimRun(local, grant, "alice-session");
    let reads = 0; const ctx = createExecutionContext();
    const response = await dataStream(local, grant, ctx, async () => new Response(new ReadableStream({
      pull(c) { reads++; c.enqueue(new Uint8Array(128)); }
    }, { highWaterMark: 0 })));
    const reader = response.body!.getReader(); await reader.read();
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(reads).toBe(1);
    await reader.cancel(); await waitOnExecutionContext(ctx);
  });
});

describe("email sign-in", () => {
  it("runs native Better Auth D1 OTP login with a secure session and no password", async () => {
    let code = "";
    const send = vi.fn(async (message) => { code = message.text.match(/\d{6}/)[0]; return { messageId: "local-only" }; });
    const local = { ...e, EMAIL: { send } };
    const auth = authFor(local);
    const headers = { "Content-Type": "application/json", Origin: e.APP_ORIGIN };
    const requested = await auth.handler(new Request(`${e.APP_ORIGIN}/api/auth/email-otp/send-verification-otp`, { method: "POST", headers, body: JSON.stringify({ email: "new@example.com", type: "sign-in" }) }));
    expect(requested.status).toBe(200);
    const stored = await e.DB.prepare("SELECT value FROM verification").first<string>("value");
    expect(stored).not.toContain(code);
    const response = await auth.handler(new Request(`${e.APP_ORIGIN}/api/auth/sign-in/email-otp`, { method: "POST", headers, body: JSON.stringify({ email: "new@example.com", otp: code }) }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("HttpOnly");
    const result = await response.json(); expect(result.user.emailVerified).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("rejects cross-origin mutations and disabled or shortcut download routes", async () => {
    const ctx = createExecutionContext();
    const foreign = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/auth/sign-in/email-otp`, { method: "POST", headers: { Origin: "https://evil.example" } }), e, ctx);
    expect(foreign.status).toBe(403);
    const head = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/download`, { method: "HEAD" }), e, ctx); expect(head.status).toBe(400);
    const range = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/download`, { headers: { Range: "bytes=1-" } }), e, ctx); expect(range.status).toBe(400);
    const disabled = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/download`), e, ctx); expect(disabled.status).toBe(503);
  });
  it("connects real login, control, download and redemption with two run requests", async () => {
    let otp = "";
    const local = { ...e, RANKED_ENABLED: "true", MAX_RUN_BYTES: "4096", UPSTREAM_CONCURRENCY: "1", EMAIL: {
      send: async (message) => { otp = message.text.match(/\d{6}/)[0]; return { messageId: "test-local" }; }
    } };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async url => {
      if (String(url).includes("siteverify")) return Response.json({ success: true });
      return new Response(new Uint8Array(4096), { headers: { "Content-Length": "4096" } });
    });
    const ctx = createExecutionContext();
    const headers = { "Content-Type": "application/json", Origin: e.APP_ORIGIN };
    const sent = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/auth/email-otp/send-verification-otp`, { method: "POST", headers, body: JSON.stringify({ email: "flow@example.com", turnstileToken: "test" }) }), local, ctx);
    expect(sent.status).toBe(200);
    const loggedIn = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/auth/sign-in/email-otp`, { method: "POST", headers, body: JSON.stringify({ email: "flow@example.com", otp }) }), local, ctx);
    expect(loggedIn.status).toBe(200);
    expect(await loggedIn.clone().text()).not.toContain("flow@example.com");
    const cookie = loggedIn.headers.get("Set-Cookie")!.split(";")[0];
    const controlled = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/control`, { headers: { Origin: e.APP_ORIGIN, Cookie: cookie, Upgrade: "websocket" } }), local, ctx);
    expect(controlled.status).toBe(101);
    const socket = controlled.webSocket!;
    function next(type: string) {
      return new Promise<Record<string, unknown>>(resolve => {
        const listener = (event: MessageEvent) => { const value = JSON.parse(event.data as string); if (value.type === type) { socket.removeEventListener("message", listener); resolve(value); } };
        socket.addEventListener("message", listener);
      });
    }
    const readyPromise = next("ready"); socket.accept(); const ready = await readyPromise;
    expect(ready.profile).toBeTruthy();
    const granted = next("grant"); socket.send(JSON.stringify({ type: "start" })); const grant = await granted;
    const downloaded = await worker.fetch(new Request(`${e.APP_ORIGIN}/api/download`, { headers: { Cookie: cookie, "X-Data-Grant": String(grant.token) } }), local, ctx);
    expect(downloaded.status).toBe(200);
    const bytes = new Uint8Array(await downloaded.arrayBuffer());
    const length = new DataView(bytes.buffer).getUint32(4102);
    const token = new TextDecoder().decode(bytes.slice(4106, 4106 + length));
    await new Promise(resolve => setTimeout(resolve, 300));
    const accepted = next("accepted"); socket.send(JSON.stringify({ type: "checkpoint", receipts: [token] }));
    expect((await accepted).profile).toMatchObject({ totalBytes: 4096 });
    socket.close(); await waitOnExecutionContext(ctx); fetchMock.mockRestore();
  });
});
