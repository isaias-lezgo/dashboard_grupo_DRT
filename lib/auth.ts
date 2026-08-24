// lib/auth.ts
// Edge-safe auth helpers. Uses Web Crypto (crypto.subtle) so this module can be
// imported from middleware (Edge runtime) as well as Node route handlers.
// No Next.js imports here — keep it pure and runtime-agnostic.

export const SESSION_COOKIE = "dash_session";
export const SESSION_MAX_AGE_SECONDS = 7 * 24 * 60 * 60; // 7 days

function getSecret(): string {
  const secret = process.env.DASHBOARD_AUTH_SECRET;
  if (!secret) {
    throw new Error("DASHBOARD_AUTH_SECRET is not set");
  }
  return secret;
}

// Constant-time string comparison to avoid leaking length/character timing.
export function safeEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // Compare against a fixed-length XOR accumulator. Differing lengths still
  // run the loop to the max length and fail.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

async function hmac(message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(getSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(message),
  );
  // hex-encode
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// Token format: "<clientId>.<expiryMs>.<hmac(clientId.expiryMs)>".
// The client id is INSIDE the signed payload, so a client cannot edit their
// cookie to impersonate another client — the signature check fails. Contains no
// password and no PII.
export async function signToken(clientId: string, expiryMs: number): Promise<string> {
  const payload = `${clientId}.${expiryMs}`;
  const sig = await hmac(payload);
  return `${payload}.${sig}`;
}

// Returns the client id on success, null on any failure (missing, malformed,
// expired, or bad signature). Callers resolve the id to a ClientConfig.
export async function verifyToken(value: string | undefined): Promise<string | null> {
  if (!value) return null;
  const parts = value.split(".");
  if (parts.length !== 3) return null;

  const [clientId, expiryRaw, sig] = parts;
  if (!clientId) return null;

  const expiryMs = Number(expiryRaw);
  if (!Number.isFinite(expiryMs)) return null;
  if (Date.now() > expiryMs) return null; // expired

  const expected = await hmac(`${clientId}.${expiryMs}`);
  if (!safeEqual(sig, expected)) return null;

  return clientId;
}
