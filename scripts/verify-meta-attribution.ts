// Verificación de lib/meta-attribution.ts. Correr: pnpm verify:meta-attribution
//
// Aquí se decide cuánto costó cada venta. La llave es el ad id; a falta de id,
// el nombre del ad cuando es inequívoco; y una oportunidad que no es de pauta
// (orgánica, referida, importada por CSV) nunca entra al costo. Un bug aquí es
// un costo por venta que el cliente cree y que es falso.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import {
  NO_AD_ID,
  oppAdId,
  buildMetaIndex,
  buildPautaContacts,
  classifyLead,
  assignAdDesarrollos,
  scopeMetaDaily,
  localDay,
  stageIndexOf,
  reachedStage,
  buildCostPerStage,
  buildCampaignPerformance,
  STAGE_TARGETS,
  type AttributionContext,
} from "../lib/meta-attribution";
import { buildPautaNameByContact } from "../lib/pauta";
import { NO_DESARROLLO } from "../lib/panel-scope";
import type { MetaAdsData, Opportunity, Pauta, Pipeline } from "../lib/types";

const STAGES = [
  "00. Recibido", "01. Contactado", "02. Lead en Seguimiento", "03. Lead Calificado",
  "04. Cita Programada", "05. Visita al Desarrollo", "06. Negociación", "07. Apartado",
  "08. Venta", "Inversión Futura", "Negocio perdido",
];
const pipelines: Pipeline[] = [
  { id: "p-can", name: "Cañadas", stages: STAGES },
  { id: "p-atr", name: "Atria", stages: STAGES },
  { id: "p-pal", name: "Palmyra", stages: STAGES },
];

function opp(p: Partial<Opportunity> & { id: string }): Opportunity {
  return {
    name: p.id, pipelineId: "p-can", pipelineStageId: "x", status: "open",
    createdAt: "2026-08-10T15:00:00.000Z", contactId: "c-" + p.id, value: 0,
    stage: "00. Recibido", pipelineName: "Cañadas", source: "Pauta WhatsApp",
    ...p,
  };
}

const meta: MetaAdsData = {
  accounts: [
    { id: "act_1", name: "Uno", currency: "MXN", timezone: "America/Mexico_City" },
    { id: "act_2", name: "Dos", currency: "USD", timezone: "America/Mexico_City" },
  ],
  campaigns: [
    { id: "c1", name: "IW - Cañadas - Agosto", accountId: "act_1" },
    { id: "c2", name: "IW - Atria - Agosto", accountId: "act_1" },
    { id: "c3", name: "Branding genérico", accountId: "act_2" },
  ],
  adsets: [
    { id: "s1", name: "Set", campaignId: "c1" },
    { id: "s2", name: "Set", campaignId: "c2" },
    { id: "s3", name: "Set", campaignId: "c3" },
  ],
  ads: [
    { id: "101", name: "Cañadas by El Mirador", adsetId: "s1" },
    { id: "102", name: "Cañadas by El Mirador", adsetId: "s1" },   // mismo nombre, misma campaña → inequívoco
    { id: "201", name: "Atria lofts", adsetId: "s2" },
    { id: "301", name: "Terrenos desde $1.2 M", adsetId: "s3" },
    { id: "302", name: "Atria lofts", adsetId: "s3" },             // "Atria lofts" en DOS campañas → ambiguo
  ],
  daily: [
    { adId: "101", date: "2026-08-01", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 4 },
    { adId: "101", date: "2026-08-15", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 2 },
    { adId: "201", date: "2026-08-15", spend: 50, impressions: 500, reach: 400, clicks: 10, linkClicks: 8, leadsForm: 1, leadsMsg: 0 },
    { adId: "301", date: "2026-08-20", spend: 30, impressions: 300, reach: 200, clicks: 3, linkClicks: 3, leadsForm: 0, leadsMsg: 0 },
    { adId: "101", date: "2026-09-01", spend: 999, impressions: 1, reach: 1, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
  ],
  window: { since: "2026-08-01", until: "2026-09-13" },
  failedAccounts: [],
};

const pautas: Pauta[] = [
  { id: "P1", tipo: "Mensaje WhatsApp", nombrePauta: "Cañadas by El Mirador", createdAt: "2026-08-02T00:00:00.000Z", contactId: "c-11" },
  { id: "P2", tipo: "Formulario", nombrePauta: "Atria lofts", createdAt: "2026-08-02T00:00:00.000Z", contactId: "c-12" },
  { id: "P3", tipo: "Formulario", nombrePauta: "Sin nombre", createdAt: "2026-08-02T00:00:00.000Z", contactId: "c-13" },
];

async function main() {
  // --- llave: attribution manda, custom field "ID Pauta" / "ID de Pauta" como fallback
  assert.equal(oppAdId(opp({ id: "o", adId: "120247808685340416" })), "120247808685340416");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "ID Pauta": " 1202478 " } })), "1202478");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "ID de Pauta": "77" } })), "77");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "id pauta": "78" } })), "78", "nombre del campo insensible a mayúsculas");
  assert.equal(oppAdId(opp({ id: "o", adId: "1", customFieldsResolved: { "ID Pauta": "2" } })), "1", "cuando difieren, manda la attribution nativa");
  assert.equal(oppAdId(opp({ id: "o", customFieldsResolved: { "URL Pauta": "https://fb.me/x", "Nombre Pauta": "x" } })), null, "URL y nombre no son ids");
  assert.equal(oppAdId(opp({ id: "o", adId: "abc" })), null, "un id sin dígitos no es un ad id");
  assert.equal(oppAdId(opp({ id: "o" })), null);
  assert.equal(NO_AD_ID, "Sin ad id");

  // --- índice: jerarquía y nombres plegados → campañas
  const index = buildMetaIndex(meta);
  assert.equal(index.byAd.get("101")?.campaign?.id, "c1");
  assert.equal(index.byAd.get("101")?.account?.currency, "MXN");
  assert.equal(index.dailyByAd.get("101")?.length, 3);
  assert.deepEqual([...index.byName.get("canadas by el mirador")!], ["c1"]);
  assert.deepEqual([...index.byName.get("atria lofts")!].sort(), ["c2", "c3"]);
  assert.deepEqual([...index.byName.get("iw - canadas - agosto")!], ["c1"], "los nombres de campaña también se indexan");

  // --- clasificación de un lead
  const ctx: AttributionContext = {
    index,
    pautaContacts: buildPautaContacts(pautas),
    pautaNameByContact: buildPautaNameByContact(pautas),
  };
  assert.deepEqual(classifyLead(opp({ id: "1", adId: "101" }), ctx), { kind: "exact", adId: "101", campaignId: "c1" });
  assert.deepEqual(classifyLead(opp({ id: "9", adId: "9999" }), ctx), { kind: "unknownAd", adId: "9999" });
  // sin id, con nombre en el custom field de la oportunidad → campaña única
  assert.deepEqual(
    classifyLead(opp({ id: "11", customFieldsResolved: { "Nombre Pauta": "Cañadas by El Mirador" } }), ctx),
    { kind: "byName", name: "Cañadas by El Mirador", campaignId: "c1" }
  );
  // sin id ni custom field, pero el contacto tiene registro Pauta con nombre → campaña única
  assert.deepEqual(classifyLead(opp({ id: "11", contactId: "c-11", source: undefined }), ctx), {
    kind: "byName", name: "Cañadas by El Mirador", campaignId: "c1",
  });
  // nombre ambiguo (dos campañas) → NO se atribuye; queda como pauta sin id
  assert.deepEqual(classifyLead(opp({ id: "12", contactId: "c-12" }), ctx), { kind: "noAdId" });
  // nombre "Sin nombre" del Make → no cuenta como nombre
  assert.deepEqual(classifyLead(opp({ id: "13", contactId: "c-13" }), ctx), { kind: "noAdId" });
  // de pauta por source, sin id ni nombre
  assert.deepEqual(classifyLead(opp({ id: "8", source: "Pauta Formulario" }), ctx), { kind: "noAdId" });
  // orgánico: sin señal de pauta
  assert.deepEqual(classifyLead(opp({ id: "r", source: "Referido" }), ctx), { kind: "notPauta" });
  // importado por CSV: nunca es de pauta, aunque el pipeline sea de un desarrollo
  assert.deepEqual(classifyLead(opp({ id: "csv", source: undefined, attributionMedium: "csv_import", pipelineId: "p-pal" }), ctx), { kind: "notPauta" });
  assert.deepEqual(classifyLead(opp({ id: "csv2", adId: "101", attributionMedium: "csv_import" }), ctx), { kind: "notPauta" }, "csv_import gana incluso con ad id");

  // --- desarrollo por moda de leads, por nombre, sin desarrollo, y mixtos
  const opps = [
    opp({ id: "1", adId: "101", pipelineId: "p-can" }),
    opp({ id: "2", adId: "101", pipelineId: "p-can" }),
    opp({ id: "3", adId: "101", pipelineId: "p-atr" }),
    opp({ id: "4", adId: "101", pipelineId: "p-can", stage: "05. Visita al Desarrollo" }),
    opp({ id: "5", adId: "101", pipelineId: "p-can", stage: "07. Apartado", status: "lost" }),
    opp({ id: "6", adId: "101", pipelineId: "p-can", stage: "08. Venta" }),
    opp({ id: "7", adId: "201", pipelineId: "p-atr", createdAt: "2026-08-15T05:30:00.000Z" }),
    opp({ id: "8", pipelineId: "p-can", source: "Pauta Formulario" }),
    opp({ id: "9", adId: "9999", pipelineId: "p-can" }),
    opp({ id: "10", adId: "101", pipelineId: "p-can", createdAt: "2026-07-31T23:30:00.000Z" }),
    opp({ id: "11", contactId: "c-11", pipelineId: "p-can", source: undefined, stage: "04. Cita Programada" }),
    opp({ id: "r", pipelineId: "p-can", source: "Referido" }),
    opp({ id: "csv", pipelineId: "p-pal", source: undefined, attributionMedium: "csv_import" }),
  ];
  const { byAd: desarrolloByAd, mixed } = assignAdDesarrollos(meta, index, opps, pipelines);
  assert.equal(desarrolloByAd.get("101"), "Cañadas", "moda: 6 en Cañadas vs 1 en Atria");
  assert.deepEqual(mixed, ["101"], "a1 tiene leads en más de un desarrollo");
  assert.equal(desarrolloByAd.get("201"), "Atria");
  assert.equal(desarrolloByAd.get("301"), NO_DESARROLLO, "sin leads y sin nombre de desarrollo");
  assert.equal(desarrolloByAd.get("102"), "Cañadas", "sin leads, pero la campaña dice Cañadas");
  assert.equal(desarrolloByAd.get("302"), "Atria", "la campaña es 'Branding genérico', pero el nombre del AD dice Atria");
  // un desarrollo que NO está en PANEL_SCOPES pero sí en los pipelines también se detecta por nombre
  const withSeventh: Pipeline[] = [...pipelines, { id: "p-7", name: "Nuevo Bosque", stages: STAGES }];
  const metaNoLeads = { ...meta, ads: [{ id: "701", name: "Nuevo Bosque lotes", adsetId: "s1" }], daily: [] };
  const r2 = assignAdDesarrollos(metaNoLeads, buildMetaIndex(metaNoLeads), [], withSeventh);
  assert.equal(r2.byAd.get("701"), "Nuevo Bosque");

  // --- scope por panel: GENERAL devuelve la misma referencia; el fallback por nombre y el scope coinciden
  assert.equal(scopeMetaDaily(meta, desarrolloByAd, "general", pipelines), meta.daily);
  const canDaily = scopeMetaDaily(meta, desarrolloByAd, "canadas", pipelines);
  assert.deepEqual(canDaily.map((d) => d.adId), ["101", "101", "101"]);
  assert.deepEqual(scopeMetaDaily(meta, desarrolloByAd, "palmyra", pipelines), []);

  // --- día local: 2026-07-31T23:30Z es 31 de julio en CDMX (UTC-6); 2026-08-15T05:30Z es 14 de agosto
  assert.equal(localDay("2026-07-31T23:30:00.000Z"), "2026-07-31");
  assert.equal(localDay("2026-08-15T05:30:00.000Z"), "2026-08-14");
  assert.equal(localDay("no-es-fecha"), "");

  // --- etapas
  assert.equal(stageIndexOf("05. Visita al Desarrollo"), 5);
  assert.equal(stageIndexOf("Negocio perdido"), null);
  assert.equal(stageIndexOf(undefined), null);
  const venta = STAGE_TARGETS.find((t) => t.key === "venta")!;
  const visita = STAGE_TARGETS.find((t) => t.key === "visita")!;
  assert.equal(reachedStage(opp({ id: "x", stage: "07. Apartado", status: "lost" }), visita), true, "una perdida en Apartado sí alcanzó Visita");
  assert.equal(reachedStage(opp({ id: "x", stage: "07. Apartado", status: "lost" }), venta), false);
  assert.equal(reachedStage(opp({ id: "x", stage: "02. Lead en Seguimiento", status: "won" }), venta), true, "status won cuenta como Venta aunque la etapa no");
  assert.equal(reachedStage(opp({ id: "x", stage: "Negocio perdido" }), visita), false);

  // --- costo por etapa, agosto, GENERAL
  const range = { start: "2026-08-01", end: "2026-08-31" };
  const cost = buildCostPerStage({ opportunities: opps, daily: meta.daily, ctx, accounts: meta.accounts, range });
  assert.deepEqual(cost.spendByCurrency, { MXN: 250, USD: 30 });
  assert.equal(cost.mixedCurrency, true);
  // exactos en agosto (día local): 1,2,3,4,5,6 (a1) + 7 (a2, 14 ago) = 7; la 10 es 31 de julio
  assert.equal(cost.leadsExact, 7);
  assert.equal(cost.leadsByName, 1, "la 11, por el registro Pauta del contacto");
  assert.equal(cost.leadsCrm, 8, "exactos + por nombre");
  assert.equal(cost.leadsMeta, 7, "4+2 msg + 1 form");
  assert.equal(cost.noAdId, 1, "la 8: de pauta, sin id ni nombre");
  assert.equal(cost.unknownAdLeads, 1, "la 9");
  assert.equal(cost.notPauta, 2, "referido + csv_import; nunca entran al costo");
  const byKey = Object.fromEntries(cost.stages.map((s) => [s.key, s]));
  assert.equal(byKey.contactado.reached, 4, "4 (05), 5 (07), 6 (08), 11 (04)");
  assert.equal(byKey.cita.reached, 4);
  assert.equal(byKey.visita.reached, 3);
  assert.equal(byKey.apartado.reached, 2);
  assert.equal(byKey.venta.reached, 1);
  assert.deepEqual(byKey.venta.oppIds, ["6"]);
  assert.equal(byKey.venta.costPerResult, null, "con moneda mixta no hay costo consolidado");

  // --- una sola moneda: costo = gasto / alcanzaron; sin alcanzaron → null
  const mxnDaily = meta.daily.filter((d) => d.adId !== "301");
  const costMxn = buildCostPerStage({ opportunities: opps, daily: mxnDaily, ctx, accounts: meta.accounts, range });
  assert.equal(costMxn.mixedCurrency, false);
  assert.equal(costMxn.stages.find((s) => s.key === "venta")?.costPerResult, 250);
  assert.equal(costMxn.stages.find((s) => s.key === "apartado")?.costPerResult, 125);
  const nadie = buildCostPerStage({ opportunities: [opp({ id: "solo", adId: "101" })], daily: mxnDaily, ctx, accounts: meta.accounts, range });
  assert.equal(nadie.stages.find((s) => s.key === "venta")?.costPerResult, null, "sin ventas → null, nunca ∞");

  // --- sin rango = toda la ventana
  const all = buildCostPerStage({ opportunities: opps, daily: meta.daily, ctx, accounts: meta.accounts, range: null });
  assert.deepEqual(all.spendByCurrency, { MXN: 1249, USD: 30 });
  assert.equal(all.leadsExact, 8, "la 10 (julio) entra");

  // --- rendimiento por campaña, agosto
  const rows = buildCampaignPerformance({ opportunities: opps, daily: meta.daily, ctx, accounts: meta.accounts, range });
  assert.deepEqual(rows.map((r) => r.campaignId), ["c1", "c2", "c3"], "por gasto desc");
  const c1 = rows[0];
  assert.equal(c1.spend, 200);
  assert.equal(c1.currency, "MXN");
  assert.equal(c1.leadsMeta, 6);
  assert.equal(c1.leadsCrm, 7, "6 exactos + la 11 por nombre");
  assert.equal(c1.leadsByName, 1);
  assert.equal(c1.reached.venta, 1);
  assert.equal(c1.cpl, 200 / 7);
  assert.equal(c1.costPerVenta, 200);
  assert.equal(c1.cpm, 100, "200 / 2000 impresiones × 1000");
  assert.equal(c1.ctr, 0.05, "100 clics / 2000 impresiones");
  const c3 = rows[2];
  assert.equal(c3.leadsCrm, 0);
  assert.equal(c3.cpl, null, "gasto sin leads: null, y la UI lo pinta en rojizo");
  assert.deepEqual(c3.adIds, ["301"]);

  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
