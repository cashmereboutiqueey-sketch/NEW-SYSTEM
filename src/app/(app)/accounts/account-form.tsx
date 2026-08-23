"use client";

import { useActionState, useState } from "react";
import { createAccountAction } from "./actions";
import type { FormState } from "@/components/entity-form";

const empty: FormState = {};
const field =
  "w-full rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm outline-none focus:border-rose-deep";
const label = "mb-1 block text-xs font-medium text-ink-600";

export type ParentOption = {
  id: string;
  code: string;
  nameAr: string;
  nameEn: string;
  type: string;
};

const NORMAL: Record<string, "DEBIT" | "CREDIT"> = {
  ASSET: "DEBIT",
  LIABILITY: "CREDIT",
  EQUITY: "CREDIT",
  REVENUE: "CREDIT",
  COGS: "DEBIT",
  EXPENSE: "DEBIT",
};

/**
 * Adding an account.
 *
 * The normal balance is shown, never asked. An asset is a debit balance — it
 * is not a preference, and a dropdown offering the choice is a dropdown
 * offering somebody the chance to invert a report.
 *
 * Only parents of the same type are offered, because an expense filed under
 * an asset header makes every subtotal above it wrong and nothing downstream
 * would notice.
 */
export function AccountForm({ ar, parents }: { ar: boolean; parents: ParentOption[] }) {
  const [state, action, pending] = useActionState(createAccountAction, empty);
  const [open, setOpen] = useState(false);
  const [type, setType] = useState("EXPENSE");
  const [code, setCode] = useState("");

  const eligible = parents.filter((p) => p.type === type);
  const normal = NORMAL[type];
  const badCode = code !== "" && !/^[0-9]{4}$/.test(code);

  const typeLabel: Record<string, string> = ar
    ? {
        ASSET: "أصول",
        LIABILITY: "خصوم",
        EQUITY: "حقوق ملكية",
        REVENUE: "إيرادات",
        COGS: "تكلفة مبيعات",
        EXPENSE: "مصروفات",
      }
    : {
        ASSET: "Asset",
        LIABILITY: "Liability",
        EQUITY: "Equity",
        REVENUE: "Revenue",
        COGS: "Cost of sales",
        EXPENSE: "Expense",
      };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white hover:bg-ink-800"
      >
        {ar ? "حساب جديد" : "New account"}
      </button>
    );
  }

  return (
    <form action={action} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="code">
            {ar ? "الكود" : "Code"}
          </label>
          <input
            id="code" name="code" required dir="ltr" inputMode="numeric" maxLength={4}
            className={`${field} num`} value={code}
            onChange={(e) => setCode(e.target.value)}
            placeholder="5600"
          />
          {badCode && (
            <p className="mt-1 text-xs text-bad">
              {ar ? "الكود أربع أرقام." : "A code is four digits."}
            </p>
          )}
          <p className="mt-1 text-[11px] text-ink-400">
            {ar
              ? "الكود ما بيتغيّرش ولا بيتعاد استخدامه بعد كده — الدفاتر بتشاور عليه."
              : "A code is never changed or reused afterwards: the books refer to it."}
          </p>
        </div>

        <div>
          <label className={label} htmlFor="nameAr">
            {ar ? "الاسم بالعربي" : "Arabic name"}
          </label>
          <input id="nameAr" name="nameAr" required className={field} />
        </div>

        <div>
          <label className={label} htmlFor="nameEn">
            {ar ? "الاسم بالإنجليزي" : "English name"}
          </label>
          <input id="nameEn" name="nameEn" className={field} />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div>
          <label className={label} htmlFor="type">
            {ar ? "النوع" : "Type"}
          </label>
          <select
            id="type" name="type" className={field}
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {Object.keys(NORMAL).map((t) => (
              <option key={t} value={t}>{typeLabel[t]}</option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-500">
            {ar ? "رصيده الطبيعي" : "Normal balance"}{" "}
            <b>{normal === "DEBIT" ? (ar ? "مدين" : "Debit") : ar ? "دائن" : "Credit"}</b>
            <span className="text-ink-400">
              {ar ? " — بيتحدد من النوع، مش اختيار." : " — set by the type, not a choice."}
            </span>
          </p>
        </div>

        <div>
          <label className={label} htmlFor="parentId">
            {ar ? "تحت أي حساب" : "Under which account"}
          </label>
          <select id="parentId" name="parentId" className={field}>
            <option value="">{ar ? "مستقل" : "Top level"}</option>
            {eligible.map((p) => (
              <option key={p.id} value={p.id}>
                {p.code} — {ar ? p.nameAr : p.nameEn}
              </option>
            ))}
          </select>
          <p className="mt-1 text-[11px] text-ink-400">
            {ar
              ? "بس حسابات من نفس النوع. لو اخترت واحد، هيبقى رأس مجموعة ومش هيتسجل عليه."
              : "Same type only. Whichever you pick becomes a header and stops accepting postings."}
          </p>
        </div>

        <div>
          <label className={label} htmlFor="scope">
            {ar ? "بيخص" : "Applies to"}
          </label>
          <select id="scope" name="scope" className={field} defaultValue="BOTH">
            <option value="BOTH">{ar ? "الاتنين" : "Both"}</option>
            <option value="FACTORY">{ar ? "المصنع" : "Factory"}</option>
            <option value="BRAND">{ar ? "البراند" : "Brand"}</option>
          </select>
        </div>
      </div>

      <div className="grid gap-2 rounded-lg border border-ink-200 bg-ink-50 p-3 sm:grid-cols-2">
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" name="includeInMinuteRate" className="mt-0.5" />
          <span>
            <b>{ar ? "يدخل في تكلفة الدقيقة" : "Feeds the minute rate"}</b>
            <span className="block text-ink-400">
              {ar
                ? "لو علّمت هنا، الحساب ده هيغيّر تكلفة كل قطعة بتتصنّع بعد كده."
                : "Ticking this changes what every garment made afterwards is costed at."}
            </span>
          </span>
        </label>
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" name="includeInBrandFixedPool" className="mt-0.5" />
          <span>
            <b>{ar ? "من مصاريف البراند الثابتة" : "Brand fixed cost"}</b>
            <span className="block text-ink-400">
              {ar
                ? "بيدخل في نقطة التعادل وفي تسعير البراند."
                : "Feeds break-even and the brand's pricing."}
            </span>
          </span>
        </label>
      </div>

      {state.error && <p className="text-sm text-bad">{state.error}</p>}
      {state.success && <p className="text-sm text-good">{state.success}</p>}

      <div className="flex items-center gap-2">
        <button
          type="submit"
          disabled={pending || badCode}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيتضاف…" : "Adding…") : ar ? "أضف الحساب" : "Add the account"}
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
