// lib/ghl-limiter.ts
// Per-LOCATION concurrency + request-rate limiting for GHL.
//
// GHL's budget is per location (~100 requests / 10s — confirmed via the
// x-ratelimit-max / x-ratelimit-interval-milliseconds headers it returns on every
// call), so this state MUST be keyed by location. It used to be process-wide
// module state in ghl-client.ts, which in a multi-client deployment was wrong in
// both directions: it needlessly serialized clients that have independent budgets,
// and — worse — one client's 429 set a global cooldown that froze every other
// client's sync.

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Tunable. GHL's burst limit is ~100 requests / 10s, so 8 concurrent leaves
// comfortable headroom.
const MAX_CONCURRENT_GHL_REQUESTS = 8;

// The concurrency cap above bounds in-flight requests but NOT the request *rate*,
// and those are different things. GHL answers in ~60ms, so 8 concurrent requests
// fire at >100/s — ~10x over budget — which is exactly what produced 429 storms
// when fanning out over ~700 contacts. This token bucket paces the rate. We target
// 80/10s to leave headroom for the burst allowance and any other consumer of the
// same token (e.g. the GHL MCP). A small bucket capacity smooths emission instead
// of letting a burst align badly with GHL's window: worst-case requests in any 10s
// window = capacity + rate*10s = 8 + 80 = 88, comfortably under 100.
const RATE_LIMIT_MAX = 80;
export const RATE_LIMIT_INTERVAL_MS = 10_000;
const RATE_REFILL_PER_MS = RATE_LIMIT_MAX / RATE_LIMIT_INTERVAL_MS;
const RATE_BUCKET_CAPACITY = MAX_CONCURRENT_GHL_REQUESTS;

interface LimiterState {
  active: number;
  queue: Array<() => void>;
  tokens: number;
  lastRefill: number;
  // Hard floor for THIS location: when GHL pushes back with 429 (or reports a
  // near-empty budget) nothing for this client starts until this timestamp.
  // Other clients are unaffected.
  cooldownUntil: number;
}

const limiters = new Map<string, LimiterState>();

function getState(locationId: string): LimiterState {
  let state = limiters.get(locationId);
  if (!state) {
    state = {
      active: 0,
      queue: [],
      tokens: RATE_BUCKET_CAPACITY,
      lastRefill: Date.now(),
      cooldownUntil: 0,
    };
    limiters.set(locationId, state);
  }
  return state;
}

export function acquireSlot(locationId: string): Promise<void> {
  const s = getState(locationId);
  if (s.active < MAX_CONCURRENT_GHL_REQUESTS) {
    s.active++;
    return Promise.resolve();
  }
  // At capacity — wait until a slot is handed off directly (active count stays
  // pinned at the max while the slot transfers, so we never over-admit).
  return new Promise<void>((resolve) => s.queue.push(resolve));
}

export function releaseSlot(locationId: string): void {
  const s = getState(locationId);
  const next = s.queue.shift();
  if (next) {
    next(); // hand the slot straight to the next waiter; active count unchanged
  } else {
    s.active--;
  }
}

function refillRateTokens(s: LimiterState): void {
  const now = Date.now();
  s.tokens = Math.min(RATE_BUCKET_CAPACITY, s.tokens + (now - s.lastRefill) * RATE_REFILL_PER_MS);
  s.lastRefill = now;
}

// Block until a request for this location may start: honor any active cooldown,
// then wait for a rate-limiter token. Called before EVERY HTTP attempt (including
// retries), so 429 backoff is paced too — not just the initial request.
export async function acquireRateToken(locationId: string): Promise<void> {
  const s = getState(locationId);
  for (;;) {
    const now = Date.now();
    if (now < s.cooldownUntil) {
      await sleep(s.cooldownUntil - now);
      continue;
    }
    refillRateTokens(s);
    if (s.tokens >= 1) {
      s.tokens -= 1;
      return;
    }
    await sleep(Math.ceil((1 - s.tokens) / RATE_REFILL_PER_MS));
  }
}

// Read GHL's rate headers off a response. When the remaining budget for the
// current window is nearly spent, coast (set a short cooldown for THIS location
// until the window resets) so we glide under the limit instead of tripping a 429.
export function noteRateLimitHeaders(locationId: string, response: Response): void {
  const remaining = Number(response.headers.get("x-ratelimit-remaining"));
  if (Number.isFinite(remaining) && remaining <= 2) {
    const interval =
      Number(response.headers.get("x-ratelimit-interval-milliseconds")) || RATE_LIMIT_INTERVAL_MS;
    const s = getState(locationId);
    s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + interval);
  }
}

// A 429 means we (or another consumer of this token) overran the window. Set a
// cooldown for this location so every pending request for THIS client backs off
// together — and no other client is affected.
export function note429(locationId: string, cooldownMs: number): void {
  const s = getState(locationId);
  s.cooldownUntil = Math.max(s.cooldownUntil, Date.now() + cooldownMs);
}

// --- verification hooks (scripts/verify-limiter.ts) ---
export function __resetLimiters(): void {
  limiters.clear();
}

export function __peek(locationId: string): { active: number; cooldownUntil: number } {
  const s = getState(locationId);
  return { active: s.active, cooldownUntil: s.cooldownUntil };
}
