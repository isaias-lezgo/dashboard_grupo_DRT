import { withClient } from "@/lib/ghl-context"
import { getClients } from "@/lib/clients"
import { getCustomObjects, getAllCustomObjectRecords, getContacts } from "@/lib/ghl-client"

async function main() {
  const client = getClients().find((c) => c.name.toLowerCase().includes("grand"))
  if (!client) throw new Error("Grand Center client not found in roster")

  await withClient(client, async () => {
    const schemas = await getCustomObjects()
    const stub = schemas.objects.find(
      (s) =>
        s.labels.singular.toLowerCase().includes("pauta") ||
        s.labels.plural.toLowerCase().includes("pautas")
    )
    if (!stub) throw new Error("Pautas schema not found")

    const { records } = await getAllCustomObjectRecords(stub.key)
    console.log(`Total pauta records: ${records.length}`)

    const noContactRel = records.filter(
      (r) => !r.relations?.some((rel) => rel.objectKey === "contact")
    )
    console.log(`\nRecords WITHOUT a "contact" relation: ${noContactRel.length}`)
    for (const r of noContactRel) {
      console.log(JSON.stringify({
        id: r.id,
        tipo: r.properties["tipo"],
        nombre_pauta: r.properties["nombre_pauta"],
        createdAt: r.createdAt,
        relations: r.relations ?? null,
      }, null, 2))
    }

    // For records that DO have a contact relation, check whether that contact id
    // would resolve against the fetched contacts (the "deleted contact" case).
    const contactIds = new Set<string>()
    for (const r of records) {
      const rel = r.relations?.find((x) => x.objectKey === "contact")
      if (rel?.recordId) contactIds.add(rel.recordId)
    }
    console.log(`\nDistinct related contact ids across all pautas: ${contactIds.size}`)
  })
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
