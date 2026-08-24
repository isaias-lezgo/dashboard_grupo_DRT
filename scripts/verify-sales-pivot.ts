// Verification for lib/sales-pivot.ts + lib/panel-scope.ts —
// the three pure modules that decide WHICH opportunities a panel is talking about
// and what they add up to.
// Run: pnpm verify:pivot
//
// These two modules answer a question in money, and a wrong answer looks
// exactly like a right one on screen — there is no crash to notice. The UTC
// month bucketing (assertion 1) is the subtle one: GHL stores DATE custom
// fields at UTC midnight, so reading the month in local time moves a close on
// the 1st into the previous month.
//
// Wrapped in main() rather than using top-level await: this package is CJS.
import assert from "node:assert/strict";
import type { Opportunity, Pipeline } from "../lib/types";
import {
  buildSalesPivot,
  closeDateOf,
  NO_DATE_KEY,
  NO_SERVICIO,
  NO_SUCURSAL,
  TOTAL_KEY,
} from "../lib/sales-pivot";
import { buildSalesSeries, OTROS_KEY } from "../lib/sales-series";
import { monthKeyOf as createdMonthKeyOf, statusBucket } from "../lib/opportunity-breakdown";
import { PANEL_SCOPES, resolvePipelineId, scopeOpportunities } from "../lib/panel-scope";

// El pivote recibe el nombre del campo por parámetro, así que la prueba elige
// uno cualquiera: lo que se afirma es la agregación, no el nombre del campo.
const SUCURSAL_FIELD = "Sucursal";

let seq = 0;

// Build a minimally valid Opportunity. Only the fields the pivot reads matter.
function opp(o: {
  value: number;
  cierre?: string;
  sucursal?: string;
  servicio?: string;
  status?: Opportunity["status"];
  stage?: string;
  pipelineId?: string;
  creado?: string;
}): Opportunity {
  const resolved: Record<string, string> = {};
  if (o.cierre) resolved["Fecha de Cierre"] = o.cierre;
  if (o.sucursal) resolved[SUCURSAL_FIELD] = o.sucursal;
  if (o.servicio) resolved["Servicio"] = o.servicio;

  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: o.pipelineId ?? PANEL_SCOPES.canadas.pipelineId!,
    pipelineStageId: "stage-1",
    status: o.status ?? "won",
    createdAt: o.creado ?? "2026-01-01T00:00:00.000Z",
    contactId: `c${seq}`,
    value: o.value,
    stage: o.stage ?? "Ganado",
    pipelineName: "VAEO",
    customFieldsResolved: resolved,
  };
}

const cellAt = (
  pivot: ReturnType<typeof buildSalesPivot>,
  rowKey: string,
  columnKey: string
) => {
  const row = pivot.rows.find((r) => r.key === rowKey);
  assert.ok(row, `row ${rowKey} exists`);
  const i = pivot.columns.findIndex((c) => c.key === columnKey);
  assert.notEqual(i, -1, `column ${columnKey} exists`);
  return row!.cells[i];
};

function main() {
  // 1. UTC month bucketing at the month boundary.
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 100, cierre: "2026-08-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 50, cierre: "2026-07-31T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    const keys = pivot.rows.filter((r) => r.kind === "month").map((r) => r.key);
    assert.deepEqual(keys, ["2026-07", "2026-08"], "UTC midnight on the 1st stays in its own month");
    assert.equal(cellAt(pivot, "2026-08", "MTY Tanarah||Coworking").value, 100);
    assert.equal(cellAt(pivot, "2026-07", "MTY Tanarah||Coworking").value, 50);
  }

  // 2. Empty buckets: missing sucursal, missing servicio, missing close date.
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 10, cierre: "2026-03-15T00:00:00.000Z", servicio: "Coworking" }),
        opp({ value: 20, cierre: "2026-03-15T00:00:00.000Z", sucursal: "SLP Covalia" }),
        opp({ value: 30, sucursal: "SLP Covalia", servicio: "Coworking" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    assert.equal(cellAt(pivot, "2026-03", `${NO_SUCURSAL}||Coworking`).value, 10, "sucursal vacía cae en Sin sucursal");
    assert.equal(cellAt(pivot, "2026-03", `SLP Covalia||${NO_SERVICIO}`).value, 20, "servicio vacío cae en Sin servicio");
    assert.equal(cellAt(pivot, NO_DATE_KEY, "SLP Covalia||Coworking").value, 30, "sin fecha cae en su propia fila");
    assert.equal(pivot.grandTotal, 60, "las tres siguen contando para el total");
  }

  // 3. Only wins count — including a stage-only win with status "open".
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 100, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "won" }),
        opp({ value: 7, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "open", stage: "Propuesta" }),
        opp({ value: 7, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "lost", stage: "Ganado" }),
        opp({ value: 7, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "abandoned", stage: "Perdido" }),
        opp({ value: 25, cierre: "2026-05-10T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Day pass", status: "open", stage: "Ganado" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    assert.equal(pivot.grandTotal, 125, "abierta/perdida/abandonada fuera; stage Ganado con status open dentro");
  }

  // 4. Subtotals, total row and grand total agree with the raw sum.
  {
    const opps = [
      opp({ value: 100, cierre: "2026-04-02T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
      opp({ value: 200, cierre: "2026-04-20T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Sala de Juntas" }),
      opp({ value: 300, cierre: "2026-05-05T00:00:00.000Z", sucursal: "SLP Covalia", servicio: "Coworking" }),
      opp({ value: 400, cierre: "2026-05-06T00:00:00.000Z", sucursal: "SLP Covalia" }),
    ];
    const pivot = buildSalesPivot(opps, { sucursalField: SUCURSAL_FIELD });
    const raw = opps.reduce((s, o) => s + o.value, 0);

    assert.equal(pivot.grandTotal, raw, "el total general cuadra con la suma cruda");
    assert.equal(cellAt(pivot, "2026-04", "sub||MTY Tanarah").value, 300, "subtotal por sucursal en un mes");
    assert.equal(cellAt(pivot, TOTAL_KEY, "sub||SLP Covalia").value, 700, "subtotal de la fila Total");
    assert.equal(cellAt(pivot, TOTAL_KEY, TOTAL_KEY).value, raw, "la celda Total/Total es el total general");

    // Every row's Total cell equals the sum of that row's plain cells.
    for (const row of pivot.rows) {
      const cellSum = pivot.columns.reduce(
        (s, c, i) => (c.kind === "cell" ? s + row.cells[i].value : s),
        0
      );
      const totalIdx = pivot.columns.findIndex((c) => c.key === TOTAL_KEY);
      assert.equal(row.cells[totalIdx].value, cellSum, `la fila ${row.key} cuadra con sus celdas`);
    }

    // Drill-down ids: the Total/Total cell holds every won opportunity.
    assert.equal(cellAt(pivot, TOTAL_KEY, TOTAL_KEY).oppIds.length, opps.length, "el drill del total trae todas");
  }

  // 5. Ordering: no-date row first, months ascending, Total last;
  //    "Sin servicio" closes its group and the grand total is the last column.
  {
    const pivot = buildSalesPivot(
      [
        opp({ value: 5, cierre: "2026-06-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 5, cierre: "2026-01-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 9, sucursal: "MTY Tanarah", servicio: "Coworking" }),
        opp({ value: 1, cierre: "2026-01-01T00:00:00.000Z", sucursal: "MTY Tanarah" }),
      ],
      { sucursalField: SUCURSAL_FIELD }
    );
    assert.deepEqual(
      pivot.rows.map((r) => r.key),
      [NO_DATE_KEY, "2026-01", "2026-06", TOTAL_KEY],
      "sin-fecha arriba, meses ascendentes, Total al final"
    );
    assert.deepEqual(
      pivot.columns.map((c) => c.key),
      [
        "MTY Tanarah||Coworking",
        `MTY Tanarah||${NO_SERVICIO}`,
        "sub||MTY Tanarah",
        TOTAL_KEY,
      ],
      "Sin servicio cierra el grupo, luego Subtotal, y Total al final"
    );
    assert.equal(pivot.rows[0].label, "Sin fecha de cierre");
    assert.equal(pivot.rows[1].label, "ene 2026", "etiqueta de mes en español");
  }

  // 6. Empty input produces an empty pivot, not a lone Total row.
  {
    const pivot = buildSalesPivot([], { sucursalField: SUCURSAL_FIELD });
    assert.deepEqual(pivot.rows, [], "sin datos no hay filas");
    assert.equal(pivot.grandTotal, 0);
  }

  // 7. closeDateOf ignores an unparseable value.
  {
    const bad = opp({ value: 1, sucursal: "MTY Tanarah" });
    bad.customFieldsResolved = { "Fecha de Cierre": "no soy fecha" };
    assert.equal(closeDateOf(bad), undefined, "una fecha basura se trata como ausente");
  }

  // 8. panel-scope: name match wins, id is the fallback, and scoping filters.
  {
    const pipelines: Pipeline[] = [
      { id: "nuevo-id-canadas", name: "Cañadas", stages: ["00. Recibido", "08. Venta"] },
      { id: "nuevo-id-atria", name: "Atria", stages: ["00. Recibido", "08. Venta"] },
    ];
    assert.equal(resolvePipelineId(pipelines, "canadas"), "nuevo-id-canadas", "gana el match por nombre");
    assert.equal(resolvePipelineId([], "canadas"), PANEL_SCOPES.canadas.pipelineId, "sin match, cae al id");
    assert.equal(resolvePipelineId(undefined, "atria"), PANEL_SCOPES.atria.pipelineId, "sin pipelines, cae al id");
    // El match por nombre ignora acentos: la llave del panel es "canadas".
    assert.equal(resolvePipelineId(pipelines, "canadas"), "nuevo-id-canadas", "\u00f1 y acentos no rompen el match");

    const mixed = [
      opp({ value: 1, pipelineId: "nuevo-id-canadas" }),
      opp({ value: 1, pipelineId: "nuevo-id-atria" }),
    ];
    assert.equal(scopeOpportunities(mixed, "canadas", pipelines).length, 1, "solo el pipeline del panel");
    assert.equal(scopeOpportunities(mixed, "atria", pipelines).length, 1);

    // GENERAL no acota: devuelve el MISMO arreglo, sin copiar.
    assert.equal(resolvePipelineId(pipelines, "general"), null, "GENERAL no tiene embudo");
    assert.equal(scopeOpportunities(mixed, "general", pipelines), mixed, "GENERAL: misma referencia");
  }

  // 9. sales-series: cuadre exacto con el pivote sobre el mismo input.
  // Es LA aserción del módulo: los dos charts y la tabla viven en la misma
  // pantalla, así que una discrepancia es visible y vergonzosa.
  {
    const opps = [
      opp({ value: 100, cierre: "2026-06-10T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Coworking" }),
      opp({ value: 250, cierre: "2026-06-20T00:00:00.000Z", sucursal: "QRO Central Park", servicio: "Coworking" }),
      opp({ value: 70, cierre: "2026-07-01T00:00:00.000Z", sucursal: "MTY Tanarah", servicio: "Sala de Juntas" }),
      opp({ value: 30, cierre: "2026-07-05T00:00:00.000Z", sucursal: "SLP Covalia" }),
      opp({ value: 40, sucursal: "MTY Tanarah", servicio: "Coworking" }),
    ];
    const pivot = buildSalesPivot(opps, { sucursalField: SUCURSAL_FIELD });
    const series = buildSalesSeries(opps, {
      dimensionField: SUCURSAL_FIELD,
      emptyLabel: NO_SUCURSAL,
    });

    assert.equal(series.grandTotal, pivot.grandTotal, "el total general cuadra con el pivote");

    for (const bucket of series.buckets) {
      const cell = cellAt(pivot, bucket.key, TOTAL_KEY);
      assert.equal(bucket.total, cell.value, `el bucket ${bucket.key} cuadra con su fila`);
    }

    for (const s of series.series) {
      const cell = cellAt(pivot, TOTAL_KEY, `sub||${s.key}`);
      assert.equal(s.total, cell.value, `la serie ${s.key} cuadra con su subtotal`);
    }
  }

  // 10. sales-series: orden, cubetas y drill.
  {
    const opps = [
      opp({ value: 10, cierre: "2026-05-02T00:00:00.000Z", sucursal: "MTY Tanarah" }),
      opp({ value: 900, cierre: "2026-04-02T00:00:00.000Z", sucursal: "QRO Central Park" }),
      opp({ value: 5, cierre: "2026-04-03T00:00:00.000Z" }),
      opp({ value: 7, sucursal: "MTY Tanarah" }),
      opp({ value: 3, cierre: "2026-04-01T00:00:00.000Z", sucursal: "MTY Tanarah", status: "lost", stage: "Perdido" }),
    ];
    const d = buildSalesSeries(opps, {
      dimensionField: SUCURSAL_FIELD,
      emptyLabel: NO_SUCURSAL,
    });

    assert.deepEqual(
      d.series.map((s) => s.key),
      ["QRO Central Park", "MTY Tanarah", NO_SUCURSAL],
      "series por total desc, la cubeta vacía siempre al final"
    );
    assert.deepEqual(
      d.buckets.map((b) => b.label),
      ["abr 2026", "may 2026", "Sin fecha de cierre"],
      "meses ascendentes y la cubeta sin fecha al FINAL (al revés que el pivote)"
    );
    assert.equal(d.buckets[2].kind, "no-date");
    assert.equal(d.buckets[2].total, 7, "la ganada sin fecha vive en su propio bucket");
    assert.equal(d.grandTotal, 922, "la perdida no cuenta; todo lo demás sí");

    const abr = d.buckets[0];
    assert.equal(abr.values["QRO Central Park"], 900);
    assert.equal(abr.values[NO_SUCURSAL], 5, "sucursal vacía cae en la cubeta vacía");
    assert.equal(abr.values["MTY Tanarah"], undefined, "una serie sin valor no ocupa lugar");
    assert.equal(abr.oppIds["QRO Central Park"].length, 1, "el drill trae los ids de la celda");
  }

  // 11. sales-series: la cola se pliega en "Otros" cuando hay más de maxNamed.
  {
    const mk = (servicio: string, value: number) =>
      opp({ value, cierre: "2026-04-02T00:00:00.000Z", servicio });
    const opps = [
      mk("A", 100), mk("B", 90), mk("C", 80), mk("D", 70),
      mk("E", 60), mk("F", 50), mk("G", 40),
    ];
    const d = buildSalesSeries(opps, {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
      maxNamed: 5,
    });

    assert.deepEqual(
      d.series.map((s) => s.key),
      ["A", "B", "C", "D", "E", OTROS_KEY],
      "las 5 mayores conservan nombre, F y G se pliegan"
    );
    assert.equal(d.series[5].total, 90, "Otros suma la cola");
    assert.equal(d.series[5].foldedCount, 2, "Otros dice cuántas plegó");
    assert.equal(d.buckets[0].oppIds[OTROS_KEY].length, 2, "el drill de Otros trae las dos");
    assert.equal(d.grandTotal, 490, "plegar no cambia el total");
  }

  // 12. sales-series: namedKeys congela qué series existen. Sin esto, filtrar
  // por fecha puede "despiegar" una serie que en el total vive dentro de Otros,
  // y el chart repinta colores al mover el filtro.
  {
    const mk = (servicio: string, value: number) =>
      opp({ value, cierre: "2026-04-02T00:00:00.000Z", servicio });
    const d = buildSalesSeries([mk("F", 50), mk("G", 40)], {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
      namedKeys: ["A", "B", "C", "D", "E"],
    });
    assert.deepEqual(
      d.series.map((s) => s.key),
      [OTROS_KEY],
      "F y G siguen plegadas aunque a solas serían las mayores"
    );
    assert.equal(d.series[0].total, 90, "Otros suma las dos");
  }

  // 13. sales-series: no se pliega una sola sobrante — "Otros (1)" es absurdo.
  {
    const mk = (servicio: string, value: number) =>
      opp({ value, cierre: "2026-04-02T00:00:00.000Z", servicio });
    const d = buildSalesSeries(
      [mk("A", 100), mk("B", 90), mk("C", 80), mk("D", 70), mk("E", 60), mk("F", 50)],
      { dimensionField: "Servicio", emptyLabel: NO_SERVICIO, maxNamed: 5 }
    );
    assert.deepEqual(
      d.series.map((s) => s.key),
      ["A", "B", "C", "D", "E", "F"],
      "con una sola sobrante se queda con su nombre"
    );
  }

  // ---------------------------------------------------------------------------
  // buildSalesSeries generalizado: include / monthOf / measure
  //
  // Las tres opciones existen para que "Leads no ganados por servicio" reuse
  // este agregado en vez de copiarle el orden de series y el plegado de
  // "Otros". Lo que hay que aseverar es que los DEFAULTS no se movieron —el
  // pivote de ventas depende de ellos— y que las opciones recortan el universo
  // que dicen recortar.
  // ---------------------------------------------------------------------------

  // 14. Los defaults siguen siendo ganadas × Fecha de Cierre × valor. Una
  // perdida con valor no puede colarse al agregado de ventas.
  {
    const mixto = [
      opp({ value: 100, cierre: "2026-04-02T00:00:00.000Z", servicio: "Coworking" }),
      opp({
        value: 999,
        cierre: "2026-04-02T00:00:00.000Z",
        servicio: "Coworking",
        status: "lost",
        stage: "Perdido",
      }),
    ];
    const d = buildSalesSeries(mixto, {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
    });
    assert.equal(d.grandTotal, 100, "sin opciones solo cuentan las ganadas, y en dinero");
  }

  // 15. include + measure: "count" — el universo espejo, contado por cabezas.
  // El valor monetario deja de importar: una perdida en $0 pesa igual que una
  // en $99,000, que es justo lo que quiere decir "cuántos leads".
  {
    const noGanada = (servicio: string, value: number, creado: string) =>
      opp({ value, servicio, creado, status: "lost", stage: "Perdido" });
    const set = [
      noGanada("Coworking", 0, "2026-04-10T15:00:00.000Z"),
      noGanada("Coworking", 99000, "2026-04-11T15:00:00.000Z"),
      opp({ value: 5000, cierre: "2026-04-02T00:00:00.000Z", servicio: "Coworking" }),
    ];
    const d = buildSalesSeries(set, {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
      include: (o) => statusBucket(o) === "perdida",
      monthOf: (o) => createdMonthKeyOf(o.createdAt),
      measure: "count",
    });
    assert.equal(d.grandTotal, 2, "cuenta oportunidades, no pesos, y deja fuera la ganada");
    assert.equal(d.series[0].total, 2, "las dos perdidas caen en la misma serie");
  }

  // 16. "No ganadas" incluye las abiertas. Ojo con la etapa: isWonOpp() decide
  // por NOMBRE de etapa, así que una abierta parada en "Ganado" sí es una venta
  // y no debe entrar aquí.
  {
    const set = [
      opp({ value: 0, servicio: "Coworking", status: "open", stage: "Nuevo Lead" }),
      opp({ value: 0, servicio: "Coworking", status: "lost", stage: "Perdido" }),
      opp({ value: 0, servicio: "Coworking", status: "open", stage: "Ganado" }),
    ];
    const d = buildSalesSeries(set, {
      dimensionField: "Servicio",
      emptyLabel: NO_SERVICIO,
      include: (o) => statusBucket(o) !== "ganada",
      monthOf: (o) => createdMonthKeyOf(o.createdAt),
      measure: "count",
    });
    assert.equal(d.grandTotal, 2, "abierta + perdida; la parada en Ganado es una venta");
  }

  // 17. monthOf manda sobre el bucket, y se lee EN HORA LOCAL. No se asevera un
  // mes literal —el script corre en la zona que sea— sino que el bucket es
  // exactamente el que da el lector de opportunity-breakdown, que es el mismo
  // que usa "Oportunidades por estado". Si las dos gráficas leyeran el mes
  // distinto, un lead creado el 1 a las 02:00Z aparecería en meses distintos en
  // cada una.
  {
    const creado = "2026-08-01T02:00:00.000Z";
    const d = buildSalesSeries(
      [opp({ value: 0, servicio: "Coworking", creado, status: "lost", stage: "Perdido" })],
      {
        dimensionField: "Servicio",
        emptyLabel: NO_SERVICIO,
        include: (o) => statusBucket(o) === "perdida",
        monthOf: (o) => createdMonthKeyOf(o.createdAt),
        measure: "count",
      }
    );
    assert.equal(
      d.buckets[0].key,
      createdMonthKeyOf(creado),
      "el bucket es el mes local, el mismo que lee opportunity-breakdown"
    );
  }

  // 18. monthOf que devuelve null cae en la cubeta sin fecha en vez de perderse.
  {
    const d = buildSalesSeries(
      [opp({ value: 0, servicio: "Coworking", status: "lost", stage: "Perdido" })],
      {
        dimensionField: "Servicio",
        emptyLabel: NO_SERVICIO,
        include: () => true,
        monthOf: () => null,
        measure: "count",
      }
    );
    assert.equal(d.buckets[0].key, NO_DATE_KEY, "sin mes legible va a la cubeta sin fecha");
    assert.equal(d.grandTotal, 1, "y sigue contando");
  }

  // 19. La cubeta vacía se rotula con emptyLabel y va SIEMPRE al final de las
  // series, aunque sea la mayor. Es el caso real de esta gráfica: "Servicio" no
  // se captura en los leads que se pierden, así que "Sin servicio" domina y
  // aun así no puede robarle el primer lugar del apilado a un servicio real.
  {
    const perdida = (servicio?: string) =>
      opp({ value: 0, servicio, status: "lost", stage: "Perdido" });
    const d = buildSalesSeries(
      [perdida(), perdida(), perdida(), perdida("Coworking")],
      {
        dimensionField: "Servicio",
        emptyLabel: NO_SERVICIO,
        include: (o) => statusBucket(o) === "perdida",
        monthOf: (o) => createdMonthKeyOf(o.createdAt),
        measure: "count",
      }
    );
    assert.deepEqual(
      d.series.map((s) => s.key),
      ["Coworking", NO_SERVICIO],
      "la cubeta vacía va al final aunque pese 3 contra 1"
    );
    assert.equal(d.series[1].kind, "empty", "y queda marcada como cubeta vacía");
    assert.equal(d.series[1].total, 3);
  }

  console.log("verify-sales-pivot: all assertions passed");
}

main();
