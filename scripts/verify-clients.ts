// Verification for lib/clients.ts. Run: npm run verify:clients
import assert from "node:assert/strict";
import { parseClients, effectivePassword, findClientByPassword, getClientById } from "../lib/clients";

const VALID = JSON.stringify([
  { id: "yconia", name: "Yconia", locationId: "loc-yconia", ghlToken: "pit-a" },
  { id: "condesa", name: "Condesa", locationId: "loc-condesa", ghlToken: "pit-b", password: "custom-pw" },
]);

function throws(raw: string, needle: string, label: string) {
  assert.throws(
    () => parseClients(raw),
    (e: unknown) => {
      const msg = e instanceof Error ? e.message : String(e);
      assert.ok(msg.includes(needle), `${label}: expected message to include "${needle}", got "${msg}"`);
      return true;
    },
    label,
  );
}

// --- parse + shape
const clients = parseClients(VALID);
assert.equal(clients.length, 2);
assert.equal(clients[0].id, "yconia");
assert.equal(clients[0].password, undefined);
assert.equal(clients[1].password, "custom-pw");

// --- password defaults to locationId, override wins
assert.equal(effectivePassword(clients[0]), "loc-yconia");
assert.equal(effectivePassword(clients[1]), "custom-pw");

// --- validation failures
throws("not json", "not valid JSON", "malformed JSON");
throws(JSON.stringify({ id: "x" }), "must be a JSON array", "not an array");
throws("[]", "no clients configured", "empty array");
throws(JSON.stringify([{ id: "a", name: "A", locationId: "l" }]), "ghlToken", "missing ghlToken");
throws(JSON.stringify([{ id: "a", name: "A", locationId: "l", ghlToken: "" }]), "ghlToken", "empty ghlToken");
throws(JSON.stringify([{ id: "A.b", name: "A", locationId: "l", ghlToken: "t" }]), "invalid id", "id with a dot");
throws(
  JSON.stringify([
    { id: "a", name: "A", locationId: "l1", ghlToken: "t" },
    { id: "a", name: "B", locationId: "l2", ghlToken: "t" },
  ]),
  "duplicate id",
  "duplicate id",
);
throws(
  JSON.stringify([
    { id: "a", name: "A", locationId: "same", ghlToken: "t" },
    { id: "b", name: "B", locationId: "same", ghlToken: "t" },
  ]),
  "shares a password",
  "password collision via identical locationId",
);
throws(
  JSON.stringify([
    { id: "a", name: "A", locationId: "l1", ghlToken: "t" },
    { id: "b", name: "B", locationId: "l2", ghlToken: "t", password: "l1" },
  ]),
  "shares a password",
  "password collision via override",
);

// --- env-backed lookups
process.env.DASHBOARD_CLIENTS = VALID;
assert.equal(getClientById("yconia")?.name, "Yconia");
assert.equal(getClientById("nope"), null);
assert.equal(findClientByPassword("loc-yconia")?.id, "yconia");
assert.equal(findClientByPassword("custom-pw")?.id, "condesa");
// the overridden client's locationId must NOT work as a password
assert.equal(findClientByPassword("loc-condesa"), null);
assert.equal(findClientByPassword("wrong"), null);
assert.equal(findClientByPassword(""), null);

console.log("✅ lib/clients.ts — all assertions passed");
