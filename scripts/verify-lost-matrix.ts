// Verification for lib/lost-reason-matrix.ts — el cruce de la tabla "Motivos de
// perdido" (motivo × Canal de Contacto / Origen de Lead).
// Correr: pnpm verify:lost-matrix
//
// Un cruce mal armado no truena: da una respuesta plausible y equivocada. Las
// dos trampas concretas son (a) que se cuele una oportunidad que no es perdida
// —"ganada" en esta cuenta se decide por etapa, no por status— y (b) que una
// oportunidad con dos categorías en la misma celda se cuente dos veces en el
// gran total en vez de sumar solo en sus dos columnas.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import { CANAL_FIELDS, NO_VALUE_LABEL, buildCategoryBreakdown } from "../lib/opportunity-breakdown";
import { NO_REASON_LABEL, buildLostReasonMatrix } from "../lib/lost-reason-matrix";

let seq = 0;

// Oportunidad mínimamente válida; solo importan los campos que lee el módulo.
function opp(o: {
  status?: Opportunity["status"];
  stage?: string;
  lostReason?: string;
  canal?: string;
}): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "pipe-1",
    pipelineStageId: "stage-1",
    status: o.status ?? "lost",
    createdAt: "2026-06-15T12:00:00.000Z",
    contactId: `c${seq}`,
    value: 0,
    stage: o.stage ?? "Perdido",
    pipelineName: "VAEO",
    lostReason: o.lostReason,
    ...(o.canal ? { customFieldsResolved: { "Canal de Contacto": o.canal } } : {}),
  };
}

const rowFor = (m: ReturnType<typeof buildLostReasonMatrix>, label: string) => {
  const r = m.rows.find((x) => x.label === label);
  assert.ok(r, `existe la fila "${label}" (hay: ${m.rows.map((x) => x.label).join(", ")})`);
  return r!;
};

const colIndex = (m: ReturnType<typeof buildLostReasonMatrix>, label: string) => {
  const i = m.columns.findIndex((c) => c.label === label);
  assert.notEqual(
    i,
    -1,
    `existe la columna "${label}" (hay: ${m.columns.map((c) => c.label).join(", ")})`
  );
  return i;
};

function main() {
  // 1. Solo entran las perdidas. "Ganada" se decide por etapa, así que una
  //    oportunidad `open` en etapa "Ganado" NO puede colarse; `abandoned` sí es
  //    pérdida, igual que en la barra roja del gráfico de estado.
  {
    const m = buildLostReasonMatrix(
      [
        opp({ status: "lost", lostReason: "No contesta", canal: "WHATSAPP" }),
        opp({ status: "abandoned", lostReason: "Spam", canal: "DM" }),
        opp({ status: "open", stage: "Ganado", lostReason: "No contesta", canal: "DM" }),
        opp({ status: "won", stage: "Ganado", canal: "DM" }),
        opp({ status: "open", stage: "Propuesta", canal: "DM" }),
      ],
      CANAL_FIELDS
    );
    assert.equal(m.grandTotal, 2, "solo cuentan lost + abandoned");
    assert.equal(rowFor(m, "No contesta").total, 1);
    assert.equal(rowFor(m, "Spam").total, 1);
  }

  // 2. Las columnas son EXACTAMENTE las del ranking de categorías sobre el mismo
  //    conjunto de perdidas. Si esto se rompe, la tabla y el gráfico de barras de
  //    al lado reportarían agrupamientos distintos para la misma pregunta.
  {
    const lost = [
      opp({ lostReason: "No contesta", canal: "WHATSAPP" }),
      opp({ lostReason: "No contesta", canal: "whatsapp" }),
      opp({ lostReason: "Spam", canal: "DM" }),
      opp({ lostReason: "Spam" }),
    ];
    const m = buildLostReasonMatrix(lost, CANAL_FIELDS);
    const bars = buildCategoryBreakdown(lost, CANAL_FIELDS);
    assert.deepEqual(
      m.columns.map((c) => [c.label, c.total]),
      bars.map((b) => [b.label, b.count]),
      "columnas == filas del ranking, en el mismo orden"
    );
    // La normalización viene heredada: WHATSAPP y whatsapp son una sola columna.
    assert.equal(m.columns.filter((c) => c.label === "WhatsApp").length, 1);
    assert.equal(m.columns[colIndex(m, "WhatsApp")].total, 2);
  }

  // 3. Multi-valor: una celda con dos categorías suma en las DOS columnas, pero
  //    una sola vez en el total de su fila y en el gran total.
  {
    const m = buildLostReasonMatrix(
      [
        opp({ lostReason: "Ya no le interesa", canal: "WHATSAPP, Formulario" }),
        opp({ lostReason: "Ya no le interesa", canal: "WHATSAPP" }),
      ],
      CANAL_FIELDS
    );
    const row = rowFor(m, "Ya no le interesa");
    assert.equal(row.cells[colIndex(m, "WhatsApp")].count, 2);
    assert.equal(row.cells[colIndex(m, "Formulario")].count, 1);
    assert.equal(row.total, 2, "el total de la fila son oportunidades distintas");
    assert.equal(m.grandTotal, 2);
    const suma = row.cells.reduce((a, c) => a + c.count, 0);
    assert.equal(suma, 3, "la suma horizontal puede pasarse del total — es a propósito");
    assert.equal(row.pct, 100);
  }

  // 4. "Sin motivo" y "Sin dato" van al final de su eje aunque sean los más
  //    grandes: son fugas de captura, no categorías que compitan en el ranking.
  {
    const m = buildLostReasonMatrix(
      [
        opp({ lostReason: undefined }),
        opp({ lostReason: undefined }),
        opp({ lostReason: "   " }),
        opp({ lostReason: "Spam", canal: "DM" }),
      ],
      CANAL_FIELDS
    );
    assert.equal(m.rows[m.rows.length - 1].label, NO_REASON_LABEL);
    assert.equal(rowFor(m, NO_REASON_LABEL).total, 3, "el motivo en blanco cae en Sin motivo");
    assert.equal(m.columns[m.columns.length - 1].label, NO_VALUE_LABEL);
  }

  // 5. La fila de totales está alineada con las columnas y cuadra con ellas.
  {
    const m = buildLostReasonMatrix(
      [
        opp({ lostReason: "No contesta", canal: "DM" }),
        opp({ lostReason: "Spam", canal: "DM" }),
        opp({ lostReason: "Spam", canal: "Llamada" }),
      ],
      CANAL_FIELDS
    );
    assert.equal(m.totals.length, m.columns.length);
    m.columns.forEach((c, i) => {
      assert.equal(m.totals[i].count, c.total, `total de la columna ${c.label}`);
      assert.equal(m.totals[i].oppIds.length, c.total);
      // Cada columna es la suma vertical de sus celdas.
      const vert = m.rows.reduce((a, r) => a + r.cells[i].count, 0);
      assert.equal(vert, c.total, `suma vertical de ${c.label}`);
    });
    assert.equal(m.grandTotal, 3);
    assert.equal(m.maxCell, 1);
    // Los porcentajes de fila suman 100 cuando ninguna oportunidad se repite.
    const pct = m.rows.reduce((a, r) => a + r.pct, 0);
    assert.ok(Math.abs(pct - 100) < 1e-9, `los % de fila suman 100 (dio ${pct})`);
  }

  // 6. Sin perdidas: matriz vacía, sin reventar ni dividir entre cero.
  {
    const m = buildLostReasonMatrix([opp({ status: "open", stage: "Propuesta" })], CANAL_FIELDS);
    assert.deepEqual(m.rows, []);
    assert.deepEqual(m.columns, []);
    assert.equal(m.grandTotal, 0);
    assert.equal(m.maxCell, 0);
    assert.deepEqual(buildLostReasonMatrix([], CANAL_FIELDS).rows, []);
  }

  // 7. Los ids de una celda son resolvibles: son los mismos que trae la fila y
  //    la columna. El drawer se arma con ellos, así que una celda que devuelva
  //    ids que no existen abriría un cajón vacío.
  {
    const a = opp({ lostReason: "No contesta", canal: "DM" });
    const b = opp({ lostReason: "No contesta", canal: "Llamada" });
    const m = buildLostReasonMatrix([a, b], CANAL_FIELDS);
    const row = rowFor(m, "No contesta");
    assert.deepEqual(row.cells[colIndex(m, "DM")].oppIds, [a.id]);
    assert.deepEqual(row.cells[colIndex(m, "Llamada")].oppIds, [b.id]);
    assert.deepEqual([...row.oppIds].sort(), [a.id, b.id].sort());
  }

  console.log("✓ lib/lost-reason-matrix.ts");
}

main();
