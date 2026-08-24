# AI Assistant — Clarifying Questions with Multiple-Choice GUI

**Date:** 2026-06-15
**Status:** Approved (design)

## Problem

The AI assistant (Conversations tab) answers questions against the full GHL
dataset using a client-driven agent loop. Several common user terms map to
**distinct data paths** that produce materially different answers, but the
assistant currently never asks — the system prompt only tells it to *assume and
disclaim*. Example: "pautas" can mean the **Pauta custom object**
(`search_pautas` / `get_pauta`) or the **ad the lead came from**
(`adId` / `attributionUrl` / `campaign` attribution). Guessing wrong wastes
tokens and erodes trust.

We want the assistant to ask a clarifying question **when, and only when,** a
request is genuinely ambiguous between distinct paths — guiding the user and
saving tokens — without nagging on every message. Multiple-choice questions get
a GUI (buttons/chips); free-text clarifications already work today (the model
just ends its turn with a question and the normal input box handles the reply).

## Goals

- Add an `ask_user` tool the model calls to pose a **multiple-choice** question.
- Pause the agent loop until the user answers, then resume with the answer fed
  back as the tool's result.
- Render an inline GUI for the question: single-select buttons or multi-select
  chips + confirm.
- Keep a free-text escape: the user can always type a reply instead of clicking.
- Encode prompt guidance for **when** to ask and **which** terms are ambiguous,
  with a strong bias toward sensible defaults over interrogation.

## Non-Goals

- Persisting answers across `reset()` / chat restarts.
- Analytics / logging of questions asked.
- A separate tool for free-text-only questions (the model already does these by
  ending its turn with a plain question — no code needed).
- Changing the server `/api/chat` turn contract.

## Architecture Context

```
conversations-chat.tsx  (renders messages, owns panel + chart drill state)
    ↓ useAgentLoop({ datasetSummary, dataset, onToolExecuted })
hooks/use-agent-loop.ts  (client agent loop: POST /api/chat → exec tool_use →
                          POST tool_result → repeat until no tool_use)
    ↓
lib/ai-tools.ts  (TOOL_DEFINITIONS schemas + executeTool executor;
                  render_chart / show_in_panel are UI-only "ack" tools)
lib/ai-context.ts  (ASSISTANT_SYSTEM_PROMPT + buildDatasetSummary)
app/api/chat/route.ts  (one Anthropic turn per request, returns content blocks)
```

The existing `render_chart` / `show_in_panel` pattern — a tool whose executor
returns only an ack while the real behavior happens client-side — is the model
to follow for `ask_user`.

## Design

### 1. `ask_user` tool definition (`lib/ai-tools.ts`)

Add to `TOOL_DEFINITIONS`:

- `question` (string, required) — the question, in Spanish.
- `options` (array, required) — each `{ label: string, value?: string,
  hint?: string }`. `label` is shown on the button; `value` (defaults to
  `label`) is what's reported back; `hint` is an optional one-line subtitle.
- `multiSelect` (boolean, optional, default false) — when true, render toggle
  chips + a "Confirmar" button; the result reports all chosen values.
- `context` (string, optional) — a one-line "por qué pregunto" shown under the
  question.

The loop intercepts `ask_user` before the executor, so `executeTool` is never
reached for it in practice. For safety, add an ack branch in `executeTool`
(mirroring `show_in_panel`) returning `{ ok: true }` so an unexpected execution
path still yields a valid `tool_result`.

### 2. Pause / resume in the agent loop (`hooks/use-agent-loop.ts`)

New state and refs:

- `pendingQuestion: PendingQuestion | null` — `{ toolUseId, question, options,
  multiSelect, context }`, exposed from the hook.
- An internal stash (ref) holding the sibling `tool_result`s computed in the
  same batch as the `ask_user` call, plus the current `convo`, so resume can
  rebuild a valid user message.

Loop changes inside `runWithMessages`:

- After computing `toolUses`, check for an `ask_user` block.
- If present: execute every **non-`ask_user`** tool in the batch as today and
  collect their `tool_result`s. Do **not** POST. Stash `{ partialResults, convo,
  askToolUseId }`, set `pendingQuestion`, set `busy=false`, `status=null`, and
  `return` (pause). (The model is instructed to call `ask_user` alone, but
  executing siblings keeps the message valid if it doesn't.)

New `answer(payload)` callback exposed from the hook:

- `payload`: either `{ values: string[] }` (button/chip selection) or
  `{ text: string }` (free-text escape).
- Builds the `ask_user` `tool_result` with content like
  `JSON.stringify({ answer: values })` or `{ answer: text, freeText: true }`.
- Merges it with the stashed `partialResults` into one `user` message, appends
  to the stashed `convo`, clears `pendingQuestion` + stash, and calls
  `runWithMessages` to resume.

Free-text escape in `send(text)`:

- If `pendingQuestion` is set, route the text through `answer({ text })` instead
  of starting a fresh user turn — this keeps the `ask_user` `tool_use` paired
  with its `tool_result` (required by the API) while still letting the user say
  something off-menu.

`reset()` also clears `pendingQuestion` and the stash.

### 3. Question GUI (`conversations-chat.tsx` + new `components/dashboard/chat-question.tsx`)

- New presentational `ChatQuestion` component: renders the question text, the
  optional `context` line, and the options.
  - Single-select: a column/grid of buttons; clicking one calls
    `onAnswer({ values: [value] })` immediately.
  - Multi-select: toggleable chips with selected styling, plus a "Confirmar"
    button (disabled until ≥1 selected) that calls `onAnswer({ values })`.
- `conversations-chat.tsx` consumes `pendingQuestion` + `answer` from the hook
  and renders `ChatQuestion` **inline at the bottom of the message stream**
  (after `messages.map`, before the busy indicator). The normal input box stays
  enabled the whole time as the free-text escape.
- Styling matches the existing suggestion cards / tool chips (border, muted bg,
  primary accents) so it reads as native chat UI.

### 4. Prompt guidance (`lib/ai-context.ts`)

Add a `# Cuándo preguntar (ask_user)` section to `ASSISTANT_SYSTEM_PROMPT`:

**The balance (when to ask):**

- Ask via `ask_user` **only** when a term maps to genuinely distinct data paths
  that would give materially different answers **and** the conversation/context
  doesn't already disambiguate.
- For mild ambiguity, pick the sensible default and state the assumption in one
  line — do **not** ask.
- Never ask more than one question before doing work; bundle into a single
  `ask_user`. Never ask if the user already specified the path. Don't ask for
  trivial or easily-recoverable ambiguity.
- Prefer doing useful work over interrogating; a question must save more than it
  costs.

**The four ambiguous triggers (each with the options to offer):**

1. **"Pautas"** → ask: the Pauta object (`search_pautas`/`get_pauta`) vs. the ad
   the lead came from (`adId`/`attributionUrl`/`campaign` attribution).
2. **Atribución / fuente / origen** (unspecified) → ask: lead-level
   (`contact.source/...`) vs. sale-level (`opportunity.source/...`).
3. **Campaña / anuncio** → ask (or default, per existing rule): native
   `campaign` (usually empty) vs. real ad identity in `adId`/`attributionUrl`.
4. **Periodo / fecha base** for things like "oportunidades de junio" → ask: the
   opportunity's `createdAt` vs. the contact's `createdAt` vs. `closedAt`.

The section cross-references the existing attribution rules (currently
"assume + disclaim") so the model knows the question path is preferred for these
high-ambiguity cases and the disclaim path remains the fallback for everything
else.

## Data Flow (question round-trip)

```
user asks ambiguous question
  → model emits ask_user tool_use (alone)
  → loop: no siblings to run; stash convo + ask id; set pendingQuestion; pause
  → ChatQuestion renders inline; input box still live
  → user clicks option  OR  types free text
  → answer({values|text}) builds ask_user tool_result, appends user msg, resumes
  → loop POSTs; model now has the answer and proceeds down the chosen path
```

## Testing

No automated tests in this project (per CLAUDE.md). Verify manually via the dev
server / build:

- Ask "dame las pautas de mayo" → question appears with the two paths; clicking
  each routes to the right tool (`search_pautas` vs. `aggregate` on `adId`).
- Multi-select question renders chips + Confirmar and reports all picks.
- Typing a free-text reply while a question is shown resolves it (no API error
  about an unmatched `tool_use`).
- An unambiguous query ("leads por plataforma") does **not** trigger a question.
- `Reiniciar` clears a pending question.
- `npm run build` passes.

## Risks / Notes

- **Unmatched `tool_use`:** the API rejects a `tool_use` without a matching
  `tool_result`. The free-text escape and the sibling-result stash both exist to
  guarantee pairing on resume.
- **Caching:** resume is append-only, so the rolling cache breakpoint in
  `/api/chat` keeps working unchanged.
- **Over-asking:** mitigated entirely by prompt guidance; if the model asks too
  often, tighten the "when to ask" wording rather than the code.
