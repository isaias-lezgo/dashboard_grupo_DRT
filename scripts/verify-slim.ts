// Verificación de lib/sync-slim.ts. Correr: pnpm verify:slim
//
// El payload del dashboard pesaba 68 MB de JSON (medido 2026-09-29) y ~20 MB
// eran campos que nadie lee: `relations` y `customFields` crudos, el contacto
// embebido en la oportunidad, cursores de paginación, duplicados en minúsculas.
// Un bug aquí es o un campo que el panel sí lee y desaparece (y un chart se
// queda en "Sin dato"), o un campo pesado que se cuela de vuelta.
//
// Envuelto en main() en vez de usar await de nivel superior: este paquete es CJS.
import assert from "node:assert/strict";
import { slimContact, slimOpportunity, slimAttributions } from "../lib/sync-slim";
import type { Contact, Opportunity } from "../lib/types";

async function main() {
  // --- attributions: solo las llaves que la atribución, el filtro de agencia y el asistente leen
  const attrs = [
    {
      isFirst: true, utmAdId: "1", url: "https://fb.me/x", pageUrl: "https://fb.me/x?fbclid=…",
      adName: "a1", utmCampaign: "C", utmCampaignId: "9", utmSource: "fb", utmMedium: "paid",
      utmContent: "v", utmSessionSource: "Paid Social", medium: "whatsapp", mediumId: "m1",
      adSource: "Facebook", isLast: false, gclid: "zzz",
    },
  ];
  assert.deepEqual(slimAttributions(attrs), [
    {
      isFirst: true, utmAdId: "1", url: "https://fb.me/x", adName: "a1", utmCampaign: "C",
      utmCampaignId: "9", utmSource: "fb", utmMedium: "paid", utmContent: "v",
      utmSessionSource: "Paid Social", medium: "whatsapp", adSource: "Facebook", isLast: false,
    },
  ], "pageUrl, mediumId y llaves desconocidas se van; las demás se quedan tal cual");
  assert.deepEqual(slimAttributions(undefined), undefined);
  assert.deepEqual(slimAttributions([{ medium: "manual" }]), [{ medium: "manual" }]);

  // --- oportunidad: se van los crudos y lo interno de GHL; se queda lo calculado
  const opp = {
    id: "o1", name: "Lead", pipelineId: "p", pipelineStageId: "s", status: "open", createdAt: "2026-08-01T00:00:00.000Z",
    contactId: "c1", value: 0, stage: "01. Recibido", pipelineName: "Cañadas",
    customFields: [{ id: "f1", value: "x" }],
    customFieldsResolved: { Pauta: "x" },
    attributions: [{ isFirst: true, utmAdId: "1", pageUrl: "p" }],
    contact: { id: "c1", name: "N" },
    relations: [{ objectKey: "contact", recordId: "c1" }],
    pipelineStageUId: "uid", sort: [1, 2], followers: ["u"], indexVersion: 3,
    lastStageChangeAt: "2026-08-02T00:00:00.000Z", assignedTo: "Asesor", tags: ["t"], monetaryValue: 10,
  } as unknown as Opportunity;
  const so = slimOpportunity(opp) as unknown as Record<string, unknown>;
  for (const gone of ["customFields", "contact", "relations", "pipelineStageUId", "sort", "followers", "indexVersion"]) {
    assert.equal(gone in so, false, `${gone} no viaja`);
  }
  for (const kept of ["id", "pipelineStageId", "customFieldsResolved", "lastStageChangeAt", "assignedTo", "tags", "monetaryValue", "stage", "pipelineName", "contactId"]) {
    assert.equal(kept in so, true, `${kept} se queda`);
  }
  assert.deepEqual(so.attributions, [{ isFirst: true, utmAdId: "1" }]);
  assert.notEqual(so, opp, "devuelve un objeto nuevo");
  assert.equal("customFields" in opp, true, "no muta el original");

  // --- contacto: ídem; los nombres en minúsculas y los crudos de GHL sobran
  const contact = {
    id: "c1", name: "Nombre", email: "a@b", phone: "+52", tags: [], dateAdded: "2026-08-01T00:00:00.000Z", createdAt: "2026-08-01T00:00:00.000Z",
    customFields: [{ id: "f1", value: "x" }], customFieldsResolved: { "Origen de lead": "Facebook" },
    attributions: [{ isLast: true, url: "https://fb.me/y", mediumId: "m" }],
    firstNameLowerCase: "nombre", lastNameLowerCase: "", fullNameLowerCase: "nombre", emailLowerCase: "a@b",
    firstNameRaw: "Nombre", lastNameRaw: "", contactName: "Nombre",
    followers: [], startAfter: 1, additionalEmails: [], profilePhoto: "", dndSettings: {},
    assignedTo: "Asesor", source: "Pauta WhatsApp", attributionMedium: "whatsapp", dateUpdated: "2026-08-02T00:00:00.000Z",
  } as unknown as Contact;
  const sc = slimContact(contact) as unknown as Record<string, unknown>;
  for (const gone of ["customFields", "firstNameLowerCase", "lastNameLowerCase", "fullNameLowerCase", "emailLowerCase", "firstNameRaw", "lastNameRaw", "contactName", "followers", "startAfter", "additionalEmails", "profilePhoto", "dndSettings"]) {
    assert.equal(gone in sc, false, `${gone} no viaja`);
  }
  for (const kept of ["id", "name", "email", "phone", "customFieldsResolved", "assignedTo", "source", "attributionMedium", "dateUpdated", "createdAt"]) {
    assert.equal(kept in sc, true, `${kept} se queda`);
  }
  assert.deepEqual(sc.attributions, [{ isLast: true, url: "https://fb.me/y" }]);

  console.log("✅ verify:slim OK");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
