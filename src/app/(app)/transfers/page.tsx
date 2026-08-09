import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { awaitingDespatch, awaitingIntake, recentTransfers } from "@/lib/intercompany";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { DespatchForm } from "./transfer-form";

/**
 * الشحن للبراند — the factory's side of the handover.
 *
 * This is the step people forget, and forgetting it is not a small mistake: a
 * garment sitting in the factory warehouse belongs to the factory, so it will
 * never appear at a till no matter how many were made.
 *
 * Sending is not selling. The goods stay the factory's while they are on the
 * road; the invoice is raised when the shop counts them in, for what the shop
 * actually found. So this screen has no journal behind it — only a note the
 * shop will count against.
 */
export default async function TransfersPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayDespatch = can(session.role, "inventory:transfer");
  const maySeePrice = can(session.role, "transfer_price:view");

  const [pending, inTransit, history] = await Promise.all([
    awaitingDespatch(),
    awaitingIntake(),
    recentTransfers(),
  ]);

  const today = new Date().toISOString().slice(0, 10);

  const waitingUnits = pending.reduce((s, r) => s.plus(dec(r.quantity)), dec(0));
  const waitingCost = pending.reduce((s, r) => s.plus(dec(r.factoryCost)), dec(0));
  const transitUnits = inTransit.reduce((s, r) => s.plus(dec(r.expectedQty)), dec(0));

  // Margin the group has invoiced itself but not yet earned from an outsider.
  const unrealised = history.reduce(
    (s, t) =>
      t.marginPerUnit == null
        ? s
        : s.plus(dec(t.marginPerUnit).times(dec(t.unsoldQty))),
    dec(0),
  );

  return (
    <>
      <PageHeader
        title={ar ? "الشحن للبراند" : "Despatch to the Brand"}
        subtitle={
          ar
            ? "الشحن مش بيع — البضاعة تفضل ملك المصنع لحد ما المعرض يعدّها ويستلمها، والفاتورة تتعمل على اللي وصل فعلًا"
            : "Sending is not selling — the goods stay the Factory's until the shop counts them in, and the invoice is raised for what actually arrived"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "جاهزة للشحن" : "Ready to send"}
          value={formatNumber(waitingUnits, locale)}
          tone={waitingUnits.greaterThan(0) ? "warn" : "neutral"}
          hint={ar ? "لسه في المصنع" : "Still at the factory"}
        />
        <StatTile
          label={ar ? "في الطريق" : "On the road"}
          value={formatNumber(transitUnits, locale)}
          tone={transitUnits.greaterThan(0) ? "info" : "neutral"}
          hint={ar ? "مستنية استلام المعرض" : "Waiting to be counted in"}
        />
        <StatTile
          label={ar ? "بتكلفة المصنع" : "At factory cost"}
          value={formatMoney(waitingCost, locale)}
        />
        {maySeePrice && (
          <StatTile
            label={ar ? "ربح داخلي غير محقق" : "Unrealised internal margin"}
            value={formatMoney(unrealised, locale)}
            tone={unrealised.greaterThan(0) ? "info" : "neutral"}
            hint={ar ? "بيتشال من أرباح المجموعة" : "Removed from group profit"}
          />
        )}
      </div>

      {/* -------------------------------------------------- ready to despatch */}
      <Card
        className="mb-4"
        title={ar ? "جاهزة للشحن" : "Ready to send"}
        description={
          ar
            ? "السعر جاي من التكلفة المجمّدة قبل ما التشغيلة تبدأ، فمش قابل للتعديل هنا"
            : "The price comes from the cost frozen before the run started, so it cannot be edited here"
        }
      >
        {pending.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "مفيش بضاعة تامّة في المصنع مستنية شحن."
              : "No finished goods are waiting at the factory."}
          </p>
        ) : (
          <ul className="divide-y divide-ink-100">
            {pending.map((r) => (
              <li key={`${r.variantId}-${r.costSnapshotId ?? "none"}`} className="py-4">
                <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                  <code dir="ltr" className="text-xs text-ink-500">{r.sku}</code>
                  <span className="font-medium">
                    {ar ? r.styleAr : r.styleEn} · {ar ? r.colourAr : r.colourEn} · {r.size}
                  </span>
                  <span className="text-xs text-ink-400">
                    {ar ? "في" : "at"} {ar ? r.locationAr : r.locationEn}
                  </span>
                  {maySeePrice && r.transferPrice && (
                    <span className="text-xs text-ink-500">
                      {ar ? "سعر التحويل" : "Transfer price"}{" "}
                      <span className="num">{Number(r.transferPrice).toFixed(2)}</span>
                      {r.marginPerUnit && (
                        <>
                          {" · "}
                          {ar ? "هامش" : "margin"}{" "}
                          <span className="num">{Number(r.marginPerUnit).toFixed(2)}</span>
                        </>
                      )}
                    </span>
                  )}
                </div>

                {r.blockedReason === "NO_SNAPSHOT" ? (
                  <p className="text-sm text-bad">
                    {ar
                      ? "التشغيلة دي اتعملت من غير تكلفة مجمّدة، فمفيش سعر تحويل تتفوتر بيه. اعمل لقطة تكلفة للموديل الأول."
                      : "This run was made without a frozen cost, so there is no price to invoice at. Take a cost snapshot for the style first."}
                  </p>
                ) : !mayDespatch ? (
                  <p className="text-sm text-ink-400">
                    <span className="num">{r.quantity}</span>{" "}
                    {ar ? "قطعة — مش من صلاحياتك تشحنها." : "units — despatching is not yours to do."}
                  </p>
                ) : (
                  <DespatchForm
                    locale={locale}
                    today={today}
                    row={{
                      variantId: r.variantId,
                      sku: r.sku,
                      name: ar ? r.styleAr : r.styleEn,
                      locationId: r.locationId,
                      locationName: ar ? r.locationAr : r.locationEn,
                      quantity: r.quantity,
                      transferPrice: maySeePrice ? r.transferPrice : null,
                      marginPerUnit: maySeePrice ? r.marginPerUnit : null,
                      retailPrice: r.retailPrice,
                      costSnapshotId: r.costSnapshotId,
                    }}
                  />
                )}
              </li>
            ))}
          </ul>
        )}
      </Card>

      {/* ------------------------------------------------------ on the road */}
      {inTransit.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "في الطريق" : "On the road"}
          description={
            ar
              ? "اتشحنت ولسه المعرض ماستلمهاش. لحد دلوقتي هي ملك المصنع ومفيش فاتورة اتعملت."
              : "Sent, not yet counted in. Until then they are the Factory's and nothing has been invoiced."
          }
        >
          <DataTable
            headers={[
              ar ? "إذن الشحن" : "Note",
              ar ? "التاريخ" : "Date",
              "SKU",
              ar ? "الصنف" : "Item",
              ar ? "المُرسَل" : "Sent",
            ]}
            rows={inTransit.map((r, i) => [
              <code key={`${i}-n`} dir="ltr" className="text-xs text-ink-500">
                {r.despatchNumber}
              </code>,
              <span key={`${i}-d`} className="num" dir="ltr">
                {r.despatchedOn.toISOString().slice(0, 10)}
              </span>,
              <code key={`${i}-s`} dir="ltr" className="text-xs text-ink-500">{r.sku}</code>,
              <span key={`${i}-i`}>
                {ar ? r.styleAr : r.styleEn} · {ar ? r.colourAr : r.colourEn} · {r.size}
              </span>,
              <span key={`${i}-q`} className="num">{formatNumber(dec(r.expectedQty), locale)}</span>,
            ])}
          />
          <p className="mt-3 text-xs text-ink-500">
            {ar ? (
              <>
                الاستلام بيتم من{" "}
                <a href="/goods-in" className="underline decoration-ink-300 underline-offset-2">
                  الوارد من المصنع
                </a>
                .
              </>
            ) : (
              <>
                Counted in from{" "}
                <a href="/goods-in" className="underline decoration-ink-300 underline-offset-2">
                  Goods in
                </a>
                .
              </>
            )}
          </p>
        </Card>
      )}

      {/* ------------------------------------------------------- what moved */}
      <Card title={ar ? "التحويلات السابقة" : "Past transfers"}>
        {history.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لسه مفيش تحويلات." : "Nothing has been transferred yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الفاتورة" : "Invoice",
              ar ? "التاريخ" : "Date",
              "SKU",
              ar ? "إلى" : "To",
              ar ? "الكمية" : "Qty",
              ar ? "القيمة" : "Value",
              ar ? "لسه متباعش" : "Unsold",
            ]}
            rows={history.map((t, i) => [
              <a
                key={`${i}-n`}
                href={`/print/transfer/${t.transferNumber}`}
                dir="ltr"
                className="text-xs text-ink-600 underline decoration-ink-300 underline-offset-2"
              >
                {t.transferNumber}
              </a>,
              <span key={`${i}-d`} className="num" dir="ltr">
                {t.date.toISOString().slice(0, 10)}
              </span>,
              <code key={`${i}-s`} dir="ltr" className="text-xs text-ink-500">{t.sku}</code>,
              <span key={`${i}-l`}>{ar ? t.toLocationAr : t.toLocationEn}</span>,
              <span key={`${i}-q`} className="num">{formatNumber(dec(t.quantity), locale)}</span>,
              <span key={`${i}-v`} className="num">
                {maySeePrice ? formatMoney(dec(t.total), locale) : "—"}
              </span>,
              dec(t.unsoldQty).isZero() ? (
                <Badge key={`${i}-u`} tone="good">{ar ? "اتباعت كلها" : "All sold"}</Badge>
              ) : (
                <span key={`${i}-u`} className="num text-ink-500">
                  {formatNumber(dec(t.unsoldQty), locale)}
                </span>
              ),
            ])}
          />
        )}
      </Card>
    </>
  );
}
