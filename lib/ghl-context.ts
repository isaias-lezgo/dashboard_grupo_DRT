// lib/ghl-context.ts
// Request-scoped GHL credentials.
//
// ghlFetch is the single funnel for every GHL call, but it sits several layers
// below the route handler that knows WHICH client is asking, with ~113 exported
// functions in between. AsyncLocalStorage carries the client down that call chain
// without changing a single one of those signatures. Concurrent requests for
// different clients on the same instance get independent stores.
//
// NEVER replace this with a module-level "current client" variable: one instance
// serves overlapping requests, so that would silently serve client A's dashboard
// using client B's token.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ClientConfig } from "./clients";

const ctx = new AsyncLocalStorage<ClientConfig>();

export function withClient<T>(client: ClientConfig, fn: () => T): T {
  return ctx.run(client, fn);
}

// Fails closed. There is deliberately no fallback to process.env or a default
// client — serving the wrong tenant's data is far worse than a 500.
export function currentClient(): ClientConfig {
  const client = ctx.getStore();
  if (!client) {
    throw new Error(
      "No GHL client context — ghlFetch() was called outside withClient(). " +
        "Wrap the route's GHL work in withClient(client, ...).",
    );
  }
  return client;
}
