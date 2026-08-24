// Verificación de lib/stale-opportunity-matrix.ts — la matriz de
// "Oportunidades sin atención". Correr: pnpm verify:stale-matrix
//
// Justifican el script dos cosas. Una: el universo se define EXCLUYENDO etapas
// por nombre, y una etapa que cambie de grafía en GHL metería ventas cerradas
// en un gráfico de leads abandonados. Dos: un contacto ausente del mapa de
// actividad cae a propósito en la cubeta más profunda, así que un bug que
// vacíe el mapa no se ve como un error sino como una acusación de abandono
// total — verosímil, alarmante y falsa.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import {
  bucketOfDays,
  buildStaleMatrix,
  daysSince,
  isLiveStage,
  STALE_BUCKETS,
  type StaleBucketKey,
} from "../lib/stale-opportunity-matrix";

let seq = 0;

const NOW = new Date("2026-08-06T12:00:00.000Z");

/** ISO de hace `d` días exactos respecto a NOW. */
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function opp(o: {
  stage?: string;
  status?: Opportunity["status"];
  contactId?: string;
  movedDaysAgo?: number;
  createdDaysAgo?: number;
}): Opportunity {
  seq++;
  return {
    id: `o${seq}`,
    name: `Opp ${seq}`,
    pipelineId: "MiATYfkJWklaXqYc7hOr",
    pipelineStageId: "stage-1",
    status: o.status ?? "open",
    createdAt: daysAgo(o.createdDaysAgo ?? 0),
    contactId: o.contactId ?? `c${seq}`,
    value: 0,
    stage: o.stage ?? "Lead en proceso",
    pipelineName: "VAEO",
    lastStageChangeAt: o.movedDaysAgo === undefined ? undefined : daysAgo(o.movedDaysAgo),
  };
}

const cell = (
  m: ReturnType<typeof buildStaleMatrix>,
  row: StaleBucketKey,
  col: StaleBucketKey
) => {
  const r = m.rows.find((x) => x.bucket === row);
  assert.ok(r, `existe la fila ${row}`);
  return r!.cells[col];
};

async function main() {
  // 1. Fronteras exactas de cubeta, en los dos ejes (son la misma función).
  {
    assert.equal(bucketOfDays(0), "0-7");
    assert.equal(bucketOfDays(7), "0-7", "el día 7 todavía es la primera cubeta");
    assert.equal(bucketOfDays(8), "8-15", "el día 8 ya es la segunda");
    assert.equal(bucketOfDays(15), "8-15");
    assert.equal(bucketOfDays(16), "16-30");
    assert.equal(bucketOfDays(30), "16-30");
    assert.equal(bucketOfDays(31), "31-60");
    assert.equal(bucketOfDays(60), "31-60", "el día 60 todavía es 31-60");
    assert.equal(bucketOfDays(61), "60+", "el día 61 cae en la más profunda");
    assert.equal(bucketOfDays(9999), "60+");
    assert.equal(bucketOfDays(null), "60+", "sin dato ⇒ la más profunda");
    // Las cubetas cubren la recta sin huecos ni traslapes.
    for (let d = 0; d <= 120; d++) {
      const k = bucketOfDays(d);
      const def = STALE_BUCKETS.find((b) => b.key === k)!;
      assert.ok(d >= def.min && d <= def.max, `día ${d} dentro de ${k}`);
    }
  }

  // 2. daysSince: piso en días, y null cuando no hay dato utilizable.
  {
    assert.equal(daysSince(daysAgo(3), NOW), 3);
    assert.equal(daysSince(NOW.toISOString(), NOW), 0);
    assert.equal(daysSince(undefined, NOW), null);
    assert.equal(daysSince(null, NOW), null);
    assert.equal(daysSince("no-es-fecha", NOW), null);
    // Una fecha en el FUTURO no es negativa: se trata como recién movida.
    assert.equal(daysSince(new Date(NOW.getTime() + 86_400_000).toISOString(), NOW), 0);
  }

  // 3. El universo excluye Ganado / Perdido / Cliente Futuro POR NOMBRE, en sus
  //    dos grafías, y respeta el status.
  {
    assert.ok(isLiveStage("Nuevo Lead"));
    assert.ok(isLiveStage("Lead Perfilado"));
    assert.ok(isLiveStage("Lead perfilado"), "la grafía de MESH también es viva");
    assert.ok(isLiveStage("Propuesta"));
    assert.ok(isLiveStage("Negociación"));
    assert.ok(!isLiveStage("Ganado"));
    assert.ok(!isLiveStage("ganada"));
    assert.ok(!isLiveStage("09. Negocio Ganado"));
    assert.ok(!isLiveStage("Perdido"));
    assert.ok(!isLiveStage("perdida"));
    assert.ok(!isLiveStage("Cliente Futuro"));
    assert.ok(!isLiveStage("cliente  futuro"), "espacios de más no lo salvan");
  }

  {
    const opps = [
      opp({ stage: "Lead en proceso" }),
      opp({ stage: "Ganado" }),
      opp({ stage: "Perdido" }),
      opp({ stage: "Cliente Futuro" }),
      opp({ stage: "Lead en proceso", status: "won" }),
      opp({ stage: "Lead en proceso", status: "lost" }),
      opp({ stage: "Lead en proceso", status: "abandoned" }),
    ];
    const m = buildStaleMatrix(opps, new Map(), NOW);
    assert.equal(m.grandTotal, 1, "solo la abierta en etapa viva entra");
  }

  // 4. Eje de movimiento: lastStageChangeAt manda; sin él, createdAt.
  {
    const a = opp({ movedDaysAgo: 3, createdDaysAgo: 90 });
    const b = opp({ createdDaysAgo: 45 });
    const m = buildStaleMatrix([a, b], new Map(), NOW);
    assert.deepEqual(cell(m, "0-7", "60+").oppIds, [a.id], "movida hace 3 días, no hace 90");
    assert.deepEqual(
      cell(m, "31-60", "60+").oppIds,
      [b.id],
      "sin lastStageChangeAt cae a createdAt"
    );
  }

  // 5. Eje de mensajes: ausente del mapa y presente-pero-null son LO MISMO.
  {
    const ausente = opp({ contactId: "c-ausente", movedDaysAgo: 2 });
    const nulo = opp({ contactId: "c-nulo", movedDaysAgo: 2 });
    const reciente = opp({ contactId: "c-reciente", movedDaysAgo: 2 });
    const map = new Map<string, string | null>([
      ["c-nulo", null],
      ["c-reciente", daysAgo(4)],
    ]);
    const m = buildStaleMatrix([ausente, nulo, reciente], map, NOW);
    assert.equal(cell(m, "0-7", "60+").count, 2, "ausente y null van juntos a la cubeta profunda");
    assert.deepEqual(cell(m, "0-7", "0-7").oppIds, [reciente.id]);
  }

  // 6. Totales, máximo y cuadrante crítico.
  {
    const criticas = [
      opp({ contactId: "x1", movedDaysAgo: 40 }),
      opp({ contactId: "x2", movedDaysAgo: 70 }),
      opp({ contactId: "x3", movedDaysAgo: 31 }),
    ];
    const sanas = [
      opp({ contactId: "y1", movedDaysAgo: 1 }),
      opp({ contactId: "y2", movedDaysAgo: 20 }),
    ];
    const map = new Map<string, string | null>([
      ["y1", daysAgo(1)],
      ["y2", daysAgo(9)],
    ]);
    const m = buildStaleMatrix([...criticas, ...sanas], map, NOW);

    assert.equal(m.grandTotal, 5);
    const sumCells = m.rows.reduce(
      (acc, r) => acc + STALE_BUCKETS.reduce((a, b) => a + r.cells[b.key].count, 0),
      0
    );
    assert.equal(sumCells, m.grandTotal, "las celdas suman el gran total");

    const sumRows = m.rows.reduce((a, r) => a + r.total, 0);
    assert.equal(sumRows, m.grandTotal, "los totales de fila cuadran");

    const sumCols = STALE_BUCKETS.reduce((a, b) => a + m.colTotals[b.key].count, 0);
    assert.equal(sumCols, m.grandTotal, "los totales de columna cuadran");

    // Las tres críticas: ≥31 días de movimiento y sin mensaje (⇒ 60+).
    assert.equal(m.criticalCount, 3);
    assert.deepEqual([...m.criticalOppIds].sort(), criticas.map((o) => o.id).sort());
    assert.equal(m.cellMax, 2, "el máximo de celda es (31-60 × 60+)");

    // Se dibujan las cinco filas aunque estén vacías: un renglón faltante haría
    // que el ojo lea la matriz corrida.
    assert.equal(m.rows.length, STALE_BUCKETS.length);
  }

  // 7. Conjunto vacío.
  {
    const m = buildStaleMatrix([], new Map(), NOW);
    assert.equal(m.grandTotal, 0);
    assert.equal(m.cellMax, 0);
    assert.equal(m.criticalCount, 0);
    assert.equal(m.rows.length, STALE_BUCKETS.length, "la rejilla existe aunque no haya datos");
  }

  console.log("verify-stale-matrix: all assertions passed");
}

main();
