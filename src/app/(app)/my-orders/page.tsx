import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatNumber } from "@/lib/money";

/**
 * Everything one person is still waiting on.
 *
 * Somebody takes an order in a message and then has nowhere to look at it
 * again. It went into the books, and the books belong to the office: the
 * person who promised a customer a date has to ask somebody else whether the
 * parcel went, or walk to the factory to find out whether the piece is cut.
 * That is the thing this screen removes.
 *
 * Only their own, because this answers "what am I waiting on", not "how is the
 * shop doing", and the second question has its own screens behind capabilities
 * these roles do not hold.
 *
 * Not a figure in money anywhere on it. What is useful at this end of the job
 * is how many pieces, what state they are in and which ones have gone quiet;
 * what the shop made on them is a different question for different people, and
 * this screen stands where anybody walking past can read it.
 */
export default async function MyOrdersPage() {
  const session = await requirePermission("sales_order:create");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const today = new Date(new Date().toISOString().slice(0, 10));

  const [sales, promises] = await Promise.all([
    db.salesOrder.findMany({
      where: { createdByUserId: session.userId },
      select: {
        id: true,
        orderNumber: true,
        source: true,
        status: true,
        orderDate: true,
        shippedDate: true,
        deliveredDate: true,
        customer: { select: { name: true, phone: true } },
        lines: { select: { quantity: true } },
        shipments: {
          select: { status: true, courier: true, courierStatus: true, reference: true },
          orderBy: { createdAt: "desc" },
          take: 1,
        },
        returns: { select: { id: true } },
      },
      orderBy: [{ orderDate: "desc" }],
      take: 200,
    }),
    db.customOrder.findMany({
      where: { createdByUserId: session.userId },
      select: {
        id: true,
        orderNumber: true,
        status: true,
        quantity: true,
        promisedDate: true,
        customer: { select: { name: true, phone: true } },
        variant: {
          select: {
            sku: true,
            style: { select: { nameAr: true, nameEn: true } },
            colorCode: { select: { nameAr: true, nameEn: true } },
            sizeCode: { select: { code: true } },
          },
        },
        productionOrder: { select: { orderNumber: true, status: true } },
      },
      orderBy: [{ promisedDate: "asc" }, { createdAt: "desc" }],
      take: 200,
    }),
  ]);

  const piecesOf = (o: { lines: { quantity: number }[] }) =>
    o.lines.reduce((s, l) => s + l.quantity, 0);

  // Done is delivered, or cancelled. Everything else is still somebody's
  // problem, and while it is, it is the problem of whoever promised it.
  const openSales = sales.filter((o) => !["DELIVERED", "CANCELLED"].includes(o.status));
  const openPromises = promises.filter((p) =>
    ["PENDING", "IN_PRODUCTION", "READY"].includes(p.status),
  );

  const awaitingDespatch = openSales.filter((o) => o.shipments.length === 0 && !o.shippedDate);
  const onTheRoad = openSales.filter((o) => o.shipments.length > 0);
  const awaitingFactory = openPromises.filter((p) => p.status !== "READY");
  const readyToHandOver = openPromises.filter((p) => p.status === "READY");

  // Gone quiet, in the two ways that matter: a parcel the courier turned back,
  // and a promise whose day has passed with nothing to hand over.
  const trouble = [
    ...onTheRoad
      .filter((o) => ["RETURNED", "FAILED", "NEEDS_REVIEW"].includes(o.shipments[0].status))
      .map((o) => ({
        key: `s-${o.id}`,
        number: o.orderNumber,
        who: o.customer?.name ?? "—",
        what: ar ? "الطرد رجع أو اتعطّل" : "the parcel came back or stalled",
        detail: o.shipments[0].courierStatus ?? o.shipments[0].status,
      })),
    ...openPromises
      .filter((p) => p.promisedDate !== null && p.promisedDate < today && p.status !== "READY")
      .map((p) => ({
        key: `p-${p.id}`,
        number: p.orderNumber,
        who: p.customer.name,
        what: ar ? "فات ميعاده ولسه مش جاهز" : "past its promised day and not ready",
        detail: p.promisedDate!.toISOString().slice(0, 10),
      })),
  ];

  const dateText = (d: Date | null) => (d ? new Date(d).toISOString().slice(0, 10) : "—");

  const saleStatus = (s: string) =>
    ar
      ? { PENDING: "مستني", CONFIRMED: "متأكد", SHIPPED: "اتشحن", DELIVERED: "اتسلّم", CANCELLED: "اتلغى", RETURNED: "مرتجع" }[s] ?? s
      : { PENDING: "Pending", CONFIRMED: "Confirmed", SHIPPED: "Shipped", DELIVERED: "Delivered", CANCELLED: "Cancelled", RETURNED: "Returned" }[s] ?? s;

  const promiseStatus = (s: string) =>
    ar
      ? { PENDING: "مستني أمر إنتاج", IN_PRODUCTION: "بيتصنّع", READY: "جاهز للتسليم", DELIVERED: "اتسلّم", CANCELLED: "اتلغى" }[s] ?? s
      : { PENDING: "Awaiting a run", IN_PRODUCTION: "Being made", READY: "Ready to hand over", DELIVERED: "Handed over", CANCELLED: "Cancelled" }[s] ?? s;

  const shipmentStatus = (s: string) =>
    ar
      ? { SENT: "مع المندوب", IN_TRANSIT: "في الطريق", DELIVERED: "اتسلّم", NEEDS_REVIEW: "محتاج مراجعة", RETURNED: "راجع", FAILED: "اتعطّل" }[s] ?? s
      : s;

  return (
    <>
      <PageHeader
        title={ar ? "أوردراتي" : "My orders"}
        subtitle={
          ar
            ? "اللي انتي سجّلتيه ولسه مخلصش — إيه اللي مستني شحن، وإيه اللي مستني المصنع، وإيه اللي جاهز تسلّميه."
            : "What you took and has not finished — waiting on the courier, waiting on the factory, or ready to hand over."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "مستنية شحن" : "Waiting to go out"}
          value={formatNumber(awaitingDespatch.length, locale)}
          hint={ar ? "اتسجّلت ولسه ماخرجتش" : "taken, not despatched"}
          tone={awaitingDespatch.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "في الطريق" : "On the road"}
          value={formatNumber(onTheRoad.length, locale)}
          hint={ar ? "مع المندوب" : "with the courier"}
        />
        <StatTile
          label={ar ? "مستنية المصنع" : "Waiting on the factory"}
          value={formatNumber(awaitingFactory.length, locale)}
          hint={ar ? "لسه بتتعمل" : "still being made"}
          tone={awaitingFactory.length > 0 ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "جاهزة للتسليم" : "Ready to hand over"}
          value={formatNumber(readyToHandOver.length, locale)}
          hint={ar ? "كلّمي العميل" : "call the customer"}
          tone={readyToHandOver.length > 0 ? "good" : "neutral"}
        />
      </div>

      {trouble.length > 0 && (
        <Card
          className="mb-5"
          title={ar ? "دي محتاجاكي دلوقتي" : "These need you now"}
          description={
            ar
              ? "طرد رجع، أو وعد فات ميعاده — الاتنين العميل بيستنى فيهم رد."
              : "A parcel that came back, or a promise whose day has passed. In both the customer is waiting to hear."
          }
        >
          <DataTable
            headers={[
              ar ? "الأوردر" : "Order",
              ar ? "العميل" : "Customer",
              ar ? "إيه اللي حصل" : "What happened",
              "",
            ]}
            rows={trouble.map((t) => [
              <span key="n" className="num text-xs" dir="ltr">{t.number}</span>,
              <span key="w" className="font-medium">{t.who}</span>,
              <span key="x" className="text-bad">{t.what}</span>,
              <span key="d" className="text-xs text-ink-500" dir="ltr">{t.detail}</span>,
            ])}
          />
        </Card>
      )}

      <Card
        className="mb-5"
        title={ar ? "بيعاتي اللي لسه شغالة" : "My sales still in hand"}
        description={
          ar
            ? "اللي اتسلّم أو اتلغى مش هنا — دي بس اللي لسه عليها شغل."
            : "Delivered and cancelled are not here. This is what still has work on it."
        }
      >
        <DataTable
          headers={[
            ar ? "الأوردر" : "Order",
            ar ? "يوم" : "Day",
            ar ? "العميل" : "Customer",
            ar ? "قطع" : "Pieces",
            ar ? "الحالة" : "Status",
            ar ? "الشحن" : "Courier",
          ]}
          empty={ar ? "مفيش حاجة شغالة — كله اتسلّم" : "Nothing in hand"}
          rows={openSales.map((o) => [
            <span key="n" className="num text-xs" dir="ltr">
              {o.orderNumber}
              <span className="ms-2 text-[10px] text-ink-400">{o.source}</span>
            </span>,
            <span key="d" className="num text-xs" dir="ltr">{dateText(o.orderDate)}</span>,
            <span key="c">
              {o.customer?.name ?? "—"}
              {o.customer?.phone && (
                <span className="ms-2 num text-xs text-ink-400" dir="ltr">{o.customer.phone}</span>
              )}
            </span>,
            <span key="q" className="num">{formatNumber(piecesOf(o), locale)}</span>,
            <span key="s" className="flex items-center gap-1.5">
              <Badge tone={o.status === "SHIPPED" ? "info" : "warn"}>{saleStatus(o.status)}</Badge>
              {o.returns.length > 0 && (
                <Badge tone="bad">{ar ? "فيه مرتجع" : "returned"}</Badge>
              )}
            </span>,
            o.shipments.length > 0 ? (
              <span key="p" className="text-xs">
                <Badge
                  tone={
                    ["RETURNED", "FAILED"].includes(o.shipments[0].status)
                      ? "bad"
                      : o.shipments[0].status === "DELIVERED"
                        ? "good"
                        : "info"
                  }
                >
                  {shipmentStatus(o.shipments[0].status)}
                </Badge>
                <span className="ms-2 text-ink-400">{o.shipments[0].courier}</span>
              </span>
            ) : (
              <span key="p" className="text-xs text-warn">{ar ? "لسه ماخرجش" : "not out yet"}</span>
            ),
          ])}
        />
      </Card>

      <Card
        title={ar ? "اللي وعدت بيه" : "What I promised"}
        description={
          ar
            ? "الحاجات اللي اتعملت مخصوص. لما تبقى «جاهز للتسليم» كلّمي العميل وسلّميها من صفحة المودريتور."
            : "The made-to-order pieces. When one says ready, call the customer and hand it over from the moderator desk."
        }
      >
        <DataTable
          headers={[
            ar ? "الأوردر" : "Order",
            ar ? "العميل" : "Customer",
            ar ? "المطلوب" : "Piece",
            ar ? "عدد" : "Qty",
            ar ? "الحالة" : "Status",
            ar ? "أمر الإنتاج" : "Run",
            ar ? "موعده" : "Promised",
            "",
          ]}
          empty={ar ? "مفيش وعود مفتوحة" : "Nothing promised"}
          rows={openPromises.map((p) => [
            <span key="n" className="num text-xs" dir="ltr">{p.orderNumber}</span>,
            <span key="c">
              {p.customer.name}
              {p.customer.phone && (
                <span className="ms-2 num text-xs text-ink-400" dir="ltr">{p.customer.phone}</span>
              )}
            </span>,
            <span key="v" className="text-xs">
              <code dir="ltr" className="text-ink-400">{p.variant.sku}</code>
              <span className="ms-2">
                {ar ? p.variant.style.nameAr : p.variant.style.nameEn}
                {" · "}
                {ar ? p.variant.colorCode.nameAr : p.variant.colorCode.nameEn}
                {" · "}
                {p.variant.sizeCode.code}
              </span>
            </span>,
            <span key="q" className="num">{p.quantity}</span>,
            <Badge
              key="s"
              tone={p.status === "READY" ? "good" : p.status === "IN_PRODUCTION" ? "info" : "warn"}
            >
              {promiseStatus(p.status)}
            </Badge>,
            p.productionOrder ? (
              <span key="r" className="num text-xs" dir="ltr">{p.productionOrder.orderNumber}</span>
            ) : (
              <span key="r" className="text-xs text-warn">{ar ? "لسه مفيش" : "none yet"}</span>
            ),
            <span
              key="d"
              className={`num text-xs ${
                p.promisedDate && p.promisedDate < today && p.status !== "READY" ? "text-bad" : ""
              }`}
              dir="ltr"
            >
              {dateText(p.promisedDate)}
            </span>,
            p.status === "READY" ? (
              <Link key="a" href="/moderator" className="text-xs font-medium text-ink-900 underline">
                {ar ? "سلّميها" : "Hand over"}
              </Link>
            ) : (
              <span key="a" />
            ),
          ])}
        />
      </Card>
    </>
  );
}
