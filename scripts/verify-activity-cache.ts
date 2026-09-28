// Verificación de lib/activity-cache.ts. Correr: pnpm verify:activity-cache
//
// Un error aquí no truena: se ve como una matriz de abandono equivocada. Un
// incremental que corre cuando la base tiene huecos deja contactos en "+60 d"
// para siempre; una fusión que deja ganar a la fecha vieja "des-contacta" a un
// lead. Las dos cosas parecen hallazgos, no bugs.
import assert from "node:assert/strict";
import {
  FULL_EVERY_MS,
  WATERMARK_OVERLAP_MS,
  mergeOutbound,
  planRun,
  queueThreads,
  toClientPayload,
  type ActivityState,
} from "../lib/activity-cache";

const DAY = 86_400_000;
const now = Date.parse("2026-09-28T20:00:00.000Z");
const H = 60;
const cutoff = now - H * DAY;

function base(over: Partial<ActivityState["meta"]> = {}): ActivityState {
  return {
    activity: [{ contactId: "c1", lastOutboundAt: new Date(now - 3 * DAY).toISOString() }],
    meta: {
      conversations: 100,
      threadsOpened: 10,
      threadsFailed: 0,
      threadsUnopened: 0,
      scanIncomplete: false,
      scannedDays: H,
      horizonDays: H,
      fetchedAt: new Date(now - 20 * 60_000).toISOString(),
      mode: "full",
      watermark: now - 20 * 60_000,
      fullAt: new Date(now - 60 * 60_000).toISOString(),
      unopened: [],
      ...over,
    },
  };
}

// --- planRun: incremental SOLO sobre una base confiable
assert.deepEqual(planRun(null, now, H), { mode: "full", stopAt: cutoff }, "sin base: completa");
const inc = planRun(base(), now, H);
assert.equal(inc.mode, "incremental", "base sana y reciente: incremental");
assert.equal(inc.stopAt, now - 20 * 60_000 - WATERMARK_OVERLAP_MS, "empalma con traslape");
assert.equal(planRun(base({ scanIncomplete: true }), now, H).mode, "full", "recorrido cortado: completa");
assert.equal(planRun(base({ watermark: null }), now, H).mode, "full", "sin corte: completa");
assert.equal(planRun(base({ fullAt: null }), now, H).mode, "full", "nunca hubo completa: completa");
assert.equal(
  planRun(base({ fullAt: new Date(now - FULL_EVERY_MS).toISOString() }), now, H).mode,
  "full",
  "completa de hace un día: se rehace"
);
assert.equal(planRun(base({ horizonDays: 30 }), now, H).mode, "full", "cambió el horizonte: completa");
// Un corte más viejo que el horizonte no debe recorrer de más.
assert.equal(
  planRun(base({ watermark: now - 90 * DAY }), now, H).stopAt,
  cutoff,
  "stopAt nunca pasa del horizonte"
);

// --- mergeOutbound: gana la más reciente y se poda lo que salió del horizonte
const iso = (d: number) => new Date(now - d * DAY).toISOString();
const merged = mergeOutbound(
  [
    ["a", iso(2)],
    ["b", iso(10)],
    ["viejo", iso(61)],
  ],
  [
    ["a", iso(5)], // más vieja que la guardada: NO debe ganar
    ["b", iso(1)], // más nueva: gana
    ["c", iso(0)],
    ["basura", "no-es-fecha"],
  ],
  cutoff
);
assert.equal(merged.get("a"), iso(2), "una lectura vieja no corrige hacia atrás");
assert.equal(merged.get("b"), iso(1), "la más reciente gana");
assert.equal(merged.get("c"), iso(0));
assert.equal(merged.has("viejo"), false, "fuera del horizonte se poda");
assert.equal(merged.has("basura"), false, "una fecha ilegible no entra");

// --- queueThreads: recién vistos primero, sin repetir conversación
const q = queueThreads(
  [
    { conversationId: "x", contactId: "1" },
    { conversationId: "y", contactId: "2" },
  ],
  [
    { conversationId: "y", contactId: "2" },
    { conversationId: "z", contactId: "3" },
  ]
);
assert.deepEqual(
  q.map((t) => t.conversationId),
  ["y", "z", "x"],
  "frescos primero, luego pendientes, sin duplicar"
);

// --- toClientPayload: la contabilidad interna no viaja al navegador
const pay = toClientPayload(base({ unopened: [{ conversationId: "x", contactId: "1" }] }));
assert.equal("watermark" in pay.meta, false);
assert.equal("fullAt" in pay.meta, false);
assert.equal("unopened" in pay.meta, false);
assert.equal(pay.meta.mode, "full");

console.log("✅ lib/activity-cache.ts — todas las aserciones pasaron");
