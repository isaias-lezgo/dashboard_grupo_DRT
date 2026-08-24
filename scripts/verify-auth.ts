// Verification for lib/auth.ts. Run: npm run verify:auth
//
// Wrapped in main() rather than using top-level await: this package is CJS
// ("type" is not "module"), so tsx compiles to CJS where TLA is unavailable.
import assert from "node:assert/strict";

process.env.DASHBOARD_AUTH_SECRET = "test-secret-do-not-use-in-prod";

import { signToken, verifyToken } from "../lib/auth";

const HOUR = 60 * 60 * 1000;

async function main() {
  // --- round trip: the client id survives sign → verify
  const token = await signToken("yconia", Date.now() + HOUR);
  assert.equal(await verifyToken(token), "yconia");

  // --- the token is dot-delimited: clientId.expiry.signature
  assert.equal(token.split(".").length, 3, "token must have exactly 3 segments");
  assert.ok(token.startsWith("yconia."), "client id must be the first segment");

  // --- THE ISOLATION GUARANTEE: swapping the client id invalidates the signature.
  // This is the assertion that stops client A from reading client B's data.
  const [, expiry, sig] = token.split(".");
  assert.equal(await verifyToken(`condesa.${expiry}.${sig}`), null, "tampered client id must be rejected");

  // --- other tampering
  assert.equal(await verifyToken(`yconia.${expiry}.deadbeef`), null, "bad signature rejected");
  assert.equal(await verifyToken(`yconia.${Number(expiry) + 1}.${sig}`), null, "tampered expiry rejected");

  // --- expiry is enforced
  const expired = await signToken("yconia", Date.now() - 1000);
  assert.equal(await verifyToken(expired), null, "expired token rejected");

  // --- malformed input
  assert.equal(await verifyToken(undefined), null);
  assert.equal(await verifyToken(""), null);
  assert.equal(await verifyToken("garbage"), null);
  assert.equal(await verifyToken("only.two"), null);
  assert.equal(await verifyToken("a.b.c.d"), null);
  assert.equal(await verifyToken(`.${expiry}.${sig}`), null, "empty client id rejected");

  // --- two clients get distinguishable tokens
  const a = await signToken("yconia", Date.now() + HOUR);
  const b = await signToken("condesa", Date.now() + HOUR);
  assert.equal(await verifyToken(a), "yconia");
  assert.equal(await verifyToken(b), "condesa");

  console.log("✅ lib/auth.ts — all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
