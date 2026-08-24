// lib/clients.ts
// The client roster — the seam between "where client config comes from" and
// everything downstream. Nothing outside this file knows the roster is backed by
// an env var, so swapping in a database later touches only this file.
import { safeEqual } from "./auth";

export interface ClientConfig {
  id: string;
  name: string;
  locationId: string;
  ghlToken: string;
  // Optional override. Absent = the GHL location id doubles as the password.
  // See the design doc's "Password model" for the accepted risk; this field is
  // the escape hatch that makes a single client's password rotatable.
  password?: string;
}

export function effectivePassword(c: ClientConfig): string {
  return c.password ?? c.locationId;
}

// The session token is dot-delimited and embeds the id, so ids may not contain dots.
const ID_RE = /^[a-z0-9-]+$/;
const REQUIRED = ["id", "name", "locationId", "ghlToken"] as const;

// Pure. Throws with an actionable message on any invalid roster — a half-valid
// roster in production is far worse than a loud failure at startup.
export function parseClients(raw: string): ClientConfig[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`DASHBOARD_CLIENTS is not valid JSON: ${msg}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("DASHBOARD_CLIENTS must be a JSON array");
  }
  if (parsed.length === 0) {
    throw new Error("DASHBOARD_CLIENTS is empty — no clients configured");
  }

  const clients: ClientConfig[] = [];
  const seenIds = new Set<string>();
  const seenPasswords = new Set<string>();

  parsed.forEach((entry, i) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error(`DASHBOARD_CLIENTS[${i}] is not an object`);
    }
    const e = entry as Record<string, unknown>;

    for (const field of REQUIRED) {
      const v = e[field];
      if (typeof v !== "string" || v.trim() === "") {
        throw new Error(`DASHBOARD_CLIENTS[${i}] is missing required field "${field}"`);
      }
    }
    if (e.password !== undefined && (typeof e.password !== "string" || e.password.trim() === "")) {
      throw new Error(
        `DASHBOARD_CLIENTS[${i}] has an empty "password" — omit the field entirely to default to locationId`,
      );
    }

    const client: ClientConfig = {
      id: e.id as string,
      name: e.name as string,
      locationId: e.locationId as string,
      ghlToken: e.ghlToken as string,
      ...(e.password !== undefined ? { password: e.password as string } : {}),
    };

    if (!ID_RE.test(client.id)) {
      throw new Error(
        `DASHBOARD_CLIENTS[${i}] has an invalid id "${client.id}" — use lowercase letters, digits and hyphens only`,
      );
    }
    if (seenIds.has(client.id)) {
      throw new Error(`DASHBOARD_CLIENTS has a duplicate id "${client.id}"`);
    }
    seenIds.add(client.id);

    // Two clients with the same effective password would make the login lookup
    // ambiguous — one would silently shadow the other.
    const pw = effectivePassword(client);
    if (seenPasswords.has(pw)) {
      throw new Error(`DASHBOARD_CLIENTS: client "${client.id}" shares a password with another client`);
    }
    seenPasswords.add(pw);

    clients.push(client);
  });

  return clients;
}

// Lazy + cached. Lazy (rather than parsing at module load) so that importing this
// module in an environment without the env var doesn't throw at import time.
let cache: ClientConfig[] | null = null;

export function getClients(): ClientConfig[] {
  if (cache) return cache;
  const raw = process.env.DASHBOARD_CLIENTS;
  if (!raw) throw new Error("DASHBOARD_CLIENTS is not set");
  cache = parseClients(raw);
  return cache;
}

export function getClientById(id: string): ClientConfig | null {
  return getClients().find((c) => c.id === id) ?? null;
}

// Compares against EVERY client with no early return, so response timing doesn't
// reveal which client a wrong password nearly matched.
export function findClientByPassword(password: string): ClientConfig | null {
  if (password === "") return null;
  let match: ClientConfig | null = null;
  for (const c of getClients()) {
    if (safeEqual(password, effectivePassword(c))) match = c;
  }
  return match;
}
