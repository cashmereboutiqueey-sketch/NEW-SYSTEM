"use client";

import { useMemo, useState } from "react";
import { quickAddCustomerAction } from "@/app/(app)/pos/actions";

/**
 * Choosing a customer, or making one without leaving the screen.
 *
 * A list of five hundred names in a dropdown is a list nobody uses: the
 * moderator types the phone number into the chat, not into the till, and
 * scrolling for a name they half remember is slower than typing it again —
 * which is how the same person ends up in the database three times.
 *
 * So it searches on both, because the two screens that need this know the
 * customer by different things. A shop counter knows a face and a name; a
 * moderator on a phone knows a number and nothing else.
 *
 * Adding one checks the number first and then *offers* the match rather than
 * taking it. A shared family phone is common enough that silently choosing
 * the wrong sister is worse than asking, and silently making a second record
 * is the thing being avoided.
 */
export type Person = { id: string; name: string; phone: string | null };

export function CustomerPicker({
  ar,
  people,
  value,
  onChange,
  source = "POS",
  required = false,
  name,
}: {
  ar: boolean;
  people: Person[];
  value: string;
  onChange: (id: string, person: Person | null) => void;
  /** Where they walked in, so acquisition reporting means something. */
  source?: "POS" | "EXHIBITION";
  required?: boolean;
  /** Set to post the chosen id with a plain form. */
  name?: string;
}) {
  const [list, setList] = useState<Person[]>(people);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ name: "", phone: "" });
  const [duplicate, setDuplicate] = useState<{ id: string; name: string; phone: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const field =
    "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";

  const chosen = list.find((c) => c.id === value) ?? null;

  /**
   * Digits only when the query looks like a number.
   *
   * A number typed with spaces or a leading zero has to find the same person
   * as one stored without them, or the search is worse than the scroll.
   */
  const matching = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return list.slice(0, 40);
    const digits = q.replace(/\D/g, "");
    return list
      .filter((c) => {
        if (c.name.toLowerCase().includes(q)) return true;
        if (!digits) return false;
        return (c.phone ?? "").replace(/\D/g, "").includes(digits);
      })
      .slice(0, 40);
  }, [list, query]);

  async function add(createAnyway = false) {
    setSaving(true);
    setError(null);
    try {
      const result = await quickAddCustomerAction({ ...draft, source, createAnyway });
      if (result.ok) {
        setList((prev) => [result.customer, ...prev]);
        onChange(result.customer.id, result.customer);
        setAdding(false);
        setDraft({ name: "", phone: "" });
        setDuplicate(null);
        setQuery("");
      } else if ("match" in result) {
        setDuplicate(result.match);
      } else {
        setError(result.message);
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-2">
      {name && <input type="hidden" name={name} value={value} required={required} />}

      <div className="flex items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={ar ? "دوّر بالاسم أو بالتليفون" : "Search by name or phone"}
          className={`${field} min-w-0 flex-1`}
        />
        <button
          type="button"
          onClick={() => {
            setAdding((v) => !v);
            // The name is usually already typed into the search box by the
            // time somebody works out this person is new.
            setDraft({ name: /\d/.test(query) ? "" : query.trim(), phone: /\d/.test(query) ? query.trim() : "" });
            setDuplicate(null);
            setError(null);
          }}
          title={ar ? "عميل جديد" : "New customer"}
          className="shrink-0 rounded-lg border border-ink-300 px-3 py-2 text-sm font-semibold text-ink-700"
        >
          {adding ? "×" : "+"}
        </button>
      </div>

      {chosen && !adding && (
        <div className="flex items-center justify-between rounded-lg bg-ink-50 px-3 py-2 text-sm">
          <span>
            {chosen.name}
            {chosen.phone && <span className="ms-2 num text-xs text-ink-500" dir="ltr">{chosen.phone}</span>}
          </span>
          <button type="button" onClick={() => onChange("", null)} className="text-xs text-ink-500 underline">
            {ar ? "غيّره" : "change"}
          </button>
        </div>
      )}

      {!chosen && !adding && (
        <div className="max-h-44 overflow-y-auto rounded-lg border border-ink-100">
          {matching.length === 0 ? (
            <p className="px-3 py-3 text-xs text-ink-400">
              {ar ? "محدش بالاسم ولا الرقم ده. اضغط + وزوّده." : "Nobody by that name or number. Press + to add them."}
            </p>
          ) : (
            <ul className="divide-y divide-ink-100">
              {matching.map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    onClick={() => onChange(c.id, c)}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-start text-sm hover:bg-ink-50"
                  >
                    <span>{c.name}</span>
                    {c.phone && <span className="num text-xs text-ink-500" dir="ltr">{c.phone}</span>}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {adding && (
        <div className="space-y-2 rounded-lg border border-ink-200 p-2">
          <div className="flex gap-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              placeholder={ar ? "الاسم" : "Name"}
              className={field}
            />
            <input
              value={draft.phone}
              onChange={(e) => setDraft((d) => ({ ...d, phone: e.target.value }))}
              placeholder={ar ? "التليفون" : "Phone"}
              className={`${field} num`}
              dir="ltr"
            />
          </div>

          {duplicate && (
            <div className="rounded-lg bg-warn/10 px-3 py-2 text-xs text-warn">
              <p>
                {ar
                  ? `الرقم ده مسجّل باسم ${duplicate.name}. هو نفس الشخص؟`
                  : `That number is already ${duplicate.name}. Is it the same person?`}
              </p>
              <div className="mt-1.5 flex gap-3">
                <button
                  type="button"
                  onClick={() => {
                    const person = { id: duplicate.id, name: duplicate.name, phone: duplicate.phone };
                    setList((prev) => (prev.some((c) => c.id === person.id) ? prev : [person, ...prev]));
                    onChange(person.id, person);
                    setAdding(false);
                    setDuplicate(null);
                  }}
                  className="font-medium underline"
                >
                  {ar ? "أيوه هو" : "Yes, that is them"}
                </button>
                <button type="button" onClick={() => void add(true)} className="underline">
                  {ar ? "لأ، ده حد تاني" : "No, somebody else"}
                </button>
              </div>
            </div>
          )}

          {error && <p className="text-xs text-bad">{error}</p>}

          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={saving || !draft.name.trim()}
              onClick={() => void add(false)}
              className="rounded-lg bg-ink-900 px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50"
            >
              {saving ? (ar ? "بنحفظ…" : "Saving…") : ar ? "زوّده" : "Add them"}
            </button>
            <button type="button" onClick={() => setAdding(false)} className="text-xs text-ink-500">
              {ar ? "سيبك" : "Cancel"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
