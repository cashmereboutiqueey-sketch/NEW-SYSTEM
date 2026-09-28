import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { db } from "@/lib/db";
import { imageUrl } from "@/lib/images";
import { dec, formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { can } from "@/core/permissions";
import { Badge, Card, PageHeader } from "@/components/ui";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 border-b border-ink-100 py-2.5 last:border-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-ink-800">{children || "—"}</dd>
    </div>
  );
}

export default async function MySalesOrderPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const session = await requirePermission("sales_order:create");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const seeFinancials = can(session.role, "journal:view") || can(session.role, "transfer_price:view");
  const { id } = await params;

  const order = await db.salesOrder.findFirst({
    where: { id, createdByUserId: session.userId },
    include: {
      channel: true,
      customer: true,
      createdBy: true,
      location: true,
      courierZone: true,
      lines: {
        include: { variant: { include: { style: true, colorCode: true, sizeCode: true } } },
      },
      payments: { orderBy: { createdAt: "asc" } },
      shipments: { orderBy: { createdAt: "desc" } },
      returns: { include: { variant: true }, orderBy: { createdAt: "desc" } },
    },
  });
  if (!order) notFound();

  const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? "—";
  const name = (value: { nameAr: string; nameEn: string } | null) =>
    value ? (ar ? value.nameAr : value.nameEn) : "—";
  const statusLabels: Record<string, string> = ar
    ? { PENDING: "معلّق", CONFIRMED: "مؤكد", SHIPPED: "اتشحن", DELIVERED: "اتسلّم", CANCELLED: "ملغي", RETURNED: "مرتجع" }
    : { PENDING: "Pending", CONFIRMED: "Confirmed", SHIPPED: "Shipped", DELIVERED: "Delivered", CANCELLED: "Cancelled", RETURNED: "Returned" };
  const sourceLabels: Record<string, string> = ar
    ? { SHOPIFY: "الموقع", MODERATOR: "السوشيال", POS: "المعرض", EXHIBITION: "بازار", WHOLESALE: "جملة", MANUAL: "يدوي" }
    : { SHOPIFY: "Website", MODERATOR: "Social", POS: "Showroom", EXHIBITION: "Exhibition", WHOLESALE: "Wholesale", MANUAL: "Manual" };
  const paymentLabels: Record<string, string> = ar
    ? { CASH: "نقدي", CARD: "بطاقة", COD: "عند الاستلام", BANK_TRANSFER: "تحويل بنكي", INSTAPAY: "إنستا باي", WALLET: "محفظة", STORE_CREDIT: "رصيد متجر", DEPOSIT: "عربون" }
    : { CASH: "Cash", CARD: "Card", COD: "Cash on delivery", BANK_TRANSFER: "Bank transfer", INSTAPAY: "InstaPay", WALLET: "Wallet", STORE_CREDIT: "Store credit", DEPOSIT: "Deposit" };
  const paymentStatusLabels: Record<string, string> = ar
    ? { PENDING: "معلّق", COLLECTED: "متحصل", FAILED: "فشل", REFUNDED: "مسترد" }
    : { PENDING: "Pending", COLLECTED: "Collected", FAILED: "Failed", REFUNDED: "Refunded" };
  const shipmentLabels: Record<string, string> = ar
    ? { SENT: "اترسل", IN_TRANSIT: "في الطريق", DELIVERED: "اتسلّم", NEEDS_REVIEW: "محتاج مراجعة", RETURNED: "راجع", FAILED: "فشل التسليم", POSTPONED: "اتأجل" }
    : { SENT: "Sent", IN_TRANSIT: "In transit", DELIVERED: "Delivered", NEEDS_REVIEW: "Needs review", RETURNED: "Returned", FAILED: "Failed", POSTPONED: "Postponed" };
  const inPerson = order.source === "POS" || order.source === "EXHIBITION";
  const statusText = inPerson && order.status === "DELIVERED"
    ? ar ? order.source === "EXHIBITION" ? "اتسلّم من البازار" : "اتسلّم من المحل" : "Handed over in person"
    : statusLabels[order.status] ?? order.status;
  const statusTone = order.status === "DELIVERED" ? "good" : order.status === "CANCELLED" || order.status === "RETURNED" ? "warn" : "info";
  const quantity = order.lines.reduce((total, line) => total + line.quantity, 0);
  const totalDue = dec(order.netAmount).plus(dec(order.shippingAmount));

  return (
    <>
      <div className="mb-3">
        <Link href="/my-orders" className="text-sm text-ink-500 underline underline-offset-4 hover:text-ink-900">
          {ar ? "← أوردراتي" : "← My orders"}
        </Link>
      </div>
      <PageHeader
        title={ar ? `تفاصيل الطلب ${order.orderNumber}` : `Order ${order.orderNumber}`}
        subtitle={`${date(order.orderDate)} · ${sourceLabels[order.source] ?? order.source} · ${name(order.channel)}`}
        actions={<Badge tone={statusTone}>{statusText}</Badge>}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <div className="card p-4">
          <p className="text-xs text-ink-500">{ar ? "القطع" : "Items"}</p>
          <p className="num mt-1 text-xl font-semibold text-ink-900">{formatNumber(quantity, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-ink-500">{ar ? "قيمة الطلب" : "Order total"}</p>
          <p className="num mt-1 text-xl font-semibold text-ink-900">{formatMoney(totalDue, locale)}</p>
        </div>
        <div className="card p-4">
          <p className="text-xs text-ink-500">{ar ? "الحالة" : "Status"}</p>
          <div className="mt-2"><Badge tone={statusTone}>{statusText}</Badge></div>
        </div>
      </div>

      <Card title={ar ? "المنتجات" : "Items"} description={ar ? "الصورة واللون والمقاس لكل قطعة في الطلب" : "Photo, colour and size for every item"} className="mb-4">
        <div className="divide-y divide-ink-100">
          {order.lines.map((line) => {
            const variant = line.variant;
            const style = variant.style;
            const photo = imageUrl(variant.imageName) ?? imageUrl(style.imageName);
            const styleName = name(style);
            return (
              <div key={line.id} className="flex gap-4 py-4 first:pt-0 last:pb-0">
                <div className="h-24 w-20 shrink-0 overflow-hidden rounded-lg bg-ink-100 sm:h-28 sm:w-24">
                  {photo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={photo} alt={`${styleName} · ${name(variant.colorCode)}`} className="h-full w-full object-cover" />
                  ) : (
                    <div className="flex h-full items-center justify-center px-2 text-center text-xs text-ink-400">
                      {ar ? "لا توجد صورة" : "No photo"}
                    </div>
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <h3 className="font-semibold text-ink-900">{styleName}</h3>
                  <p className="mt-0.5 text-xs text-ink-500" dir="ltr">{variant.sku}</p>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-700">
                    <span className="inline-flex items-center gap-1.5">
                      {ar ? "اللون" : "Colour"}:
                      {variant.colorCode.hex && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(variant.colorCode.hex) && (
                        <span className="h-3.5 w-3.5 rounded-full border border-ink-200" style={{ backgroundColor: variant.colorCode.hex }} aria-hidden="true" />
                      )}
                      <strong>{name(variant.colorCode)}</strong>
                    </span>
                    <span>{ar ? "المقاس" : "Size"}: <strong dir="ltr">{variant.sizeCode.code}</strong></span>
                    <span>{ar ? "الكمية" : "Quantity"}: <strong className="num">{formatNumber(line.quantity, locale)}</strong></span>
                  </div>
                  <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-ink-700">
                    <span>{ar ? "سعر القطعة" : "Unit price"}: <strong className="num">{formatMoney(line.netPrice, locale)}</strong></span>
                    {dec(line.discountPct).greaterThan(0) && (
                      <span>{ar ? "الخصم" : "Discount"}: <strong className="num">{formatPercent(line.discountPct, locale)}</strong></span>
                    )}
                    <span>{ar ? "الإجمالي" : "Line total"}: <strong className="num text-ink-900">{formatMoney(line.lineTotal, locale)}</strong></span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title={inPerson ? ar ? "العميل" : "Customer" : ar ? "العميل والتوصيل" : "Customer and delivery"}>
          <dl>
            <Detail label={ar ? "العميل" : "Customer"}>{order.customer?.name ?? order.recipientName}</Detail>
            {!inPerson && <Detail label={ar ? "اسم المستلم" : "Recipient"}>{order.recipientName}</Detail>}
            <Detail label={ar ? "رقم الهاتف" : "Phone"}>{order.shippingPhone ?? order.customer?.phone}</Detail>
            {order.secondPhone && <Detail label={ar ? "رقم بديل" : "Other phone"}>{order.secondPhone}</Detail>}
            {order.customer?.email && <Detail label={ar ? "البريد الإلكتروني" : "Email"}>{order.customer.email}</Detail>}
            {!inPerson && <Detail label={ar ? "العنوان" : "Address"}>{order.addressLine}</Detail>}
            {!inPerson && <Detail label={ar ? "المدينة / المنطقة" : "City / area"}>{[order.governorate, order.city].filter(Boolean).join(" · ")}</Detail>}
            {!inPerson && order.courierZone && <Detail label={ar ? "منطقة الشحن" : "Courier zone"}>{order.courierZone.region}</Detail>}
          </dl>
        </Card>
        <Card title={ar ? "ملخص الحساب" : "Payment summary"}>
          <dl>
            <Detail label={ar ? "قيمة المنتجات قبل الخصم" : "Items before discount"}>{formatMoney(order.grossAmount, locale)}</Detail>
            <Detail label={ar ? "الخصم" : "Discount"}>{formatMoney(order.discountAmount, locale)}</Detail>
            <Detail label={ar ? "قيمة المنتجات" : "Items total"}>{formatMoney(order.netAmount, locale)}</Detail>
            <Detail label={ar ? "الشحن" : "Shipping"}>{formatMoney(order.shippingAmount, locale)}</Detail>
            <Detail label={ar ? "المطلوب من العميل" : "Total due"}>{formatMoney(totalDue, locale)}</Detail>
            {seeFinancials && (
              <>
                <Detail label={ar ? "تكلفة المنتجات" : "Cost of goods"}>{formatMoney(order.cogsAmount, locale)}</Detail>
                <Detail label={ar ? "رسوم الدفع" : "Payment fees"}>{formatMoney(order.paymentFee, locale)}</Detail>
              </>
            )}
          </dl>
        </Card>
      </div>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <Card title={ar ? "المدفوعات" : "Payments"}>
          {order.payments.length === 0 ? <p className="text-sm text-ink-400">{ar ? "لا توجد مدفوعات مسجلة" : "No payments recorded"}</p> : (
            <div className="divide-y divide-ink-100">
              {order.payments.map((payment) => (
                <div key={payment.id} className="flex flex-wrap items-start justify-between gap-2 py-3 first:pt-0 last:pb-0">
                  <div>
                    <p className="text-sm font-medium text-ink-800">{paymentLabels[payment.method] ?? payment.method}</p>
                    <p className="mt-0.5 text-xs text-ink-500">{paymentStatusLabels[payment.status] ?? payment.status}{payment.collectedAt ? ` · ${date(payment.collectedAt)}` : ""}</p>
                    {payment.reference && <p className="mt-0.5 break-all text-xs text-ink-500" dir="ltr">{payment.reference}</p>}
                  </div>
                  <strong className="num text-sm text-ink-900">{formatMoney(payment.amount, locale)}</strong>
                </div>
              ))}
            </div>
          )}
          {order.payments.some((payment) => payment.method === "COD" && payment.status === "PENDING"
            || payment.method === "CASH" && order.source === "MODERATOR") && (
            <p className="mt-3 rounded-lg bg-ink-50 px-3 py-2 text-xs text-ink-600">
              {ar
                ? "لو العميل حوّل InstaPay بدل الكاش أو الدفع للمندوب، صحّح طريقة الدفع من شاشة التسويات بعد التأكد إن التحويل وصل. ما تسجّلش تحصيل تاني على نفس الأوردر."
                : "If the customer transferred by InstaPay instead of cash or COD, correct the payment in Reconciliation after confirming receipt. Do not record a second collection for this order."}
              {can(session.role, "payment:create") && can(session.role, "journal:view") && (
                <> <Link href="/reconciliation" className="font-medium text-rose-deep underline">{ar ? "افتح التسويات" : "Open Reconciliation"}</Link></>
              )}
            </p>
          )}
        </Card>
        <Card title={inPerson ? ar ? "التسليم المباشر" : "In-person handover" : ar ? "الشحن وحركة الطلب" : "Shipping and fulfilment"}>
          <dl>
            <Detail label={inPerson ? ar ? "مكان البيع" : "Sale location" : ar ? "مكان التجهيز" : "Fulfilment location"}>{name(order.location)}</Detail>
            {!inPerson && <Detail label={ar ? "تاريخ الشحن" : "Shipped"}>{date(order.shippedDate)}</Detail>}
            <Detail label={inPerson ? ar ? "تاريخ الاستلام" : "Handed over on" : ar ? "تاريخ التسليم" : "Delivered"}>{date(order.deliveredDate)}</Detail>
            {order.dueDate && <Detail label={ar ? "ميعاد التحصيل" : "Payment due"}>{date(order.dueDate)}</Detail>}
            {order.collectedDate && <Detail label={ar ? "تاريخ التحصيل" : "Collected"}>{date(order.collectedDate)}</Detail>}
            {order.shipments.map((shipment) => (
              <Detail key={shipment.id} label={ar ? "الشحنة" : "Shipment"}>
                {shipment.courier} · {shipmentLabels[shipment.status] ?? shipment.status}
                {shipment.courierStatus ? ` · ${shipment.courierStatus}` : ""}
              </Detail>
            ))}
          </dl>
        </Card>
      </div>

      {(order.notes || order.returns.length > 0 || order.createdBy || order.externalId) && (
        <Card title={ar ? "معلومات إضافية" : "More details"}>
          <dl>
            {order.createdBy && <Detail label={ar ? "سجّله" : "Entered by"}>{order.createdBy.name}</Detail>}
            {order.externalId && <Detail label={ar ? "مرجع المصدر" : "Source reference"}>{order.externalId}</Detail>}
            {order.notes && <Detail label={ar ? "ملاحظات" : "Notes"}><span className="whitespace-pre-wrap">{order.notes}</span></Detail>}
            {order.returns.map((item) => (
              <Detail key={item.id} label={ar ? "مرتجع" : "Return"}>
                {item.returnNumber} · {item.variant.sku} · {formatNumber(item.quantity, locale)} {ar ? "قطعة" : "unit(s)"} · {formatMoney(item.refundAmount, locale)}
              </Detail>
            ))}
          </dl>
        </Card>
      )}
    </>
  );
}
