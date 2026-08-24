// Verification for lib/panel-filters.ts — los cuatro filtros globales de la
// barra (desarrollo, asesor, origen, canal).
//
// Un filtro silenciosamente mal se ve igual que uno bien: números más chicos.
// Por eso estas aserciones existen y por eso el módulo es puro y sin React.
//
// Correr con: pnpm verify:filters
import assert from "node:assert/strict";
import type { Opportunity, Pipeline } from "../lib/types";
import { NO_DESARROLLO, PANEL_SCOPES } from "../lib/panel-scope";
import {
  activeFilterCount,
  advisorKeyOf,
  applyPanelFilters,
  collectAdvisors,
  EMPTY_PANEL_FILTERS,
  NO_ASESOR,
  type PanelFilters,
} from "../lib/panel-filters";

const CANADAS = "id-canadas";
const ATRIA = "id-atria";

/** Los embudos son los desarrollos: el filtro lee el nombre de aquí. */
const PIPELINES: Pipeline[] = [
  { id: CANADAS, name: "Cañadas", stages: ["00. Recibido", "08. Venta"] },
  { id: ATRIA, name: "Atria", stages: ["00. Recibido", "08. Venta"] },
];

let seq = 0;

function opp(o: {
  pipelineId?: string;
  asesor?: string;
  origen?: string;
}): Opportunity {
  const resolved: Record<string, string> = {};
  if (o.origen !== undefined) resolved["Origen de Lead"] = o.origen;

  return {
    id: `o${++seq}`,
    name: `Opp ${seq}`,
    pipelineId: o.pipelineId ?? CANADAS,
    pipelineStageId: "stage-1",
    status: "open",
    createdAt: "2026-01-01T00:00:00.000Z",
    contactId: `c${seq}`,
    value: 1,
    stage: "00. Recibido",
    pipelineName: "Cañadas",
    assignedTo: o.asesor,
    customFieldsResolved: resolved,
  };
}

/** Filtros parciales sobre el estado vacío: aísla al script de campos nuevos. */
const filters = (p: Partial<PanelFilters>): PanelFilters => ({
  ...EMPTY_PANEL_FILTERS,
  ...p,
});

function main() {
  // 1. Sin selección no se filtra NADA, y se devuelve la MISMA referencia.
  // Una copia nueva invalidaría los memos de app/page.tsx en cada render.
  {
    const opps = [opp({ asesor: "Judith Gil" })];
    assert.equal(
      applyPanelFilters(opps, EMPTY_PANEL_FILTERS, PIPELINES),
      opps,
      "sin filtros: misma referencia, sin copia"
    );
    assert.equal(activeFilterCount(EMPTY_PANEL_FILTERS), 0);
  }

  // 2. El desarrollo sale del EMBUDO, no de un campo personalizado: en esta
  // subcuenta el pipeline ES el desarrollo. Un embudo que no resuelve cae en la
  // cubeta centinela en vez de desaparecer.
  {
    const opps = [
      opp({ pipelineId: CANADAS }),
      opp({ pipelineId: ATRIA }),
      opp({ pipelineId: "embudo-que-no-existe" }),
    ];
    const dos = applyPanelFilters(opps, filters({ desarrollos: ["Cañadas", "Atria"] }), PIPELINES);
    assert.equal(dos.length, 2, "OR dentro del menú");

    const huerfanas = applyPanelFilters(opps, filters({ desarrollos: [NO_DESARROLLO] }), PIPELINES);
    assert.deepEqual(
      huerfanas.map((o) => o.pipelineId),
      ["embudo-que-no-existe"],
      "la cubeta vacía es seleccionable, no un agujero"
    );

    // Sin la lista de embudos NADA resuelve: todo cae en la cubeta centinela.
    // Es el modo degradado correcto — inventar un desarrollo sería peor.
    assert.equal(
      applyPanelFilters(opps, filters({ desarrollos: [NO_DESARROLLO] }), undefined).length,
      3,
      "sin pipelines, ninguna resuelve su desarrollo"
    );
  }

  // 3. La clave del asesor es el nombre COMPLETO normalizado, no el primero.
  // Esta es LA aserción que impide la regresión más cara del filtro: la
  // subcuenta tiene dos Adrianas y dos Mónicas distintas, y casar por primer
  // nombre las fundiría en una sola fila sin que nada se viera roto.
  {
    assert.equal(advisorKeyOf(opp({ asesor: "Judith Gil" })), "judith gil");
    assert.equal(advisorKeyOf(opp({ asesor: "JUDITH GIL" })), "judith gil", "sin mayúsculas");
    assert.equal(advisorKeyOf(opp({ asesor: "Judíth Gil" })), "judith gil", "sin acentos");
    assert.equal(advisorKeyOf(opp({ asesor: " Judith   Gil " })), "judith gil", "espacios colapsados");

    assert.notEqual(
      advisorKeyOf(opp({ asesor: "Adriana López" })),
      advisorKeyOf(opp({ asesor: "Adriana Ortega" })),
      "dos Adrianas distintas NO comparten clave"
    );
    assert.notEqual(
      advisorKeyOf(opp({ asesor: "Mónica Gomez" })),
      advisorKeyOf(opp({ asesor: "Mónica Leal" })),
      "dos Mónicas distintas NO comparten clave"
    );

    assert.equal(advisorKeyOf(opp({})), NO_ASESOR, "sin asignar cae en la cubeta centinela");
    assert.equal(advisorKeyOf(opp({ asesor: "   " })), NO_ASESOR, "puros espacios es lo mismo que vacío");
  }

  // 4. Filtro por asesor, incluida la cubeta de las huérfanas: ~17% de las
  // oportunidades de DRT no tienen asesor, así que tienen que ser alcanzables.
  {
    const opps = [
      opp({ asesor: "Judith Gil" }),
      opp({ asesor: "Adriana López" }),
      opp({ asesor: "Adriana Ortega" }),
      opp({}),
    ];
    const solo = applyPanelFilters(opps, filters({ asesores: ["judith gil"] }), PIPELINES);
    assert.deepEqual(solo.map((o) => o.assignedTo), ["Judith Gil"]);

    const unaAdriana = applyPanelFilters(opps, filters({ asesores: ["adriana lopez"] }), PIPELINES);
    assert.deepEqual(
      unaAdriana.map((o) => o.assignedTo),
      ["Adriana López"],
      "seleccionar una Adriana NO arrastra a la otra"
    );

    const dos = applyPanelFilters(opps, filters({ asesores: ["judith gil", "adriana ortega"] }), PIPELINES);
    assert.equal(dos.length, 2, "OR dentro del menú de asesores");

    const huerfanas = applyPanelFilters(opps, filters({ asesores: [NO_ASESOR] }), PIPELINES);
    assert.equal(huerfanas.length, 1, "las oportunidades sin asesor son seleccionables");
    assert.equal(huerfanas[0].assignedTo, undefined);

    assert.equal(
      applyPanelFilters(opps, filters({ asesores: ["quien no existe"] }), PIPELINES).length,
      0,
      "un asesor sin oportunidades devuelve vacío, no todo"
    );
  }

  // 5. collectAdvisors: por VOLUMEN descendente, con la etiqueta legible, y sin
  // la cubeta de las huérfanas (el menú la agrega aparte, siempre al final).
  {
    const opps = [
      opp({ asesor: "Adriana López" }),
      opp({ asesor: "Judith Gil" }),
      opp({ asesor: "Judith Gil" }),
      opp({ asesor: "Judith Gil" }),
      opp({ asesor: "Adriana López" }),
      opp({ asesor: "Mónica Leal" }),
      opp({}),
    ];
    assert.deepEqual(
      collectAdvisors(opps).map((a) => a.label),
      ["Judith Gil", "Adriana López", "Mónica Leal"],
      "por volumen descendente: con ~24 asesores el alfabético entierra a los que venden"
    );
    assert.deepEqual(
      collectAdvisors(opps).map((a) => a.key),
      ["judith gil", "adriana lopez", "monica leal"],
      "la clave va normalizada; la etiqueta conserva acentos"
    );
    assert.deepEqual(collectAdvisors([]), [], "sin datos, sin opciones");

    // Dos grafías de la misma persona son UNA opción, con la primera vista
    // como etiqueta. Distinto de origen/canal, donde las grafías NO se agrupan.
    const grafias = [opp({ asesor: "Mónica Leal" }), opp({ asesor: "monica leal" })];
    assert.deepEqual(
      collectAdvisors(grafias),
      [{ key: "monica leal", label: "Mónica Leal" }],
      "acentos y mayúsculas no parten a una persona en dos"
    );
  }

  // 6. Los CUATRO menús cruzan con AND. Esta es la razón de que los cuatro
  // vivan en el mismo objeto de estado: el cruce está escrito una sola vez.
  {
    const opps = [
      opp({ pipelineId: CANADAS, asesor: "Judith Gil", origen: "Meta" }),
      opp({ pipelineId: CANADAS, asesor: "Judith Gil", origen: "Walk In" }),
      opp({ pipelineId: ATRIA, asesor: "Judith Gil", origen: "Meta" }),
      opp({ pipelineId: CANADAS, asesor: "Adriana López", origen: "Meta" }),
    ];
    const all = applyPanelFilters(
      opps,
      filters({ desarrollos: ["Cañadas"], asesores: ["judith gil"], origen: ["Meta"] }),
      PIPELINES
    );
    assert.equal(all.length, 1, "desarrollo Y asesor Y origen");
    assert.equal(
      activeFilterCount(filters({ origen: ["Meta"], canal: ["WhatsApp", "DM"] })),
      3,
      "la píldora de filtros activos cuenta los cuatro menús"
    );

    // Las grafías NO se agrupan tampoco cruzando el filtro completo.
    const variantes = [opp({ origen: "Walk In" }), opp({ origen: "WALK IN" })];
    assert.equal(
      applyPanelFilters(variantes, filters({ origen: ["Walk In"] }), PIPELINES).length,
      1
    );

    // Y sin selección en ninguno de los cuatro, sigue siendo la misma referencia.
    assert.equal(applyPanelFilters(opps, EMPTY_PANEL_FILTERS, PIPELINES), opps);
  }

  // 7. Los seis desarrollos del roster tienen embudo; GENERAL a propósito no.
  {
    assert.equal(PANEL_SCOPES.general.pipelineId, null, "GENERAL no acota a ningún embudo");
    for (const id of ["atria", "canadas", "lasierra", "palmyra", "saggita", "zanda"] as const) {
      assert.ok(PANEL_SCOPES[id].pipelineId, `${id} tiene embudo de respaldo`);
    }
  }

  console.log("verify-panel-filters: all assertions passed");
}

main();
