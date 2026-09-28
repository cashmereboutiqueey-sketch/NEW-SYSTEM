import Link from "next/link";
import { notFound } from "next/navigation";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { db } from "@/lib/db";
import { imageUrl } from "@/lib/images";
import { formatMoney, formatNumber } from "@/lib/money";
import { Badge, Card, PageHeader } from "@/components/ui";

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="border-b border-ink-100 py-2.5 last:border-0">
      <dt className="text-xs text-ink-500">{label}</dt>
      <dd className="mt-1 break-words text-sm font-medium text-ink-800">{children || "—"}</dd>
    </div>
  );
}

export default async function MyCustomOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const session = await requirePermission("sales_order:create");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const { id } = await params;
  const order = await db.customOrder.findFirst({
    where: { id, createdByUserId: session.userId },
    include: {
      customer: true,
      location: true,
      variant: { include: { style: true, colorCode: true, sizeCode: true } },
      productionOrder: true,
      salesOrder: { select: { orderNumber: true } },
    },
  });
  if (!order) notFound();

  const variant = order.variant;
  const styleName = ar ? variant.style.nameAr : variant.style.nameEn;
  const colourName = ar ? variant.colorCode.nameAr : variant.colorCode.nameEn;
  const photo = imageUrl(variant.imageName) ?? imageUrl(variant.style.imageName);
  const date = (value: Date | null) => value?.toISOString().slice(0, 10) ?? "—";
  const statusLabels: Record<string, string> = ar
    ? { PENDING: "مستني أمر إنتاج", IN_PRODUCTION: "بيتصنّع", READY: "جاهز للتسليم", DELIVERED: "اتسلّم", CANCELLED: "اتلغى" }
    : { PENDING: "Awaiting a run", IN_PRODUCTION: "Being made", READY: "Ready to hand over", DELIVERED: "Handed over", CANCELLED: "Cancelled" };
  const tone = order.status === "READY" || order.status === "DELIVERED" ? "good" : order.status === "CANCELLED" ? "warn" : "info";

  return (
    <>
      <div className="mb-3">
        <Link href="/my-orders" className="text-sm text-ink-500 underline underline-offset-4 hover:text-ink-900">
          {ar ? "← أوردراتي" : "← My orders"}
        </Link>
      </div>
      <PageHeader
        title={ar ? `تفاصيل الطلب ${order.orderNumber}` : `Order ${order.orderNumber}`}
        subtitle={ar ? "قطعة بتتصنّع مخصوص للعميل" : "Made to order for this customer"}
        actions={<Badge tone={tone}>{statusLabels[order.status] ?? order.status}</Badge>}
      />

      <Card title={ar ? "القطعة المطلوبة" : "Ordered item"} className="mb-4">
        <div className="flex gap-4">
          <div className="h-32 w-24 shrink-0 overflow-hidden rounded-lg bg-ink-100 sm:h-40 sm:w-32">
            {photo ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={photo} alt={`${styleName} · ${colourName}`} className="h-full w-full object-cover" />
            ) : (
              <div className="flex h-full items-center justify-center px-2 text-center text-xs text-ink-400">
                {ar ? "لا توجد صورة" : "No photo"}
              </div>
            )}
          </div>
          <div className="min-w-0 flex-1">
            <h2 className="font-semibold text-ink-900">{styleName}</h2>
            <p className="mt-1 text-xs text-ink-500" dir="ltr">{variant.sku}</p>
            <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-3 text-sm">
              <div>
                <dt className="text-xs text-ink-500">{ar ? "اللون" : "Colour"}</dt>
                <dd className="mt-1 inline-flex items-center gap-1.5 font-medium text-ink-800">
                  {variant.colorCode.hex && /^#[0-9a-fA-F]{3}([0-9a-fA-F]{3})?$/.test(variant.colorCode.hex) && (
                    <span className="h-3.5 w-3.5 rounded-full border border-ink-200" style={{ backgroundColor: variant.colorCode.hex }} aria-hidden="true" />
                  )}
                  {colourName}
                </dd>
              </div>
              <div><dt className="text-xs text-ink-500">{ar ? "المقاس" : "Size"}</dt><dd className="mt-1 font-medium text-ink-800" dir="ltr">{variant.sizeCode.code}</dd></div>
              <div><dt className="text-xs text-ink-500">{ar ? "الكمية" : "Quantity"}</dt><dd className="num mt-1 font-medium text-ink-800">{formatNumber(order.quantity, locale)}</dd></div>
            </dl>
          </div>
        </div>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title={ar ? "العميل والتسليم" : "Customer and handover"}>
          <dl>
            <Detail label={ar ? "العميل" : "Customer"}>{order.customer.name}</Detail>
            <Detail label={ar ? "الهاتف" : "Phone"}>{order.customer.phone}</Detail>
            {order.customer.email && <Detail label={ar ? "البريد الإلكتروني" : "Email"}>{order.customer.email}</Detail>}
            <Detail label={ar ? "مكان التسليم" : "Handover location"}>{ar ? order.location.nameAr : order.location.nameEn}</Detail>
            <Detail label={ar ? "الموعد المتفق عليه" : "Promised date"}>{date(order.promisedDate)}</Detail>
            {order.deliveredAt && <Detail label={ar ? "تاريخ التسليم" : "Delivered"}>{date(order.deliveredAt)}</Detail>}
            {order.cancelledAt && <Detail label={ar ? "تاريخ الإلغاء" : "Cancelled"}>{date(order.cancelledAt)}</Detail>}
          </dl>
        </Card>
        <Card title={ar ? "السعر والإنتاج" : "Price and production"}>
          <dl>
            <Detail label={ar ? "سعر القطعة" : "Unit price"}>{formatMoney(order.agreedUnitPrice, locale)}</Detail>
            <Detail label={ar ? "الإجمالي المتفق عليه" : "Agreed total"}>{formatMoney(order.agreedTotal, locale)}</Detail>
            <Detail label={ar ? "العربون" : "Deposit"}>{formatMoney(order.depositAmount, locale)}</Detail>
            <Detail label={ar ? "أمر الإنتاج" : "Production run"}>{order.productionOrder?.orderNumber}</Detail>
            {order.productionOrder && <Detail label={ar ? "حالة الإنتاج" : "Production status"}>{order.productionOrder.status}</Detail>}
            {order.salesOrder && <Detail label={ar ? "رقم البيع بعد التسليم" : "Sale after handover"}>{order.salesOrder.orderNumber}</Detail>}
          </dl>
        </Card>
      </div>

      {(order.notes || order.cancelReason) && (
        <Card title={ar ? "ملاحظات" : "Notes"} className="mt-4">
          <dl>
            {order.notes && <Detail label={ar ? "تفاصيل الطلب" : "Order notes"}><span className="whitespace-pre-wrap">{order.notes}</span></Detail>}
            {order.cancelReason && <Detail label={ar ? "سبب الإلغاء" : "Cancellation reason"}>{order.cancelReason}</Detail>}
          </dl>
        </Card>
      )}
    </>
  );
}
