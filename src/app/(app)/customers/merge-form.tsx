"use client";

import { useActionState, useState } from "react";
import { mergeCustomersAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type MergeCandidate = {
  id: string;
  name: string;
  phone: string | null;
  orders: number;
};

/**
 * Merging one customer into another.
 *
 * The same person walks in twice and gets typed in twice — a phone number with
 * a space in it, a name spelled two ways — and their history splits across two
 * records. Neither shows what they are really worth, and the credit limit on
 * one says nothing about what they owe on the other.
 *
 * The action existed and no screen called it, so the duplicates had nowhere to
 * go. Merging rewrites who owns an order history, so it asks which record
 * survives explicitly rather than guessing from dates, and it wants a reason:
 * the customer whose record disappears may ask about it later.
 */
export function MergeForm({ ar, customers }: { ar: boolean; customers: MergeCandidate[] }) {
  const [state, action, pending] = useActionState(mergeCustomersAction, empty);
  const [open, setOpen] = useState(false);
  const [keepId, setKeepId] = useState("");
  const [mergeId, setMergeId] = useState("");
  const [reason, setReason] = useState("");

  const keep = customers.find((c) => c.id === keepId);
  const merge = customers.find((c) => c.id === mergeId);
  const sameRecord = keepId !== "" && keepId === mergeId;
  const ready = keepId !== "" && mergeId !== "" && !sameRecord && reason.trim().length >= 5;

  if (customers.length < 2) {
    return (
      <p className="text-sm text-ink-500">
        {ar ? "محتاج عميلين على الأقل عشان تدمج." : "Merging needs at least two customers."}
      </p>
    );
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700 hover:border-ink-500"
      >
        {ar ? "ادمج عميلين مكررين" : "Merge duplicates"}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor="keepId">
            {ar ? "السجل اللي هيفضل" : "The record that survives"}
          </label>
          <select
            id="keepId" name="keepId" required className={field}
            value={keepId}
            onChange={(e) => setKeepId(e.target.value)}
          >
            <option value="">{ar ? "اختار" : "Choose"}</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.phone ? ` · ${c.phone}` : ""} ({c.orders})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className={label} htmlFor="mergeId">
            {ar ? "السجل اللي هيتدمج فيه" : "The record folded into it"}
          </label>
          <select
            id="mergeId" name="mergeId" required className={field}
            value={mergeId}
            onChange={(e) => setMergeId(e.target.value)}
          >
            <option value="">{ar ? "اختار" : "Choose"}</option>
            {customers
              .filter((c) => c.id !== keepId)
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                  {c.phone ? ` · ${c.phone}` : ""} ({c.orders})
                </option>
              ))}
          </select>
        </div>
      </div>

      <div>
        <label className={label} htmlFor="merge-reason">
          {ar ? "السبب" : "Why"}
        </label>
        <input
          id="merge-reason" name="reason" required className={field}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder={
            ar ? "نفس الزبونة، اتسجلت مرتين برقمين" : "The same person, entered twice"
          }
        />
      </div>

      {keep && merge && !sameRecord && (
        <div className="rounded-lg border border-warn/30 bg-warn/5 p-3 text-sm">
          {ar ? (
            <>
              <b>{merge.orders}</b> أوردر هينتقلوا من <b>{merge.name}</b> لـ <b>{keep.name}</b>، وسجل{" "}
              <b>{merge.name}</b> هيختفي. ده مش بيتلغي.
            </>
          ) : (
            <>
              <b>{merge.orders}</b> order(s) move from <b>{merge.name}</b> to <b>{keep.name}</b>, and{" "}
              <b>{merge.name}</b> disappears. This cannot be undone.
            </>
          )}
        </div>
      )}

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || !ready}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتدمج…" : "Merging…") : ar ? "ادمج" : "Merge"}
        </button>
        <button
          type="button"
          onClick={() => setOpen(false)}
          className="rounded-lg border border-ink-200 px-4 py-2 text-sm text-ink-600"
        >
          {ar ? "إلغاء" : "Cancel"}
        </button>
      </div>
    </form>
  );
}
