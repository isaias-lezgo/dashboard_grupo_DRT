---
name: ghl-api
description: GoHighLevel REST API gotchas for this repo — customFields read-vs-write shapes, DATE fields as epoch-ms at UTC midnight, snake_case on /opportunities/search, tag overwrite behavior, opportunity status values, conversation type codes, required scopes. Use when touching lib/ghl-client.ts, app/api/dashboard/route.ts, lib/ghl-fetchers.ts, or any code that reads or writes GHL data.
---

# GHL API Gotchas

> Full schema reference: `/Users/isaiasrios/Downloads/GHL-API-Schemas.md`

- **Version header required** on all requests: `Version: 2021-07-28` (legacy) or `2023-02-21` (current).
- **customFields shape differs between read and write**:
  - Write (create/update): `{ id, key, field_value }`
  - Read (contacts): `{ id, value }`
  - Read (opportunities): `{ id, fieldValue }`
- **DATE custom fields use `fieldValueDate`** — an epoch in **milliseconds at UTC
  midnight**, not `fieldValue`/`fieldValueString`/`value`. `resolveCustomFields()` in
  `app/api/dashboard/route.ts` normalizes it to ISO so `customFieldsResolved` stays
  string-valued. Bucket such dates with **UTC** getters: read in `America/Mexico_City`, a
  close on the 1st at 00:00Z lands in the previous month.
- **Tags on contacts**: sending `tags` in update/upsert **overwrites all existing tags**. Use `/contacts/:id/tags` (POST/DELETE) for incremental changes.
- **Opportunity status** valid values: `open`, `won`, `lost`, `abandoned`, `all` (`all` is search-filter only).
- **`lostReasonId`** is only relevant when status is `"lost"`.
- **`/opportunities/search`** uses snake_case params (`location_id`, `pipeline_id`, etc.) — already handled by `useSnakeCaseLocationId` flag in `ghlFetch`.
- **Conversation `type`** is numeric in some endpoints: `1=Phone`, `2=Email`, `3=FB Messenger`, `4=Review`, `5=Group SMS`.
- **Required scopes**: `contacts.readonly/write`, `opportunities.readonly/write`, `conversations.readonly/write`.
