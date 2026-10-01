import { betterAuth } from "better-auth";
import { emailOTP } from "better-auth/plugins/email-otp";
import { HttpError, numberSetting } from "./http";
import { keyedHash } from "./receipts";

export function authFor(env: Env) {
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32 || !env.OTP_SECRET || env.OTP_SECRET.length < 32) {
    throw new HttpError(503, "Accounts have not been configured yet.");
  }
  return betterAuth({
    database: env.DB,
    secret: env.BETTER_AUTH_SECRET,
    baseURL: env.APP_ORIGIN,
    basePath: "/api/auth",
    trustedOrigins: [env.APP_ORIGIN],
    emailAndPassword: { enabled: false },
    session: { expiresIn: 7 * 86400, updateAge: 86400 },
    advanced: { database: { validateSchema: false } },
    rateLimit: { enabled: false }, // Atomic D1 limits protect the only exposed routes below.
    plugins: [emailOTP({
      otpLength: 6,
      expiresIn: 300,
      allowedAttempts: 5,
      storeOTP: { hash: otp => keyedHash(env.OTP_SECRET, `otp:${otp}`) },
      sendVerificationOTP: async ({ email, otp, type }) => {
        if (type !== "sign-in") throw new HttpError(400, "Only email sign-in is enabled.");
        await env.EMAIL.send({
          from: env.EMAIL_FROM,
          to: email,
          subject: "Your Data Flood sign-in code",
          text: `Your sign-in code is ${otp}. It expires in five minutes.\n\nIf you did not request this code, you can ignore this email.`
        });
      }
    })]
  });
}

export async function limit(db: D1Database, key: string, maximum: number, windowMs: number, now = Date.now()): Promise<void> {
  const result = await db.prepare(`
    INSERT INTO limits(key, count, expires_at) VALUES(?, 1, ?)
    ON CONFLICT(key) DO UPDATE SET
      count = CASE WHEN expires_at <= ? THEN 1 ELSE count + 1 END,
      expires_at = CASE WHEN expires_at <= ? THEN ? ELSE expires_at END
    WHERE expires_at <= ? OR count < ?
    RETURNING count
  `).bind(key, now + windowMs, now, now, now + windowMs, now, maximum).first();
  if (!result) throw new HttpError(429, "Too many attempts. Please try again later.");
}

export async function otpLimits(request: Request, env: Env, email: string, sending: boolean): Promise<void> {
  const privateEmailKey = await keyedHash(env.OTP_SECRET, email);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const privateIpKey = await keyedHash(env.OTP_SECRET, ip);
  if (sending) {
    await limit(env.DB, `send-ip:${privateIpKey}`, 10, 3600000);
    await limit(env.DB, `send-email:${privateEmailKey}`, 1, 60000);
    await limit(env.DB, `email-day:${new Date().toISOString().slice(0, 10)}`, numberSetting(env.DAILY_EMAIL_BUDGET, 1, 3000), 86400000);
  } else {
    await limit(env.DB, `verify-ip:${privateIpKey}`, 30, 300000);
    await limit(env.DB, `verify-email:${privateEmailKey}`, 5, 300000);
  }
}

export async function turnstile(request: Request, env: Env, token: unknown): Promise<void> {
  if (typeof token !== "string" || token.length > 2048 || !env.TURNSTILE_SECRET_KEY) throw new HttpError(400, "Complete the verification first.");
  const result = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET_KEY, response: token, remoteip: request.headers.get("CF-Connecting-IP") || undefined }),
    headers: { "Content-Type": "application/json" }
  });
  const value = await result.json<{ success: boolean; hostname?: string; action?: string }>();
  const host = new URL(env.APP_ORIGIN).hostname;
  const local = host === "localhost" || host === "127.0.0.1";
  if (!value.success || (!local && (value.hostname !== host || value.action !== "login"))) throw new HttpError(403, "Verification failed. Please try again.");
}

export async function sessionFor(request: Request, env: Env) {
  const session = await authFor(env).api.getSession({ headers: request.headers, query: { disableCookieCache: true } });
  if (!session || session.session.expiresAt.getTime() <= Date.now()) throw new HttpError(401, "Sign in to use your account.");
  return session;
}

export async function profile(db: D1Database, userId: string) {
  await db.prepare("INSERT OR IGNORE INTO profiles(user_id, alias) VALUES(?, ?)")
    .bind(userId, `Flood-${userId.replace(/[^a-zA-Z0-9]/g, "").slice(0, 20)}`).run();
  return db.prepare("SELECT alias, total_bytes AS totalBytes FROM profiles WHERE user_id = ?").bind(userId).first<{ alias: string; totalBytes: number }>();
}
