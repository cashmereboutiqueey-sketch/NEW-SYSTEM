"use client";

import { useActionState, useState } from "react";
import { receiveConsignmentAction, type ConsignmentState } from "./actions";

const empty: ConsignmentState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";

export function ReceiveForm({
  ar,
  consignors,
  locations,
}: {
  ar: boolean;
  consignors: { id: string; name: string; commissionPct: string }[];
  locations: { id: string; name: string }[];
}) {
  const [state, action, pending] = useActionState(receiveConsignmentAction, empty);
  const [consignorId, setConsignorId] = useState(consignors[0]?.id ?? "");

  const today = new Date().toISOString().slice(0, 10);
  const chosen = consignors.find((c) => c.id === consignorId);

  return (
    <form action={action} className="grid gap-3 sm:grid-cols-2">
      <label className="text-sm sm:col-span-2">
        <span className="mb-1 block text-ink-600">{ar ? "صاحب البضاعة" : "Owner"}</span>
        <select
          name="consignorId"
          required
          value={consignorId}
          onChange={(e) => setConsignorId(e.target.value)}
          className={field}
        >
          {consignors.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name} — {c.commissionPct}%
            </option>
          ))}
        </select>
      </label>

      <label className="text-sm sm:col-span-2">
        <span className="mb-1 block text-ink-600">{ar ? "الصنف" : "What is it"}</span>
        <input
          name="description" required
          placeholder={ar ? "فستان سواريه" : "Evening dress"}
          className={field}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "اللون" : "Colour"}</span>
        <input name="colour" className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "المقاس" : "Size"}</span>
        <input name="size" className={field} />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "العدد" : "How many"}</span>
        <input
          name="quantity" type="number" min="1" step="1" required
          defaultValue="1" dir="ltr" className={`${field} text-end`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "سعر البيع" : "Retail price"}</span>
        <input
          name="retailPrice" type="number" min="0" step="0.01" required
          dir="ltr" className={`${field} text-end`}
        />
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">{ar ? "المكان" : "Where"}</span>
        <select name="locationId" required className={field}>
          {locations.map((l) => (
            <option key={l.id} value={l.id}>{l.name}</option>
          ))}
        </select>
      </label>

      <label className="text-sm">
        <span className="mb-1 block text-ink-600">
          {ar ? "نسبة خاصة % (اختياري)" : "Special rate % (optional)"}
        </span>
        <input
          name="commissionPct" type="number" min="0" max="100" step="0.5"
          placeholder={chosen?.commissionPct}
          dir="ltr" className={`${field} text-end`}
        />
      </label>

      <input type="hidden" name="receivedDate" value={today} />

      <label className="text-sm sm:col-span-2">
        <span className="mb-1 block text-ink-600">
          {ar ? "يرجّعها امتى لو مباعتش (اختياري)" : "Return by, if unsold (optional)"}
        </span>
        <input name="expiresAt" type="date" dir="ltr" className={field} />
      </label>

      <div className="sm:col-span-2 flex flex-wrap items-center gap-3">
        <button
          type="submit"
          disabled={pending || consignors.length === 0}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "…" : "…") : ar ? "استلمها" : "Take it in"}
        </button>
        {state.error && <p className="text-sm text-bad">{state.error}</p>}
        {state.success && <p className="text-sm text-good">{state.success}</p>}
      </div>
    </form>
  );
}
