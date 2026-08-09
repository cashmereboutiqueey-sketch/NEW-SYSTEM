import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber } from "@/lib/money";
import { dec } from "@/lib/money";
import { PurchaseOrderForm, GoodsReceiptForm } from "./purchase-forms";

/**
 * المشتريات — purchasing.
 *
 * Raising an order before goods arrive is what makes purchase price variance
 * possible: the invoice saying 112 when the order said 95 is the number that
 * explains why a garment suddenly costs more, and it only exists because the
 * intent was written down first.
 */
export default async function PurchasingPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayOrder = can(session.role, "purchase_order:create");
  const mayReceive = can(session.role, "goods_receipt:create");

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const [orders, suppliers, materials, locations] = await Promise.all([
    db.purchaseOrder.findMany({
      include: {
        supplier: true,
        lines: { include: { material: { include: { uom: true } } } },
        receipts: { include: { lines: true } },
      },
      orderBy: [{ orderDate: "desc" }, { createdAt: "desc" }],
      take: 30,
    }),
    db.supplier.findMany({ where: { isActive: true }, orderBy: { nameEn: "asc" } }),
    db.material.findMany({
      where: { isActive: true },
      include: { uom: true },
      orderBy: [{ type: "asc" }, { code: "asc" }],
    }),
    db.location.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const today = new Date().toISOString().slice(0, 10);

  const open = orders.filter(
    (o) => o.status === "CONFIRMED" || o.status === "PARTIALLY_RECEIVED",
  );
  const committed = open.reduce(
    (s, o) =>
      s.plus(
        o.lines.reduce(
          (t, l) =>
            t.plus(
              dec(l.effectiveCost).times(dec(l.quantity).minus(dec(l.receivedQty))),
            ),
          dec(0),
        ),
      ),
    dec(0),
  );

  const totalVariance = orders.reduce(
    (s, o) =>
      s.plus(
        o.receipts.reduce(
          (t, r) => t.plus(r.lines.reduce((x, l) => x.plus(dec(l.priceVariance)), dec(0))),
          dec(0),
        ),
      ),
    dec(0),
  );

  const statusTone: Record<string, "neutral" | "info" | "warn" | "good" | "bad"> = {
    DRAFT: "neutral", CONFIRMED: "info", PARTIALLY_RECEIVED: "warn",
    RECEIVED: "good", CANCELLED: "bad",
  };
  const statusLabel: Record<string, string> = ar
    ? {
        DRAFT: "مسودة", CONFIRMED: "مؤكد", PARTIALLY_RECEIVED: "استلام جزئي",
        RECEIVED: "مستلم", CANCELLED: "ملغي",
      }
    : {
        DRAFT: "Draft", CONFIRMED: "Confirmed", PARTIALLY_RECEIVED: "Part received",
        RECEIVED: "Received", CANCELLED: "Cancelled",
      };

  return (
    <>
      <PageHeader
        title={ar ? "المشتريات" : "Purchasing"}
        subtitle={
          ar
            ? "الأمر بيتسجّل قبل الاستلام عشان فرق السعر يبقى ظاهر ومفسَّر"
            : "The order is recorded before delivery, so a price difference is visible and explained"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "أوامر مفتوحة" : "Open orders"}
          value={formatNumber(open.length, locale)}
          tone={open.length > 0 ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "ملتزم به ولم يُستلم" : "Committed, not received"}
          value={formatMoney(committed, locale)}
          hint={ar ? "بيدخل في توقّع الكاش" : "Feeds the cash forecast"}
        />
        <StatTile
          label={ar ? "فرق أسعار الشراء" : "Purchase price variance"}
          value={formatMoney(totalVariance, locale)}
          tone={totalVariance.greaterThan(0) ? "bad" : totalVariance.lessThan(0) ? "good" : "neutral"}
          hint={ar ? "الفاتورة مقابل الأمر" : "Invoice against order"}
        />
      </div>

      {mayOrder && (
        <Card className="mb-4" title={ar ? "أمر شراء جديد" : "New purchase order"}>
          {suppliers.length === 0 || materials.length === 0 ? (
            <p className="py-4 text-sm text-ink-500">
              {ar
                ? "محتاج مورد وخامة واحدة على الأقل قبل ما تعمل أمر شراء."
                : "You need at least one supplier and one material before raising an order."}
            </p>
          ) : (
            <PurchaseOrderForm
              locale={locale}
              today={today}
              suppliers={suppliers.map((s) => ({
                id: s.id, label: name(s), creditDays: s.creditDays,
              }))}
              materials={materials.map((m) => ({
                id: m.id, code: m.code, nameEn: m.nameEn, nameAr: m.nameAr,
                uom: m.uom.code, basePrice: m.basePrice.toString(),
                moq: m.moq?.toString() ?? null,
              }))}
            />
          )}
        </Card>
      )}

      {/* ------------------------------------------------ pending receipts */}
      {mayReceive &&
        open.map((o) => {
          const outstanding = o.lines.filter((l) =>
            dec(l.quantity).greaterThan(dec(l.receivedQty)),
          );
          if (outstanding.length === 0) return null;

          return (
            <Card
              key={o.id}
              className="mb-4"
              title={`${ar ? "استلام" : "Receive"} ${o.poNumber}`}
              description={`${name(o.supplier)} · ${ar ? "متوقع" : "expected"} ${o.expectedDate?.toISOString().slice(0, 10) ?? "—"}`}
            >
              <GoodsReceiptForm
                locale={locale}
                purchaseOrderId={o.id}
                poNumber={o.poNumber}
                entityId={factory.id}
                today={today}
                locations={locations.map((l) => ({ id: l.id, label: name(l) }))}
                lines={outstanding.map((l) => ({
                  purchaseOrderLineId: l.id,
                  code: l.material.code,
                  name: name(l.material),
                  outstanding: Number(dec(l.quantity).minus(dec(l.receivedQty))),
                  orderedPrice: Number(l.unitPrice),
                }))}
              />
            </Card>
          );
        })}

      <Card title={ar ? "أوامر الشراء" : "Purchase orders"}>
        {orders.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لا توجد أوامر شراء بعد." : "No purchase orders yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الأمر" : "Order",
              ar ? "المورد" : "Supplier",
              ar ? "التاريخ" : "Date",
              ar ? "السداد" : "Due",
              ar ? "أسطر" : "Lines",
              ar ? "القيمة" : "Value",
              ar ? "فرق السعر" : "Variance",
              ar ? "الحالة" : "Status",
            ]}
            rows={orders.map((o) => {
              const value = o.lines.reduce(
                (s, l) => s.plus(dec(l.effectiveCost).times(dec(l.quantity))),
                dec(0),
              );
              const variance = o.receipts.reduce(
                (s, r) => s.plus(r.lines.reduce((t, l) => t.plus(dec(l.priceVariance)), dec(0))),
                dec(0),
              );
              return [
                <code key={`${o.id}-n`} dir="ltr" className="text-xs text-ink-500">{o.poNumber}</code>,
                <span key={`${o.id}-s`}>{name(o.supplier)}</span>,
                <span key={`${o.id}-d`} className="num" dir="ltr">
                  {o.orderDate.toISOString().slice(0, 10)}
                </span>,
                <span key={`${o.id}-du`} className="num" dir="ltr">
                  {o.dueDate?.toISOString().slice(0, 10) ?? "—"}
                </span>,
                <span key={`${o.id}-l`} className="num">{o.lines.length}</span>,
                <span key={`${o.id}-v`} className="num">{formatMoney(value, locale)}</span>,
                <span
                  key={`${o.id}-pv`}
                  className={
                    variance.greaterThan(0) ? "num text-bad" : variance.lessThan(0) ? "num text-good" : "num text-ink-400"
                  }
                >
                  {variance.isZero() ? "—" : formatMoney(variance, locale)}
                </span>,
                <Badge key={`${o.id}-st`} tone={statusTone[o.status]}>
                  {statusLabel[o.status]}
                </Badge>,
              ];
            })}
          />
        )}
      </Card>
    </>
  );
}
