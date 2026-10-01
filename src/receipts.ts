import { HttpError } from "./http";

export type Grant = { v: 1; uid: string; run: string; start: number; end: number; redeem: number; max: number; claim: number };
export type Receipt = Grant & { day: string; bytes: number; at: number };
const encoder = new TextEncoder();

function encode(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}
function decode(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error();
  return Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), c => c.charCodeAt(0));
}

export async function signer(secret: string) {
  if (!secret || secret.length < 32) throw new HttpError(503, "Signing secret is missing.");
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  return {
    async sign(value: Grant | Receipt, purpose: "grant" | "receipt"): Promise<string> {
      const body = encode(encoder.encode(JSON.stringify(value)));
      const mac = await crypto.subtle.sign("HMAC", key, encoder.encode(`data-${purpose}-v1.${body}`));
      return `${body}.${encode(new Uint8Array(mac))}`;
    },
    async verify(token: string, purpose: "grant" | "receipt", userId: string, now = Date.now()): Promise<Receipt | Grant> {
      try {
        if (typeof token !== "string" || token.length > 2048) throw new Error();
        const parts = token.split(".");
        if (parts.length !== 2) throw new Error();
        const [body, mac] = parts;
        if (!(await crypto.subtle.verify("HMAC", key, decode(mac), encoder.encode(`data-${purpose}-v1.${body}`)))) throw new Error();
        const value: unknown = JSON.parse(new TextDecoder().decode(decode(body)));
        if (!value || typeof value !== "object") throw new Error();
        const data = value as Receipt;
        if (data.v !== 1 || data.uid !== userId || typeof data.run !== "string" || data.run.length > 64) throw new Error();
        for (const n of [data.start, data.end, data.redeem, data.max, data.claim]) if (!Number.isSafeInteger(n) || n <= 0) throw new Error();
        if (data.end <= data.start || data.redeem < data.end || data.max > Number.MAX_SAFE_INTEGER) throw new Error();
        if (purpose === "grant" && (now > data.claim || now > data.end)) throw new Error();
        if (purpose === "receipt") {
          if (!Number.isSafeInteger(data.bytes) || data.bytes <= 0 || data.bytes > data.max) throw new Error();
          if (!Number.isSafeInteger(data.at) || data.at < data.start || data.at > data.end || data.at > now + 10000 || now > data.redeem) throw new Error();
          if (data.day !== new Date(data.at).toISOString().slice(0, 10)) throw new Error();
        }
        return data;
      } catch { throw new HttpError(400, "Invalid or expired transfer proof."); }
    }
  };
}

export async function keyedHash(secret: string, value: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return encode(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(value))));
}
