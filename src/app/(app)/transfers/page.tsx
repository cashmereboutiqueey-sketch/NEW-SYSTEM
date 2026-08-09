import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { awaitingTransfer, recentTransfers } from "@/lib/intercompany";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { TransferForm } from "./transfer-form";

/**
 * التحويل للبراند — the handover from the Factory to the Brand.
 *
 * This is the step people forget, and forgetting it is not a small mistake: a
 * garment sitting in the factory warehouse belongs to the factory, so it will
 * never appear at a till no matter how many were made. The two companies are
 * genuinely separate, and stock crosses between them by invoice, not by being
 * carried across the yard.
 */
export default async function TransfersPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayTransfer = can(session.role, "inventory:transfer");
  const maySeePrice = can(session.role, "transfer_price:view");

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [pending, history, destinations] = await Promise.all([
    awaitingTransfer(),
    recentTransfers(),
    db.location.findMany({
      where: { isActive: true, entityId: brand.id },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const today = new Date().toISOString().slice(0, 10);

  const waitingUnits = pending.reduce((s, r) => s.plus(dec(r.quantity)), dec(0));
  const waitingCost = pending.reduce((s, r) => s.plus(dec(r.factoryCost)), dec(0));

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
        title={ar ? "التحويل للبراند" : "Transfer to Brand"}
        subtitle={
          ar
            ? "البضاعة المصنّعة تفضل ملك المصنع لحد ما تتفوتر للبراند — قبل كده مش هتظهر في نقطة البيع"
            : "Finished garments stay the Factory's until they are invoiced to the Brand — until then they cannot reach a till"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "قطع في المصنع" : "Units at the factory"}
          value={formatNumber(waitingUnits, locale)}
          tone={waitingUnits.greaterThan(0) ? "warn" : "neutral"}
          hint={ar ? "مش قابلة للبيع دلوقتي" : "Not sellable yet"}
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

      {/* ------------------------------------------------- awaiting transfer */}
      <Card
        className="mb-4"
        title={ar ? "في انتظار التحويل" : "Awaiting transfer"}
        description={
          ar
            ? "السعر جاي من التكلفة المجمّدة قبل ما التشغيلة تبدأ، فمش قابل للتعديل هنا"
            : "The price comes from the cost frozen before the run started, so it cannot be edited here"
        }
      >
        {pending.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "مفيش بضاعة تامّة في المصنع مستنية تحويل."
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
                ) : !mayTransfer ? (
                  <p className="text-sm text-ink-400">
                    <span className="num">{r.quantity}</span>{" "}
                    {ar ? "قطعة — مش من صلاحياتك تحوّلها." : "units — transferring is not yours to do."}
                  </p>
                ) : (
                  <TransferForm
                    locale={locale}
                    today={today}
                    destinations={destinations.map((d) => ({ id: d.id, label: name(d) }))}
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
