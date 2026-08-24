# AI Clarifying Questions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the AI assistant pose a multiple-choice clarifying question (with an inline GUI) when a request is genuinely ambiguous between distinct data paths, pausing the agent loop until the user answers.

**Architecture:** Add an `ask_user` tool. The client agent loop intercepts it, pauses (instead of POSTing), and surfaces a `pendingQuestion`; an inline `ChatQuestion` GUI collects the answer (button click or free text), which is fed back as the tool's `tool_result` so the loop resumes down the chosen path. Prompt guidance governs *when* to ask.

**Tech Stack:** Next.js 15 (App Router), React, TypeScript, Anthropic SDK, Tailwind + shadcn/ui, lucide-react.

> **Testing note:** This project has no automated test harness, and `npm run build` ignores TypeScript errors (see `next.config.mjs`). The verification gate for each task is `npx tsc --noEmit` (real type check) plus the manual app checks called out per task. Run the app with `npm run dev` and open the **Asistente IA** tab for manual checks.

---

## File Structure

- **`lib/ai-tools.ts`** — add the `ask_user` entry to `TOOL_DEFINITIONS` (the schema Claude sees) and a safety ack branch in `executeTool`.
- **`hooks/use-agent-loop.ts`** — new `PendingQuestion`/`QuestionOption`/`AnswerPayload` types; pause-on-`ask_user` logic; `pendingQuestion` state; `answer()`; free-text escape in `send()`; clear on `reset()`; expose both from the hook.
- **`components/dashboard/chat-question.tsx`** — new presentational GUI: single-select buttons or multi-select chips + confirm.
- **`components/dashboard/conversations-chat.tsx`** — consume `pendingQuestion` + `answer`; render `ChatQuestion` inline in the message stream.
- **`lib/ai-context.ts`** — add the `# Cuándo preguntar (ask_user)` section to `ASSISTANT_SYSTEM_PROMPT`.

Build order: Task 1 (tool schema) → Task 2 (hook types + pause/resume) → Task 3 (GUI component) → Task 4 (wire into chat) → Task 5 (prompt) → Task 6 (end-to-end manual verification).

---

### Task 1: Add the `ask_user` tool

**Files:**
- Modify: `lib/ai-tools.ts` (insert into `TOOL_DEFINITIONS` before `] as const;` at line ~608; add a case in `executeTool` before `default:` at line ~881)

- [ ] **Step 1: Add the tool schema**

In `lib/ai-tools.ts`, find the end of the `create_pdf` definition:

```ts
      },
      required: ["title", "blocks"],
    },
  },
] as const;
```

Insert a new tool object between the `create_pdf` closing `},` and `] as const;`:

```ts
  {
    name: "ask_user",
    description:
      "Hace UNA pregunta de opción múltiple al usuario y PAUSA hasta que responda. Úsalo SOLO cuando un término sea genuinamente ambiguo entre rutas de datos distintas que darían respuestas materialmente diferentes y el contexto no lo aclare (ver la sección 'Cuándo preguntar' del prompt). Llama esta herramienta SOLA (sin otras herramientas en el mismo turno). NO la uses para ambigüedades triviales ni si el usuario ya especificó la ruta — en esos casos elige el valor por defecto y dilo en una línea.",
    input_schema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "La pregunta, en español, breve y concreta.",
        },
        context: {
          type: "string",
          description:
            "Opcional. Una sola línea de 'por qué pregunto' que se muestra bajo la pregunta para orientar al usuario.",
        },
        multiSelect: {
          type: "boolean",
          description:
            "Si es true, el usuario puede elegir varias opciones (chips + botón Confirmar). Default false (elige una sola).",
        },
        options: {
          type: "array",
          description: "Las opciones a mostrar. 2 a 4 idealmente.",
          items: {
            type: "object",
            properties: {
              label: { type: "string", description: "Texto del botón/chip (en español)." },
              value: {
                type: "string",
                description:
                  "Opcional. Valor que se te reporta de vuelta. Si se omite, se usa el label.",
              },
              hint: { type: "string", description: "Opcional. Subtítulo de una línea." },
            },
            required: ["label"],
          },
        },
      },
      required: ["question", "options"],
    },
  },
```

- [ ] **Step 2: Add a safety ack branch in `executeTool`**

Find the `render_chart` case and the `default:` that follow it:

```ts
      return { ok: true, points: series.length };
    }
    default:
      return { error: `Unknown tool: ${name}` };
```

Insert an `ask_user` case before `default:`:

```ts
      return { ok: true, points: series.length };
    }
    case "ask_user":
      // UI-only / loop-intercepted. The agent loop pauses on this tool and never
      // calls the executor in practice; this ack only exists so an unexpected
      // execution path still yields a valid tool_result.
      return { ok: true, pending: true };
    default:
      return { error: `Unknown tool: ${name}` };
```

- [ ] **Step 3: Type check**

Run: `npx tsc --noEmit`
Expected: no errors. (`ToolName` now includes `"ask_user"` via the `as const` inference.)

- [ ] **Step 4: Commit**

```bash
git add lib/ai-tools.ts
git commit -m "feat: add ask_user tool schema for clarifying questions"
```

---

### Task 2: Pause/resume in the agent loop

**Files:**
- Modify: `hooks/use-agent-loop.ts`

- [ ] **Step 1: Add the new exported types**

In `hooks/use-agent-loop.ts`, after the `UIMessage` interface (around line 46), add:

```ts
export interface QuestionOption {
  label: string;
  value?: string;
  hint?: string;
}
export interface PendingQuestion {
  toolUseId: string;
  question: string;
  options: QuestionOption[];
  multiSelect: boolean;
  context?: string;
}
export type AnswerPayload = { values: string[] } | { text: string };
```

- [ ] **Step 2: Extend the hook's return type**

In the `AgentLoopReturn` interface, add two members:

```ts
  pendingQuestion: PendingQuestion | null;
  answer: (payload: AnswerPayload) => void;
```

- [ ] **Step 3: Add state + a pause stash ref**

Inside `useAgentLoop`, after the existing `useState`/`useRef` declarations (after `const [totalTools, setTotalTools] = useState(0);` and the refs block), add:

```ts
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const pauseStashRef = useRef<{
    convo: UIMessage[];
    partialResults: ToolResultBlock[];
    askToolUseId: string;
  } | null>(null);
```

- [ ] **Step 4: Intercept `ask_user` in the loop**

In `runWithMessages`, locate this block:

```ts
          const toolResults: ToolResultBlock[] = await Promise.all(
            toolUses.map(async (tu): Promise<ToolResultBlock> => {
```

Replace `toolUses.map` on that line with `toRun.map`, and immediately ABOVE that `const toolResults` line insert:

```ts
          // A clarifying question pauses the loop. Run any sibling tools so their
          // results are ready for the resume, but hold the request until the user
          // answers (the model is told to call ask_user alone, so toRun is usually
          // empty here).
          const askUse = toolUses.find((b) => b.name === "ask_user");
          const toRun = askUse
            ? toolUses.filter((b) => b.name !== "ask_user")
            : toolUses;
```

So the line becomes:

```ts
          const toolResults: ToolResultBlock[] = await Promise.all(
            toRun.map(async (tu): Promise<ToolResultBlock> => {
```

- [ ] **Step 5: Pause after computing sibling results**

Immediately after the `await Promise.all([...])` block closes (the line `);` that ends `toolResults`), find:

```ts
          setTotalTools((n) => n + toolUses.length);

          convo = [...convo, { role: "user", blocks: toolResults }];
          setMessages(convo);
          messagesRef.current = convo;
```

Replace it with:

```ts
          setTotalTools((n) => n + toRun.length);

          if (askUse) {
            const aInput = askUse.input as Record<string, unknown>;
            const rawOptions = Array.isArray(aInput.options)
              ? (aInput.options as unknown[])
              : [];
            const options: QuestionOption[] = rawOptions
              .filter(
                (o): o is Record<string, unknown> =>
                  Boolean(o) && typeof o === "object",
              )
              .map((o) => ({
                label: String(o.label ?? ""),
                value: o.value !== undefined ? String(o.value) : undefined,
                hint: o.hint !== undefined ? String(o.hint) : undefined,
              }))
              .filter((o) => o.label);
            pauseStashRef.current = {
              convo,
              partialResults: toolResults,
              askToolUseId: askUse.id,
            };
            setPendingQuestion({
              toolUseId: askUse.id,
              question: String(aInput.question ?? ""),
              options,
              multiSelect: aInput.multiSelect === true,
              context:
                typeof aInput.context === "string" ? aInput.context : undefined,
            });
            setBusy(false);
            setStatus(null);
            return;
          }

          convo = [...convo, { role: "user", blocks: toolResults }];
          setMessages(convo);
          messagesRef.current = convo;
```

- [ ] **Step 6: Add the `answer` callback**

After `runWithMessages` is defined (after its closing `);`) and before `const send = useCallback(`, add:

```ts
  const answer = useCallback(
    (payload: AnswerPayload) => {
      const stash = pauseStashRef.current;
      if (!stash) return;

      const summary =
        "values" in payload ? payload.values.join(", ") : payload.text;
      const askResult: ToolResultBlock = {
        type: "tool_result",
        tool_use_id: stash.askToolUseId,
        content:
          "values" in payload
            ? JSON.stringify({ answer: payload.values })
            : JSON.stringify({ answer: payload.text, freeText: true }),
      };

      // The user message carries a visible text bubble (the chosen answer) plus
      // the tool_result blocks (sibling results + the ask_user answer) so every
      // prior tool_use stays paired with a tool_result on resume.
      const userMsg: UIMessage = {
        role: "user",
        blocks: [
          { type: "text", text: summary },
          ...stash.partialResults,
          askResult,
        ],
      };
      const resumed = [...stash.convo, userMsg];

      pauseStashRef.current = null;
      setPendingQuestion(null);
      setMessages(resumed);
      messagesRef.current = resumed;
      void runWithMessages(resumed);
    },
    [runWithMessages],
  );
```

- [ ] **Step 7: Add the free-text escape to `send`**

Replace the existing `send` callback with:

```ts
  const send = useCallback(
    (text: string) => {
      if (busy) return;
      // If a clarifying question is open, route the typed text as its answer so
      // the pending ask_user tool_use gets a matching tool_result.
      if (pauseStashRef.current) {
        answer({ text });
        return;
      }
      const userMsg: UIMessage = {
        role: "user",
        blocks: [{ type: "text", text }],
      };
      const next = [...messagesRef.current, userMsg];
      setMessages(next);
      messagesRef.current = next;
      void runWithMessages(next);
    },
    [busy, runWithMessages, answer]
  );
```

- [ ] **Step 8: Clear pending state on `reset`**

In the `reset` callback, add these two lines alongside the existing resets:

```ts
    setPendingQuestion(null);
    pauseStashRef.current = null;
```

- [ ] **Step 9: Expose the new members in the return object**

In the final `return { ... }` of the hook, add:

```ts
    pendingQuestion,
    answer,
```

- [ ] **Step 10: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 11: Commit**

```bash
git add hooks/use-agent-loop.ts
git commit -m "feat: pause agent loop on ask_user and resume with the answer"
```

---

### Task 3: The `ChatQuestion` GUI component

**Files:**
- Create: `components/dashboard/chat-question.tsx`

- [ ] **Step 1: Create the component**

Create `components/dashboard/chat-question.tsx`:

```tsx
"use client";

import { useState } from "react";
import { HelpCircle, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { PendingQuestion, AnswerPayload } from "@/hooks/use-agent-loop";

// Resolve the value reported back to the model for an option (falls back to the
// label when the model didn't set an explicit value).
function optValue(o: { label: string; value?: string }): string {
  return o.value && o.value.trim() ? o.value : o.label;
}

export function ChatQuestion({
  question,
  onAnswer,
}: {
  question: PendingQuestion;
  onAnswer: (payload: AnswerPayload) => void;
}) {
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const toggle = (value: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(value)) next.delete(value);
      else next.add(value);
      return next;
    });
  };

  return (
    <div className="w-full max-w-[85%] self-start rounded-2xl border border-primary/25 bg-primary/5 p-4">
      <div className="flex items-start gap-2.5">
        <span className="mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <HelpCircle className="h-3.5 w-3.5" />
        </span>
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm font-medium leading-snug text-foreground">
            {question.question}
          </p>
          {question.context && (
            <p className="text-[11px] leading-snug text-muted-foreground/70">
              {question.context}
            </p>
          )}
        </div>
      </div>

      {question.multiSelect ? (
        <div className="mt-3 space-y-2.5">
          <div className="flex flex-wrap gap-2">
            {question.options.map((o, i) => {
              const value = optValue(o);
              const isOn = selected.has(value);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => toggle(value)}
                  className={cn(
                    "flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs transition-colors",
                    isOn
                      ? "border-primary bg-primary/15 text-foreground"
                      : "border-border/60 bg-background/50 text-muted-foreground hover:border-primary/40"
                  )}
                >
                  {isOn && <Check className="h-3 w-3 shrink-0" />}
                  <span className="font-medium">{o.label}</span>
                </button>
              );
            })}
          </div>
          <Button
            type="button"
            size="sm"
            disabled={selected.size === 0}
            onClick={() => onAnswer({ values: Array.from(selected) })}
            className="h-7 gap-1.5 px-3 text-[11px]"
          >
            Confirmar
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2">
          {question.options.map((o, i) => (
            <button
              key={i}
              type="button"
              onClick={() => onAnswer({ values: [optValue(o)] })}
              className="flex flex-col gap-0.5 rounded-xl border border-border/50 bg-background/50 p-3 text-left transition-colors hover:border-primary/50 hover:bg-primary/5"
            >
              <span className="text-[13px] font-medium leading-tight text-foreground/90">
                {o.label}
              </span>
              {o.hint && (
                <span className="text-[11px] leading-snug text-muted-foreground/60">
                  {o.hint}
                </span>
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add components/dashboard/chat-question.tsx
git commit -m "feat: ChatQuestion inline multiple-choice GUI"
```

---

### Task 4: Wire the GUI into the chat

**Files:**
- Modify: `components/dashboard/conversations-chat.tsx`

- [ ] **Step 1: Import the component**

After the existing import of `ChatChart` (around line 51), add:

```tsx
import { ChatQuestion } from "@/components/dashboard/chat-question";
```

- [ ] **Step 2: Destructure `pendingQuestion` + `answer` from the hook**

Find:

```tsx
  const {
    messages,
    busy,
    status,
    error,
    totalCost,
    totalTools,
    send,
    stop,
    reset,
  } = useAgentLoop({ datasetSummary, dataset, onToolExecuted });
```

Add `pendingQuestion,` and `answer,` to the destructured list:

```tsx
  const {
    messages,
    busy,
    status,
    error,
    totalCost,
    totalTools,
    send,
    stop,
    reset,
    pendingQuestion,
    answer,
  } = useAgentLoop({ datasetSummary, dataset, onToolExecuted });
```

- [ ] **Step 3: Re-scroll when a question appears**

Find the scroll effect:

```tsx
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, status]);
```

Add `pendingQuestion` to its dependency array:

```tsx
  }, [messages, status, pendingQuestion]);
```

- [ ] **Step 4: Render `ChatQuestion` in the stream**

Find the busy indicator block inside the messages container:

```tsx
          {busy && status && (
```

Immediately BEFORE it, insert:

```tsx
          {pendingQuestion && !busy && (
            <ChatQuestion question={pendingQuestion} onAnswer={answer} />
          )}

```

- [ ] **Step 5: Type check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add components/dashboard/conversations-chat.tsx
git commit -m "feat: render inline clarifying-question GUI in AI chat"
```

---

### Task 5: Prompt guidance — when and what to ask

**Files:**
- Modify: `lib/ai-context.ts` (the `ASSISTANT_SYSTEM_PROMPT` template string)

- [ ] **Step 1: Insert the new section**

In `lib/ai-context.ts`, find the start of the tool-strategy section:

```ts
# Estrategia de herramientas
```

Insert the following section immediately BEFORE that line (keep a blank line after it):

```ts
# Cuándo preguntar (ask_user)

Tienes la herramienta \`ask_user\` para hacer UNA pregunta de opción múltiple y pausar hasta que el usuario responda. Es para GUIAR al usuario y ahorrar tokens cuando una palabra mapea a rutas de datos distintas. Úsala con criterio, no en cada mensaje.

**Cuándo SÍ preguntar:**
- El término es genuinamente ambiguo entre rutas que darían respuestas materialmente diferentes, Y el contexto/historial no lo aclara.
- Equivocarse de ruta costaría trabajo (varias llamadas) o daría un número engañoso.

**Cuándo NO preguntar (elige el valor por defecto y dilo en UNA línea):**
- El usuario ya especificó la ruta (no vuelvas a preguntar).
- La ambigüedad es leve o fácil de corregir → asume lo más probable y acláralo ("Asumo X; dime si querías Y").
- Ya hay una respuesta razonable por defecto según el resumen del dataset.

**Reglas de uso:**
- Como MUCHO una pregunta antes de ponerte a trabajar; agrúpala en una sola \`ask_user\`. Nunca encadenes preguntas.
- Llama \`ask_user\` SOLA en ese turno (sin otras herramientas).
- Da 2–4 opciones con \`label\` claro y, si ayuda, un \`hint\` de una línea. Usa \`context\` para el "por qué pregunto".
- Si el usuario responde texto libre en vez de elegir, respeta lo que diga.

**Términos ambiguos típicos (ofrece estas rutas):**
1. **"Pautas"**: ¿el objeto Pauta (busca con \`search_pautas\`/\`get_pauta\`) o el anuncio del que vino el lead (atribución \`adId\`/\`attributionUrl\`/\`campaign\`)? Pregunta salvo que el contexto lo deje claro.
2. **Atribución / fuente / origen** sin especificar entidad: ¿la del LEAD (\`contact.source/...\`) o la de la VENTA (\`opportunity.source/...\`)? Sus valores suelen diferir.
3. **Campaña / anuncio**: el campo \`campaign\` suele estar vacío; la identidad real vive en \`adId\`/\`attributionUrl\`. Si pedir cambia el resultado, pregunta cuál usar; si no, desglosa por \`adId\`/\`attributionUrl\` por defecto (ver reglas de atribución) y dilo.
4. **Periodo / fecha base** (p. ej. "oportunidades de junio"): ¿la fecha de creación de la OPORTUNIDAD, la de creación del CONTACTO, o la de CIERRE (\`closedAt\`)? Cada una da un conjunto distinto.

Estas preguntas tienen prioridad sobre la regla de "asumir y aclarar" SOLO para estos casos de alta ambigüedad; para todo lo demás, sigue prefiriendo asumir + aclarar en una línea.

```

- [ ] **Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: no errors (template-string edit only).

- [ ] **Step 3: Commit**

```bash
git add lib/ai-context.ts
git commit -m "feat: prompt guidance for when/what the AI should ask"
```

---

### Task 6: End-to-end manual verification

**Files:** none (manual)

- [ ] **Step 1: Start the app**

Run: `npm run dev`
Open `http://localhost:3000`, go to the **Asistente IA** tab.

- [ ] **Step 2: Single-select question (the "pautas" case)**

Type: `dame las pautas de mayo`
Expected: the agent pauses and an inline question card appears offering the Pauta-object path vs. the ad-attribution path (2 buttons, optional hints). The input box stays enabled.

- [ ] **Step 3: Click an option resolves and routes correctly**

Click the **Pauta object** option.
Expected: a user bubble shows the chosen label, the agent resumes and answers using `search_pautas`/`aggregate(pautas)` (not `adId`). Repeat from a fresh chat clicking the **ad attribution** option and confirm it uses `adId`/`attributionUrl`.

- [ ] **Step 4: Free-text escape**

Trigger a question again, then instead of clicking, type a reply in the box (e.g. `el objeto pauta`) and send.
Expected: the question resolves from the typed text, the agent resumes, and there is NO API error about an unmatched `tool_use`.

- [ ] **Step 5: Multi-select**

Ask something that should fan out platforms, e.g. `compara leads de varias plataformas` — if the model poses a multi-select question, confirm chips toggle and **Confirmar** is disabled until ≥1 is picked, then resolves with all picks. (If the model doesn't choose multi-select here, this is acceptable; the path is exercised by the schema.)

- [ ] **Step 6: No over-asking**

Type: `leads por plataforma`
Expected: NO question — the agent answers directly via `aggregate(groupBy:'attributionMedium')`. Also confirm an unambiguous profile query (`dame el perfil de <nombre>`) asks nothing.

- [ ] **Step 7: Reset clears a pending question**

Trigger a question, then click **Reiniciar**.
Expected: the question card disappears and the chat is empty.

- [ ] **Step 8: Final type check + commit (if any tweaks were needed)**

Run: `npx tsc --noEmit`
Expected: no errors. Commit any fixes made during verification.

```bash
git add -A
git commit -m "fix: adjustments from clarifying-questions manual verification"
```

---

## Self-Review

**Spec coverage:**
- `ask_user` tool (schema + ack) → Task 1. ✓
- Pause/resume, `pendingQuestion`, `answer()`, free-text escape, reset-clear → Task 2. ✓
- Single + multi-select GUI, inline placement, input stays live → Tasks 3 & 4. ✓
- Prompt "when to ask" balance + four triggers (Pautas, atribución, campaña, periodo) → Task 5. ✓
- Manual verification (no test harness) → Task 6. ✓
- Non-goals (no persistence, no analytics, no free-text-only tool, server contract unchanged) → respected; nothing added for them. ✓

**Placeholder scan:** No TBD/TODO/"handle edge cases" — every code step shows full code. ✓

**Type consistency:** `PendingQuestion`, `QuestionOption`, `AnswerPayload` defined in Task 2 and imported unchanged in Task 3; `answer`/`pendingQuestion` names match across hook return (Task 2), destructure (Task 4 Step 2), and usage (Task 4 Step 4); `AnswerPayload` is `{ values: string[] } | { text: string }` everywhere it's constructed (`answer`, `send`, `ChatQuestion`). ✓
