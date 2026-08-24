// scripts/add-client.ts — add a client to the DASHBOARD_CLIENTS roster.
//
// Interactive:     npm run add-client
// Non-interactive: npm run add-client -- --name "Plaza Bosques" --location loc-b --token pit-b
//                  (optional: --id plaza-bosques, --password s3cret)
//
// Reuses the app's own parseClients() validator, so this can never emit a roster
// the app would reject at startup. It prints the blob; you paste it into Vercel.
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv } from "node:process";
import { parseClients, type ClientConfig } from "../lib/clients";

function slugify(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // strip accents: "Yconia Café" → "yconia-cafe"
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function flag(name: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(`\n❌ ${message}\n`);
  process.exit(1);
}

async function collect(): Promise<Omit<ClientConfig, "id"> & { id?: string }> {
  // Non-interactive when --name is passed; otherwise prompt.
  const flagName = flag("name");
  if (flagName) {
    const locationId = flag("location");
    const ghlToken = flag("token");
    if (!locationId || !ghlToken) {
      fail("Non-interactive mode requires --name, --location and --token.");
    }
    const password = flag("password");
    return {
      id: flag("id"),
      name: flagName,
      locationId,
      ghlToken,
      ...(password ? { password } : {}),
    };
  }

  const rl = createInterface({ input: stdin, output: stdout });
  async function ask(question: string): Promise<string> {
    for (;;) {
      const answer = (await rl.question(question)).trim();
      if (answer) return answer;
      console.log("  ↳ required.");
    }
  }
  try {
    const name = await ask("Client name (e.g. Plaza Bosques): ");
    const suggestedId = slugify(name);
    const id = (await rl.question(`Client id [${suggestedId}]: `)).trim() || suggestedId;
    const locationId = await ask("GHL location id: ");
    const ghlToken = await ask("GHL Private Integration Token (pit-...): ");
    const password = (await rl.question("Password [blank = use the location id]: ")).trim();
    return { id, name, locationId, ghlToken, ...(password ? { password } : {}) };
  } finally {
    rl.close();
  }
}

async function main() {
  // Start from the current roster if one is present, otherwise from empty.
  const existingRaw = process.env.DASHBOARD_CLIENTS;
  let clients: ClientConfig[] = [];
  if (existingRaw) {
    try {
      clients = parseClients(existingRaw);
      console.log(`\nCurrent roster (${clients.length}): ${clients.map((c) => c.id).join(", ")}\n`);
    } catch (err) {
      fail(
        `DASHBOARD_CLIENTS is currently INVALID: ${err instanceof Error ? err.message : err}\n` +
          "Fix it before adding a client, or the whole roster stays broken.",
      );
    }
  } else {
    console.log("\nNo DASHBOARD_CLIENTS in this environment — starting a new roster.\n");
  }

  const input = await collect();
  const next: ClientConfig = {
    ...input,
    id: input.id || slugify(input.name),
  };

  const blob = JSON.stringify([...clients, next]);

  // Validate the RESULT, not just the input — this is what catches duplicate ids
  // and password collisions with clients already in the roster.
  try {
    parseClients(blob);
  } catch (err) {
    fail(`Rejected: ${err instanceof Error ? err.message : err}`);
  }

  console.log("\n✅ Valid. Set DASHBOARD_CLIENTS to:\n");
  console.log(blob);
  console.log(
    "\nPaste that into Vercel → Settings → Environment Variables → DASHBOARD_CLIENTS," +
      `\nthen redeploy. ${next.name} logs in with: ${next.password ?? next.locationId}\n`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
