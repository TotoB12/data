export class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export function json(value: unknown, status = 200, headers: HeadersInit = {}): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function sameOrigin(request: Request, env: Env): void {
  if (request.headers.get("Origin") !== new URL(env.APP_ORIGIN).origin) {
    throw new HttpError(403, "Open this page on its configured address.");
  }
}

export async function smallJson(request: Request, max = 4096): Promise<Record<string, unknown>> {
  if (!request.headers.get("Content-Type")?.startsWith("application/json")) throw new HttpError(415, "JSON required.");
  const reader = request.body?.getReader();
  if (!reader) throw new HttpError(400, "Missing request body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > max) throw new HttpError(413, "Request too large.");
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch { throw new HttpError(400, "Invalid JSON."); }
}

export function numberSetting(value: string, min: number, max: number): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new HttpError(503, "Invalid service configuration.");
  return number;
}
