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
  buildPautaInvestment,
  SIN_CAMPANA,
  ANUNCIO_ELIMINADO,
  buildMetaPanelContext,
  postKeyOf,
  shortLinksToResolve,
  buildMetaAgenciaByOpp,
  agenciaOfAd,
  campaignNameOfAd,
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
    { id: "c5", name: "SAG - GEN - WSP  - C1", accountId: "act_3" },              // nomenclatura V1 en la campaña
    { id: "c6", name: "Formularios Zanda", accountId: "act_3" },                   // sin código; el adset lo trae
  ],
  adsets: [
    { id: "s1", name: "Set", campaignId: "c1" },
    { id: "s2", name: "Set", campaignId: "c2" },
    { id: "s3", name: "Set", campaignId: "c3" },
    { id: "s4", name: "Set", campaignId: "c4" },
    { id: "s5", name: "SAG - GEN - WSP  - C1 - acotado", campaignId: "c5" },
    { id: "s6", name: "ZAN - INH - FORM - C1", campaignId: "c6" },
  ],
  ads: [
    { id: "101", name: "Cañadas by El Mirador", adsetId: "s1" },
    { id: "102", name: "Cañadas by El Mirador", adsetId: "s1" },   // mismo nombre, misma campaña → inequívoco
    { id: "201", name: "Atria lofts", adsetId: "s2" },
    { id: "301", name: "Terrenos desde $1.2 M", adsetId: "s3" },
    { id: "302", name: "Atria lofts", adsetId: "s3" },             // "Atria lofts" en DOS campañas → ambiguo
    { id: "401", name: "anuncio 1", adsetId: "s4" },
    { id: "501", name: "SAG - GEN - WSP  - C1 - A6", adsetId: "s5" },
    { id: "601", name: "A1", adsetId: "s6" },
  ],
  daily: [
    { adId: "101", accountId: "act_1", date: "2026-08-01", spend: 100, impressions: 1000, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 4 },
    { adId: "101", accountId: "act_1", date: "2026-08-15", spend: 100, impressions: 1000, clicks: 50, linkClicks: 40, leadsForm: 0, leadsMsg: 2 },
    { adId: "201", accountId: "act_1", date: "2026-08-15", spend: 50, impressions: 500, clicks: 10, linkClicks: 8, leadsForm: 1, leadsMsg: 0 },
    { adId: "301", accountId: "act_2", date: "2026-08-20", spend: 30, impressions: 300, clicks: 3, linkClicks: 3, leadsForm: 0, leadsMsg: 0 },
    { adId: "101", accountId: "act_1", date: "2026-09-01", spend: 999, impressions: 1, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 },
    { adId: "401", accountId: "act_3", date: "2026-08-03", spend: 40, impressions: 400, clicks: 4, linkClicks: 4, leadsForm: 1, leadsMsg: 0 },
    // Anuncio BORRADO: reporta gasto pero no está en `ads`.
    { adId: "777", accountId: "act_1", date: "2026-08-04", spend: 70, impressions: 700, clicks: 7, linkClicks: 7, leadsForm: 0, leadsMsg: 1 },
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
  // Solo URLs de verdad: Make escribe "-" y a veces el NOMBRE del anuncio en "URL Pauta"
  // (medido 2026-09-28: 4 008 de 8 943 valores sin http). Sin este filtro, "-" se
  // aprendía como URL y ataba 578 leads a un anuncio de Palmyra.
  assert.deepEqual(urlCandidates(opp({ id: "u1", customFieldsResolved: { "URL Pauta": "-" } })), []);
  assert.deepEqual(urlCandidates(opp({ id: "u2", customFieldsResolved: { "URL Pauta": "FORMS | ENERO | LA SIERRA - VIDEO 1" } })), []);
  assert.deepEqual(urlCandidates(opp({ id: "u3", attributionUrl: "fb.me/sinEsquema" })), []);
  // "-" es el placeholder de Make para "sin valor" (736 de los 830 "sin vínculo"
  // medidos 2026-09-29 lo traían en el campo Pauta): no es un nombre, y con él
  // ~700 oportunidades manuales pasaban por "de pauta sin vincular".
  assert.deepEqual(nameCandidates(opp({ id: "n1", customFieldsResolved: { Pauta: "-" } })), []);
  assert.deepEqual(nameCandidates(opp({ id: "n2", customFieldsResolved: { Pauta: " - ", "Nombre Pauta": "--" } })), []);
  assert.deepEqual(nameCandidates(opp({ id: "n3", attributions: [{ isFirst: true, utmCampaign: "-", adName: "Real" }] })), ["Real"]);
  assert.deepEqual(classifyLead(opp({ id: "n4", source: "Prospección", customFieldsResolved: { Pauta: "-" } }), { index, pautaContacts: new Set(), pautaNamesByContact: new Map() }), { kind: "notPauta" }, "manual con Pauta '-' no es de pauta");

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
  assert.deepEqual([...learned.byUrl.get("https://fb.me/NADIE")!.foreign], ["9999"], "un ad id que no está en Meta no enseña anuncio, pero marca la URL como ajena");
  assert.equal(learned.byUrl.get("https://fb.me/NADIE")!.ads.size, 0);
  assert.equal(learned.byUrl.has("https://fb.me/CSV"), false, "una importación no enseña nada");
  assert.deepEqual([...learned.byUrl.get("https://fb.me/DEL")!.ads], ["777"], "el anuncio borrado tiene gasto: sí es nuestro");
  assert.equal(learned.campaignOfDeletedAd.get("777"), "c1", "la campaña del borrado sale del utmCampaignId de su lead");
  // Un ad id que Meta NO conoce también enseña: marca la URL como ajena. Una URL
  // compartida por un anuncio nuestro y uno de una cuenta no conectada NO
  // identifica al nuestro (medido 2026-09-28: fb.me/9g0MEa8TO ataba 131 leads de
  // Cañadas, cuenta no conectada, a un anuncio de Palmyra).
  const learnedMix = buildLearnedIndex(
    [
      opp({ id: "M1", adId: "101", attributionUrl: "https://fb.me/MIX" }),
      opp({ id: "M2", adId: "8888", attributionUrl: "https://fb.me/MIX" }),
      opp({ id: "M3", adId: "8888", attributionUrl: "https://fb.me/AJENA" }),
    ],
    index
  );
  assert.deepEqual([...learnedMix.byUrl.get("https://fb.me/MIX")!.ads], ["101"]);
  assert.deepEqual([...learnedMix.byUrl.get("https://fb.me/MIX")!.foreign], ["8888"], "la URL vio un ad id que no es nuestro");
  assert.deepEqual([...learnedMix.byUrl.get("https://fb.me/AJENA")!.foreign], ["8888"]);

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
  assert.deepEqual(
    classifyLead(opp({ id: "3d", attributionUrl: "https://fb.me/MIX" }), { ...ctx, learned: learnedMix }),
    { kind: "noAdId" }, "una URL que también usó un anuncio ajeno no identifica nada"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "3e", adId: "9999", attributionUrl: "https://fb.me/DOS" }), ctx),
    { kind: "unknownAd", adId: "9999" }, "con un ad id propio que Meta no conoce, la URL ya no opina: es un anuncio de otra cuenta"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "3f", adId: "9999", customFieldsResolved: { "Nombre Pauta": "PALMYRA | MAYO | PERFILES" } }), ctx),
    { kind: "unknownAd", adId: "9999" }, "ídem para el nombre"
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


  // --- la agregación de la tarjeta, agosto, GENERAL (todas las cuentas)
  const contactsWithCita = new Set<string>(["c-8"]);
  const cohort = [
    opp({ id: "1", adId: "101", attributionUrl: "https://fb.me/UNO" }),                // ad 101, recibido; entró por la URL UNO
    opp({ id: "2", adId: "101", stage: "05. Visita al Desarrollo" }),                  // visita
    opp({ id: "3", adId: "101", stage: "08. Venta", status: "won" }),                  // venta
    opp({ id: "4", adId: "102", stage: "04. Cita Programada", status: "lost" }),       // cita (perdida)
    opp({ id: "5", attributionUrl: "https://fb.me/UNO" }),                             // campaña c1 por URL, sin anuncio
    opp({ id: "6", adId: "201" }),                                                     // ad 201 (c2)
    opp({ id: "7", adId: "777" }),                                                     // anuncio borrado, campaña c1
    opp({ id: "8", source: "Pauta Formulario", contactId: "c-8" }),                    // de pauta sin llave, con cita en el objeto Citas
    opp({ id: "9", adId: "9999" }),                                                    // ad no conectado
    opp({ id: "r", source: "Referido" }),                                              // no es pauta
    opp({ id: "csv", attributionMedium: "csv_import", adId: "101" }),                  // importado
  ];
  const range = { start: "2026-08-01", end: "2026-08-31" };
  const inv = buildPautaInvestment({ opportunities: cohort, daily: meta.daily, range, ctx, contactsWithCita, accountIds: null });
  assert.equal(inv.mixedCurrency, true, "act_2 es USD");
  assert.equal(inv.currency, "");
  // gasto de agosto: 101 (100+100) + 201 (50) + 301 (30) + 401 (40) + 777 (70) = 390; el 999 de septiembre queda fuera
  assert.equal(inv.kpi.spend, 390);
  assert.equal(inv.kpi.impressions, 3900);
  assert.equal(inv.kpi.leadsMeta, 4 + 2 + 1 + 0 + 1 + 1, "form + msg de las filas de agosto");
  assert.equal(inv.kpi.leadsCrm, 7, "1,2,3,4 (101/102) + 5 (c1 por URL) + 6 (201) + 7 (777)");
  assert.equal(inv.kpi.citas, 3, "2 (05), 3 (venta), 4 (04) — la 8 no está atada a nada");
  assert.equal(inv.kpi.visitas, 2, "2 y 3");
  assert.equal(inv.kpi.ventas, 1);
  assert.equal(inv.kpi.cpl, null, "moneda mixta: sin costos consolidados");
  assert.deepEqual(inv.kpi.oppIds.ventas, ["3"]);
  assert.equal(inv.noAdId.count, 1); assert.deepEqual(inv.noAdId.oppIds, ["8"]);
  assert.equal(inv.unknownAd.count, 1); assert.deepEqual(inv.unknownAd.oppIds, ["9"]);
  assert.equal(inv.otherAccount.count, 0, "en GENERAL no hay 'otra cuenta'");
  assert.equal(inv.notPauta, 2);
  assert.deepEqual(inv.via, { adId: 6, campaignId: 0, url: 1, post: 0, name: 0 });
  assert.equal(inv.unlinkedSpend, 0, "el borrado 777 sí tiene campaña aprendida");

  // filas por gasto desc: c1 (270 = 200 + 70 del borrado), c2 (50), c4 (40), c3 (30)
  assert.deepEqual(inv.campaigns.map((c) => c.campaignId), ["c1", "c2", "c4", "c3"]);
  const rc1 = inv.campaigns[0];
  assert.equal(rc1.name, "IW - Cañadas - Agosto");
  assert.equal(rc1.accountName, "Uno");
  assert.equal(rc1.metrics.spend, 270);
  assert.equal(rc1.metrics.leadsCrm, 6, "1,2,3,4,7 por anuncio + 5 por campaña");
  assert.equal(rc1.campaignOnlyLeads, 1, "la 5");
  assert.equal(rc1.metrics.cpl, 270 / 6, "una campaña vive en UNA cuenta: su costo sí existe aunque el KPI global esté mixto");
  assert.equal(rc1.metrics.costPerVenta, 270);
  assert.equal(rc1.metrics.cpm, (270 / 2700) * 1000);
  assert.deepEqual(rc1.ads.map((a) => a.adId), ["101", "777", "102"], "anuncios por gasto desc; 102 sin gasto al final");
  assert.equal(rc1.ads[0].metrics.leadsCrm, 3);
  assert.deepEqual(rc1.ads[0].urls, ["https://fb.me/UNO"], "URLs con las que entraron los leads de ese anuncio");
  assert.equal(rc1.ads[1].deleted, true);
  assert.equal(rc1.ads[1].name, ANUNCIO_ELIMINADO);
  assert.equal(rc1.ads[1].metrics.leadsCrm, 1);
  assert.equal(rc1.ads[2].metrics.spend, 0);
  assert.equal(rc1.ads[2].metrics.leadsCrm, 1, "la 4");
  assert.equal(rc1.ads[2].metrics.cpl, null, "sin gasto no hay CPL, ni cero");
  const rc3 = inv.campaigns[3];
  assert.equal(rc3.metrics.leadsCrm, 0);
  assert.equal(rc3.metrics.cpl, null, "gasto sin leads: null, la UI lo pinta en rojizo");
  assert.equal(inv.campaigns.some((c) => c.missing), false);

  // --- una sola moneda y una sola cuenta (pestaña Cañadas = act_1): costos sí, y "otra cuenta" al pie
  const invCan = buildPautaInvestment({
    opportunities: cohort,
    daily: meta.daily.filter((d) => d.accountId === "act_1"),
    range, ctx, contactsWithCita,
    accountIds: new Set(["act_1"]),
  });
  assert.equal(invCan.mixedCurrency, false);
  assert.equal(invCan.currency, "MXN");
  assert.equal(invCan.kpi.spend, 320, "101 + 201 + 777");
  assert.equal(invCan.kpi.leadsCrm, 7, "todas son de act_1 (c1, c2)");
  assert.equal(invCan.kpi.cpl, 320 / 7);
  assert.equal(invCan.kpi.costPerVenta, 320);
  assert.equal(invCan.otherAccount.count, 0);
  const invPal = buildPautaInvestment({
    opportunities: cohort,
    daily: meta.daily.filter((d) => d.accountId === "act_3"),
    range, ctx, contactsWithCita,
    accountIds: new Set(["act_3"]),
  });
  assert.equal(invPal.kpi.spend, 40);
  assert.equal(invPal.kpi.leadsCrm, 0, "ningún lead de la cohorte es de un anuncio de act_3");
  assert.equal(invPal.otherAccount.count, 7, "los 7 atados a c1/c2 son de otra cuenta");
  assert.deepEqual(invPal.campaigns.map((c) => c.campaignId), ["c4"]);
  assert.equal(invPal.kpi.cpl, null);

  // --- un anuncio borrado SIN campaña aprendida cae en "Sin campaña", al final y marcado
  const orphanDaily = [...meta.daily, { adId: "888", accountId: "act_1", date: "2026-08-05", spend: 5, impressions: 50, clicks: 1, linkClicks: 1, leadsForm: 0, leadsMsg: 0 }];
  const invOrphan = buildPautaInvestment({ opportunities: [], daily: orphanDaily, range, ctx, contactsWithCita, accountIds: null });
  const last = invOrphan.campaigns[invOrphan.campaigns.length - 1];
  assert.equal(last.campaignId, "");
  assert.equal(last.name, SIN_CAMPANA);
  assert.equal(last.missing, true);
  assert.equal(last.metrics.spend, 5);
  assert.equal(invOrphan.unlinkedSpend, 5);
  assert.deepEqual(last.ads.map((a) => a.adId), ["888"]);

  // --- sin rango = toda la ventana
  const invAll = buildPautaInvestment({ opportunities: cohort, daily: meta.daily, range: null, ctx, contactsWithCita, accountIds: null });
  assert.equal(invAll.kpi.spend, 390 + 999);

  // --- nivel "post": la URL del post que promueve el creative (2026-09-29)
  // Leads de "Mensaje WhatsApp" que Make registró sin ad id pero con la URL del
  // post. El creative de cada anuncio dice qué post promueve.
  const metaPost: MetaAdsData = {
    ...meta,
    ads: [
      ...meta.ads.map((a) => (a.id === "101" ? { ...a, igCode: "DT_CGR" } : a.id === "201" ? { ...a, storyId: "900_1" } : a)),
      { id: "103", name: "Otro", adsetId: "s1", storyId: "900_2" }, // post compartido por 103 y 104, misma campaña
      { id: "104", name: "Otro", adsetId: "s1", storyId: "900_2" },
      { id: "303", name: "X", adsetId: "s3", igCode: "MULTI" },   // post en dos campañas → no identifica nada
      { id: "304", name: "X", adsetId: "s2", igCode: "MULTI" },
    ],
    shortLinks: { "https://fb.me/POST1": "900_1", "https://fb.me/POST2": "900_2", "https://fb.me/MULT": "900_9" },
  };
  const postCtx: AttributionContext = { ...ctx, index: buildMetaIndex(metaPost), learned: undefined };
  assert.equal(postKeyOf("https://www.instagram.com/p/DT_CGR", postCtx.index.shortLinks), "ig:DT_CGR");
  assert.equal(postKeyOf("https://fb.me/POST1", postCtx.index.shortLinks), "fb:900_1");
  assert.equal(postKeyOf("https://fb.me/SINRESOLVER", postCtx.index.shortLinks), null);
  assert.deepEqual(
    classifyLead(opp({ id: "pi", source: "direct", contactId: "c-11", attributions: [{ isFirst: true, url: "https://www.instagram.com/p/DT_CGR/" }] }), postCtx),
    { kind: "ad", adId: "101", campaignId: "c1", via: "post" }, "Instagram: shortcode del permalink del creative"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "pf", attributions: [{ isFirst: true, url: "https://fb.me/POST1" }] }), postCtx),
    { kind: "ad", adId: "201", campaignId: "c2", via: "post" }, "fb.me resuelto al storyId del creative"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "pc", attributions: [{ isFirst: true, url: "https://fb.me/POST2" }] }), postCtx),
    { kind: "campaign", campaignId: "c1", via: "post" }, "post de dos anuncios de una campaña → campaña"
  );
  assert.equal(
    classifyLead(opp({ id: "pm", attributions: [{ isFirst: true, url: "https://www.instagram.com/p/MULTI/" }] }), postCtx).kind,
    "noAdId", "post de dos campañas no identifica nada"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "pa", adId: "9999", attributions: [{ isFirst: true, url: "https://fb.me/POST1" }] }), postCtx),
    { kind: "unknownAd", adId: "9999" }, "con un ad id ajeno el post ya no opina"
  );
  assert.deepEqual(
    classifyLead(opp({ id: "pl", attributions: [{ isFirst: true, url: "https://fb.me/DOS" }] }), { ...postCtx, learned }),
    { kind: "ad", adId: "201", campaignId: "c2", via: "url" }, "la URL aprendida sigue antes que el post"
  );
  assert.deepEqual(
    shortLinksToResolve([
      opp({ id: "s1", attributions: [{ isFirst: true, url: "https://fb.me/B" }, { isLast: true, url: "https://www.instagram.com/p/X/" }] }),
      opp({ id: "s2", attributionUrl: "https://fb.me/A" }),
      opp({ id: "s3", adId: "101", attributionUrl: "https://fb.me/CONID" }),
      opp({ id: "s4", attributionMedium: "csv_import", attributionUrl: "https://fb.me/CSV" }),
    ]),
    ["https://fb.me/A", "https://fb.me/B"], "solo fb.me de leads sin ad id y no importados"
  );

  // --- la agencia de un anuncio: nomenclatura V1 (CAN-DOM-WSP-C3-A7) en la campaña, luego el adset, luego el anuncio
  assert.equal(agenciaOfAd(ctx, "501"), "Genicrea", "SAG - GEN - WSP - C1: el código va detrás del desarrollo");
  assert.equal(agenciaOfAd(ctx, "601"), "Inhouse", "la campaña no dice agencia pero el adset sí");
  assert.equal(agenciaOfAd(ctx, "101"), null, "\"IW - Cañadas - Agosto\" / \"Cañadas by El Mirador\": ninguna agencia");
  assert.equal(agenciaOfAd(ctx, "777"), null, "borrado: su campaña aprendida (c1) tampoco dice agencia");
  assert.equal(agenciaOfAd(ctx, "9999"), null);
  assert.equal(campaignNameOfAd(ctx, "501"), "SAG - GEN - WSP  - C1");
  assert.equal(campaignNameOfAd(ctx, "777"), "IW - Cañadas - Agosto", "borrado: por la campaña aprendida");
  assert.equal(campaignNameOfAd(ctx, "9999"), null);
  const agByOpp = buildMetaAgenciaByOpp(
    [
      opp({ id: "g1", adId: "501" }),
      opp({ id: "g2", adId: "601" }),
      opp({ id: "g3", adId: "101" }),
      opp({ id: "g4", customFieldsResolved: { "Nombre Pauta": "SAG - GEN - WSP  - C1" } }),   // nivel nombre: campaña → su agencia
      opp({ id: "g5", source: "Referido" }),
      opp({ id: "g6", adId: "501", attributionMedium: "csv_import" }),
    ],
    ctx
  );
  assert.deepEqual([...agByOpp], [["g1", "Genicrea"], ["g2", "Inhouse"], ["g4", "Genicrea"]], "solo las que llegan a un anuncio o campaña de Meta con agencia");

  // --- el contexto que page.tsx arma una vez y baja a las siete pestañas
  const panelCtx = buildMetaPanelContext({ meta, allOpportunities: opps, contacts: [], pautas, pipelines });
  assert.equal(panelCtx.index.byAd.size, index.byAd.size);
  assert.equal(panelCtx.desarrolloByAd.get("401"), "Palmyra");
  assert.equal(panelCtx.accountToPipeline.get("act_3"), "Palmyra");
  assert.equal(panelCtx.ctx.learned?.byUrl.size, 0, "opps sin URL no enseñan nada");
  assert.deepEqual(classifyLead(opp({ id: "z", adId: "101" }), panelCtx.ctx), { kind: "ad", adId: "101", campaignId: "c1", via: "adId" });

  console.log("✅ verify:meta-attribution OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
