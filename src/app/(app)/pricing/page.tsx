import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { brandPriceList, priceStyle } from "@/lib/brand-pricing";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";
import { imageUrl } from "@/lib/images";
import { BasisForm } from "./basis-form";

/**
 * تسعير البراند — the second pricing engine.
 *
 * The factory prices its own cost: materials, minutes, a markup, and the
 * answer is the transfer price. That is where its job ends.
 *
 * The brand starts from that transfer price as its cost of goods and has to
 * cover everything the factory never sees — the shop's rent, the people in it,
 * the advertising that brought the customer through the door, the bag it
 * leaves in, and the ones that come back. Only what survives all of that is
 * profit. A garment priced at "transfer price plus a bit" is how a shop turns
 * over money all season and finds nothing at the end of it, and the margin
 * against the transfer price alone is the number that hides it.
 */
export default async function PricingPage({
  searchParams,
}: {
  searchParams: Promise<{
    style?: string;
    units?: string;
    overhead?: string;
    marketing?: string;
    target?: string;
  }>;
}) {
  await requirePermission("retail_price:manage");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  // What-if lives in the query string: nothing is saved by looking, and a
  // scenario can be handed to somebody else as a link.
  const num = (v: string | undefined) =>
    v != null && v.trim() !== "" && Number.isFinite(Number(v)) ? Number(v) : null;
  const overrides = {
    monthlyUnits: num(query.units),
    monthlyOverhead: num(query.overhead),
    marketingPerUnit: num(query.marketing),
    targetMargin: num(query.target),
  };

  const { basis, styles } = await brandPriceList(brand.id, { overrides });
  const selected = query.style
    ? await priceStyle(brand.id, query.style, { overrides }).catch(() => null)
    : null;

  const pct = (v: { toString(): string } | null) => (v ? formatPercent(v.toString()) : "—");
  const money = (v: { toString(): string } | null) => (v ? formatMoney(v.toString()) : "—");

  const losing = styles.filter((s) => s.losesMoney);
  const short = styles.filter((s) => (s.shortfall ?? dec(0)).greaterThan(0));
  const uncosted = styles.filter((s) => s.stale);

  function Thumb({ imageName, alt }: { imageName: string | null; alt: string }) {
    const src = imageUrl(imageName);
    if (!src) return <div className="h-10 w-10 shrink-0 rounded bg-ink-100" aria-hidden />;
    // eslint-disable-next-line @next/next/no-img-element
    return <img src={src} alt={alt} className="h-10 w-10 shrink-0 rounded object-cover" />;
  }

  const keep = (extra: Record<string, string | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries({ ...query, ...extra })) {
      if (v != null && v !== "") p.set(k, String(v));
    }
    return `/pricing?${p.toString()}`;
  };

  return (
    <>
      <PageHeader
        title={ar ? "تسعير البراند" : "Brand pricing"}
        subtitle={
          ar
            ? "المصنع بيسعّر تكلفته. البراند بيبدأ من سعر التحويل، وعليه كمان الإيجار والمرتبات والتسويق والمرتجع."
            : "The factory prices its cost. The brand starts from the transfer price and still has rent, salaries, marketing and returns to cover."
        }
      />

      {basis.overheadDominates && (
        <div className="mb-4 rounded-lg border border-bad/30 bg-bad/5 p-3 text-sm">
          <strong className="text-bad">
            {ar ? "الأرقام دي مش تسعير." : "These numbers are not a costing."}
          </strong>{" "}
          {ar
            ? `المصاريف الثابتة بتتقسم على ${formatNumber(Number(basis.monthlyUnits))} قطعة في الشهر بس، فكل قطعة شايلة ${money(basis.overheadPerUnit)} إيجار ومرتبات — أكتر من تكلفة القطعة نفسها. اكتب العدد اللي متوقع تبيعه فعلًا تحت.`
            : `Fixed cost is being spread over ${formatNumber(Number(basis.monthlyUnits))} garments a month, so each one carries ${money(basis.overheadPerUnit)} of rent and salaries — more than the garment itself cost. Type the volume you actually expect below.`}
        </div>
      )}

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "تكلفة بيع القطعة" : "Cost to sell one"}
          value={money(basis.costToSellPerUnit)}
          hint={ar ? "غير تكلفة القطعة نفسها" : "on top of the garment itself"}
          tone="info"
        />
        <StatTile
          label={ar ? "بيخسروا" : "Losing money"}
          value={formatNumber(losing.length)}
          hint={ar ? "بتتباع بأقل من تكلفتها" : "sold below what they cost"}
          tone={losing.length > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "تحت المستهدف" : "Below target"}
          value={formatNumber(short.length)}
          hint={`${ar ? "المستهدف" : "target"} ${pct(styles[0]?.targetMargin ?? null)}`}
          tone={short.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "من غير تكلفة" : "No costing"}
          value={formatNumber(uncosted.length)}
          hint={ar ? "مش ممكن نقترح لها سعر" : "cannot be priced"}
          tone={uncosted.length > 0 ? "warn" : "neutral"}
        />
      </div>

      <div className="mb-5">
        <Card
          title={ar ? "الأساس اللي بيتحسب عليه" : "What the numbers are built on"}
          description={
            ar
              ? "الأرقام دي مقروءة من الدفاتر. غيّر أي واحدة فيهم وشوف السعر بيتحرك — ماتتسجلش، بس اللينك بيفضل شغال لو بعته لحد."
              : "Read from the books. Change any of them and the prices move — nothing is saved, but the link keeps the scenario."
          }
        >
          <BasisForm
            ar={ar}
            months={basis.months}
            monthlyOverhead={basis.monthlyOverhead.toString()}
            overheadMeasured={basis.overheadMeasured}
            monthlyUnits={basis.monthlyUnits.toString()}
            unitsBasis={basis.unitsBasis}
            marketingPerUnit={basis.marketingPerUnit.toString()}
            marketingMeasured={basis.marketingMeasured}
            targetMargin={(styles[0]?.targetMargin ?? dec("0.55")).toString()}
            current={{
              units: query.units ?? "",
              overhead: query.overhead ?? "",
              marketing: query.marketing ?? "",
              target: query.target ?? "",
            }}
          />

          <dl className="mt-4 grid gap-2 border-t border-ink-200 pt-3 text-sm sm:grid-cols-4">
            {[
              [ar ? "إيجار ومرتبات للقطعة" : "Overhead per garment", money(basis.overheadPerUnit)],
              [ar ? "تسويق للقطعة" : "Marketing per garment", money(basis.marketingPerUnit)],
              [
                ar ? "تغليف وشحن" : "Packaging and shipping",
                money(basis.packagingPerUnit.plus(basis.shippingPerUnit)),
              ],
              [ar ? "نسبة المرتجع" : "Return rate", pct(basis.returnRate)],
            ].map(([k, v]) => (
              <div key={k} className="flex items-baseline justify-between gap-2">
                <dt className="text-ink-500">{k}</dt>
                <dd className="num font-medium text-ink-900">{v}</dd>
              </div>
            ))}
          </dl>
        </Card>
      </div>

      {selected && selected.style.trueCost && (
        <div className="mb-5">
          <Card
            title={`${ar ? selected.style.nameAr : selected.style.nameEn} — ${ar ? "الخصم بياكل إيه" : "what a discount eats"}`}
            description={
              ar
                ? "الخصم مش بيتقسم بالتناسب: كله بيطلع من الربح، ولا حاجة منه بتطلع من التكلفة."
                : "A discount is not proportional: all of it comes out of the profit and none of it out of the cost."
            }
          >
            <div className="mb-3 flex flex-wrap gap-4 text-sm">
              <span>
                {ar ? "بتدفع للمصنع" : "Paid to the factory"}{" "}
                <b className="num">{money(selected.style.transferPrice)}</b>
              </span>
              <span>
                {ar ? "تكلفة المحل" : "Shop cost"}{" "}
                <b className="num">{money(selected.style.costToSell)}</b>
              </span>
              <span>
                {ar ? "حساب المرتجع" : "Return allowance"}{" "}
                <b className="num">{money(selected.style.returnAllowance)}</b>
              </span>
              <span className="border-s border-ink-200 ps-4">
                {ar ? "التكلفة الحقيقية" : "True cost"}{" "}
                <b className="num">{money(selected.style.trueCost)}</b>
              </span>
            </div>

            <DataTable
              headers={[
                ar ? "الخصم" : "Discount",
                ar ? "السعر" : "Price",
                ar ? "الربح" : "Profit",
                ar ? "الهامش" : "Margin",
                ar ? "راح من الربح" : "Profit given up",
              ]}
              rows={selected.ladder.map((r) => [
                <span key="d" className="num font-medium">{formatPercent(r.discount.toString())}</span>,
                <span key="p" className="num">{formatMoney(r.price.toString())}</span>,
                <span key="pr" className={r.belowCost ? "num text-bad" : "num"}>
                  {formatMoney(r.profit.toString())}
                </span>,
                <span key="m" className={r.belowCost ? "num text-bad" : "num"}>{pct(r.margin)}</span>,
                r.belowCost ? (
                  <Badge key="g" tone="bad">{ar ? "بخسارة" : "at a loss"}</Badge>
                ) : (
                  <span key="g" className="num">{pct(r.profitGivenUp)}</span>
                ),
              ])}
            />

            <p className="mt-3 text-sm">
              {ar ? "أقل سعر مسموح بيه" : "Lowest price allowed"}{" "}
              <b className="num">{money(selected.style.floor)}</b>{" "}
              <span className="text-ink-500">
                ({ar ? "عند هامش" : "at"} {pct(selected.style.minimumMargin)})
              </span>
              {" · "}
              {ar ? "أقصى خصم" : "Most you can take off"}{" "}
              <b className="num">{pct(selected.style.discountRoom)}</b>
              {selected.style.wipeoutDiscount && (
                <>
                  {" · "}
                  {ar ? "الربح بيتصفّر عند" : "Profit hits zero at"}{" "}
                  <b className="num text-bad">{pct(selected.style.wipeoutDiscount)}</b>
                </>
              )}
            </p>
          </Card>
        </div>
      )}

      <Card
        title={ar ? "كل موديل" : "Every style"}
        description={
          ar
            ? "اضغط على أي موديل تشوف الخصم بيعمل فيه إيه. اللي بيخسر الأول."
            : "Open any style to see what a discount does to it. The loss-makers first."
        }
      >
        <DataTable
          headers={[
            "",
            ar ? "الموديل" : "Style",
            ar ? "للمصنع" : "To factory",
            ar ? "تكلفة المحل" : "Shop cost",
            ar ? "التكلفة الحقيقية" : "True cost",
            ar ? "السعر دلوقتي" : "Priced at",
            ar ? "الهامش الحقيقي" : "Real margin",
            ar ? "لو حسبتها على المصنع بس" : "Looks like",
            ar ? "المفروض" : "Should be",
            ar ? "أقل سعر" : "Floor",
          ]}
          empty={ar ? "مافيش موديلات" : "No styles"}
          rows={styles.map((s) => [
            <Thumb key="t" imageName={s.imageName} alt={ar ? s.nameAr : s.nameEn} />,
            <Link key="n" href={keep({ style: s.styleId })} className="font-medium text-ink-900 hover:underline">
              {ar ? s.nameAr : s.nameEn}
              <span className="ms-2 num text-xs text-ink-400" dir="ltr">{s.code}</span>
              {s.stale && (
                <span className="ms-2 text-xs text-warn">
                  {ar ? "من غير تكلفة" : "no costing"}
                </span>
              )}
            </Link>,
            <span key="tp" className="num">{money(s.transferPrice)}</span>,
            <span key="cs" className="num text-ink-500">{money(s.costToSell)}</span>,
            <span key="tc" className="num font-medium">{money(s.trueCost)}</span>,
            <span key="rp" className="num">{money(s.retailPrice)}</span>,
            s.actualMargin ? (
              <Badge
                key="am"
                tone={
                  s.losesMoney ? "bad" : s.actualMargin.greaterThanOrEqualTo("0.35") ? "good" : "warn"
                }
              >
                {pct(s.actualMargin)}
              </Badge>
            ) : (
              <span key="am" className="text-ink-300">—</span>
            ),
            // The flattering number, kept next to the honest one on purpose.
            <span key="gm" className="num text-xs text-ink-400">{pct(s.grossMargin)}</span>,
            <span key="sp" className="num">
              {money(s.suggestedPrice)}
              {s.shortfall && s.shortfall.greaterThan(0) && (
                <span className="ms-1 text-xs text-bad">
                  +{formatMoney(s.shortfall.toString())}
                </span>
              )}
            </span>,
            <span key="fl" className="num text-xs text-ink-500">{money(s.floor)}</span>,
          ])}
        />

        <p className="mt-3 text-xs text-ink-400">
          {ar
            ? "«لو حسبتها على المصنع بس» هو الهامش على سعر التحويل من غير إيجار ولا مرتبات ولا تسويق. الرقم ده بيبان كبير وهو مش حقيقي — موجود هنا عشان تشوف الفرق."
            : "\"Looks like\" is the margin against the transfer price alone, before rent, salaries or marketing. It is the flattering number, kept here so the difference is visible."}
        </p>
      </Card>
    </>
  );
}
