import { HttpError, numberSetting } from "./http";
import { signer, type Grant, type Receipt } from "./receipts";

export async function createRun(env: Env, userId: string, sessionId: string, now = Date.now()): Promise<Grant> {
  const max = numberSetting(env.MAX_RUN_BYTES, 1024, 100 * 1024 ** 3);
  const end = now + numberSetting(env.MAX_RUN_SECONDS, 1, 3600) * 1000;
  const date = new Date(now).toISOString();
  const grant: Grant = { v: 1, uid: userId, run: crypto.randomUUID(), start: now, end, redeem: end + 86400000, max, claim: now + 60000 };
  try {
    await env.DB.prepare(`INSERT INTO runs(id, user_id, session_id, started_at, grant_deadline, stream_deadline, redeem_deadline,
      max_bytes, month_key, day_key, monthly_limit, daily_limit) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(grant.run, userId, sessionId, now, grant.claim, end, grant.redeem, max, `month:${date.slice(0, 7)}`, `user:${userId}:${date.slice(0, 10)}`,
        numberSetting(env.MONTHLY_BYTE_BUDGET, 1024, Number.MAX_SAFE_INTEGER), numberSetting(env.DAILY_USER_BYTE_BUDGET, 1024, Number.MAX_SAFE_INTEGER)).run();
  } catch (error) {
    const message = String(error);
    if (message.includes("active_run")) throw new HttpError(409, "Your previous stream is still active. Stop it or wait for its deadline.");
    if (message.includes("budget") || message.includes("run_start_limit")) throw new HttpError(429, "The ranked download allowance has been reached. Direct mode is still available.");
    throw error;
  }
  return grant;
}

export async function claimRun(env: Env, grant: Grant, sessionId: string, now = Date.now()): Promise<void> {
  const claimed = await env.DB.prepare(`UPDATE runs SET state = 'streaming', claimed_at = ?
    WHERE id = ? AND user_id = ? AND session_id = ? AND state = 'issued'
      AND grant_deadline >= ? AND stream_deadline = ? AND max_bytes = ? RETURNING id`)
    .bind(now, grant.run, grant.uid, sessionId, now, grant.end, grant.max).first();
  if (!claimed) throw new HttpError(409, "This download permission has expired or was already used.");
}

export async function finishRun(env: Env, grant: Grant): Promise<void> {
  // Keep reservations after completion too: never turn unacknowledged traffic into unlimited allowance.
  await env.DB.prepare("UPDATE runs SET state = 'finished', finished_at = ? WHERE id = ? AND user_id = ? AND state = 'streaming'")
    .bind(Date.now(), grant.run, grant.uid).run();
}

export async function credit(env: Env, userId: string, sessionId: string, tokens: unknown, now = Date.now()) {
  if (!Array.isArray(tokens) || tokens.length < 1 || tokens.length > 8 || tokens.some(x => typeof x !== "string")) throw new HttpError(400, "Invalid proof batch.");
  const proof = await signer(env.RECEIPT_SECRET);
  const receipts = new Map<string, Receipt>();
  for (const token of tokens) {
    const value = await proof.verify(token, "receipt", userId, now) as Receipt;
    const key = `${value.run}:${value.day}`;
    if ((receipts.get(key)?.bytes || 0) < value.bytes) receipts.set(key, value);
  }
  const statements: D1PreparedStatement[] = [];
  for (const r of receipts.values()) {
    statements.push(env.DB.prepare(`INSERT INTO run_day_highwater(run_id, day, credited_bytes)
      SELECT id, ?, ? FROM runs WHERE id = ? AND user_id = ? AND claimed_at IS NOT NULL
        AND started_at = ? AND stream_deadline = ? AND redeem_deadline = ? AND max_bytes = ? AND redeem_deadline >= ?
        AND EXISTS (SELECT 1 FROM session WHERE id = ? AND userId = ? AND datetime(expiresAt) > datetime(?))
      ON CONFLICT(run_id, day) DO UPDATE SET credited_bytes = excluded.credited_bytes
      WHERE excluded.credited_bytes > run_day_highwater.credited_bytes`)
      .bind(r.day, r.bytes, r.run, userId, r.start, r.end, r.redeem, r.max, now, sessionId, userId, new Date(now).toISOString()));
    statements.push(env.DB.prepare(`SELECT h.run_id AS run, h.day, h.credited_bytes AS bytes FROM run_day_highwater h
      JOIN runs r ON r.id = h.run_id WHERE h.run_id = ? AND h.day = ? AND r.user_id = ? AND r.redeem_deadline >= ?`)
      .bind(r.run, r.day, userId, now));
  }
  const results = await env.DB.batch<{ run: string; day: string; bytes: number }>(statements);
  const acknowledgements: { run: string; day: string; bytes: number }[] = [];
  let i = 1;
  for (const r of receipts.values()) {
    const row = results[i]?.results[0];
    if (!row || Number(row.bytes) < r.bytes) throw new HttpError(400, "The run is unknown, expired, or no longer authorized.");
    acknowledgements.push({ run: r.run, day: r.day, bytes: Number(row.bytes) });
    i += 2;
  }
  return { acknowledgements, rowsRead: results.reduce((sum, r) => sum + r.meta.rows_read, 0), rowsWritten: results.reduce((sum, r) => sum + r.meta.rows_written, 0) };
}

export async function boards(env: Env, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const monday = new Date(`${day}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - (monday.getUTCDay() + 6) % 7);
  const starts = [day, monday.toISOString().slice(0, 10), `${day.slice(0, 7)}-01`];
  const statements = starts.map(start => env.DB.prepare(`SELECT p.alias, SUM(t.credited_bytes) AS bytes FROM user_day_totals t
    JOIN profiles p ON p.user_id = t.user_id WHERE t.day >= ? AND t.day <= ?
    GROUP BY t.user_id ORDER BY bytes DESC, p.alias COLLATE NOCASE ASC LIMIT 20`).bind(start, day));
  statements.push(env.DB.prepare("SELECT alias, total_bytes AS bytes FROM profiles WHERE total_bytes > 0 ORDER BY total_bytes DESC, alias COLLATE NOCASE ASC LIMIT 20"));
  const results = await env.DB.batch(statements);
  return { generatedAt: now.toISOString(), periods: { daily: results[0].results, weekly: results[1].results, monthly: results[2].results, allTime: results[3].results } };
}

export async function cleanup(env: Env): Promise<void> {
  const now = Date.now();
  try { await import("./auth").then(({ limit }) => limit(env.DB, "maintenance", 1, 3600000, now)); }
  catch (e) { if (e instanceof HttpError && e.status === 429) return; throw e; }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM runs WHERE id IN (SELECT id FROM runs WHERE redeem_deadline < ? LIMIT 100)").bind(now - 3600000),
    env.DB.prepare("DELETE FROM limits WHERE key IN (SELECT key FROM limits WHERE expires_at < ? LIMIT 100)").bind(now - 86400000),
    env.DB.prepare("DELETE FROM verification WHERE id IN (SELECT id FROM verification WHERE datetime(expiresAt) < datetime(?) LIMIT 100)").bind(new Date(now - 86400000).toISOString())
  ]);
}
