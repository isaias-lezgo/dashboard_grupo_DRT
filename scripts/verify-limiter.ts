// Verification for lib/ghl-limiter.ts. Run: npm run verify:limiter
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import { acquireSlot, releaseSlot, note429, __resetLimiters, __peek } from "../lib/ghl-limiter";

const A = "loc-yconia";
const B = "loc-condesa";

async function main() {
  __resetLimiters();

  // --- limiters are independent per location
  await acquireSlot(A);
  await acquireSlot(A);
  assert.equal(__peek(A).active, 2, "A has 2 in flight");
  assert.equal(__peek(B).active, 0, "B is untouched by A's traffic");
  releaseSlot(A);
  releaseSlot(A);
  assert.equal(__peek(A).active, 0);

  // --- THE ISOLATION GUARANTEE: a 429 for one client must NOT freeze the others.
  // This is the bug the old process-wide cooldownUntil would have caused.
  note429(A, 10_000);
  assert.ok(__peek(A).cooldownUntil > Date.now(), "A is cooling down");
  assert.equal(__peek(B).cooldownUntil, 0, "B must NOT be cooling down");

  // --- A's concurrency cap must not starve B: saturate A, then B still admits.
  __resetLimiters();
  for (let i = 0; i < 8; i++) await acquireSlot(A); // 8 = MAX_CONCURRENT
  assert.equal(__peek(A).active, 8, "A is at its cap");

  let bAdmitted = false;
  await Promise.race([
    acquireSlot(B).then(() => {
      bAdmitted = true;
    }),
    new Promise((r) => setTimeout(r, 250)),
  ]);
  assert.ok(bAdmitted, "B must be admitted immediately even while A is saturated");

  // --- a 9th request for A queues rather than over-admitting
  let aOverAdmitted = false;
  void acquireSlot(A).then(() => {
    aOverAdmitted = true;
  });
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(aOverAdmitted, false, "A's 9th request must queue");
  assert.equal(__peek(A).active, 8, "A must never exceed its cap");

  // --- releasing hands the slot to the waiter
  releaseSlot(A);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(aOverAdmitted, "the queued request must be admitted on release");
  assert.equal(__peek(A).active, 8, "active count stays pinned at the cap on handoff");

  console.log("✅ lib/ghl-limiter.ts — all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
