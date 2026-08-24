// Verification for lib/lost-cross-matrix.ts — el cruce de la tabla "Perdidas por
// servicio, origen y canal".
// Correr: pnpm verify:lost-cross
//
// Lo que aquí se puede romper sin que truene nada: (a) que se cuele una
// oportunidad que no es perdida —"ganada" en esta cuenta se decide por etapa, no
// por status—, (b) que el doble conteo multi-valor, que ahora puede ocurrir en
// LOS DOS ejes a la vez, se cuele al total de una fila o al gran total, y (c) que
// las cubetas de captura faltante dejen de ir al final o pierdan su etiqueta por
// dimensión.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import { buildCategoryBreakdown, CANAL_FIELDS } from "../lib/opportunity-breakdown";
import { NO_SERVICIO } from "../lib/sales-pivot";
import {
  buildLostCrossMatrix,
  LOST_DIMENSIONS,
  type LostCrossMatrix,
} from "../lib/lost-cross-matrix";

let seq = 0;

// Oportunidad mínimamente válida; solo importan los campos que lee el módulo.
function opp(o: {
  status?: Opportunity["status"];
  stage?: string;
  servicio?: string;
  origen?: string;
  canal?: string;
}): Opportunity {
  const cf: Record<string, string> = {};
  if (o.servicio !== undefined) cf["Servicio"] = o.servicio;
  if (o.origen !== undefined) cf["Origen de Lead"] = o.origen;
  if (o.canal !== undefined) cf["Canal de Contacto"] = o.canal;
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
    ...(Object.keys(cf).length > 0 ? { customFieldsResolved: cf } : {}),
  };
}

const rowFor = (m: LostCrossMatrix, label: string) => {
  const r = m.rows.find((x) => x.label === label);
  assert.ok(r, `existe la fila "${label}" (hay: ${m.rows.map((x) => x.label).join(", ")})`);
  return r!;
};

const colIndex = (m: LostCrossMatrix, label: string) => {
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
    const m = buildLostCrossMatrix(
      [
        opp({ status: "lost", servicio: "Coworking", canal: "WHATSAPP" }),
        opp({ status: "abandoned", servicio: "Coworking", canal: "DM" }),
        opp({ status: "open", stage: "Ganado", servicio: "Coworking", canal: "DM" }),
        opp({ status: "won", stage: "Ganado", servicio: "Coworking", canal: "DM" }),
        opp({ status: "open", stage: "Propuesta", servicio: "Coworking", canal: "DM" }),
      ],
      "servicio",
      "canal"
    );
    assert.equal(m.grandTotal, 2, "solo cuentan lost + abandoned");
    assert.equal(rowFor(m, "Coworking").total, 2);
  }

  // 2. Cada eje es EXACTAMENTE el ranking de categorías sobre el mismo conjunto
  //    de perdidas. Si esto se rompe, esta tabla y el gráfico de barras de al
  //    lado reportarían agrupamientos distintos para la misma pregunta.
  {
    const lost = [
      opp({ servicio: "Coworking", canal: "WHATSAPP" }),
      opp({ servicio: "Coworking", canal: "whatsapp" }),
      opp({ servicio: "Sala de Juntas", canal: "DM" }),
      opp({ servicio: "Sala de Juntas" }),
    ];
    const m = buildLostCrossMatrix(lost, "servicio", "canal");
    const bars = buildCategoryBreakdown(lost, CANAL_FIELDS);
    assert.deepEqual(
      m.columns.map((c) => c.total),
      bars.map((b) => b.count),
      "columnas == filas del ranking, en el mismo orden"
    );
    // La normalización viene heredada: WHATSAPP y whatsapp son una sola columna.
    assert.equal(m.columns.filter((c) => c.label === "WhatsApp").length, 1);
    assert.equal(m.columns[colIndex(m, "WhatsApp")].total, 2);
  }

  // 3. Multi-valor EN LOS DOS EJES a la vez: la oportunidad con dos orígenes y
  //    dos canales cae en cuatro celdas, pero una sola vez en el total de su
  //    fila, en el de su columna y en el gran total. Esta es la diferencia real
  //    contra lost-reason-matrix, donde el eje de filas nunca era multi-valor.
  {
    const m = buildLostCrossMatrix(
      [opp({ origen: "Meta, Sitio Web", canal: "DM, WHATSAPP" })],
      "origen",
      "canal"
    );
    for (const fila of ["Meta", "Sitio Web"]) {
      const row = rowFor(m, fila);
      assert.equal(row.cells[colIndex(m, "DM")].count, 1);
      assert.equal(row.cells[colIndex(m, "WhatsApp")].count, 1);
      assert.equal(row.total, 1, "el total de la fila son oportunidades distintas");
      assert.equal(row.pct, 100);
    }
    assert.equal(m.grandTotal, 1, "una oportunidad es una, caiga en las celdas que caiga");
    const suma = m.rows.reduce((a, r) => a + r.cells.reduce((b, c) => b + c.count, 0), 0);
    assert.equal(suma, 4, "2 orígenes × 2 canales = 4 celdas — es a propósito");
    for (const col of m.columns) {
      assert.equal(col.total, 1, `la columna ${col.label} cuenta oportunidades distintas`);
    }
  }

  // 4. Las cubetas de captura faltante van al final de su eje aunque sean las
  //    más grandes, y cada dimensión trae su propia etiqueta: en este cruce
  //    "Sin servicio" es EL hallazgo (el campo solo se captura al cerrar), así
  //    que tiene que ser reconocible, no un "Sin dato" genérico.
  {
    const m = buildLostCrossMatrix(
      [
        opp({ canal: "DM" }),
        opp({ canal: "DM" }),
        opp({ servicio: "   ", canal: "DM" }),
        opp({ servicio: "Coworking" }),
        // La única celda con dato real en los DOS ejes: es la que debe fijar el
        // techo del sombreado, aunque "Sin servicio × DM" la triplique.
        opp({ servicio: "Coworking", canal: "DM" }),
      ],
      "servicio",
      "canal"
    );
    const last = m.rows[m.rows.length - 1];
    assert.equal(last.label, NO_SERVICIO);
    assert.equal(last.label, LOST_DIMENSIONS.servicio.missingLabel);
    assert.equal(last.missing, true);
    assert.equal(last.total, 3, "el servicio en blanco cae en Sin servicio");
    assert.equal(m.columns[m.columns.length - 1].label, LOST_DIMENSIONS.canal.missingLabel);
    assert.equal(m.columns[m.columns.length - 1].missing, true);
    // Y esas cubetas NO mandan en el sombreado: la celda más grande de la tabla
    // es "Sin servicio × DM" con 3, pero maxCell mira solo el dato real (1).
    // Sin esto, la fila del 89% deja el resto de la tabla en blanco ilegible.
    assert.equal(last.cells[colIndex(m, "DM")].count, 3, "la centinela sí es la celda mayor");
    assert.equal(m.maxCell, 1, "maxCell ignora filas y columnas centinela");
    // Y la etiqueta cambia con el eje: la misma ausencia, dicha en su idioma.
    const otra = buildLostCrossMatrix([opp({ canal: "DM" })], "origen", "canal");
    assert.equal(otra.rows[otra.rows.length - 1].label, LOST_DIMENSIONS.origen.missingLabel);
  }

  // 5. La fila de totales está alineada con las columnas y cuadra con ellas.
  {
    const m = buildLostCrossMatrix(
      [
        opp({ servicio: "Coworking", canal: "DM" }),
        opp({ servicio: "Sala de Juntas", canal: "DM" }),
        opp({ servicio: "Sala de Juntas", canal: "Llamada" }),
      ],
      "servicio",
      "canal"
    );
    assert.equal(m.totals.length, m.columns.length);
    m.columns.forEach((c, i) => {
      assert.equal(m.totals[i].count, c.total, `total de la columna ${c.label}`);
      assert.equal(m.totals[i].oppIds.length, c.total);
      // Sin multi-valor cada columna es la suma vertical de sus celdas.
      const vert = m.rows.reduce((a, r) => a + r.cells[i].count, 0);
      assert.equal(vert, c.total, `suma vertical de ${c.label}`);
    });
    assert.equal(m.grandTotal, 3);
    assert.equal(m.maxCell, 1);
    // Los porcentajes de fila suman 100 cuando ninguna oportunidad se repite.
    const pct = m.rows.reduce((a, r) => a + r.pct, 0);
    assert.ok(Math.abs(pct - 100) < 1e-9, `los % de fila suman 100 (dio ${pct})`);
  }

  // 6. Las seis combinaciones de ejes se arman, y el gran total NO depende de
  //    cuáles se eligieron: son la misma pregunta vista desde otro ángulo.
  {
    const lost = [
      opp({ servicio: "Coworking", origen: "Meta", canal: "DM" }),
      opp({ servicio: "Sala de Juntas", origen: "Sitio Web", canal: "Formulario" }),
      opp({ origen: "Meta", canal: "WHATSAPP" }),
    ];
    const ids = ["servicio", "origen", "canal"] as const;
    for (const fila of ids) {
      for (const col of ids) {
        const m = buildLostCrossMatrix(lost, fila, col);
        if (fila === col) {
          // Diagonal sin sentido: matriz vacía, no una tabla plausible y falsa.
          assert.deepEqual(m.rows, [], `${fila} × ${col} no se cruza consigo mismo`);
          assert.equal(m.grandTotal, 0);
          continue;
        }
        assert.equal(m.grandTotal, 3, `gran total de ${fila} × ${col}`);
        assert.equal(m.totals.length, m.columns.length);
        for (const row of m.rows) {
          assert.equal(row.cells.length, m.columns.length, `${fila} × ${col}: celdas alineadas`);
        }
      }
    }
  }

  // 7. Sin perdidas: matriz vacía, sin reventar ni dividir entre cero.
  {
    const m = buildLostCrossMatrix(
      [opp({ status: "open", stage: "Propuesta", canal: "DM" })],
      "servicio",
      "canal"
    );
    assert.deepEqual(m.rows, []);
    assert.deepEqual(m.columns, []);
    assert.equal(m.grandTotal, 0);
    assert.equal(m.maxCell, 0);
    assert.deepEqual(buildLostCrossMatrix([], "origen", "canal").rows, []);
  }

  // 8. Los ids de una celda son resolvibles: son los mismos que trae la fila y la
  //    columna. El drawer se arma con ellos, así que una celda que devuelva ids
  //    que no existen abriría un cajón vacío.
  {
    const a = opp({ servicio: "Coworking", canal: "DM" });
    const b = opp({ servicio: "Coworking", canal: "Llamada" });
    const m = buildLostCrossMatrix([a, b], "servicio", "canal");
    const row = rowFor(m, "Coworking");
    assert.deepEqual(row.cells[colIndex(m, "DM")].oppIds, [a.id]);
    assert.deepEqual(row.cells[colIndex(m, "Llamada")].oppIds, [b.id]);
    assert.deepEqual([...row.oppIds].sort(), [a.id, b.id].sort());
  }

  console.log("✓ lib/lost-cross-matrix.ts");
}

main();
