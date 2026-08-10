import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { db } from "@/lib/db";
import { customOrderList, depositsHeld, availableRuns } from "@/lib/custom-orders";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { TakeOrderForm } from "./take-order-form";
import { OrderActions } from "./order-actions";

/**
 * الأوردرات الخاصة — a garment somebody wants that does not exist yet.
 *
 * The number worth looking at is not the value of the promises, it is what is
 * uncovered: a bespoke piece nobody collects is worth almost nothing, because
 * it was cut to one person's measurements and taste. The deposit is the only
 * thing standing between the shop and that loss, so it is on the screen next
 * to every order rather than buried in a detail page.
 */
export default async function CustomOrdersPage() {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayTake = can(session.role, "sales_order:create");
  const mayHandleMoney = can(session.role, "payment:create");
  const mayPlan = can(session.role, "production:create");

  const [orders, held, brand, customers, variants, channel, locations] = await Promise.all([
    customOrderList(true),
    depositsHeld(),
    db.entity.findFirstOrThrow({ where: { kind: "BRAND" } }),
    db.customer.findMany({
      where: { isActive: true },
      select: { id: true, name: true, phone: true },
      orderBy: { name: "asc" },
      take: 300,
    }),
    db.variant.findMany({
      where: { isActive: true },
      include: { style: true, colorCode: true, sizeCode: true },
      orderBy: { sku: "asc" },
      take: 500,
    }),
    db.salesChannel.findFirst(),
    db.location.findMany({
      where: { isActive: true, kind: { in: ["SHOWROOM", "STORE"] } },
      orderBy: { sortOrder: "asc" },
    }),
  ]);

  const open = orders.filter((o) =>
    ["PENDING", "IN_PRODUCTION", "READY"].includes(o.status),
  );
  const finished = orders.filter((o) => ["DELIVERED", "CANCELLED"].includes(o.status));

  const promised = open.reduce((s, o) => s.plus(dec(o.agreedTotal)), dec(0));
  const uncovered = open.reduce((s, o) => s.plus(dec(o.atRisk)), dec(0));

  // Runs the planner could attach, gathered per style so the row can offer them.
  const runsByStyle = new Map<string, Awaited<ReturnType<typeof availableRuns>>>();
  for (const o of open) {
    if (o.status === "PENDING" && !runsByStyle.has(o.styleId)) {
      runsByStyle.set(o.styleId, await availableRuns(o.styleId));
    }
  }

  const dateText = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : "—";

  const statusLabel = (s: string) =>
    ar
      ? { PENDING: "مستني", IN_PRODUCTION: "بيتصنّع", READY: "جاهز", DELIVERED: "اتسلّم", CANCELLED: "اتلغى" }[s] ?? s
      : { PENDING: "Pending", IN_PRODUCTION: "In production", READY: "Ready", DELIVERED: "Delivered", CANCELLED: "Cancelled" }[s] ?? s;

  const statusTone = (s: string) =>
    ({ PENDING: "warn", IN_PRODUCTION: "info", READY: "good", DELIVERED: "neutral", CANCELLED: "neutral" }[s] ?? "neutral") as
      "warn" | "info" | "good" | "neutral";

  return (
    <>
      <PageHeader
        title={ar ? "أوردرات خاصة" : "Made to order"}
        subtitle={
          ar
            ? "حاجة الزبون عايزها ومش موجودة — بتتصنّع مخصوص وتتسلّم له."
            : "A garment the shop does not have, made for one customer."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "أوردرات شغالة" : "Open orders"}
          value={formatNumber(open.length)}
          tone={open.length > 0 ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "عرابين محتجزة" : "Deposits held"}
          value={formatMoney(held.toString())}
          hint={ar ? "فلوس الناس لسه مش إيراد" : "customers' money, not income"}
          tone="neutral"
        />
        <StatTile
          label={ar ? "مكشوف من غير عربون" : "Uncovered"}
          value={formatMoney(uncovered.toString())}
          hint={
            ar
              ? `من ${formatMoney(promised.toString())} متعهد بيها`
              : `of ${formatMoney(promised.toString())} promised`
          }
          tone={uncovered.greaterThan(0) ? "bad" : "good"}
        />
      </div>

      {mayTake && channel && locations.length > 0 && (
        <div className="mb-5">
          <Card
            title={ar ? "اكتب أوردر جديد" : "Take an order"}
            description={
              ar
                ? "العربون اختياري. من غيره المحل شايل المخاطرة كلها لو الزبون ماجاش."
                : "The deposit is optional. Without one the shop carries the whole risk."
            }
          >
            <TakeOrderForm
              ar={ar}
              entityId={brand.id}
              customers={customers}
              variants={variants.map((v) => ({
                id: v.id,
                sku: v.sku,
                label: `${v.sku} · ${ar ? v.style.nameAr : v.style.nameEn} · ${
                  ar ? v.colorCode.nameAr : v.colorCode.nameEn
                } · ${v.sizeCode.code}`,
                retailPrice: v.style.retailPrice ? dec(v.style.retailPrice).toString() : "",
              }))}
              locations={locations.map((l) => ({ id: l.id, name: ar ? l.nameAr : l.nameEn }))}
            />
          </Card>
        </div>
      )}

      <div className="mb-5">
        <Card
          title={ar ? "شغالة دلوقتي" : "In hand"}
          description={
            ar
              ? "«مكشوف» يعني اللي المحل هيخسره لو الزبون ماجاش يستلم."
              : "Uncovered is what the shop loses if the customer never comes back."
          }
        >
          <DataTable
            headers={[
              ar ? "رقم" : "No.",
              ar ? "الزبون" : "Customer",
              ar ? "الطلب" : "Item",
              ar ? "الحالة" : "Status",
              ar ? "الميعاد" : "Promised",
              ar ? "الاتفاق" : "Agreed",
              ar ? "عربون" : "Deposit",
              ar ? "مكشوف" : "Uncovered",
              "",
            ]}
            empty={ar ? "مفيش أوردرات خاصة دلوقتي" : "No custom orders open"}
            rows={open.map((o) => [
              <span key="n" className="num text-xs" dir="ltr">{o.orderNumber}</span>,
              <span key="c">
                <span className="font-medium text-ink-900">{o.customerName}</span>
                {o.customerPhone && (
                  <span className="ms-2 num text-xs text-ink-400" dir="ltr">
                    {o.customerPhone}
                  </span>
                )}
              </span>,
              <span key="i" className="text-xs">
                {o.styleName} · {o.colour} · {o.size}
                {o.quantity > 1 && <strong className="ms-1">×{o.quantity}</strong>}
              </span>,
              <span key="s" className="flex items-center gap-1.5">
                <Badge tone={statusTone(o.status)}>{statusLabel(o.status)}</Badge>
                {o.runNumber && (
                  <span className="num text-[11px] text-ink-400" dir="ltr">
                    {o.runNumber}
                  </span>
                )}
              </span>,
              <span key="p" className="num text-xs" dir="ltr">{dateText(o.promisedDate)}</span>,
              <span key="t" className="num">{formatMoney(o.agreedTotal)}</span>,
              <span key="d" className="num">{formatMoney(o.deposit)}</span>,
              dec(o.atRisk).greaterThan(0) ? (
                <span key="r" className="num text-bad">{formatMoney(o.atRisk)}</span>
              ) : (
                <span key="r" className="text-good">—</span>
              ),
              <OrderActions
                key="a"
                ar={ar}
                order={{
                  id: o.id,
                  status: o.status,
                  atRisk: o.atRisk,
                  deposit: o.deposit,
                }}
                channelId={channel?.id ?? ""}
                runs={(runsByStyle.get(o.styleId) ?? []).map((r) => ({
                  id: r.id,
                  label: `${r.orderNumber} · ${r.plannedQty} ${ar ? "قطعة" : "pcs"} · ${r.status}`,
                }))}
                mayHandleMoney={mayHandleMoney}
                mayPlan={mayPlan}
                mayDeliver={mayTake}
              />,
            ])}
          />
        </Card>
      </div>

      <Card title={ar ? "خلصت" : "Finished"}>
        <DataTable
          headers={[
            ar ? "رقم" : "No.",
            ar ? "الزبون" : "Customer",
            ar ? "الحالة" : "Status",
            ar ? "الاتفاق" : "Agreed",
            ar ? "الفاتورة" : "Invoice",
          ]}
          empty={ar ? "لسه مفيش" : "Nothing yet"}
          rows={finished.slice(0, 50).map((o) => [
            <span key="n" className="num text-xs" dir="ltr">{o.orderNumber}</span>,
            o.customerName,
            <Badge key="s" tone={o.status === "CANCELLED" ? "bad" : "good"}>
              {statusLabel(o.status)}
            </Badge>,
            <span key="t" className="num">{formatMoney(o.agreedTotal)}</span>,
            <span key="i" className="num text-xs" dir="ltr">
              {o.salesOrderNumber ?? "—"}
            </span>,
          ])}
        />
      </Card>

      <p className="mt-4 text-xs text-ink-500">
        {ar
          ? "العربون بيتسجّل التزام على المحل مش إيراد، وبيتحوّل لإيراد يوم التسليم بس. لو الأوردر اتلغى بيترجّع."
          : "A deposit is recorded as money the shop owes, not as income. It becomes revenue only on the day of delivery, and is returned if the order is cancelled."}
      </p>
    </>
  );
}
