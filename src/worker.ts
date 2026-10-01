import { authFor, limit, otpLimits, profile, sessionFor, turnstile } from "./auth";
import { HttpError, json, sameOrigin, smallJson } from "./http";
import { signer } from "./receipts";
import { boards, claimRun, cleanup, createRun, credit } from "./scoring";
import { dataStream } from "./stream";

async function cachedBoards(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const key = new Request(`${env.APP_ORIGIN}/api/leaderboards`);
  const cache = caches.default;
  const cached = await cache.match(key);
  if (cached) return cached;
  const response = json(await boards(env), 200, { "Cache-Control": "public, max-age=300" });
  ctx.waitUntil(cache.put(key, response.clone()));
  return response;
}

async function authRoute(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  sameOrigin(request, env);
  const path = new URL(request.url).pathname;
  const auth = authFor(env);
  if (path === "/api/auth/sign-out" && request.method === "POST") return auth.handler(request);
  if (request.method !== "POST" || !["/api/auth/email-otp/send-verification-otp", "/api/auth/sign-in/email-otp"].includes(path)) throw new HttpError(404, "Unknown sign-in route.");
  const body = await smallJson(request);
  if (typeof body.email !== "string" || body.email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.email)) throw new HttpError(400, "Enter a valid email address.");
  const email = body.email.trim().toLowerCase();
  const sending = path.endsWith("send-verification-otp");
  if (sending) {
    await limit(env.DB, `challenge:${request.headers.get("CF-Connecting-IP") || "local"}`, 20, 3600000);
    await turnstile(request, env, body.turnstileToken);
  } else if (typeof body.otp !== "string" || !/^\d{6}$/.test(body.otp)) throw new HttpError(400, "Enter the six-digit code.");
  await otpLimits(request, env, email, sending);
  const forwardedHeaders = new Headers(request.headers);
  forwardedHeaders.delete("Content-Length");
  const forwarded = new Request(request.url, {
    method: "POST", headers: forwardedHeaders,
    body: JSON.stringify(sending ? { email, type: "sign-in" } : { email, otp: body.otp })
  });
  const response = await auth.handler(forwarded);
  ctx.waitUntil(cleanup(env).catch(() => console.error("maintenance_failed")));
  if (sending || !response.ok) return response;
  const data = await response.json<{ user: { id: string }; token?: string }>();
  const account = await profile(env.DB, data.user.id);
  const headers = new Headers(response.headers);
  headers.set("Cache-Control", "no-store");
  // Return only public profile fields. The opaque session token remains in its HttpOnly cookie.
  return new Response(JSON.stringify({ profile: account }), { status: response.status, headers });
}

async function control(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  sameOrigin(request, env);
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") throw new HttpError(426, "WebSocket required.");
  const session = await sessionFor(request, env);
  await limit(env.DB, `control:${session.user.id}`, 30, 3600000);
  const account = await profile(env.DB, session.user.id);
  const pair = new WebSocketPair();
  const client = pair[0]; const server = pair[1];
  server.accept();
  let pending = false;
  let nextMessage = 0;
  let lastBoard = 0;
  let deadlineTimer: ReturnType<typeof setTimeout>;
  const send = (value: unknown) => { if (server.readyState === WebSocket.OPEN) server.send(JSON.stringify(value)); };
  send({ type: "ready", userId: session.user.id, profile: account, rankedEnabled: env.RANKED_ENABLED === "true", expiresAt: session.session.expiresAt.toISOString() });
  deadlineTimer = setTimeout(() => server.close(1000, "Session window ended."), Math.min(session.session.expiresAt.getTime() - Date.now(), 3600000));
  server.addEventListener("close", () => clearTimeout(deadlineTimer));
  server.addEventListener("error", () => clearTimeout(deadlineTimer));
  server.addEventListener("message", event => {
    if (typeof event.data !== "string" || event.data.length > 18000) { server.close(1009, "Message too large."); return; }
    if (pending || Date.now() < nextMessage) { server.close(1008, "Too many control messages."); return; }
    pending = true;
    nextMessage = Date.now() + 250;
    ctx.waitUntil((async () => {
      try {
        const message: unknown = JSON.parse(event.data as string);
        if (!message || typeof message !== "object") throw new HttpError(400, "Invalid message.");
        const m = message as Record<string, unknown>;
        if (m.type === "start") {
          if (env.RANKED_ENABLED !== "true") throw new HttpError(503, "Ranking is awaiting the owner's usage benchmark. Direct mode is available.");
          await sessionFor(request, env);
          const grant = await createRun(env, session.user.id, session.session.id);
          send({ type: "grant", token: await (await signer(env.RECEIPT_SECRET)).sign(grant, "grant"), deadline: grant.end, maxBytes: grant.max });
        } else if (m.type === "checkpoint") {
          await limit(env.DB, `checkpoint:${session.user.id}`, 2, 120000);
          await sessionFor(request, env);
          const accepted = await credit(env, session.user.id, session.session.id, m.receipts);
          send({ type: "accepted", ...accepted, profile: await profile(env.DB, session.user.id) });
          ctx.waitUntil(cleanup(env).catch(() => console.error("maintenance_failed")));
        } else if (m.type === "leaderboards") {
          if (Date.now() - lastBoard < 300000) throw new HttpError(429, "Leaderboards refresh every five minutes.");
          lastBoard = Date.now();
          const response = await cachedBoards(request, env, ctx);
          send({ type: "leaderboards", data: await response.json() });
        } else throw new HttpError(400, "Unknown control message.");
      } catch (e) {
        const error = e instanceof HttpError ? e : new HttpError(500, "The request could not be completed.");
        if (!(e instanceof HttpError)) console.error("control_request_failed");
        send({ type: "error", status: error.status, message: error.message });
      } finally { pending = false; }
    })());
  });
  return new Response(null, { status: 101, webSocket: client });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);
      if (url.pathname.startsWith("/api/auth/")) return await authRoute(request, env, ctx);
      if (url.pathname === "/api/control" && request.method === "GET") return await control(request, env, ctx);
      if (url.pathname === "/api/leaderboards" && request.method === "GET") return await cachedBoards(request, env, ctx);
      if (url.pathname === "/api/profile" && request.method === "POST") {
        sameOrigin(request, env);
        const session = await sessionFor(request, env);
        await limit(env.DB, `alias:${session.user.id}`, 5, 3600000);
        const body = await smallJson(request);
        if (typeof body.alias !== "string" || !/^[A-Za-z0-9_-]{3,24}$/.test(body.alias)) throw new HttpError(400, "Use 3–24 letters, numbers, underscores or hyphens.");
        try { await env.DB.prepare("UPDATE profiles SET alias = ? WHERE user_id = ?").bind(body.alias, session.user.id).run(); }
        catch { throw new HttpError(409, "That display name is already in use."); }
        return json({ profile: await profile(env.DB, session.user.id) });
      }
      if (url.pathname === "/api/download") {
        if (request.method !== "GET" || ["Range", "If-None-Match", "If-Modified-Since", "If-Range"].some(h => request.headers.has(h))) throw new HttpError(400, "Only a complete ranked stream is supported.");
        if (env.RANKED_ENABLED !== "true") throw new HttpError(503, "Ranked downloads are disabled.");
        // Same-origin fetch carries its session cookie. A leaked grant alone cannot open a stream.
        const session = await sessionFor(request, env);
        const token = request.headers.get("X-Data-Grant") || "";
        const grant = await (await signer(env.RECEIPT_SECRET)).verify(token, "grant", session.user.id);
        await claimRun(env, grant, session.session.id);
        try { return await dataStream(env, grant, ctx); }
        catch (e) { await import("./scoring").then(({ finishRun }) => finishRun(env, grant)); throw e; }
      }
      throw new HttpError(404, "Unknown endpoint.");
    } catch (e) {
      const error = e instanceof HttpError ? e : new HttpError(500, "The request could not be completed.");
      if (!(e instanceof HttpError)) console.error("api_request_failed");
      return json({ error: error.message }, error.status);
    }
  }
} satisfies ExportedHandler<Env>;
