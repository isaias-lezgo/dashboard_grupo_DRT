// Verificación de lib/desarrollo-funnel.ts — recuentos por desarrollo y el
// embudo de seis pasos de GENERAL.
// Correr: pnpm verify:desarrollo-funnel
//
// Lo que justifica el script: "alcanzó la etapa" se lee del prefijo numérico y
// "cita" es una unión de dos fuentes con una regla de monotonía encima. Cada
// una de esas reglas, mal aplicada, produce un embudo verosímil y falso.
//
// Envuelto en main() en vez de top-level await: este paquete es CJS.
import assert from "node:assert/strict";
import type { Appointment, Opportunity, Pipeline } from "../lib/types";
import { NO_DESARROLLO } from "../lib/panel-scope";
import {
  buildDesarrolloCounts,
  buildStageFunnel,
  reachedStage,
  stageIndexOf,
} from "../lib/desarrollo-funnel";

const PIPELINES: Pipeline[] = [
  { id: "p-atria", name: "Atria", stages: [] },
  { id: "p-canadas", name: "Cañadas", stages: [] },
  { id: "p-palmyra", name: "Palmyra", stages: [] },
] as unknown as Pipeline[];

let seq = 0;
function opp(o: {
  pipeline?: string;
  stage?: string;
  status?: Opportunity["status"];
  contactId?: string;
}): Opportunity {
  seq++;
  return {
    id: `o${seq}`,
    name: `Opp ${seq}`,
    pipelineId: o.pipeline ?? "p-atria",
    pipelineStageId: "s",
    status: o.status ?? "open",
    createdAt: "2026-08-01T12:00:00.000Z",
    contactId: o.contactId ?? `c${seq}`,
    value: 0,
    stage: o.stage ?? "00. Recibido",
    pipelineName: "",
  };
}

function cita(contactId: string, status = "confirmed"): Appointment {
  return {
    id: `a${++seq}`,
    contactId,
    startTime: "2026-08-10T16:00:00.000Z",
    endTime: "2026-08-10T17:00:00.000Z",
    status,
  };
}

const step = (steps: ReturnType<typeof buildStageFunnel>, key: string) => {
  const s = steps.find((x) => x.key === key);
  assert.ok(s, `existe el paso "${key}"`);
  return s!;
};

function main() {
  // 1. El prefijo numérico de la etapa.
  {
    assert.equal(stageIndexOf("05. Visita al Desarrollo"), 5);
    assert.equal(stageIndexOf("  07.Apartado"), 7);
    assert.equal(stageIndexOf("Negocio perdido"), null);
    assert.equal(stageIndexOf("Inversión Futura"), null);
    assert.equal(stageIndexOf(undefined), null);

    const visita = { key: "visita", minIndex: 5 };
    const venta = { key: "venta", minIndex: 8 };
    assert.equal(reachedStage(opp({ stage: "07. Apartado", status: "lost" }), visita), true, "una perdida en Apartado sí visitó");
    assert.equal(reachedStage(opp({ stage: "04. Cita Programada" }), visita), false);
    assert.equal(reachedStage(opp({ stage: "02. Lead en Seguimiento", status: "won" }), venta), true, "status won es venta aunque la etapa no");
    assert.equal(reachedStage(opp({ stage: "08. Venta", status: "lost" }), venta), false, "una perdida en 08. no es venta");
  }

  // 2. Recuentos por desarrollo: una sola agregación, tres columnas.
  {
    const rows = buildDesarrolloCounts(
      [
        opp({ pipeline: "p-atria", stage: "00. Recibido" }),
        opp({ pipeline: "p-atria", stage: "05. Visita al Desarrollo", status: "lost" }),
        opp({ pipeline: "p-atria", stage: "08. Venta" }), // won por etapa, status open
        opp({ pipeline: "p-canadas", stage: "01. Contactado" }),
        opp({ pipeline: "p-canadas", stage: "07. Apartado" }),
        opp({ pipeline: "p-canadas", stage: "03. Lead Calificado", status: "won" }),
        opp({ pipeline: "p-canadas", stage: "Negocio perdido", status: "lost" }),
        opp({ pipeline: "p-palmyra" }),
        opp({ pipeline: "p-desconocido" }),
      ],
      PIPELINES
    );

    assert.deepEqual(
      rows.map((r) => r.desarrollo),
      ["Cañadas", "Atria", "Palmyra", NO_DESARROLLO],
      "por registros desc, Sin desarrollo al final"
    );
    const atria = rows[1];
    assert.deepEqual([atria.registros, atria.visitas, atria.ventas], [3, 2, 1]);
    assert.equal(atria.ids.visitas.length, 2, "la perdida en 05. y la venta en 08. visitaron");
    const canadas = rows[0];
    assert.deepEqual([canadas.registros, canadas.visitas, canadas.ventas], [4, 2, 1]);
    assert.equal(canadas.ventas, 1, "won por status cuenta aunque esté en 03.");
    assert.equal(canadas.visitas, 2, "la ganada en 03. cuenta como visita: venta implica visita, igual que en el embudo");
    const palmyra = rows[2];
    assert.deepEqual([palmyra.registros, palmyra.visitas, palmyra.ventas], [1, 0, 0], "cero visitas y cero ventas sí se dibujan");
    assert.equal(rows[3].missing, true);
    assert.equal(buildDesarrolloCounts([], PIPELINES).length, 0);
  }

  // 3. El embudo: seis pasos, monótono, con la cita como unión.
  {
    const opps = [
      opp({ stage: "00. Recibido", contactId: "sin-cita" }),
      opp({ stage: "00. Recibido", contactId: "con-cita" }), // cita solo por el CRM
      opp({ stage: "02. Lead en Seguimiento" }),
      opp({ stage: "04. Cita Programada" }),
      opp({ stage: "05. Visita al Desarrollo", status: "lost" }),
      opp({ stage: "07. Apartado" }),
      opp({ stage: "08. Venta" }),
      opp({ stage: "Negocio perdido", status: "lost" }),
    ];
    const steps = buildStageFunnel(opps, [cita("con-cita", "cancelled"), cita("nadie")]);

    assert.deepEqual(
      steps.map((s) => [s.n, s.key]),
      [[1, "leads"], [2, "precalificados"], [3, "citas"], [4, "visitas"], [5, "apartados"], [6, "ventas"]]
    );
    assert.equal(step(steps, "leads").count, 8, "toda oportunidad es un lead, incluida la perdida sin prefijo");
    assert.equal(step(steps, "citas").count, 5, "04, 05, 07, 08 por etapa + la de 00. con cita cancelada");
    assert.deepEqual(step(steps, "citas").fuentes, { porEtapa: 4, soloPorCita: 1 });
    assert.equal(step(steps, "precalificados").count, 6, "02 + los 4 de etapa + la de cita: la cita implica precalificado");
    assert.equal(step(steps, "visitas").count, 3);
    assert.equal(step(steps, "apartados").count, 2);
    assert.equal(step(steps, "ventas").count, 1);

    // Monotonía: cada paso ≤ el anterior, y sus ids son subconjunto.
    for (let i = 1; i < steps.length; i++) {
      assert.ok(steps[i].count <= steps[i - 1].count, `${steps[i].key} ≤ ${steps[i - 1].key}`);
      const prev = new Set(steps[i - 1].ids);
      assert.ok(steps[i].ids.every((id) => prev.has(id)), `${steps[i].key} ⊆ ${steps[i - 1].key}`);
    }

    assert.equal(step(steps, "leads").pctOfPrev, null);
    assert.equal(step(steps, "citas").pctOfTotal, (5 / 8) * 100);
    assert.equal(step(steps, "visitas").pctOfPrev, (3 / 5) * 100);
    assert.equal(step(steps, "leads").pctOfTotal, 100);
  }

  // 4. Una ganada por status en etapa temprana arrastra todo el embudo: la
  //    venta implica apartado, visita, cita y precalificado.
  {
    const steps = buildStageFunnel([opp({ stage: "01. Contactado", status: "won" })], []);
    assert.deepEqual(steps.map((s) => s.count), [1, 1, 1, 1, 1, 1]);
    assert.deepEqual(step(steps, "citas").fuentes, { porEtapa: 1, soloPorCita: 0 }, "arrastrada desde venta cuenta como por etapa, no como por cita");
  }

  // 5. Vacío: nada truena, todo en cero, sin porcentajes inventados.
  {
    const steps = buildStageFunnel([], []);
    assert.equal(steps.length, 6);
    assert.ok(steps.every((s) => s.count === 0 && s.pctOfTotal === 0));
    assert.ok(steps.every((s) => s.pctOfPrev === null), "sin denominador no hay porcentaje");
  }

  console.log("verify-desarrollo-funnel: OK");
}

main();
