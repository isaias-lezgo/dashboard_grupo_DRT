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
- **10,000-row ceiling on search endpoints, and two different escapes.**
  `/opportunities/search` returns `400 SEARCH_USE_START_AFTER_PAGINATION` past row 10,000
  and offers `startAfter`/`startAfterId` — `getAllOpportunities` walks it by cursor.
  `/objects/:key/records/search` has the **same ceiling** (`page × pageLimit ≤ 10,000`,
  any page size) but returns a bare `400 Invalid request body` and accepts **no cursor**
  (`searchAfter` is rejected). The only way past is a `filters` entry
  `{field:"createdAt", operator:"range", value:{gte?, lt?}}` (ISO strings; `lt`/`gte` as
  *operators* are rejected for dates) — `getAllCustomObjectRecords` bisects the time
  window with `bisectFanOut` until every window fits. Measured 2026-09-13 on DRT: 10,095
  pautas, page 101 rejected deterministically.
