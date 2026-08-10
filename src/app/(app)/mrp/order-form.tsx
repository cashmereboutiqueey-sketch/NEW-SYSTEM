"use client";

import { useActionState, useState } from "react";
import { raiseOrdersFromPlanAction } from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};

export type PlanLine = {
  materialId: string;
  code: string;
  name: string;
  uom: string;
  suggestedQty: string;
  estimatedCost: string;
  supplier: string | null;
  urgency: "OVERDUE" | "URGENT" | "PLANNED";
};

/**
 * Choosing what to actually buy.
 *
 * Overdue and urgent lines start ticked because they are the ones that hold up
 * a run; anything merely planned is left for a person to decide on. Orders are
 * grouped by supplier, since one delivery arrives on one lorry however many
 * materials it carries.
 */
export function RaiseOrdersForm({
  locale,
  lines,
}: {
  locale: Locale;
  lines: PlanLine[];
}) {
  const [state, formAction, pending] = useActionState(raiseOrdersFromPlanAction, initial);
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(lines.filter((l) => l.urgency !== "PLANNED").map((l) => l.materialId)),
  );
  const ar = locale === "ar";

  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const picked = lines.filter((l) => chosen.has(l.materialId));
  const total = picked.reduce((s, l) => s + Number(l.estimatedCost), 0);
  const suppliers = new Set(picked.map((l) => l.supplier ?? "—")).size;
  const missingSupplier = picked.filter((l) => !l.supplier);

  return (
    <form action={formAction} className="space-y-3">
      <input type="hidden" name="materialIds" value={[...chosen].join(",")} />

      <ul className="divide-y divide-ink-100">
        {lines.map((l) => (
          <li key={l.materialId} className="flex flex-wrap items-center gap-3 py-2">
            <input
              type="checkbox"
              checked={chosen.has(l.materialId)}
              onChange={() => toggle(l.materialId)}
              className="h-4 w-4"
              aria-label={l.code}
            />
            <span className="flex-1 text-sm">
              <code dir="ltr" className="text-xs text-ink-500">{l.code}</code>
              <span className="ms-2">{l.name}</span>
            </span>
            <span className="num text-sm">
              {Number(l.suggestedQty).toFixed(2)} {l.uom}
            </span>
            <span className="num text-sm text-ink-500">
              {Number(l.estimatedCost).toFixed(2)}
            </span>
            <span className="min-w-28 text-xs text-ink-500">
              {l.supplier ?? (
                <span className="text-bad">{ar ? "بدون مورد" : "no supplier"}</span>
              )}
            </span>
          </li>
        ))}
      </ul>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          disabled={pending || chosen.size === 0 || missingSupplier.length > 0}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          {pending
            ? ar ? "بيعمل الأوامر…" : "Raising…"
            : ar
              ? `اعمل ${suppliers} أمر شراء`
              : `Raise ${suppliers} purchase order${suppliers === 1 ? "" : "s"}`}
        </button>
        <span className="text-sm text-ink-500">
          {chosen.size} {ar ? "خامة" : "materials"} ·{" "}
          <span className="num">{total.toFixed(2)}</span>
        </span>
      </div>

      {missingSupplier.length > 0 && (
        <p className="text-sm text-bad">
          {ar
            ? `مفيش مورد محدد لـ ${missingSupplier.map((l) => l.code).join("، ")}. حدده من صفحة الخامات الأول.`
            : `No supplier is set for ${missingSupplier.map((l) => l.code).join(", ")}. Set one on the materials screen first.`}
        </p>
      )}

      <p className="text-xs text-ink-500">
        {ar
          ? "الأسعار بتيجي من السعر الأساسي للخامة — راجعها مع عرض المورد قبل ما تبعت."
          : "Prices come from each material's base price — check them against the supplier's quote before sending."}
      </p>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}
