// Verificación de lib/assignment-funnel.ts — "Leads sin asesor por mes".
// Correr: pnpm verify:assignment
//
// Lo que justifica el script es que esta tarjeta tiene DOS poblaciones en juego:
// el apilado cuenta solo las oportunidades sin asesor, pero el porcentaje se
// calcula contra TODOS los leads del mes. Confundirlas no truena nada — solo
// hace que la tarjeta afirme un porcentaje equivocado con toda seguridad.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity } from "../lib/types";
import { NO_DATE_KEY, NO_DATE_LABEL, STATUS_BUCKETS } from "../lib/opportunity-breakdown";
import {
  activeBuckets,
  buildUnassignedByMonth,
  isUnassigned,
  summarizeUnassigned,
} from "../lib/assignment-funnel";

let seq = 0;

function opp(o: {
  advisor?: string;
  stage?: string;
  status?: Opportunity["status"];
  createdAt?: string | undefined;
}): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "MiATYfkJWklaXqYc7hOr",
    pipelineStageId: "stage-1",
    status: o.status ?? "open",
    createdAt: "createdAt" in o ? (o.createdAt as string) : "2026-06-15T12:00:00.000Z",
    contactId: `c${seq}`,
    value: 0,
    stage: o.stage ?? "Nuevo Lead",
    pipelineName: "VAEO",
    assignedTo: o.advisor,
  };
}

const rowFor = (rows: ReturnType<typeof buildUnassignedByMonth>, key: string) => {
  const r = rows.find((x) => x.key === key);
  assert.ok(r, `existe la fila "${key}" (hay: ${rows.map((x) => x.key).join(", ")})`);
  return r!;
};

function main() {
  // 1. Qué cuenta como sin asesor.
  {
    assert.equal(isUnassigned(opp({})), true);
    assert.equal(isUnassigned(opp({ advisor: "" })), true);
    assert.equal(isUnassigned(opp({ advisor: "   " })), true, "espacios no son un asesor");
    assert.equal(isUnassigned(opp({ advisor: "Zulema" })), false);
  }

  // 2. Las asignadas NO entran al apilado, pero SÍ al denominador. Esta es la
  //    invariante que sostiene el porcentaje de la tarjeta.
  {
    const rows = buildUnassignedByMonth([
      opp({ createdAt: "2026-07-02T10:00:00.000Z" }),
      opp({ createdAt: "2026-07-03T10:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-07-04T10:00:00.000Z", advisor: "Zulema", status: "lost" }),
      opp({ createdAt: "2026-07-05T10:00:00.000Z", advisor: "Diana", stage: "Ganado" }),
    ]);
    const jul = rowFor(rows, "2026-07");
    assert.equal(jul.total, 2, "solo las huérfanas llegan a la barra");
    assert.equal(jul.monthTotal, 4, "pero el denominador cuenta a todas");
    assert.equal(Math.round(jul.pctSinAsesor), 50);
    assert.equal(jul.abierta, 1);
    assert.equal(jul.perdida, 1);
    assert.equal(jul.ganada, 0, "la ganada era de Diana, no huérfana");

    const suma = STATUS_BUCKETS.reduce((n, b) => n + jul[b], 0);
    assert.equal(suma, jul.total, "las cubetas suman la altura de la barra");
  }

  // 3. Un mes con leads pero sin ningún huérfano se dibuja en cero, no se omite:
  //    esa barra vacía es la buena noticia que la tarjeta quiere poder mostrar.
  {
    const rows = buildUnassignedByMonth([
      opp({ createdAt: "2026-05-10T10:00:00.000Z" }),
      opp({ createdAt: "2026-06-10T10:00:00.000Z", advisor: "Zulema" }),
      opp({ createdAt: "2026-07-10T10:00:00.000Z" }),
    ]);
    const jun = rowFor(rows, "2026-06");
    assert.equal(jun.total, 0);
    assert.equal(jun.monthTotal, 1);
    assert.equal(jun.pctSinAsesor, 0);
  }

  // 4. Los ids del drill-down: cada huérfana en EXACTAMENTE una cubeta, y ninguna
  //    asignada colándose.
  {
    const huerfanas = [
      opp({ createdAt: "2026-07-02T10:00:00.000Z" }),
      opp({ createdAt: "2026-07-03T10:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-07-04T10:00:00.000Z", stage: "Ganado" }),
    ];
    const asignada = opp({ createdAt: "2026-07-05T10:00:00.000Z", advisor: "Zulema" });
    const rows = buildUnassignedByMonth([...huerfanas, asignada]);
    const jul = rowFor(rows, "2026-07");
    const ids = STATUS_BUCKETS.flatMap((b) => jul.ids[b]);
    assert.equal(ids.length, huerfanas.length);
    assert.equal(new Set(ids).size, huerfanas.length, "ningún id repetido");
    assert.ok(!ids.includes(asignada.id), "una asignada NUNCA aparece en un drill-down");
    for (const b of STATUS_BUCKETS) {
      assert.equal(jul.ids[b].length, jul[b], `ids["${b}"] cuadra con su conteo`);
    }
  }

  // 5. Una huérfana ganada por etapa (sin status "won") cuenta como ganada — la
  //    misma regla que isWonOpp() aplica en todo el panel.
  {
    const rows = buildUnassignedByMonth([opp({ createdAt: "2026-07-02T10:00:00.000Z", stage: "Ganado" })]);
    assert.equal(rowFor(rows, "2026-07").ganada, 1);
  }

  // 6. Meses intermedios rellenos, y sin fecha al final.
  {
    const rows = buildUnassignedByMonth([
      opp({ createdAt: "2026-03-10T10:00:00.000Z" }),
      opp({ createdAt: "2026-06-10T10:00:00.000Z" }),
      opp({ createdAt: undefined }),
      opp({ createdAt: "no-es-una-fecha" }),
    ]);
    assert.deepEqual(
      rows.map((r) => r.key),
      ["2026-03", "2026-04", "2026-05", "2026-06", NO_DATE_KEY]
    );
    const last = rows[rows.length - 1];
    assert.equal(last.label, NO_DATE_LABEL);
    assert.equal(last.total, 2, "no se pierde ningún registro sin fecha");
  }

  // 7. activeBuckets: la leyenda no lista una serie que no se dibuja. Es lo que
  //    evita un renglón "Ganadas" permanente que nunca corresponde a nada.
  {
    const soloPerdidas = buildUnassignedByMonth([
      opp({ createdAt: "2026-07-02T10:00:00.000Z", status: "lost" }),
    ]);
    assert.deepEqual(activeBuckets(soloPerdidas), ["perdida"]);

    const conAbiertas = buildUnassignedByMonth([
      opp({ createdAt: "2026-07-02T10:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-07-03T10:00:00.000Z" }),
    ]);
    assert.deepEqual(activeBuckets(conAbiertas), ["abierta", "perdida"]);

    // Y en cuanto aparece una ganada huérfana, la serie entra sola.
    const conGanada = buildUnassignedByMonth([
      opp({ createdAt: "2026-07-02T10:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-07-03T10:00:00.000Z", stage: "Ganado" }),
    ]);
    assert.deepEqual(activeBuckets(conGanada), ["ganada", "perdida"]);

    assert.deepEqual(activeBuckets([]), [], "sin filas no hay series");
  }

  // 8. El resumen de la nota al pie.
  {
    const rows = buildUnassignedByMonth([
      opp({ createdAt: "2026-07-02T10:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-07-03T10:00:00.000Z", status: "lost" }),
      opp({ createdAt: "2026-07-04T10:00:00.000Z" }),
      opp({ createdAt: "2026-07-05T10:00:00.000Z", advisor: "Zulema" }),
      opp({ createdAt: "2026-07-06T10:00:00.000Z", advisor: "Diana", stage: "Ganado" }),
    ]);
    const s = summarizeUnassigned(rows);
    assert.equal(s.total, 3, "huérfanas");
    assert.equal(s.grandTotal, 5, "todos los leads");
    assert.equal(Math.round(s.pctSinAsesor), 60);
    assert.deepEqual(s.byBucket, { ganada: 0, abierta: 1, perdida: 2 });
  }

  // 9. Sin datos: nada de NaN en los porcentajes.
  {
    assert.deepEqual(buildUnassignedByMonth([]), []);
    const s = summarizeUnassigned([]);
    assert.equal(s.total, 0);
    assert.equal(s.grandTotal, 0);
    assert.equal(s.pctSinAsesor, 0);
    assert.ok(!Number.isNaN(s.pctSinAsesor));

    // Un periodo con leads pero sin huérfanos: 0%, no división por cero.
    const sanos = summarizeUnassigned(
      buildUnassignedByMonth([opp({ createdAt: "2026-07-02T10:00:00.000Z", advisor: "Zulema" })])
    );
    assert.equal(sanos.total, 0);
    assert.equal(sanos.grandTotal, 1);
    assert.equal(sanos.pctSinAsesor, 0);
  }

  console.log("verify-assignment-funnel: OK");
}

main();
