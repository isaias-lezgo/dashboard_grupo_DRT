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
            onClick={() => {
              const chosen = question.options.filter((o) =>
                selected.has(optValue(o)),
              );
              onAnswer({
                values: chosen.map(optValue),
                labels: chosen.map((o) => o.label),
              });
            }}
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
              onClick={() => onAnswer({ values: [optValue(o)], labels: [o.label] })}
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
