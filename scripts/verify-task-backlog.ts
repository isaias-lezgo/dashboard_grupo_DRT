// Verificación de lib/task-backlog.ts — las cubetas de vencimiento de
// "Tareas pendientes por asesor". Correr: pnpm verify:task-backlog
//
// Justifica el script la frontera de día: el servidor corre en UTC en Vercel y
// el cliente vive en America/Mexico_City, así que una tarea que vence hoy a las
// 23:00 local tiene un ISO que cae en el día UTC SIGUIENTE. Leerla sin zona la
// pinta como "Más adelante" cuando en realidad vence hoy — un gráfico de rezago
// que tranquiliza de más es peor que no tenerlo.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity, Task } from "../lib/types";
import {
  bucketOfDueDate,
  buildTaskBacklog,
  PANEL_TIME_ZONE,
  TASK_BUCKETS,
} from "../lib/task-backlog";
import { NO_ADVISOR_LABEL } from "../lib/advisor-breakdown";

let seq = 0;

function task(t: {
  contactId: string;
  dueDate?: string;
  advisor?: string;
  status?: Task["status"];
}): Task {
  return {
    id: `t${++seq}`,
    title: `Tarea ${seq}`,
    status: t.status ?? "pending",
    dueDate: t.dueDate,
    contactId: t.contactId,
    assignedToName: t.advisor,
  };
}

function opp(o: { contactId: string; pipelineId: string }): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: o.pipelineId,
    pipelineStageId: "stage-1",
    status: "open",
    createdAt: "2026-06-15T12:00:00.000Z",
    contactId: o.contactId,
    value: 0,
    stage: "Nuevo Lead",
    pipelineName: "VAEO",
  };
}

const VAEO = "MiATYfkJWklaXqYc7hOr";
const MESH = "DkZiRWdizgMRt7osjuRb";

// 2026-08-06 a las 12:00 en America/Mexico_City (UTC-6) = 18:00Z.
const NOW = new Date("2026-08-06T18:00:00.000Z");

async function main() {
  // 1. Cubetas básicas contra NOW.
  {
    assert.equal(bucketOfDueDate(undefined, NOW), "sinFecha", "sin dueDate");
    assert.equal(bucketOfDueDate("no-es-fecha", NOW), "sinFecha", "dueDate ilegible");
    assert.equal(bucketOfDueDate("2026-08-05T18:00:00.000Z", NOW), "vencidas", "ayer");
    assert.equal(bucketOfDueDate("2026-08-06T09:00:00.000Z", NOW), "hoy", "hoy en la mañana");
    assert.equal(bucketOfDueDate("2026-08-07T18:00:00.000Z", NOW), "prox7", "mañana");
    assert.equal(bucketOfDueDate("2026-08-13T18:00:00.000Z", NOW), "prox7", "día +7, último de la cubeta");
    assert.equal(bucketOfDueDate("2026-08-14T18:00:00.000Z", NOW), "adelante", "día +8, ya no");
  }

  // 2. LA razón de ser del script: la frontera de día es LOCAL, no UTC.
  {
    // 2026-08-06 23:30 en Mexico_City = 2026-08-07T05:30Z. En UTC sería mañana;
    // en la zona del cliente todavía es hoy.
    assert.equal(
      bucketOfDueDate("2026-08-07T05:30:00.000Z", NOW),
      "hoy",
      "23:30 hora local del día de hoy NO es mañana"
    );
    // 2026-08-05 23:30 local = 2026-08-06T05:30Z. En UTC es hoy; localmente
    // venció ayer.
    assert.equal(
      bucketOfDueDate("2026-08-06T05:30:00.000Z", NOW),
      "vencidas",
      "23:30 hora local de ayer YA venció"
    );
    // Con la zona equivocada, ambas se irían a la cubeta de al lado.
    assert.equal(bucketOfDueDate("2026-08-07T05:30:00.000Z", NOW, "UTC"), "prox7");
  }

  // 3. Solo cuentan las pendientes.
  {
    const tasks = [
      task({ contactId: "c1" }),
      task({ contactId: "c1", status: "completed" }),
    ];
    const opps = [opp({ contactId: "c1", pipelineId: VAEO })];
    const b = buildTaskBacklog(tasks, opps, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(b.grandTotal, 1, "la completada no es rezago");
  }

  // 4. Reparto por panel: el join va contacto → sus oportunidades → embudo.
  {
    const opps = [
      opp({ contactId: "c-vaeo", pipelineId: VAEO }),
      opp({ contactId: "c-mesh", pipelineId: MESH }),
      opp({ contactId: "c-ambos", pipelineId: VAEO }),
      opp({ contactId: "c-ambos", pipelineId: MESH }),
    ];
    const tasks = [
      task({ contactId: "c-vaeo", advisor: "Zulema Silva" }),
      task({ contactId: "c-mesh", advisor: "Zulema Silva" }),
      task({ contactId: "c-ambos", advisor: "Zulema Silva" }),
      task({ contactId: "c-huerfano", advisor: "Zulema Silva" }),
    ];
    const scopedVaeo = opps.filter((o) => o.pipelineId === VAEO);
    const scopedMesh = opps.filter((o) => o.pipelineId === MESH);

    const v = buildTaskBacklog(tasks, scopedVaeo, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(v.grandTotal, 2, "VAEO ve c-vaeo y c-ambos");
    assert.equal(v.unscoped.count, 1, "c-huerfano queda fuera del agregado");
    assert.deepEqual(v.unscoped.contactIds, ["c-huerfano"]);

    const m = buildTaskBacklog(tasks, scopedMesh, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(m.grandTotal, 2, "MESH ve c-mesh y c-ambos");
    assert.equal(m.unscoped.count, 1, "el huérfano se reporta en LOS DOS paneles");

    // El contacto con oportunidades en ambas líneas cuenta en ambas: es la
    // misma regla que el panel ya fija para contactos compartidos.
    const inV = v.rows[0].contactIds.includes("c-ambos");
    const inM = m.rows[0].contactIds.includes("c-ambos");
    assert.ok(inV && inM, "c-ambos aparece en los dos paneles");

    // Y el contacto de la OTRA línea nunca se cuela ni como unscoped.
    assert.ok(!v.unscoped.contactIds.includes("c-mesh"), "c-mesh no es huérfano, es de la otra línea");
  }

  // 4b. Regresión: el tercer argumento tiene que ser el set CRUDO, no el que ya
  //     pasó por los filtros de panel. Se detectó manejando la app real — con un
  //     filtro de sucursal puesto, `unscoped` saltaba de 11 a 131 y la nota al
  //     pie afirmaba que 131 contactos no tenían ninguna oportunidad cuando sí
  //     la tenían, solo que en otra sucursal.
  {
    const todas = [
      opp({ contactId: "c-qro", pipelineId: VAEO }),
      opp({ contactId: "c-mty", pipelineId: VAEO }),
    ];
    // Lo que sobrevive a un filtro de sucursal = QRO.
    const filtradas = [todas[0]];
    const tasks = [
      task({ contactId: "c-qro", advisor: "Zulema Silva" }),
      task({ contactId: "c-mty", advisor: "Zulema Silva" }),
    ];

    const bien = buildTaskBacklog(tasks, filtradas, todas, NOW, PANEL_TIME_ZONE);
    assert.equal(bien.grandTotal, 1, "solo la tarea de la sucursal filtrada cuenta");
    assert.equal(
      bien.unscoped.count,
      0,
      "c-mty NO es huérfano: tiene oportunidad, solo que en otra sucursal"
    );

    // Pasar el set ya filtrado como tercer argumento es justamente el bug.
    const mal = buildTaskBacklog(tasks, filtradas, filtradas, NOW, PANEL_TIME_ZONE);
    assert.equal(mal.unscoped.count, 1, "así se veía el bug: c-mty leído como huérfano");
  }

  // 5. Asesor: se toma de assignedToName; vacío ⇒ "Sin asesor", siempre al final.
  {
    const opps = [
      opp({ contactId: "c1", pipelineId: VAEO }),
      opp({ contactId: "c2", pipelineId: VAEO }),
      opp({ contactId: "c3", pipelineId: VAEO }),
    ];
    const tasks = [
      task({ contactId: "c1", advisor: "Zulema Silva" }),
      task({ contactId: "c2", advisor: "  " }),
      task({ contactId: "c3" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez" }),
    ];
    const b = buildTaskBacklog(tasks, opps, opps, NOW, PANEL_TIME_ZONE);
    assert.equal(b.rows.at(-1)!.advisor, NO_ADVISOR_LABEL, "sin asesor va al final");
    assert.equal(b.rows.at(-1)!.total, 2, "el espacio en blanco cuenta como sin asesor");
    assert.ok(b.rows.at(-1)!.unassigned);
    assert.equal(b.rows[0].advisor, "Diana Arbelaez", "las filas se ordenan por volumen");
    assert.equal(b.rows[0].total, 2);
  }

  // 6. Los totales cuadran con la suma de las celdas.
  {
    const opps = [opp({ contactId: "c1", pipelineId: VAEO })];
    const tasks = [
      task({ contactId: "c1", advisor: "Zulema Silva", dueDate: "2026-08-01T18:00:00.000Z" }),
      task({ contactId: "c1", advisor: "Zulema Silva", dueDate: "2026-08-06T09:00:00.000Z" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez", dueDate: "2026-09-30T18:00:00.000Z" }),
      task({ contactId: "c1", advisor: "Diana Arbelaez" }),
    ];
    const b = buildTaskBacklog(tasks, opps, opps, NOW, PANEL_TIME_ZONE);
    const sumCells = b.rows.reduce(
      (acc, r) => acc + TASK_BUCKETS.reduce((a, k) => a + r.buckets[k].count, 0),
      0
    );
    assert.equal(sumCells, b.grandTotal, "celdas = gran total");
    assert.equal(b.totals.total, b.grandTotal, "la fila de totales cuadra");
    assert.equal(b.totals.buckets.vencidas.count, 1);
    assert.equal(b.totals.buckets.hoy.count, 1);
    assert.equal(b.totals.buckets.adelante.count, 1);
    assert.equal(b.totals.buckets.sinFecha.count, 1);
    assert.equal(b.totals.taskIds.length, 4, "los ids del total no se pierden");
  }

  // 7. Conjuntos vacíos.
  {
    const b = buildTaskBacklog([], [], [], NOW, PANEL_TIME_ZONE);
    assert.deepEqual(b.rows, []);
    assert.equal(b.grandTotal, 0);
    assert.equal(b.unscoped.count, 0);
    assert.equal(b.totals.total, 0);
  }

  console.log("verify-task-backlog: all assertions passed");
}

main();
