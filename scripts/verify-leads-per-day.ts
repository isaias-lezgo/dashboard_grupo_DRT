// Verificación de lib/leads-per-day.ts — "Leads creados por día".
// Correr: pnpm verify:leads-per-day
//
// Lo que justifica el script es la frontera de día: `createdAt` viene en UTC y
// el día que cuenta es el de México. Un corte mal hecho no truena nada — solo
// corre el pico de una campaña un día, con toda seguridad.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import { NO_DATE_KEY, NO_DATE_LABEL } from "../lib/opportunity-breakdown";
import {
  buildLeadsByDay,
  dayLabelOf,
  dayLongLabelOf,
  daysBetween,
  summarizeLeadsByDay,
} from "../lib/leads-per-day";

let seq = 0;

function opp(createdAt: string | undefined): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "ChCZUhFDe5m0RSNp4qbb",
    pipelineStageId: "stage-1",
    status: "open",
    createdAt: createdAt as string,
    contactId: `c${seq}`,
    value: 0,
    stage: "00. Recibido",
    pipelineName: "Cañadas",
  };
}

async function main() {
  // ── Etiquetas ─────────────────────────────────────────────────────────────
  assert.equal(dayLabelOf("2026-09-14"), "14 sep");
  assert.equal(dayLabelOf("2026-01-05"), "5 ene", "sin cero a la izquierda");
  assert.equal(dayLongLabelOf("2026-09-14"), "14 sep 2026");

  // ── daysBetween ───────────────────────────────────────────────────────────
  assert.deepEqual(daysBetween("2026-02-27", "2026-03-02"), [
    "2026-02-27",
    "2026-02-28",
    "2026-03-01",
    "2026-03-02",
  ]);
  assert.deepEqual(daysBetween("2026-09-14", "2026-09-14"), ["2026-09-14"]);
  assert.deepEqual(daysBetween("2026-09-15", "2026-09-14"), [], "rango invertido → vacío");

  // ── Frontera de día en hora de México ────────────────────────────────────
  // 2026-09-15T04:30Z son las 22:30 del 14 en CDMX (UTC-6, sin horario de verano).
  {
    const rows = buildLeadsByDay([opp("2026-09-15T04:30:00.000Z")]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].key, "2026-09-14", "las 22:30 de México son del día 14, no del 15");
    assert.equal(rows[0].count, 1);
  }
  // 2026-09-15T06:00Z ya es medianoche del 15 en CDMX.
  {
    const rows = buildLeadsByDay([opp("2026-09-15T06:00:00.000Z")]);
    assert.equal(rows[0].key, "2026-09-15");
  }

  // ── Relleno de huecos, orden y drill-down ────────────────────────────────
  {
    const rows = buildLeadsByDay([
      opp("2026-09-14T15:00:00.000Z"),
      opp("2026-09-11T15:00:00.000Z"),
      opp("2026-09-14T16:00:00.000Z"),
      opp("2026-09-14T17:00:00.000Z"),
    ]);
    assert.deepEqual(
      rows.map((r) => r.key),
      ["2026-09-11", "2026-09-12", "2026-09-13", "2026-09-14"],
      "los días intermedios se rellenan en cero y el orden es cronológico"
    );
    assert.deepEqual(rows.map((r) => r.count), [1, 0, 0, 3]);
    assert.equal(rows[3].ids.length, 3, "los ids del día viajan para el drawer");
    assert.deepEqual(rows[1].ids, []);
    assert.equal(rows[0].label, "11 sep");
    assert.equal(rows[0].longLabel, "11 sep 2026");

    const s = summarizeLeadsByDay(rows);
    assert.equal(s.total, 4);
    assert.equal(s.days, 4, "los huecos cuentan como días del periodo");
    assert.equal(s.perDay, 1);
    assert.equal(s.peak?.key, "2026-09-14");
    assert.equal(s.noDate, 0);
  }

  // ── Sin fecha ─────────────────────────────────────────────────────────────
  {
    const rows = buildLeadsByDay([
      opp("2026-09-14T15:00:00.000Z"),
      opp(undefined),
      opp("no-es-fecha"),
    ]);
    assert.equal(rows.length, 2);
    const last = rows[rows.length - 1];
    assert.equal(last.key, NO_DATE_KEY, "la fila sin fecha va al final");
    assert.equal(last.label, NO_DATE_LABEL);
    assert.equal(last.count, 2, "undefined y una cadena ilegible caen juntas");

    const s = summarizeLeadsByDay(rows);
    assert.equal(s.total, 3, "el total incluye las sin fecha");
    assert.equal(s.noDate, 2);
    assert.equal(s.days, 1, "la fila sin fecha no es un día");
    assert.equal(s.perDay, 1, "el promedio se calcula sin las sin fecha");
    assert.equal(s.peak?.key, "2026-09-14", "la fila sin fecha nunca es el pico");
  }

  // ── Empate en el pico → el día más antiguo ────────────────────────────────
  {
    const rows = buildLeadsByDay([
      opp("2026-09-12T15:00:00.000Z"),
      opp("2026-09-13T15:00:00.000Z"),
    ]);
    assert.equal(summarizeLeadsByDay(rows).peak?.key, "2026-09-12");
  }

  // ── Vacío ─────────────────────────────────────────────────────────────────
  {
    const rows = buildLeadsByDay([]);
    assert.deepEqual(rows, []);
    const s = summarizeLeadsByDay(rows);
    assert.equal(s.total, 0);
    assert.equal(s.days, 0);
    assert.equal(s.perDay, 0);
    assert.equal(s.peak, null);
  }

  console.log("verify-leads-per-day: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
