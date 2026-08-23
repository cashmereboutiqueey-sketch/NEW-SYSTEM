"use client";

import { useActionState } from "react";
import {
  importStatementAction,
  autoMatchAction,
  matchLineAction,
  explainLineAction,
} from "./actions";
import type { FormState } from "@/components/entity-form";
import type { Locale } from "@/lib/i18n";

const initial: FormState = {};
const field =
  "rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm text-ink-900 " +
  "focus:border-rose-deep focus:outline-none focus:ring-1 focus:ring-rose";
const label = "mb-1 block text-xs font-medium text-ink-600";

/**
 * Entering a statement.
 *
 * Pasted rather than uploaded: every bank exports a different shape, and a
 * parser that guesses at four of them badly is worse than a box somebody
 * pastes three columns into. Rows that cannot be read are reported and skipped
 * rather than silently dropped.
 */
export function ImportStatementForm({
  locale,
  entities,
  accounts,
  today,
}: {
  locale: Locale;
  entities: { id: string; label: string }[];
  accounts: { code: string; label: string }[];
  today: string;
}) {
  const [state, formAction, pending] = useActionState(importStatementAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <div>
          <label className={label} htmlFor="bs-entity">{ar ? "الكيان" : "Entity"}</label>
          <select id="bs-entity" name="entityId" required className={`${field} w-full`}>
            {entities.map((e) => (
              <option key={e.id} value={e.id}>{e.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="bs-acc">{ar ? "الحساب" : "Account"}</label>
          <select id="bs-acc" name="accountCode" required className={`${field} w-full`}>
            {accounts.map((a) => (
              <option key={a.code} value={a.code}>{a.label}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={label} htmlFor="bs-date">{ar ? "تاريخ الكشف" : "Statement date"}</label>
          <input
            id="bs-date" name="statementDate" type="date" required defaultValue={today}
            dir="ltr" className={`${field} w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="bs-open">{ar ? "الرصيد الافتتاحي" : "Opening"}</label>
          <input
            id="bs-open" name="openingBalance" type="number" step="0.01" required defaultValue={0}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="bs-close">{ar ? "الرصيد الختامي" : "Closing"}</label>
          <input
            id="bs-close" name="closingBalance" type="number" step="0.01" required defaultValue={0}
            dir="ltr" className={`${field} num w-full`}
          />
        </div>
        <div>
          <label className={label} htmlFor="bs-ref">{ar ? "مرجع" : "Reference"}</label>
          <input id="bs-ref" name="reference" dir="ltr" className={`${field} w-full`} />
        </div>
      </div>

      <div>
        <label className={label} htmlFor="bs-lines">
          {ar ? "الصق سطور الكشف" : "Paste the statement lines"}
        </label>
        <textarea
          id="bs-lines"
          name="lines"
          required
          rows={8}
          dir="ltr"
          placeholder={"2026-08-03\tTransfer from ARAMEX\t47300\n2026-08-05\tBank charges\t-250"}
          className={`${field} w-full font-mono text-xs`}
        />
        <p className="mt-1 text-xs text-ink-500">
          {ar
            ? "سطر لكل حركة: التاريخ، الوصف، المبلغ. المبلغ بالسالب يعني فلوس خارجة. افصل بين الأعمدة بـTab أو فاصلة."
            : "One row per movement: date, description, amount. A negative amount is money out. Separate the columns with a tab or a comma."}
        </p>
      </div>

      <button
        type="submit"
        disabled={pending}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
      >
        {pending ? (ar ? "بيقرا…" : "Reading…") : ar ? "اقرا الكشف" : "Read the statement"}
      </button>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}
    </form>
  );
}

export function AutoMatchForm({ locale, statementId }: { locale: Locale; statementId: string }) {
  const [state, formAction, pending] = useActionState(autoMatchAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex items-center gap-3">
      <input type="hidden" name="statementId" value={statementId} />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 disabled:opacity-40"
      >
        {pending ? "…" : ar ? "طابق تلقائي" : "Match what you can"}
      </button>
      {state.error && <span className="text-xs text-bad">{state.error}</span>}
      {state.success && <span className="text-xs text-good">{state.success}</span>}
    </form>
  );
}

/** Matching one statement line to one ledger line by hand. */
export function MatchLineForm({
  locale,
  bankStatementLineId,
  candidates,
}: {
  locale: Locale;
  bankStatementLineId: string;
  candidates: { id: string; label: string }[];
}) {
  const [state, formAction, pending] = useActionState(matchLineAction, initial);
  const ar = locale === "ar";

  if (candidates.length === 0) {
    return (
      <span className="text-xs text-ink-400">
        {ar ? "مفيش سطر مقابل في الدفاتر" : "nothing in the books to match"}
      </span>
    );
  }

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="bankStatementLineId" value={bankStatementLineId} />
      <select name="journalLineId" required className={`${field} min-w-56 py-1 text-xs`}>
        {candidates.map((c) => (
          <option key={c.id} value={c.id}>{c.label}</option>
        ))}
      </select>
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700 disabled:opacity-40"
      >
        {pending ? "…" : ar ? "طابق" : "Match"}
      </button>
      {state.error && <span className="w-full text-xs text-bad">{state.error}</span>}
    </form>
  );
}

export function ExplainLineForm({
  locale,
  bankStatementLineId,
}: {
  locale: Locale;
  bankStatementLineId: string;
}) {
  const [state, formAction, pending] = useActionState(explainLineAction, initial);
  const ar = locale === "ar";

  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="bankStatementLineId" value={bankStatementLineId} />
      <input
        name="note"
        required
        placeholder={ar ? "مصاريف بنك، فوايد…" : "bank charge, interest…"}
        className={`${field} min-w-44 py-1 text-xs`}
      />
      <button
        type="submit"
        disabled={pending}
        className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700 disabled:opacity-40"
      >
        {pending ? "…" : ar ? "فسّرها" : "Explain"}
      </button>
      {state.error && <span className="w-full text-xs text-bad">{state.error}</span>}
      {state.success && <span className="w-full text-xs text-good">{state.success}</span>}
    </form>
  );
}
