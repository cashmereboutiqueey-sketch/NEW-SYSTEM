import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { sellableStock } from "@/lib/pos";
import { makeabilityByStyle } from "@/lib/made-to-order";
import { courierZones } from "@/lib/shipping";
import { customOrderList, depositsHeld, availableRuns } from "@/lib/custom-orders";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { dec, formatMoney, formatNumber } from "@/lib/money";
import { ModeratorOrderForm } from "../sales/moderator-form";
import { MakeToOrderForm, type MakeableVariant } from "./make-form";
import { OrderActions } from "./order-actions";

/**
 * One desk for an order that arrived as a message.
 *
 * Both halves of the same conversation live here, because on the shop floor
 * they are the same conversation. Somebody asks for a piece; either it is on
 * the shelf, in which case it is sold, or it is not, in which case the only
 * question worth asking is whether the cloth exists — and that question was
 * previously answered by walking to the factory.
 *
 * What the two halves must never become is one record. A sale relieves stock
 * and books revenue today. A promise books neither: the deposit is money the
 * shop is holding for somebody else until the garment is in their hands.
 * Collapsing them would book income for a coat nobody has cut and then try to
 * take it out of stock that is not there.
 *
 * The whole life of a promise lives here too — the deposit, the run, marking
 * it ready, handing it over, calling it off — because it started here and a
 * second screen for the rest of it is how an order sits for a week waiting
 * for somebody to notice it.
 */
export default async function ModeratorPage() {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayTake = can(session.role, "sales_order:create");
  const mayPlan = can(session.role, "production:create");
  const mayHandleMoney = can(session.role, "payment:create");
  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [customers, channels, brandLocations, collectLocations, zones, variants, makeable, promises] =
    await Promise.all([
      db.customer.findMany({
        where: { isSuppressed: false, mergedIntoId: null },
        select: { id: true, name: true, phone: true },
        orderBy: { name: "asc" },
        take: 500,
      }),
      db.salesChannel.findMany({ where: { isActive: true }, orderBy: { nameEn: "asc" } }),
      db.location.findMany({
        where: { isActive: true, entityId: brand.id },
        orderBy: { sortOrder: "asc" },
      }),
      db.location.findMany({
        where: { isActive: true, kind: { in: ["SHOWROOM", "STORE"] } },
        orderBy: { sortOrder: "asc" },
      }),
      courierZones(),
      db.variant.findMany({
        where: { isActive: true },
        include: { style: true, colorCode: true, sizeCode: true },
        orderBy: { sku: "asc" },
        take: 500,
      }),
      makeabilityByStyle(),
      customOrderList(true),
    ]);

  const held = await depositsHeld();
  const open = promises.filter((o) => ["PENDING", "IN_PRODUCTION", "READY"].includes(o.status));
  const finished = promises.filter((o) => ["DELIVERED", "CANCELLED"].includes(o.status));
  const uncovered = open.reduce((sum, o) => sum.plus(dec(o.atRisk)), dec(0));
  const channel = channels[0] ?? null;

  // Runs a planner could attach by hand, gathered per style so a row can offer
  // them. Only for orders still waiting: one that is already being made has
  // its run, and one delivered is finished with.
  const runsByStyle = new Map<string, Awaited<ReturnType<typeof availableRuns>>>();
  for (const o of open) {
    if (o.status === "PENDING" && !runsByStyle.has(o.styleId)) {
      runsByStyle.set(o.styleId, await availableRuns(o.styleId));
    }
  }

  // What the brand actually holds, so an order cannot promise a garment that
  // is still at the factory or still on the road.
  const shelves = await Promise.all(brandLocations.map((l) => sellableStock(l.id, brand.id)));
  const sellable = new Map<
    string,
    { variantId: string; sku: string; label: string; available: number; retailPrice: number }
  >();
  for (const shelf of shelves) {
    for (const p of shelf) {
      const existing = sellable.get(p.variantId);
      const available = Number(p.available);
      if (existing) existing.available += available;
      else
        sellable.set(p.variantId, {
          variantId: p.variantId,
          sku: p.sku,
          label: `${ar ? p.styleAr : p.styleEn} · ${ar ? p.colourAr : p.colourEn} · ${p.size}`,
          available,
          retailPrice: Number(p.retailPrice ?? 0),
        });
    }
  }

  // Only what is not on a shelf. A piece that exists is sold, not promised,
  // and offering both routes for the same SKU is how a shop ends up making a
  // coat it already had.
  const toMake: MakeableVariant[] = variants
    .filter((v) => !sellable.has(v.id))
    .map((v) => {
      const m = makeable.get(v.styleId);
      const limit = m?.limitedBy
        ? m.materials.find((x) => x.materialId === m.limitedBy!.materialId) ?? null
        : null;
      return {
        variantId: v.id,
        styleId: v.styleId,
        sku: v.sku,
        label: `${ar ? v.style.nameAr : v.style.nameEn} · ${
          ar ? v.colorCode.nameAr : v.colorCode.nameEn
        } · ${v.sizeCode.code}`,
        retailPrice: v.style.retailPrice ? dec(v.style.retailPrice).toString() : "",
        available: 0,
        makeable: m?.makeable ?? 0,
        hasBom: m?.hasBom ?? false,
        hasOperations: m?.hasOperations ?? false,
        limitedBy: limit
          ? {
              code: limit.code,
              nameAr: limit.nameAr,
              nameEn: limit.nameEn,
              onHand: dec(limit.onHand).toFixed(2),
              perUnit: dec(limit.perUnit).toFixed(2),
              uom: limit.uom,
            }
          : null,
      };
    })
    // The ones the factory could start today first: that is the answer the
    // person in the conversation is looking for.
    .sort((a, b) => b.makeable - a.makeable || a.sku.localeCompare(b.sku));

  const onShelf = [...sellable.values()].reduce((s, p) => s + p.available, 0);
  const startableNow = toMake.filter((v) => v.makeable > 0).length;

  const status = (s: string) =>
    ar
      ? { PENDING: "مستني", IN_PRODUCTION: "بيتصنّع", READY: "جاهز", DELIVERED: "اتسلّم", CANCELLED: "اتلغى" }[s] ?? s
      : { PENDING: "Pending", IN_PRODUCTION: "In production", READY: "Ready", DELIVERED: "Delivered", CANCELLED: "Cancelled" }[s] ?? s;

  const statusTone = (s: string) =>
    ({ PENDING: "warn", IN_PRODUCTION: "info", READY: "good", DELIVERED: "neutral", CANCELLED: "neutral" }[s] ??
      "neutral") as "warn" | "info" | "good" | "neutral";

  return (
    <>
      <PageHeader
        title={ar ? "المودريتور" : "Moderator"}
        subtitle={
          ar
            ? "أوردر جه في رسالة. لو موجود يتباع، ولو مش موجود نشوف القماش وننزّله أمر إنتاج."
            : "An order that arrived by message. On the shelf, it is sold; not on the shelf, the cloth decides."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "قطع على الرف" : "Pieces on the shelf"}
          value={formatNumber(onShelf, locale)}
          hint={ar ? "تتباع دلوقتي" : "sellable now"}
          tone={onShelf > 0 ? "good" : "warn"}
        />
        <StatTile
          label={ar ? "مقاسات ينفع تتعمل" : "Sizes the cloth allows"}
          value={formatNumber(startableNow, locale)}
          hint={ar ? "من غير ما تشتري قماش" : "without buying fabric"}
          tone={startableNow > 0 ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "وعود مفتوحة" : "Promises open"}
          value={formatNumber(open.length, locale)}
          hint={
            ar
              ? `عرابين محتجزة ${formatMoney(held.toString(), locale)}`
              : `${formatMoney(held.toString(), locale)} of deposits held`
          }
          tone={open.length > 0 ? "warn" : "neutral"}
        />
      </div>

      {/* --------------------------------------------- it is on the shelf */}
      <Card
        className="mb-5"
        title={ar ? "١ — موجود: بيعه" : "1 — On the shelf: sell it"}
        description={
          ar
            ? "بيعة عادية دلوقتي: المخزون بينزل والإيراد بيتسجّل، زي أي بيعة من الكاشير."
            : "An ordinary sale, now: stock is relieved and revenue posted, exactly as at the till."
        }
      >
        {!mayTake ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "مالكش صلاحية تكتب أوردر. الجداول تحت بتتقري عادي."
              : "You may not take an order. The tables below read as usual."}
          </p>
        ) : sellable.size === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "مفيش حاجة على الرف دلوقتي. كل الأوردرات هتبقى تصنيع."
              : "Nothing on the shelf. Everything is made to order today."}
          </p>
        ) : (
          <ModeratorOrderForm
            locale={locale}
            products={[...sellable.values()].sort((a, b) => a.sku.localeCompare(b.sku))}
            customers={customers}
            locations={brandLocations.map((l) => ({ id: l.id, label: ar ? l.nameAr : l.nameEn }))}
            channels={channels.map((c) => ({ id: c.id, label: ar ? c.nameAr : c.nameEn }))}
            entityId={brand.id}
            canDiscount={can(session.role, "sales_order:discount")}
            today={new Date().toISOString().slice(0, 10)}
            zones={zones}
          />
        )}
      </Card>

      {/* ------------------------------------------ it is not on the shelf */}
      <Card
        className="mb-5"
        title={ar ? "٢ — مش موجود: اتعمله" : "2 — Not on the shelf: make it"}
        description={
          ar
            ? "دي مش بيعة. دي وعد، والعربون فلوس بتمسكها للعميل لحد ما يستلم. البيعة بتحصل يوم التسليم."
            : "Not a sale but a promise: the deposit is the customer's money until they collect, and the sale happens on the day they do."
        }
      >
        {!mayTake ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "مالكش صلاحية تكتب أوردر."
              : "You may not take an order."}
          </p>
        ) : collectLocations.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar ? "مفيش مكان استلام متعرّف." : "No collection point is set up."}
          </p>
        ) : (
          <MakeToOrderForm
            ar={ar}
            entityId={brand.id}
            customers={customers}
            variants={toMake}
            locations={collectLocations.map((l) => ({ id: l.id, name: ar ? l.nameAr : l.nameEn }))}
            mayPlan={mayPlan}
          />
        )}
      </Card>

      <Card
        className="mb-5"
        title={ar ? "٣ — الوعود اللي لسه مفتوحة" : "3 — Promises still open"}
        description={
          ar
            ? "«مكشوف» هو اللي المحل هيخسره لو الزبون ماجاش — القطعة دي اتفصلت لواحد بعينه ومحدش تاني طالبها."
            : "Uncovered is what the shop loses if nobody collects: the piece was cut to one person's taste and nobody else asked for it."
        }
      >
        <DataTable
          headers={[
            ar ? "الأوردر" : "Order",
            ar ? "الزبون" : "Customer",
            ar ? "المطلوب" : "Piece",
            ar ? "الحالة" : "Status",
            ar ? "موعده" : "Promised",
            ar ? "الاتفاق" : "Agreed",
            ar ? "عربون" : "Deposit",
            ar ? "مكشوف" : "Uncovered",
            "",
          ]}
          empty={ar ? "مفيش وعود مفتوحة" : "Nothing promised"}
          rows={open.map((o) => [
            <span key="n" className="num text-xs" dir="ltr">{o.orderNumber}</span>,
            <span key="c">
              <span className="font-medium text-ink-900">{o.customerName}</span>
              {o.customerPhone && (
                <span className="ms-2 num text-xs text-ink-400" dir="ltr">{o.customerPhone}</span>
              )}
            </span>,
            <span key="i" className="text-xs">
              <code dir="ltr" className="text-ink-400">{o.sku}</code>
              <span className="ms-2">{o.styleName} · {o.colour} · {o.size}</span>
              {o.quantity > 1 && <strong className="ms-1">×{o.quantity}</strong>}
            </span>,
            <span key="s" className="flex items-center gap-1.5">
              <Badge tone={statusTone(o.status)}>{status(o.status)}</Badge>
              {o.runNumber ? (
                <span className="num text-[11px] text-ink-400" dir="ltr">{o.runNumber}</span>
              ) : (
                <span className="text-[11px] text-warn">{ar ? "من غير أمر" : "no run"}</span>
              )}
            </span>,
            <span key="p" className="num text-xs" dir="ltr">
              {o.promisedDate ? new Date(o.promisedDate).toISOString().slice(0, 10) : "—"}
            </span>,
            <span key="t" className="num">{formatMoney(o.agreedTotal, locale)}</span>,
            <span key="d" className="num">{formatMoney(o.deposit, locale)}</span>,
            dec(o.atRisk).greaterThan(0) ? (
              <span key="r" className="num text-bad">{formatMoney(o.atRisk, locale)}</span>
            ) : (
              <span key="r" className="text-good">—</span>
            ),
            <OrderActions
              key="a"
              ar={ar}
              order={{ id: o.id, status: o.status, atRisk: o.atRisk, deposit: o.deposit }}
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
        {uncovered.greaterThan(0) && (
          <p className="mt-3 rounded-lg bg-bad/10 px-3 py-2 text-xs text-bad">
            {ar
              ? `${formatMoney(uncovered.toString(), locale)} متعهد بيها من غير عربون يغطيها.`
              : `${formatMoney(uncovered.toString(), locale)} promised with no deposit behind it.`}
          </p>
        )}
      </Card>

      <Card title={ar ? "خلصت" : "Finished"}>
        <DataTable
          headers={[
            ar ? "الأوردر" : "Order",
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
              {status(o.status)}
            </Badge>,
            <span key="t" className="num">{formatMoney(o.agreedTotal, locale)}</span>,
            <span key="i" className="num text-xs" dir="ltr">{o.salesOrderNumber ?? "—"}</span>,
          ])}
        />
      </Card>
    </>
  );
}
