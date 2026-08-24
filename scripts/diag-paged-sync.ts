// Throwaway diagnostic: drive the three paginated walks against a real
// sub-account and report completeness. This is what reveals WHICH page fails
// and why — the log line that has never existed until now.
//
// Run: pnpm tsx scripts/diag-paged-sync.ts [substring-of-client-name]
import { withClient } from "@/lib/ghl-context"
import { getClients } from "@/lib/clients"
import { getAllContacts, getAllOpportunities } from "@/lib/ghl-client"

async function main() {
  const needle = (process.argv[2] || "").toLowerCase()
  const clients = getClients()
  const client = needle
    ? clients.find((c) => c.name.toLowerCase().includes(needle))
    : clients[0]
  if (!client) {
    throw new Error(
      `No client matched "${needle}". Roster: ${clients.map((c) => c.name).join(", ")}`
    )
  }

  console.log(`Sub-account: ${client.name} (${client.locationId})\n`)

  await withClient(client, async () => {
    const t0 = Date.now()
    const opps = await getAllOpportunities()
    console.log(
      `opportunities: ${opps.records.length} of ${opps.total ?? "?"} ` +
        `| missingPages=[${opps.missingPages.join(", ")}] ` +
        `| est. lost=${opps.missingEstimate} ` +
        `| ${((Date.now() - t0) / 1000).toFixed(1)}s`
    )

    const t1 = Date.now()
    const contacts = await getAllContacts()
    console.log(
      `contacts:      ${contacts.records.length} of ${contacts.total ?? "?"} ` +
        `| missingPages=[${contacts.missingPages.join(", ")}] ` +
        `| est. lost=${contacts.missingEstimate} ` +
        `| ${((Date.now() - t1) / 1000).toFixed(1)}s`
    )
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
