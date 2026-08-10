"use client";

import { useState, useTransition } from "react";
import { fetchRateCardAction, type RateCardResult } from "./actions";

const field =
  "rounded-lg border border-ink-200 bg-white px-3 py-2 text-sm outline-none focus:border-ink-500";

/**
 * The answer to "how few can you make, and for how much".
 *
 * One table somebody can read down the phone. The reason the price falls with
 * quantity gets its own column rather than being left to look like a
 * negotiating position: the setup is the same work whether the run is fifty
 * pieces or five thousand, so it costs more per garment when there are fewer
 * garments to spread it over.
 */
export function RateCard({
  ar,
  clients,
}: {
  ar: boolean;
  clients: { id: string; name: string; minimumQuantity: number | null }[];
}) {
  const [smv, setSmv] = useState("25");
  const [clientId, setClientId] = useState("");
  const [margin, setMargin] = useState("15");
  const [card, setCard] = useState<RateCardResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const run = () => {
    setError(null);
    start(async () => {
      const result = await fetchRateCardAction({
        smvPerUnit: smv,
        clientId: clientId || null,
        marginOverFloor: String(Number(margin || 0) / 100),
      });
      if ("error" in result) {
        setError(result.error);
        setCard(null);
      } else {
        setCard(result);
      }
    });
  };

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <label className="text-sm">
          <span className="mb-1 block text-ink-600">
            {ar ? "دقائق القطعة" : "Minutes per garment"}
          </span>
          <input
            type="number" step="0.1" min="0" dir="ltr"
            value={smv} onChange={(e) => setSmv(e.target.value)}
            className={`${field} w-32 text-end`}
          />
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">{ar ? "العميل" : "Client"}</span>
          <select
            value={clientId}
            onChange={(e) => setClientId(e.target.value)}
            className={`${field} w-48`}
          >
            <option value="">{ar ? "أي عميل" : "Anyone"}</option>
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.minimumQuantity ? ` (${c.minimumQuantity}+)` : ""}
              </option>
            ))}
          </select>
        </label>

        <label className="text-sm">
          <span className="mb-1 block text-ink-600">
            {ar ? "هامش فوق الحد الأدنى %" : "Margin over floor %"}
          </span>
          <input
            type="number" step="1" min="0" dir="ltr"
            value={margin} onChange={(e) => setMargin(e.target.value)}
            className={`${field} w-28 text-end`}
          />
        </label>

        <button
          type="button"
          onClick={run}
          disabled={pending}
          className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {pending ? (ar ? "بيحسب…" : "Working…") : ar ? "احسب" : "Work it out"}
        </button>
      </div>

      {error && <p className="text-sm text-bad">{error}</p>}

      {card && (
        <>
          <div className="mb-3 flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-500">
            <span>
              {ar ? "أقل كمية" : "Minimum"}:{" "}
              <strong className="num text-ink-800">{card.minimumQuantity}</strong>
            </span>
            <span>
              {ar ? "دقائق التجهيز للأمر" : "Setup per run"}:{" "}
              <strong className="num text-ink-800">{card.setupMinutes}</strong>
            </span>
            <span>
              {ar ? "الحد الأدنى للدقيقة" : "Floor rate"}:{" "}
              <strong className="num text-ink-800">{card.floorMinuteRate}</strong>
            </span>
            <span>
              {ar ? "سعر الدقيقة المعروض" : "Quoted rate"}:{" "}
              <strong className="num text-ink-800">{card.quotedMinuteRate}</strong>
            </span>
            <span>
              {ar ? "دقائق فاضية الشهر ده" : "Free this month"}:{" "}
              <strong className="num text-ink-800">{card.freeMinutes}</strong>
            </span>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-ink-200 text-ink-500">
                  <th className="px-2 py-2 text-start font-medium">{ar ? "الكمية" : "Quantity"}</th>
                  <th className="px-2 py-2 text-end font-medium">
                    {ar ? "تجهيز/قطعة" : "Setup each"}
                  </th>
                  <th className="px-2 py-2 text-end font-medium">
                    {ar ? "دقائق/قطعة" : "Minutes each"}
                  </th>
                  <th className="px-2 py-2 text-end font-medium">
                    {ar ? "سعر القطعة" : "Unit price"}
                  </th>
                  <th className="px-2 py-2 text-end font-medium">{ar ? "الإجمالي" : "Total"}</th>
                  <th className="px-2 py-2 text-end font-medium">{ar ? "المدة" : "Lead time"}</th>
                </tr>
              </thead>
              <tbody>
                {card.tiers.map((t) => (
                  <tr key={t.quantity} className="border-b border-ink-100">
                    <td className="px-2 py-2 num font-medium">{t.quantity}</td>
                    <td className="px-2 py-2 text-end num text-ink-500">{t.setupPerUnit}</td>
                    <td className="px-2 py-2 text-end num text-ink-500">{t.minutesPerUnit}</td>
                    <td className="px-2 py-2 text-end num font-semibold">{t.unitPrice}</td>
                    <td className="px-2 py-2 text-end num">{t.total}</td>
                    <td className="px-2 py-2 text-end">
                      <span className="num">{t.leadDays}</span>{" "}
                      <span className="text-xs text-ink-400">{ar ? "يوم" : "days"}</span>
                      {!t.capacityAvailable && (
                        <div className="text-[11px] text-warn">
                          {ar ? "أكبر من الفاضي" : "over free capacity"}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "سعر القطعة = (دقائق القطعة + التجهيز ÷ الكمية) × سعر الدقيقة. الكميات الصغيرة أغلى لأن التجهيز واحد سواء صنّعت خمسين قطعة أو خمس آلاف."
              : "Unit price = (minutes per garment + setup ÷ quantity) × minute rate. Small runs cost more because the setup is the same work either way."}
          </p>
        </>
      )}
    </div>
  );
}
