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
  accountToPipeline,
  adIdCandidates,
  urlCandidates,
  nameCandidates,
  normalizeUrl,
  buildLearnedIndex,
  buildPautaContacts,
  classifyLead,
  assignAdDesarrollos,
  scopeMetaDaily,
  localDay,
  stageIndexOf,
  reachedStage,
  STAGE_TARGETS,
  type AttributionContext,
} from "../lib/meta-attribution";
import { buildPautaNamesByContact } from "../lib/pauta-performance";
import { NO_DESARROLLO } from "../lib/panel-scope";
import type { Contact, MetaAdsData, Opportunity, Pauta, Pipeline } from "../lib/types";

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
    { id: "act_3", name: "Palmyra Residencial ", currency: "MXN", timezone: "America/Mexico_City" },
  ],
  campaigns: [
    { id: "c1", name: "IW - Cañadas - Agosto", accountId: "act_1" },
    { id: "c2", name: "IW - Atria - Agosto", accountId: "act_1" },
    { id: "c3", name: "Branding genérico", accountId: "act_2" },
    { id: "c4", name: "PALMYRA | MAYO | PERFILES", accountId: "act_3" },
  ],
  adsets: [
    { id: "s1", name: "Set", campaignId: "c1" },
    { id: "s2", name: "Set", campaignId: "c2" },
    { id: "s3", name: "Set", campaignId: "c3" },
    { id: "s4", name: "Set", campaignId: "c4" },
  ],
  ads: [
    { id: "101", name: "Cañadas by El Mirador", adsetId: "s1" },
    { id: "102", name: "Cañadas by El Mirador", adsetId: "s1" },   // mismo nombre, misma campaña → inequívoco
    { id: "201", name: "Atria lofts", adsetId: "s2" },
    { id: "301", name: "Terrenos desde $1.2 M", adsetId: "s3" },
    { id: "302", name: "Atria lofts", adsetId: "s3" },             // "Atria lofts" en DOS campañas → ambiguo
    { id: "401", name: "anuncio 1", adsetId: "s4" },
  ],
  daily: [
    { adId: "101", accountId: "act_1", date: "2026-08-01", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 4 },
    { adId: "101", accountId: "act_1", date: "2026-08-15", spend: 100, impressions: 1000, reach: 900, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 2 },
    { adId: "201", accountId: "act_1", date: "2026-08-15", spend: 50, impressions: 500, reach: 400, clicks: 10, linkClicks: 8, leadsForm: 1, leadsMsg: 0 },
    { adId: "301", accountId: "act_2", date: "2026-08-20", spend: 30, impressions: 300, reach: 200, clicks: 3, linkClicks: 3, leadsForm: 0, leadsMsg: 0 },
    { adId: "101", accountId: "act_1", date: "2026-09-01", spend: 999, impressions: 1, reach: 1, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
    { adId: "401", accountId: "act_3", date: "2026-08-03", spend: 40, impressions: 400, reach: 300, clicks: 4, linkClicks: 4, leadsForm: 1, leadsMsg: 0 },
    // Anuncio BORRADO: reporta gasto pero no está en `ads`.
    { adId: "777", accountId: "act_1", date: "2026-08-04", spend: 70, impressions: 700, reach: 600, clicks: 7, linkClicks: 7, leadsForm: 0, leadsMsg: 1 },
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
  assert.equal(index.campaignsById.get("c4")?.accountId, "act_3");
  assert.equal(index.accountsById.get("act_3")?.currency, "MXN");
  assert.deepEqual([...index.adsByName.get("canadas by el mirador")!].sort(), ["101", "102"]);
  assert.deepEqual([...index.campaignsByName.get("palmyra | mayo | perfiles")!], ["c4"]);
  assert.equal(index.adsByName.has("palmyra | mayo | perfiles"), false, "nombre de campaña no es nombre de anuncio");

  // --- cuenta = desarrollo: el nombre de la cuenta contra los pipelines, agujas largas primero
  const accMap = accountToPipeline(meta.accounts, pipelines);
  assert.equal(accMap.get("act_3"), "Palmyra", "\"Palmyra Residencial \" (con espacio) → pipeline Palmyra");
  assert.equal(accMap.has("act_1"), false, "\"Uno\" no se llama como ningún desarrollo");
  const accented: Pipeline[] = [...pipelines, { id: "p-atr2", name: "Átria", stages: STAGES }];
  assert.equal(
    accountToPipeline([{ id: "act_9", name: "Átria ", currency: "MXN", timezone: "" }], accented).get("act_9"),
    "Átria",
    "acentos y mayúsculas no importan; devuelve el nombre REAL del pipeline"
  );

  // --- llaves de una oportunidad: propias primero, luego del contacto; sin repetir
  const contactById = new Map<string, Contact>([
    ["c-K", {
      id: "c-K", name: "K", email: "", phone: "", tags: [], dateAdded: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z",
      customFieldsResolved: { "ID Pauta": "555", "URL Pauta": "https://fb.me/CONTACTO", "Nombre Pauta": "Del contacto" },
      attributions: [{ isLast: true, utmAdId: "666", url: "https://fb.me/ULTIMA", adName: "Ultima attr" }],
    }],
  ]);
  const k = opp({
    id: "K", contactId: "c-K", adId: "111",
    customFieldsResolved: { "ID de Pauta": "222", "URL Pauta": "https://fb.me/OPP/", "Nombre Pauta": "De la opp" },
    attributions: [
      { isFirst: true, utmAdId: "111", url: "https://fb.me/OPP", utmCampaign: "Camp first" },
      { isLast: true, utmAdId: "333", url: "https://www.instagram.com/p/X/?igsh=1", adName: "Ad last" },
    ],
  });
  assert.deepEqual(adIdCandidates(k, contactById), ["111", "222", "555", "333", "666"]);
  assert.deepEqual(urlCandidates(k, contactById), [
    "https://fb.me/OPP", "https://fb.me/CONTACTO", "https://www.instagram.com/p/X", "https://fb.me/ULTIMA",
  ]);
  assert.deepEqual(nameCandidates(k, contactById, new Map([["c-K", ["Pauta obj", "Sin nombre"]]])), [
    "De la opp", "Del contacto", "Camp first", "Ad last", "Ultima attr", "Pauta obj",
  ]);
  assert.equal(normalizeUrl(" https://fb.me/Abc/?x=1#y "), "https://fb.me/Abc");
  assert.deepEqual(adIdCandidates(opp({ id: "nada" })), []);

  // --- lo aprendido de los leads: URL → anuncio/campaña, y la campaña de un anuncio borrado
  const learned = buildLearnedIndex(
    [
      opp({ id: "L1", adId: "101", attributions: [{ isFirst: true, utmAdId: "101", url: "https://fb.me/UNO" }] }),
      opp({ id: "L2", adId: "102", attributions: [{ isFirst: true, utmAdId: "102", url: "https://fb.me/UNO" }] }),
      opp({ id: "L3", adId: "201", attributions: [{ isFirst: true, utmAdId: "201", url: "https://fb.me/DOS" }] }),
      opp({ id: "L4", adId: "777", attributions: [{ isFirst: true, utmAdId: "777", utmCampaignId: "c1", url: "https://fb.me/DEL" }] }),
      opp({ id: "L5", adId: "9999", attributions: [{ isFirst: true, utmAdId: "9999", url: "https://fb.me/NADIE" }] }),
      opp({ id: "L6", adId: "101", attributionMedium: "csv_import", attributions: [{ isFirst: true, utmAdId: "101", url: "https://fb.me/CSV" }] }),
    ],
    index
  );
  assert.deepEqual([...learned.byUrl.get("https://fb.me/UNO")!.ads].sort(), ["101", "102"], "una URL, dos anuncios de la misma campaña");
  assert.deepEqual([...learned.byUrl.get("https://fb.me/UNO")!.campaigns], ["c1"]);
  assert.deepEqual([...learned.byUrl.get("https://fb.me/DOS")!.ads], ["201"]);
  assert.equal(learned.byUrl.has("https://fb.me/NADIE"), false, "un ad id que no está en Meta no enseña nada");
  assert.equal(learned.byUrl.has("https://fb.me/CSV"), false, "una importación no enseña nada");
  assert.deepEqual([...learned.byUrl.get("https://fb.me/DEL")!.ads], ["777"], "el anuncio borrado tiene gasto: sí es nuestro");
  assert.equal(learned.campaignOfDeletedAd.get("777"), "c1", "la campaña del borrado sale del utmCampaignId de su lead");

  // --- clasificación: cuatro niveles, cada uno solo si el anterior no dio nada
  const ctxContacts = new Map<string, Contact>([
    ["c-U", { id: "c-U", name: "U", email: "", phone: "", tags: [], dateAdded: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z",
      customFieldsResolved: { "URL Pauta": "https://fb.me/DOS" } }],
  ]);
  const ctx: AttributionContext = {
    index,
    pautaContacts: buildPautaContacts(pautas),
    pautaNamesByContact: buildPautaNamesByContact(pautas),
    contactById: ctxContacts,
    learned,
  };
  // nivel 1: ad id
  assert.deepEqual(classifyLead(opp({ id: "1", adId: "101" }), ctx), { kind: "ad", adId: "101", campaignId: "c1", via: "adId" });
  assert.deepEqual(
    classifyLead(opp({ id: "1b", customFieldsResolved: { "ID Pauta": "102" } }), ctx),
    { kind: "ad", adId: "102", campaignId: "c1", via: "adId" }, "custom field de la opp"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "1c", attributions: [{ isLast: true, utmAdId: "201" }] }), ctx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "adId" }, "la última attribution también cuenta"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "1d", adId: "777" }), ctx),
    { kind: "ad", adId: "777", campaignId: "c1", via: "adId" }, "anuncio borrado con gasto: es nuestro; su campaña se aprendió"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "1e", adId: "9999", customFieldsResolved: { "ID Pauta": "101" } }), ctx),
    { kind: "ad", adId: "101", campaignId: "c1", via: "adId" }, "el primer id que pega manda, aunque no sea el primero de la lista"
  );
  // nivel 2: utmCampaignId
  assert.deepEqual(
    classifyLead(opp({ id: "2", adId: "9999", attributions: [{ isFirst: true, utmAdId: "9999", utmCampaignId: "c2" }] }), ctx),
    { kind: "campaign", campaignId: "c2", via: "campaignId" }, "ad id de otra cuenta pero campaña conocida → campaña, no unknownAd"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "2b", attributions: [{ isFirst: true, utmCampaignId: "c-nadie" }], source: "Pauta Formulario" }), ctx),
    { kind: "noAdId" }, "campaña desconocida no resuelve"
  );
  // nivel 3: URL aprendida
  assert.deepEqual(
    classifyLead(opp({ id: "3", customFieldsResolved: { "URL Pauta": "https://fb.me/DOS/" } }), ctx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "url" }, "URL de un solo anuncio → anuncio"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "3b", attributionUrl: "https://fb.me/UNO?fbclid=x" }), ctx),
    { kind: "campaign", campaignId: "c1", via: "url" }, "URL de dos anuncios de la misma campaña → campaña"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "3c", contactId: "c-U", source: undefined }), ctx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "url" }, "la URL puede venir del contacto"
  );
  // nivel 4: nombres
  assert.deepEqual(
    classifyLead(opp({ id: "4", customFieldsResolved: { "Nombre Pauta": "PALMYRA | MAYO | PERFILES" } }), ctx),
    { kind: "campaign", campaignId: "c4", via: "name" }, "nombre de UNA campaña de Meta → campaña"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "4b", attributions: [{ isFirst: true, utmCampaign: "IW - Atria - Agosto" }] }), ctx),
    { kind: "campaign", campaignId: "c2", via: "name" }, "utmCampaign de la attribution"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "4c", customFieldsResolved: { Pauta: "Terrenos desde $1.2 M" } }), ctx),
    { kind: "ad", adId: "301", campaignId: "c3", via: "name" }, "nombre de UN anuncio → anuncio"
  );
  assert.deepEqual(classifyLead(opp({ id: "4d", contactId: "c-11", source: undefined }), ctx), { kind: "noAdId" },
    "\"Cañadas by El Mirador\" es el nombre de DOS anuncios (101, 102): ambiguo, no se atribuye");
  assert.deepEqual(classifyLead(opp({ id: "4e", contactId: "c-12" }), ctx), { kind: "noAdId" },
    "\"Atria lofts\" vive en dos campañas: ambiguo");
  assert.deepEqual(classifyLead(opp({ id: "4f", contactId: "c-13" }), ctx), { kind: "noAdId" }, "\"Sin nombre\" no es un nombre");
  // centinelas
  assert.deepEqual(classifyLead(opp({ id: "9", adId: "9999" }), ctx), { kind: "unknownAd", adId: "9999" });
  assert.deepEqual(classifyLead(opp({ id: "8", source: "Pauta Formulario" }), ctx), { kind: "noAdId" });
  assert.deepEqual(classifyLead(opp({ id: "r", source: "Referido" }), ctx), { kind: "notPauta" });
  assert.deepEqual(classifyLead(opp({ id: "csv", source: undefined, attributionMedium: "csv_import", pipelineId: "p-pal" }), ctx), { kind: "notPauta" });
  assert.deepEqual(classifyLead(opp({ id: "csv2", adId: "101", attributionMedium: "csv_import" }), ctx), { kind: "notPauta" }, "csv_import gana incluso con ad id");
  // sin `learned` ni `contactById` la cadena sigue funcionando con lo que la opp trae
  assert.deepEqual(
    classifyLead(opp({ id: "min", adId: "101" }), { index, pautaContacts: ctx.pautaContacts, pautaNamesByContact: ctx.pautaNamesByContact }),
    { kind: "ad", adId: "101", campaignId: "c1", via: "adId" }
  );

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
  assert.equal(desarrolloByAd.get("401"), "Palmyra", "la CUENTA manda: act_3 es Palmyra aunque no tenga leads");
  assert.equal(desarrolloByAd.get("777"), NO_DESARROLLO, "un anuncio borrado sin cuenta reconocible: sin desarrollo");
  const canByAccount = assignAdDesarrollos(
    { ...meta, accounts: [{ id: "act_1", name: "Cañadas by El Mirador ", currency: "MXN", timezone: "" }, ...meta.accounts.slice(1)] },
    index, opps, pipelines
  ).byAd;
  assert.equal(canByAccount.get("201"), "Cañadas", "con la cuenta reconocida, ni la moda de leads (Atria) ni el nombre del ad la contradicen");
  assert.equal(canByAccount.get("777"), "Cañadas", "el borrado hereda el desarrollo de la cuenta de su fila diaria");
  // un desarrollo que NO está en PANEL_SCOPES pero sí en los pipelines también se detecta por nombre
  const withSeventh: Pipeline[] = [...pipelines, { id: "p-7", name: "Nuevo Bosque", stages: STAGES }];
  const metaNoLeads = { ...meta, ads: [{ id: "701", name: "Nuevo Bosque lotes", adsetId: "s1" }], daily: [] };
  const r2 = assignAdDesarrollos(metaNoLeads, buildMetaIndex(metaNoLeads), [], withSeventh);
  assert.equal(r2.byAd.get("701"), "Nuevo Bosque");

  // --- scope por panel: GENERAL devuelve la misma referencia; el fallback por nombre y el scope coinciden
  assert.equal(scopeMetaDaily(meta, desarrolloByAd, "general", pipelines), meta.daily);
  const canDaily = scopeMetaDaily(meta, desarrolloByAd, "canadas", pipelines);
  assert.deepEqual(canDaily.map((d) => d.adId), ["101", "101", "101"]);
  assert.deepEqual(scopeMetaDaily(meta, desarrolloByAd, "palmyra", pipelines).map((d) => d.adId), ["401"]);

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


  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
