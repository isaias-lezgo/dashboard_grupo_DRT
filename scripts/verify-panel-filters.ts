// Verification for lib/panel-filters.ts — los seis filtros globales de la
// barra (desarrollo, asesor, origen, canal, campaña, agencia).
//
// Un filtro silenciosamente mal se ve igual que uno bien: números más chicos.
// Por eso estas aserciones existen y por eso el módulo es puro y sin React.
//
// Correr con: pnpm verify:filters
import assert from "node:assert/strict";
import type { Opportunity, Pauta, Pipeline } from "../lib/types";
import { buildPautaNamesByContact } from "../lib/pauta-performance";
import { SIN_NOMBRE_CAMPAIGN } from "../lib/pauta";
import { NO_DESARROLLO, PANEL_SCOPES } from "../lib/panel-scope";
import {
  activeFilterCount,
  advisorKeyOf,
  applyPanelFilters,
  buildCampanaOptions,
  campanasOf,
  collectAdvisors,
  EMPTY_PANEL_FILTERS,
  NO_ASESOR,
  NO_PAUTA,
  resolveCampanas,
  type PanelFilters,
} from "../lib/panel-filters";
import {
  buildAgenciaOptions,
  detectAgencia,
  NO_AGENCIA,
  resolveAgencias,
} from "../lib/agencia";

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

  // 8. Campaña = nombre de Pauta, enlazado por CONTACTO. Un contacto con dos
  // Pautas entra con cualquiera de las dos; el que no tiene ninguna cae en
  // NO_PAUTA y sigue alcanzable; "Sin nombre" es otra cosa (Pauta sin nombre).
  {
    const a = opp({ pipelineId: ATRIA }); // Pauta de Atria
    const b = opp({ pipelineId: ATRIA }); // Pautas de Atria y de Cañadas
    const c = opp({ pipelineId: ATRIA }); // sin Pauta
    const d = opp({ pipelineId: ATRIA }); // Pauta sin nombre
    const e = opp({ pipelineId: ATRIA }); // solo Pauta de Cañadas
    const pauta = (contactId: string, nombrePauta: string, desarrollo: string): Pauta => ({
      id: `p-${contactId}-${nombrePauta}`,
      tipo: "Formulario",
      nombrePauta,
      createdAt: "2026-01-01T00:00:00.000Z",
      contactId,
      properties: { desarrollo },
    });
    const pautas = [
      pauta(a.contactId!, "Atria Lanzamiento", "Atria"),
      pauta(b.contactId!, "Atria Lanzamiento", "Atria"),
      pauta(b.contactId!, "Cañadas by El Mirador", "Cañadas"),
      pauta(d.contactId!, "", "Atria"),
      pauta(e.contactId!, "Cañadas by El Mirador", "Cañadas"),
    ];
    const map = { pautaNamesByContact: buildPautaNamesByContact(pautas) };
    const opps = [a, b, c, d, e];
    const ids = (xs: Opportunity[]) => xs.map((x) => x.id);

    assert.deepEqual(campanasOf(c, map), [NO_PAUTA]);
    assert.deepEqual(campanasOf(d, map), [SIN_NOMBRE_CAMPAIGN]);
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ campanas: ["Cañadas by El Mirador"] }), PIPELINES, undefined, map)),
      ids([b, e]),
      "multi-Pauta: b entra por su segunda Pauta"
    );
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ campanas: [NO_PAUTA] }), PIPELINES, undefined, map)),
      ids([c]),
      "Sin Pauta alcanza solo al contacto sin ningún registro"
    );
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ campanas: ["Atria Lanzamiento", SIN_NOMBRE_CAMPAIGN] }), PIPELINES, undefined, map)),
      ids([a, b, d]),
      "dentro del menú es OR"
    );
    assert.equal(activeFilterCount(filters({ campanas: ["x", "y"] })), 2);

    // Opciones en la pestaña de Atria: solo se LISTAN Pautas de Atria, pero el
    // conteo es el del filtro — `e` no es "Sin Pauta" aunque su única Pauta sea
    // de Cañadas. Centinelas al final.
    const allowed = new Set([...buildPautaNamesByContact(pautas, "Atria").values()].flat());
    assert.equal(map.pautaNamesByContact.size, 4);
    assert.deepEqual(buildCampanaOptions(opps, map, allowed), [
      { value: "Atria Lanzamiento", count: 2, muted: false },
      { value: SIN_NOMBRE_CAMPAIGN, count: 1, muted: true },
      { value: NO_PAUTA, count: 1, muted: true },
    ]);
    // En GENERAL se listan todas, por volumen.
    assert.deepEqual(
      buildCampanaOptions(opps, map).map((o) => [o.value, o.count]),
      [
        ["Atria Lanzamiento", 2],
        ["Cañadas by El Mirador", 2],
        [SIN_NOMBRE_CAMPAIGN, 1],
        [NO_PAUTA, 1],
      ]
    );
    // Sin contexto (modo degradado) todo es Sin Pauta, nunca una campaña inventada.
    assert.equal(applyPanelFilters(opps, filters({ campanas: [NO_PAUTA] }), PIPELINES).length, 5);
  }

  // 9. La cadena de respaldo de la campaña: Meta (por ad id) → objeto Pauta →
  // campo "Nombre Pauta" → centinela. Cada nivel entra solo si el anterior no
  // dio nombre; nunca se suman.
  {
    const withField = (o: Opportunity, nombre: string): Opportunity => ({
      ...o,
      customFieldsResolved: { ...o.customFieldsResolved, "Nombre Pauta": nombre },
    });
    const withAd = (o: Opportunity, adId: string): Opportunity => ({
      ...o,
      customFieldsResolved: { ...o.customFieldsResolved, "ID Pauta": adId },
    });
    const pauta = (contactId: string, nombrePauta: string): Pauta => ({
      id: `p-${contactId}`,
      tipo: "Formulario",
      nombrePauta,
      createdAt: "2026-01-01T00:00:00.000Z",
      contactId,
      properties: { desarrollo: "Atria" },
    });

    const conMeta = withField(withAd(opp({ pipelineId: ATRIA }), "111"), "Campo X"); // + Pauta
    const soloPauta = withField(opp({ pipelineId: ATRIA }), "Campo X"); // + Pauta
    const soloCampo = withField(opp({ pipelineId: ATRIA }), "Campo X");
    const pautaSinNombre = withField(opp({ pipelineId: ATRIA }), "Campo Y"); // + Pauta ""
    const adDesconocido = withAd(opp({ pipelineId: ATRIA }), "999"); // sin nada más
    const importado: Opportunity = { ...withAd(opp({ pipelineId: ATRIA }), "111"), attributionMedium: "csv_import" };
    const pautas = [
      pauta(conMeta.contactId!, "Pauta A"),
      pauta(soloPauta.contactId!, "Pauta A"),
      pauta(pautaSinNombre.contactId!, ""),
    ];
    const metaCampaignByAd = new Map([["111", "Meta Campaña 1"]]);
    const ctx = { pautaNamesByContact: buildPautaNamesByContact(pautas), metaCampaignByAd };
    const sinMeta = { pautaNamesByContact: ctx.pautaNamesByContact };

    assert.deepEqual(resolveCampanas(conMeta, ctx), { names: ["Meta Campaña 1"], source: "meta" });
    assert.deepEqual(resolveCampanas(conMeta, sinMeta), { names: ["Pauta A"], source: "pauta" }, "sin Meta conectado cae al objeto Pauta");
    assert.deepEqual(resolveCampanas(soloPauta, ctx), { names: ["Pauta A"], source: "pauta" }, "la Pauta gana al campo");
    assert.deepEqual(resolveCampanas(soloCampo, ctx), { names: ["Campo X"], source: "campo" });
    assert.deepEqual(resolveCampanas(pautaSinNombre, ctx), { names: ["Campo Y"], source: "campo" }, "una Pauta sin nombre no tapa el campo");
    assert.deepEqual(resolveCampanas(adDesconocido, ctx), { names: [NO_PAUTA], source: "none" }, "un ad que Meta no devolvió no inventa campaña");
    assert.deepEqual(resolveCampanas(importado, ctx), { names: [NO_PAUTA], source: "none" }, "un importado por CSV no toma la campaña de Meta");

    // El filtro compara con lo mismo que resolveCampanas.
    const opps = [conMeta, soloPauta, soloCampo, pautaSinNombre, adDesconocido, importado];
    const ids = (xs: Opportunity[]) => xs.map((x) => x.id);
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ campanas: ["Meta Campaña 1"] }), PIPELINES, undefined, ctx)),
      ids([conMeta])
    );
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ campanas: ["Campo X"] }), PIPELINES, undefined, ctx)),
      ids([soloCampo]),
      "el campo solo cuenta cuando no hubo Meta ni Pauta"
    );

    // En una pestaña, `allowed` acota solo los nombres del objeto Pauta: los de
    // Meta y los del campo vienen de la oportunidad y se listan siempre.
    const opciones = buildCampanaOptions(opps, ctx, new Set<string>());
    assert.deepEqual(
      opciones.map((o) => o.value),
      ["Campo X", "Campo Y", "Meta Campaña 1", NO_PAUTA]
    );
  }

  // Agencia: la nomenclatura "CAN-DOM-WSP-C3" y el nombre completo en los
  // nombres viejos. Cadena Pauta → última atribución → source.
  {
    assert.equal(detectAgencia("CAN-DOM-WSP-C3"), "Domus");
    assert.equal(detectAgencia("SAG-GEN-WSP-C1-A2"), "Genicrea");
    assert.equal(detectAgencia("pal-inh-wsp-c1"), "Inhouse", "sin importar mayúsculas");
    assert.equal(detectAgencia("ATR - DOM - FORM - C2"), "Domus", "separadores con espacios");
    assert.equal(detectAgencia("CAÑADA | Domus |  FORM 2 Jul"), "Domus");
    assert.equal(detectAgencia("Form.Saggita - Inhouse"), "Inhouse");
    assert.equal(detectAgencia("Campaña Inhouse"), "Inhouse");
    assert.equal(detectAgencia("Campaña In House"), "Inhouse");
    assert.equal(detectAgencia("FORMS | GEN | LA SIERRA"), null, "GEN suelto sin desarrollo delante no cuenta");
    assert.equal(detectAgencia("Domusa Residencial"), null, "palabra completa, no prefijo");
    assert.equal(detectAgencia("Cañadas by El Mirador"), null);
    assert.equal(detectAgencia(undefined), null);

    const porPauta = opp({});
    const dosPautas = opp({});
    const porAtribucion = { ...opp({}), attributions: [
      { isFirst: true, utmCampaign: "CAN-GEN-FORM-C1" },
      { isLast: true, utmCampaign: "SIE-INH-FORM-C1" },
    ] };
    const porAdName = { ...opp({}), attributions: [{ isLast: true, adName: "ZAN-DOM-WSP-C1-A3" }] };
    const porSource = { ...opp({}), source: "Campaña Inhouse" };
    const nada = { ...opp({}), source: "facebook" };
    // La Pauta gana a la atribución y al source.
    const pautaGana = { ...opp({}), source: "Campaña Inhouse" };
    const pautas: Pauta[] = [
      { id: "pa1", contactId: porPauta.contactId, nombrePauta: "CAÑADA | Domus |  FORM", createdAt: "" } as Pauta,
      { id: "pa2", contactId: dosPautas.contactId, nombrePauta: "Form. Cañadas - Inhouse", createdAt: "" } as Pauta,
      { id: "pa3", contactId: dosPautas.contactId, nombrePauta: "CAN-DOM-FORM-C1", createdAt: "" } as Pauta,
      { id: "pa4", contactId: pautaGana.contactId, nombrePauta: "SAG-GEN-WSP-C1", createdAt: "" } as Pauta,
      { id: "pa5", contactId: nada.contactId, nombrePauta: "Cañadas by El Mirador", createdAt: "" } as Pauta,
    ];
    const byContact = buildPautaNamesByContact(pautas);

    assert.deepEqual(resolveAgencias(porPauta, byContact), { names: ["Domus"], source: "pauta" });
    assert.deepEqual(resolveAgencias(dosPautas, byContact), { names: ["Domus", "Inhouse"], source: "pauta" }, "dos Pautas, dos agencias");
    assert.deepEqual(resolveAgencias(porAtribucion, byContact), { names: ["Inhouse"], source: "atribucion" }, "la ÚLTIMA atribución, no la primera");
    assert.deepEqual(resolveAgencias(porAdName, byContact), { names: ["Domus"], source: "atribucion" });
    assert.deepEqual(resolveAgencias(porSource, byContact), { names: ["Inhouse"], source: "source" });
    assert.deepEqual(resolveAgencias(pautaGana, byContact), { names: ["Genicrea"], source: "pauta" });
    assert.deepEqual(resolveAgencias(nada, byContact), { names: [NO_AGENCIA], source: "none" }, "una Pauta sin código no nombra agencia");

    const opps = [porPauta, dosPautas, porAtribucion, porAdName, porSource, nada, pautaGana];
    const ctx = { pautaNamesByContact: byContact };
    const ids = (xs: Opportunity[]) => xs.map((x) => x.id);
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ agencias: ["Domus"] }), PIPELINES, undefined, ctx)),
      ids([porPauta, dosPautas, porAdName])
    );
    assert.deepEqual(
      ids(applyPanelFilters(opps, filters({ agencias: [NO_AGENCIA] }), PIPELINES, undefined, ctx)),
      ids([nada]),
      "la cubeta vacía es seleccionable"
    );
    assert.equal(activeFilterCount(filters({ agencias: ["Domus", "Inhouse"] })), 2);

    // Las tres siempre, en orden fijo, aunque estén en cero; "Sin agencia" al final.
    assert.deepEqual(
      buildAgenciaOptions([nada], byContact).map((o) => [o.value, o.count]),
      [["Domus", 0], ["Genicrea", 0], ["Inhouse", 0], [NO_AGENCIA, 1]]
    );
  }

  console.log("verify-panel-filters: all assertions passed");
}

main();
