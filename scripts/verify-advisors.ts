// Verificación de lib/advisor-breakdown.ts — la matriz asesor × etapa de
// "Oportunidades por asesor". Correr: pnpm verify:advisors
//
// Justifica el script el hecho de que la tabla es la única vista del panel donde
// se compara el desempeño de PERSONAS: un conteo mal asignado no se ve raro en
// pantalla, se ve como que alguien trabajó menos. Y el orden de las columnas sale
// del embudo, no de los datos, así que una etapa que se cae de la lista
// desaparecería en silencio junto con sus registros.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Opportunity, Pipeline } from "../lib/types";
import {
  buildAdvisorMatrix,
  NO_ADVISOR_LABEL,
  OTHER_STAGE_LABEL,
  panelStageOrder,
  stageKind,
} from "../lib/advisor-breakdown";

let seq = 0;

// Etapas reales del embudo VAEO, en orden.
const STAGES = [
  "Nuevo Lead",
  "Lead en proceso",
  "Lead Perfilado",
  "Propuesta",
  "Negociación",
  "Ganado",
  "Perdido",
  "Cliente Futuro",
];

function opp(o: {
  advisor?: string;
  stage?: string;
  status?: Opportunity["status"];
}): Opportunity {
  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: "MiATYfkJWklaXqYc7hOr",
    pipelineStageId: "stage-1",
    status: o.status ?? "open",
    createdAt: "2026-06-15T12:00:00.000Z",
    contactId: `c${seq}`,
    value: 0,
    stage: o.stage ?? "Nuevo Lead",
    pipelineName: "VAEO",
    assignedTo: o.advisor,
  };
}

const rowFor = (m: ReturnType<typeof buildAdvisorMatrix>, advisor: string) => {
  const r = m.rows.find((x) => x.advisor === advisor);
  assert.ok(r, `existe la fila "${advisor}" (hay: ${m.rows.map((x) => x.advisor).join(", ")})`);
  return r!;
};

function main() {
  // 1. El tipo de etapa se decide por NOMBRE, en las dos grafías de los embudos.
  {
    assert.equal(stageKind("Ganado"), "ganado");
    assert.equal(stageKind("ganada"), "ganado");
    assert.equal(stageKind("Perdido"), "perdido");
    assert.equal(stageKind("Closed Won"), "ganado");
    assert.equal(stageKind("Negociación"), "abierto");
    assert.equal(
      stageKind("Cliente Futuro"),
      "abierto",
      "Cliente Futuro es cartera parada, no un desenlace"
    );
  }

  // 2. Las columnas salen del embudo, no de los datos: una etapa sin un solo
  //    registro sigue apareciendo, que es justo el dato que se quiere ver.
  {
    const m = buildAdvisorMatrix([opp({ advisor: "Zulema Silva" })], STAGES);
    assert.deepEqual(m.stages, STAGES);
    assert.equal(m.totals.stages["Negociación"].count, 0, "columna vacía, pero presente");
  }

  // 3. Una etapa que traen los datos y el embudo ya no declara NO se pierde:
  //    se agrega como columna extra al final.
  {
    const m = buildAdvisorMatrix(
      [opp({ advisor: "Diana Arbelaez", stage: "Etapa Retirada" })],
      STAGES
    );
    assert.deepEqual(m.stages.slice(-1), ["Etapa Retirada"]);
    assert.equal(m.totals.total, 1, "el registro sigue contando en el total");
    assert.equal(rowFor(m, "Diana Arbelaez").stages["Etapa Retirada"].count, 1);
  }

  // 3b. Etapa vacía o solo espacios cae en "Otra etapa" en vez de desaparecer.
  {
    const m = buildAdvisorMatrix([opp({ advisor: "Diana Arbelaez", stage: "   " })], STAGES);
    assert.ok(m.stages.includes(OTHER_STAGE_LABEL));
    assert.equal(rowFor(m, "Diana Arbelaez").stages[OTHER_STAGE_LABEL].count, 1);
  }

  // 3c. La etapa se une sin importar mayúsculas ni espacios sobrantes — MESH
  //     escribe "Lead perfilado" y VAEO "Lead Perfilado".
  {
    const m = buildAdvisorMatrix(
      [
        opp({ advisor: "Zulema Silva", stage: "lead perfilado" }),
        opp({ advisor: "Zulema Silva", stage: " Lead Perfilado " }),
      ],
      STAGES
    );
    assert.equal(m.stages.length, STAGES.length, "no se inventó una columna nueva");
    assert.equal(rowFor(m, "Zulema Silva").stages["Lead Perfilado"].count, 2);
  }

  // 4. Sin asesor: nunca se descarta, se rotula, y siempre va al final aunque sea
  //    la fila más grande de todas.
  {
    const m = buildAdvisorMatrix(
      [
        ...Array.from({ length: 5 }, () => opp({ advisor: undefined, stage: "Perdido", status: "lost" })),
        opp({ advisor: "Zulema Silva" }),
        opp({ advisor: "   " }),
      ],
      STAGES
    );
    const last = m.rows[m.rows.length - 1];
    assert.equal(last.advisor, NO_ADVISOR_LABEL);
    assert.equal(last.unassigned, true);
    assert.equal(last.total, 6, "sin campo y campo en blanco son lo mismo");
    assert.equal(m.rows[0].advisor, "Zulema Silva", "Sin asesor no compite por el primer lugar");
    assert.equal(m.totals.total, 7);
  }

  // 5. El máximo por columna excluye a "Sin asesor": normalizar el sombreado
  //    contra sus mil perdidas dejaría a los tres asesores en gris parejo.
  {
    const m = buildAdvisorMatrix(
      [
        ...Array.from({ length: 100 }, () => opp({ advisor: undefined, stage: "Perdido", status: "lost" })),
        ...Array.from({ length: 4 }, () => opp({ advisor: "Zulema Silva", stage: "Perdido", status: "lost" })),
        opp({ advisor: "Diana Arbelaez", stage: "Perdido", status: "lost" }),
      ],
      STAGES
    );
    assert.equal(m.stageMax["Perdido"], 4, "el máximo es el del mayor asesor, no el de Sin asesor");
  }

  // 6. Estatus: manda isWonOpp(), no el status crudo, y por eso la barra puede
  //    NO cuadrar con las columnas Ganado / Perdido. Es a propósito.
  {
    const m = buildAdvisorMatrix(
      [
        opp({ advisor: "Zulema Silva", stage: "Ganado", status: "open" }),
        opp({ advisor: "Zulema Silva", stage: "Perdido", status: "open" }),
        opp({ advisor: "Zulema Silva", stage: "Cliente Futuro", status: "lost" }),
        opp({ advisor: "Zulema Silva", stage: "Propuesta", status: "open" }),
      ],
      STAGES
    );
    const r = rowFor(m, "Zulema Silva");
    assert.equal(r.stages["Ganado"].count, 1);
    assert.equal(r.status.ganada.count, 1, "etapa Ganado con status open cuenta como ganada");
    assert.equal(
      r.status.perdida.count,
      1,
      "solo el status lost es pérdida: la etapa Perdido con status open sigue abierta"
    );
    assert.equal(r.status.abierta.count, 2);
    assert.equal(
      r.stages["Perdido"].count,
      1,
      "la columna Perdido cuenta por etapa aunque el estatus diga otra cosa"
    );
    assert.equal(r.winRate, 25, "% ganadas es sobre el total de la fila, igual que el chart de tasa");
  }

  // 7. Los totales son la suma de las filas ya calculadas — una sola pasada, sin
  //    riesgo de que la fila Total cuente distinto que sus propias filas.
  {
    const m = buildAdvisorMatrix(
      [
        opp({ advisor: "Zulema Silva", stage: "Propuesta" }),
        opp({ advisor: "Diana Arbelaez", stage: "Propuesta" }),
        opp({ advisor: "Dariana Turrubiates", stage: "Ganado", status: "won" }),
      ],
      STAGES
    );
    assert.equal(m.totals.stages["Propuesta"].count, 2);
    assert.equal(m.totals.stages["Propuesta"].oppIds.length, 2);
    assert.equal(m.totals.total, 3);
    assert.equal(
      m.totals.total,
      m.rows.reduce((s, r) => s + r.total, 0)
    );
    assert.equal(
      m.stages.reduce((s, st) => s + m.totals.stages[st].count, 0),
      m.totals.total,
      "cada oportunidad cae en exactamente una etapa: la suma horizontal cuadra"
    );
  }

  // 8. Los ids viajan con la celda — es lo que abre el drill-down.
  {
    const a = opp({ advisor: "Diana Arbelaez", stage: "Negociación" });
    const m = buildAdvisorMatrix([a], STAGES);
    assert.deepEqual(rowFor(m, "Diana Arbelaez").stages["Negociación"].oppIds, [a.id]);
    assert.deepEqual(rowFor(m, "Diana Arbelaez").status.abierta.oppIds, [a.id]);
    assert.deepEqual(rowFor(m, "Diana Arbelaez").oppIds, [a.id]);
  }

  // 9. Empate de volumen: desempate alfabético, para que el orden sea estable
  //    entre renders y no baile al cambiar el filtro de fechas.
  {
    const m = buildAdvisorMatrix(
      [
        opp({ advisor: "Zulema Silva" }),
        opp({ advisor: "Dariana Turrubiates" }),
        opp({ advisor: "Diana Arbelaez" }),
      ],
      STAGES
    );
    assert.deepEqual(m.rows.map((r) => r.advisor), [
      "Dariana Turrubiates",
      "Diana Arbelaez",
      "Zulema Silva",
    ]);
  }

  // 10. El orden de columnas se resuelve por NOMBRE de embudo, con el id
  //     hardcodeado solo de respaldo — misma regla que resolvePipelineId().
  {
    const pipelines: Pipeline[] = [
      { id: "otro-id-cualquiera", name: "VAEO", stages: STAGES },
      { id: "DkZiRWdizgMRt7osjuRb", name: "MESH", stages: ["Nuevo Lead", "Ganado"] },
    ];
    assert.deepEqual(panelStageOrder(pipelines, "vaeo"), STAGES, "gana el match por nombre");
    assert.deepEqual(panelStageOrder(pipelines, "mesh"), ["Nuevo Lead", "Ganado"]);
    assert.deepEqual(panelStageOrder(undefined, "vaeo"), [], "sin embudos, las columnas salen de los datos");
  }

  // 11. Conjunto vacío.
  {
    const m = buildAdvisorMatrix([], STAGES);
    assert.deepEqual(m.rows, []);
    assert.equal(m.totals.total, 0);
    assert.equal(m.totals.winRate, 0);
    assert.deepEqual(m.stages, STAGES, "las columnas del embudo se dibujan aunque no haya datos");
  }

  console.log("verify-advisors: all assertions passed");
}

main();
