"use client";

/**
 * The assumptions, typed over the measurements.
 *
 * A plain GET form rather than a server action: changing what you expect to
 * sell is a question, not a decision, and a question should not write to the
 * database. The answer lands in the query string, so a scenario survives a
 * refresh and can be handed to somebody else as a link.
 *
 * Each field shows what the books measured as its placeholder. Leaving it
 * empty keeps the measurement; typing replaces it. Nothing is silently
 * defaulted to a number nobody chose.
 */
export function BasisForm({
  ar,
  months,
  monthlyOverhead,
  overheadMeasured,
  monthlyUnits,
  unitsBasis,
  marketingPerUnit,
  marketingMeasured,
  targetMargin,
  current,
}: {
  ar: boolean;
  months: number;
  monthlyOverhead: string;
  overheadMeasured: boolean;
  monthlyUnits: string;
  unitsBasis: "typed" | "planned" | "measured";
  marketingPerUnit: string;
  marketingMeasured: boolean;
  targetMargin: string;
  current: { units: string; overhead: string; marketing: string; target: string };
}) {
  const field =
    "w-full rounded-md border border-line bg-surface px-3 py-2 text-sm outline-none focus:border-ink-400";
  const label = "mb-1 block text-xs font-medium text-ink-600";
  const note = "mt-1 block text-[11px] text-ink-400";

  const round = (v: string) => Number(v).toFixed(2);

  const source =
    unitsBasis === "typed"
      ? ar ? "اللي كتبته" : "what you typed"
      : unitsBasis === "planned"
        ? ar ? "المتوقع من الإعدادات" : "the planned figure in settings"
        : ar ? `اللي اتباع فعلًا في ${months} شهور` : `what actually sold over ${months} months`;

  return (
    <form method="get" action="/pricing" className="grid gap-3 sm:grid-cols-4">
      <div>
        <label className={label} htmlFor="units">
          {ar ? "متوقع تبيع كام قطعة في الشهر" : "Garments you expect to sell a month"}
        </label>
        <input
          id="units" name="units" type="number" min="1" step="1" dir="ltr"
          className={`${field} num`}
          defaultValue={current.units}
          placeholder={Number(monthlyUnits).toFixed(0)}
        />
        <span className={note}>
          {ar ? "دلوقتي بيستخدم " : "currently using "}
          {source}
          {". "}
          {ar
            ? "المصاريف الثابتة بتتقسم على العدد ده."
            : "Fixed cost is spread over this."}
        </span>
      </div>

      <div>
        <label className={label} htmlFor="overhead">
          {ar ? "إيجار ومرتبات في الشهر" : "Rent and salaries a month"}
        </label>
        <input
          id="overhead" name="overhead" type="number" min="0" step="0.01" dir="ltr"
          className={`${field} num`}
          defaultValue={current.overhead}
          placeholder={round(monthlyOverhead)}
        />
        <span className={note}>
          {overheadMeasured
            ? ar
              ? `${round(monthlyOverhead)} مقروءة من الدفاتر`
              : `${round(monthlyOverhead)} read from the books`
            : ar
              ? "بترقيمك انت"
              : "your figure"}
        </span>
      </div>

      <div>
        <label className={label} htmlFor="marketing">
          {ar ? "تسويق للقطعة" : "Marketing per garment"}
        </label>
        <input
          id="marketing" name="marketing" type="number" min="0" step="0.01" dir="ltr"
          className={`${field} num`}
          defaultValue={current.marketing}
          placeholder={round(marketingPerUnit)}
        />
        <span className={note}>
          {marketingMeasured
            ? ar
              ? "موزّع على كل اللي اتباع — الحملة نادرًا ما بتخص موديل واحد"
              : "spread across everything sold — a campaign rarely names one style"
            : ar
              ? "بترقيمك انت"
              : "your figure"}
        </span>
      </div>

      <div>
        <label className={label} htmlFor="target">
          {ar ? "هامش الربح المستهدف" : "Target margin"}
        </label>
        <input
          id="target" name="target" type="number" min="0" max="0.95" step="0.01" dir="ltr"
          className={`${field} num`}
          defaultValue={current.target}
          placeholder={targetMargin}
        />
        <span className={note}>
          {ar
            ? "هامش على سعر البيع، مش ماركاب على التكلفة. ٠٫٥٥ يعني ٥٥٪."
            : "A margin over the price, not a markup over cost. 0.55 means 55%."}
        </span>
      </div>

      <div className="sm:col-span-4 flex items-center gap-2">
        <button
          type="submit"
          className="rounded-md bg-ink-900 px-4 py-2 text-sm text-white hover:bg-ink-800"
        >
          {ar ? "احسب بالأرقام دي" : "Reprice on these"}
        </button>
        <a
          href="/pricing"
          className="rounded-md border border-line px-4 py-2 text-sm text-ink-600 hover:border-ink-300"
        >
          {ar ? "رجّع أرقام الدفاتر" : "Back to the books"}
        </a>
      </div>
    </form>
  );
}
