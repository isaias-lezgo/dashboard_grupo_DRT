// lib/sync-slim.ts
// Lo que NO viaja al navegador. El payload del dashboard pesaba 68 MB de JSON
// (medido 2026-09-29) y ~20 MB eran campos que nadie lee: `relations` y
// `customFields` crudos (el panel usa `customFieldsResolved`), el contacto
// embebido en la oportunidad (ya viaja en `contacts`), cursores y duplicados
// internos de GHL. El stream va comprimido (br) así que el ahorro en red es
// menor, pero el navegador parsea todo el JSON en cada carga y la fila de Neon
// lo guarda entero. Puro: lo prueba pnpm verify:slim.
//
// Regla: se quita SOLO lo que ningún consumidor lee. Antes de agregar una llave
// aquí, grep en lib/ components/ app/ y en las herramientas del asistente
// (lib/ai-tools.ts lista los campos que expone de cada entidad).
import type { Contact, Opportunity } from "./types";

/** Llaves de `attributions[]` que lee alguien: lib/meta-attribution (cadena), lib/agencia, lib/sync (transform). */
const ATTRIBUTION_KEYS = new Set([
  "isFirst",
  "isLast",
  "utmAdId",
  "adId",
  "url",
  "adName",
  "utmCampaign",
  "utmCampaignId",
  "utmSource",
  "utmMedium",
  "utmContent",
  "utmSessionSource",
  "medium",
  "adSource",
]);

const OPPORTUNITY_DROP = [
  "relations",
  "customFields",
  "contact",
  "pipelineStageUId",
  "sort",
  "followers",
  "indexVersion",
  "forecastExpectedCloseDate",
  "forecastOriginalCloseDate",
  "forecastSlippageCount",
  "forecastDaysSlipped",
];

const CONTACT_DROP = [
  "customFields",
  "firstNameLowerCase",
  "lastNameLowerCase",
  "fullNameLowerCase",
  "emailLowerCase",
  "firstNameRaw",
  "lastNameRaw",
  "contactName",
  "followers",
  "startAfter",
  "additionalEmails",
  "profilePhoto",
  "dndSettings",
];

export function slimAttributions(
  attributions: Array<Record<string, unknown>> | undefined
): Array<Record<string, unknown>> | undefined {
  if (!attributions) return undefined;
  return attributions.map((a) => {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(a)) if (ATTRIBUTION_KEYS.has(k)) out[k] = a[k];
    return out;
  });
}

function without<T extends object>(obj: T, drop: string[]): T {
  const out = { ...(obj as Record<string, unknown>) };
  for (const k of drop) delete out[k];
  return out as T;
}

export function slimOpportunity(opp: Opportunity): Opportunity {
  const out = without(opp, OPPORTUNITY_DROP);
  if (opp.attributions) out.attributions = slimAttributions(opp.attributions as Array<Record<string, unknown>>);
  return out;
}

export function slimContact(contact: Contact): Contact {
  const out = without(contact, CONTACT_DROP);
  if (contact.attributions) out.attributions = slimAttributions(contact.attributions as Array<Record<string, unknown>>);
  return out;
}
