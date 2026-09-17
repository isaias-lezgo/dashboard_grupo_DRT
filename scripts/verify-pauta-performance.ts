// Verificación de lib/pauta-performance.ts — "Rendimiento por pauta".
// Correr: pnpm verify:pauta-performance
//
// Lo que justifica el script es el join por contacto en tres saltos (Pauta →
// contacto → oportunidad → cita) y la convención del doble conteo: una
// oportunidad cuyo contacto entró por dos pautas suma en las dos filas pero UNA
// sola vez en los totales. Confundir eso no truena nada — solo hace que la fila
// de totales y las filas no cuadren, o cuadren cuando no deberían.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Appointment, Opportunity, Pauta } from "../lib/types";
import { SIN_NOMBRE_CAMPAIGN } from "../lib/pauta";
import {
  buildPautaNamesByContact,
  buildPautaPerformance,
  hadCita,
  isPerdida,
  PAUTA_METRICS,
} from "../lib/pauta-performance";

let seq = 0;

function opp(o: {
  contactId?: string;
  stage?: string;
  status?: Opportunity["status"];
}): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "ChCZUhFDe5m0RSNp4qbb",
    pipelineStageId: "stage-1",
    status: o.status ?? "open",
    createdAt: "2026-09-01T12:00:00.000Z",
    contactId: o.contactId ?? `c${seq}`,
    value: 0,
    stage: o.stage ?? "00. Recibido",
    pipelineName: "Cañadas",
  };
}

function pauta(
  contactId: string | undefined,
  nombrePauta: string,
  createdAt = "2026-08-01T00:00:00.000Z",
  desarrollo?: string
): Pauta {
  return {
    id: `p${++seq}`,
    tipo: "Sin tipo",
    nombrePauta,
    createdAt,
    contactId,
    properties: desarrollo ? { desarrollo } : undefined,
  };
}

function cita(contactId: string): Appointment {
  return {
    id: `a${++seq}`,
    contactId,
    startTime: "2026-09-05T15:00:00.000Z",
    endTime: "2026-09-05T16:00:00.000Z",
    status: "confirmed",
  };
}

const rowFor = (perf: ReturnType<typeof buildPautaPerformance>, name: string) => {
  const r = perf.rows.find((x) => x.name === name);
  assert.ok(r, `existe la fila "${name}" (hay: ${perf.rows.map((x) => x.name).join(", ")})`);
  return r!;
};

async function main() {
  // ── Predicados ────────────────────────────────────────────────────────────
  {
    const none = new Set<string>();
    assert.equal(hadCita(opp({ stage: "03. Lead Calificado" }), none), false);
    assert.equal(hadCita(opp({ stage: "04. Cita Programada" }), none), true, "≥04 es cita");
    assert.equal(hadCita(opp({ stage: "05. Visita al Desarrollo", status: "lost" }), none), true, "una perdida en 05 sí tuvo cita");
    assert.equal(hadCita(opp({ stage: "01. Contactado", status: "won" }), none), true, "una venta implica cita (embudo monótono)");
    assert.equal(hadCita(opp({ stage: "00. Recibido", contactId: "cX" }), new Set(["cX"])), true, "cita en el objeto Citas");
    assert.equal(hadCita(opp({ stage: "Negocio perdido", status: "lost" }), none), false, "side bucket sin prefijo");

    assert.equal(isPerdida(opp({ status: "lost" })), true);
    assert.equal(isPerdida(opp({ status: "abandoned" })), true);
    assert.equal(isPerdida(opp({ status: "open" })), false);
    assert.equal(isPerdida(opp({ status: "won" })), false);
  }

  // ── Nombres por contacto: distintos, en orden, sin Pautas huérfanas ────────
  {
    const m = buildPautaNamesByContact([
      pauta("c1", "A"),
      pauta("c1", "A"),
      pauta("c1", "B"),
      pauta(undefined, "C"),
      pauta("c2", "  "),
    ]);
    assert.deepEqual(m.get("c1"), ["A", "B"], "sin repetidos, en orden de aparición");
    assert.equal(m.has(undefined as unknown as string), false);
    assert.deepEqual(m.get("c2"), [SIN_NOMBRE_CAMPAIGN], "un nombre vacío es 'Sin nombre'");
  }

  // ── El join completo ──────────────────────────────────────────────────────
  {
    const pautas = [
      pauta("c1", "Pauta A"),
      pauta("c2", "Pauta A"),
      pauta("c3", "Pauta A"),
      pauta("c4", "Pauta B"),
      pauta("c5", "Pauta B"),
      pauta("c5", "Pauta A"), // c5 entró por las dos
      pauta("c6", SIN_NOMBRE_CAMPAIGN),
    ];
    const opps = [
      opp({ contactId: "c1", stage: "08. Venta", status: "won" }), // A: venta (y cita por monotonía)
      opp({ contactId: "c2", stage: "05. Visita al Desarrollo", status: "lost" }), // A: cita + perdida
      opp({ contactId: "c3", stage: "00. Recibido" }), // A: solo lead, cita por objeto Citas
      opp({ contactId: "c4", stage: "01. Contactado", status: "abandoned" }), // B: perdida
      opp({ contactId: "c5", stage: "04. Cita Programada" }), // A y B: cita
      opp({ contactId: "c6", stage: "00. Recibido" }), // Sin nombre
      opp({ contactId: "c7", stage: "00. Recibido" }), // sin Pauta: fuera de la tabla
    ];
    const perf = buildPautaPerformance(opps, pautas, [cita("c3")]);

    assert.equal(perf.universe, 7);
    assert.equal(perf.sinPauta.count, 1, "la oportunidad sin Pauta no entra a ninguna fila");
    assert.deepEqual(perf.sinPauta.oppIds, [opps[6].id]);
    assert.equal(perf.multiPauta, 1, "c5 cuenta en dos filas");

    assert.deepEqual(
      perf.rows.map((r) => r.name),
      ["Pauta A", "Pauta B", SIN_NOMBRE_CAMPAIGN],
      "por leads desc, 'Sin nombre' al final"
    );

    const a = rowFor(perf, "Pauta A");
    assert.equal(a.cells.leads.count, 4, "c1, c2, c3, c5");
    assert.equal(a.cells.citas.count, 4, "venta, ≥05, objeto Citas, 04");
    assert.equal(a.cells.ventas.count, 1);
    assert.equal(a.cells.perdidos.count, 1);
    assert.equal(a.missing, false);

    const b = rowFor(perf, "Pauta B");
    assert.equal(b.cells.leads.count, 2, "c4, c5");
    assert.equal(b.cells.citas.count, 1, "solo c5");
    assert.equal(b.cells.ventas.count, 0);
    assert.equal(b.cells.perdidos.count, 1);

    const sn = rowFor(perf, SIN_NOMBRE_CAMPAIGN);
    assert.equal(sn.missing, true);
    assert.equal(sn.cells.leads.count, 1);

    // Los totales cuentan DISTINTAS: 6 con Pauta, no 4 + 2 + 1 = 7.
    assert.equal(perf.totals.leads.count, 6);
    assert.equal(perf.totals.citas.count, 4);
    assert.equal(perf.totals.ventas.count, 1);
    assert.equal(perf.totals.perdidos.count, 2);
    for (const m of PAUTA_METRICS) {
      assert.equal(new Set(perf.totals[m].oppIds).size, perf.totals[m].count, `totals.${m} sin ids repetidos`);
      assert.equal(a.cells[m].oppIds.length, a.cells[m].count, `ids de A.${m} cuadran`);
    }
    assert.equal(perf.totals.leads.count + perf.sinPauta.count, perf.universe, "con Pauta + sin Pauta = universo");

    // Una ganada nunca es perdida, aunque el status diga lo que diga la etapa.
    assert.ok(!a.cells.perdidos.oppIds.includes(opps[0].id));
  }

  // ── Una Pauta fuera de la ventana de fechas sigue nombrando ──────────────
  // (el chart pasa allPautas; aquí solo se comprueba que createdAt no interviene)
  {
    const perf = buildPautaPerformance(
      [opp({ contactId: "c1" })],
      [pauta("c1", "Vieja", "2025-01-01T00:00:00.000Z")],
      []
    );
    assert.equal(rowFor(perf, "Vieja").cells.leads.count, 1);
  }

  // ── Acotado a un desarrollo: solo nombran fila las Pautas de ESE desarrollo ─
  {
    const pautas = [
      pauta("c1", "Cañadas by El Mirador", undefined, "Cañadas"),
      pauta("c1", "FORM ATRIA JUNIO", undefined, "Atria"),
      pauta("c2", "Cañadas by El Mirador", undefined, "Cañadas"), // c2 solo tiene Pauta de Cañadas
      pauta("c3", "Form. Átria - Agosto", undefined, "Átria"), // acento distinto al pipeline
    ];
    const opps = [
      opp({ contactId: "c1" }),
      opp({ contactId: "c2" }),
      opp({ contactId: "c3" }),
      opp({ contactId: "c4" }), // sin ninguna Pauta
    ];
    const perf = buildPautaPerformance(opps, pautas, [], "Atria");
    assert.deepEqual(
      perf.rows.map((r) => r.name),
      ["FORM ATRIA JUNIO", "Form. Átria - Agosto"],
      "la pauta de Cañadas no aparece en la tabla de Atria"
    );
    assert.equal(perf.multiPauta, 0, "c1 ya no cuenta doble: su segunda Pauta es de otro desarrollo");
    assert.equal(perf.otroDesarrollo.count, 1, "c2 tiene Pauta, pero de Cañadas");
    assert.deepEqual(perf.otroDesarrollo.oppIds, [opps[1].id]);
    assert.equal(perf.sinPauta.count, 1, "c4 no tiene ninguna Pauta — distinto de c2");
    assert.equal(perf.totals.leads.count, 2);
    assert.equal(
      perf.totals.leads.count + perf.otroDesarrollo.count + perf.sinPauta.count,
      perf.universe,
      "con Pauta del desarrollo + de otro + sin Pauta = universo"
    );

    // Sin desarrollo (GENERAL) vuelve la convención completa.
    const general = buildPautaPerformance(opps, pautas, [], null);
    assert.equal(general.rows.length, 3);
    assert.equal(general.multiPauta, 1);
    assert.equal(general.otroDesarrollo.count, 0, "en GENERAL no existe 'otro desarrollo'");
    assert.equal(general.sinPauta.count, 1);
  }

  // ── Vacío ─────────────────────────────────────────────────────────────────
  {
    const perf = buildPautaPerformance([], [], []);
    assert.deepEqual(perf.rows, []);
    assert.equal(perf.universe, 0);
    assert.equal(perf.sinPauta.count, 0);
    assert.equal(perf.otroDesarrollo.count, 0);
    assert.equal(perf.multiPauta, 0);
    for (const m of PAUTA_METRICS) assert.equal(perf.totals[m].count, 0);
  }

  console.log("verify-pauta-performance: OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
