import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { collectionPerformance } from "@/lib/analytics";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";
import { imageUrl } from "@/lib/images";

/**
 * أداء التشكيلة — how a collection did, through the eyes of whichever side is
 * asking.
 *
 * The two sides own the same garment at different moments and do not mean the
 * same thing by "how did it do". The Factory made it: its revenue is what it
 * invoiced the Brand at transfer price, its cost is what the run cost to cut
 * and sew. The Brand bought it at that same transfer price and sold it in the
 * shop: its revenue is the till, its margin is retail less transfer, and the
 * unsold pile is its problem rather than the Factory's.
 *
 * Showing one set of numbers to both — which is what the styles screen did —
 * is how a collection ends up looking profitable on a margin the Factory
 * earned and the Brand paid for.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ entity?: string }>;
}) {
  await requirePermission("production:view");
  const { locale, scope } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  // Follows the lens the person is already in, and lets them cross over.
  const kind =
    query.entity === "FACTORY" || (!query.entity && scope === "FACTORY")
      ? "FACTORY"
      : "BRAND";
  const entity = await db.entity.findFirstOrThrow({ where: { kind } });
  const report = await collectionPerformance(entity.id, kind);
  const factory = kind === "FACTORY";

  const revenue = report.reduce((t, c) => t.plus(c.revenue), dec(0));
  const margin = report.reduce((t, c) => t.plus(c.grossMargin), dec(0));
  const stock = report.reduce((t, c) => t.plus(c.onHandValue), dec(0));
  const units = report.reduce((n, c) => n + c.units, 0);

  const styleName = (s: { nameAr: string; nameEn: string }) => (ar ? s.nameAr : s.nameEn);

  /** The photograph, so a person recognises the garment before reading its code. */
  function Thumb({ imageName, alt }: { imageName: string | null; alt: string }) {
    // Null for anything that is not a name this system stored itself, so a
    // value that found its way into the column cannot become a request.
    const src = imageUrl(imageName);
    if (!src) {
      return <div className="h-12 w-12 shrink-0 rounded-md bg-ink-100" aria-hidden />;
    }
    return (
      // eslint-disable-next-line @next/next/no-img-element
      <img src={src} alt={alt} className="h-12 w-12 shrink-0 rounded-md object-cover" />
    );
  }

  /** A margin on no revenue is not zero percent, it is not a number. */
  const pct = (v: { toString(): string } | null) => (v ? formatPercent(v.toString()) : "—");

  /** One of the three answers: best, most made, slowest. */
  function Highlight({
    label,
    hint,
    style,
    figure,
  }: {
    label: string;
    hint: string;
    style: {
      id: string;
      code: string;
      nameAr: string;
      nameEn: string;
      imageName: string | null;
    } | null;
    figure: string;
  }) {
    if (!style) {
      return (
        <div className="rounded-lg border border-line bg-surface p-3">
          <div className="text-xs text-ink-500">{label}</div>
          <div className="mt-2 text-sm text-ink-300">{ar ? "لسه مافيش" : "Nothing yet"}</div>
        </div>
      );
    }
    return (
      <Link
        href={`/styles?style=${style.id}`}
        className="flex items-center gap-3 rounded-lg border border-line bg-surface p-3 transition hover:border-ink-300"
      >
        <Thumb imageName={style.imageName} alt={styleName(style)} />
        <div className="min-w-0">
          <div className="text-xs text-ink-500">{label}</div>
          <div className="truncate text-sm font-medium text-ink-900">{styleName(style)}</div>
          <div className="num text-xs text-ink-500">{figure}</div>
          <div className="text-[11px] text-ink-400">{hint}</div>
        </div>
      </Link>
    );
  }

  return (
    <>
      <PageHeader
        title={ar ? "أداء التشكيلة" : "Collection performance"}
        subtitle={
          factory
            ? ar
              ? `${entity.nameAr} — إنتاجك: عملت كام، وكلّفك كام، وبعته للبراند بكام`
              : `${entity.nameEn} — what you made, what it cost, and what you invoiced the Brand`
            : ar
              ? `${entity.nameAr} — بيعك: اشتريته بكام من المصنع، وبعته بكام، وفاضل كام`
              : `${entity.nameEn} — what you paid the Factory, what the till took, and what is left`
        }
      />

      <div className="mb-4 flex items-center gap-2 text-sm">
        <a
          href="/collections?entity=FACTORY"
          className={
            factory
              ? "rounded-md bg-ink-900 px-3 py-1.5 text-white"
              : "rounded-md border border-line px-3 py-1.5 text-ink-600 hover:border-ink-300"
          }
        >
          {ar ? "بعين المصنع" : "As the Factory"}
        </a>
        <a
          href="/collections?entity=BRAND"
          className={
            !factory
              ? "rounded-md bg-ink-900 px-3 py-1.5 text-white"
              : "rounded-md border border-line px-3 py-1.5 text-ink-600 hover:border-ink-300"
          }
        >
          {ar ? "بعين البراند" : "As the Brand"}
        </a>
        <span className="text-xs text-ink-400">
          {ar
            ? "نفس التشكيلة — أرقام مختلفة، والاتنين صح"
            : "The same collection, different numbers, both true"}
        </span>
      </div>

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={
            factory
              ? ar ? "فواتير على البراند" : "Invoiced to the Brand"
              : ar ? "إيراد البيع" : "Sales revenue"
          }
          value={formatMoney(revenue.toString())}
          hint={`${formatNumber(report.length)} ${ar ? "تشكيلة" : "collections"}`}
          tone="info"
        />
        <StatTile
          label={factory ? (ar ? "ربح التصنيع" : "Manufacturing margin") : (ar ? "ربح البيع" : "Retail margin")}
          value={formatMoney(margin.toString())}
          hint={formatPercent(revenue.isZero() ? "0" : margin.div(revenue).toString())}
          tone={margin.greaterThan(0) ? "good" : "neutral"}
        />
        <StatTile
          label={factory ? (ar ? "قطع خرجت للبراند" : "Pieces transferred") : (ar ? "قطع اتباعت" : "Pieces sold")}
          value={formatNumber(units)}
        />
        <StatTile
          label={ar ? "بضاعة فاضلة عندك" : "Stock still with you"}
          value={formatMoney(stock.toString())}
          hint={factory ? (ar ? "بالتكلفة" : "at cost") : (ar ? "بسعر التحويل" : "at transfer price")}
          tone={stock.greaterThan(0) ? "warn" : "neutral"}
        />
      </div>

      {report.length === 0 && (
        <Card title={ar ? "مافيش أرقام لسه" : "Nothing to report yet"}>
          <p className="text-sm text-ink-500">
            {ar
              ? "التشكيلة بتظهر هنا أول ما يتعمل منها إنتاج أو يتباع منها حاجة."
              : "A collection appears here once something has been produced from it or sold."}
          </p>
        </Card>
      )}

      {report.map((c) => (
        <div key={c.id} className="mb-5">
          <Card
            title={`${ar ? c.nameAr : c.nameEn} · ${c.code}`}
            description={
              ar
                ? `${c.season} ${c.year} — ${c.styleCount} موديل`
                : `${c.season} ${c.year} — ${c.styleCount} styles`
            }
          >
            <div className="mb-4 grid gap-3 sm:grid-cols-4">
              <div className="rounded-lg border border-line bg-surface p-3">
                <div className="text-xs text-ink-500">
                  {factory ? (ar ? "إجمالي فواتير التشكيلة" : "Collection invoiced") : (ar ? "إجمالي إيراد التشكيلة" : "Collection revenue")}
                </div>
                <div className="num mt-1 text-lg font-semibold text-ink-900">
                  {formatMoney(c.revenue.toString())}
                </div>
                <div className="num text-xs text-ink-500">
                  {ar ? "ربح" : "margin"} {formatMoney(c.grossMargin.toString())} ·{" "}
                  {pct(c.marginPct)}
                </div>
              </div>

              <Highlight
                label={ar ? "أحسن موديل" : "Best product"}
                hint={ar ? "بالربح، مش بعدد القطع" : "by profit, not by units"}
                style={c.best}
                figure={
                  c.best
                    ? `${formatMoney(c.best.grossMargin.toString())} ${ar ? "ربح على" : "on"} ${formatNumber(c.best.units)} ${ar ? "قطعة" : "units"}`
                    : ""
                }
              />

              <Highlight
                label={ar ? "أكتر موديل اتعمل" : "Most produced"}
                hint={
                  c.mostProduced?.costPerPiece
                    ? `${ar ? "تكلفة القطعة" : "cost per piece"} ${formatMoney(c.mostProduced.costPerPiece.toString())}`
                    : ""
                }
                style={c.mostProduced}
                figure={
                  c.mostProduced
                    ? `${formatNumber(c.mostProduced.produced)} ${ar ? "قطعة اتصنعت" : "pieces made"}`
                    : ""
                }
              />

              <Highlight
                label={ar ? "أبطأ موديل" : "Slowest mover"}
                hint={ar ? "ده اللي فلوسك واقفة فيه" : "this is where the cash is stuck"}
                style={c.worst}
                figure={
                  c.worst
                    ? `${c.worst.sellThrough ? formatPercent(c.worst.sellThrough.toString()) : "—"} ${ar ? "اتباع" : "sold through"}`
                    : ""
                }
              />
            </div>

            <DataTable
              headers={[
                "",
                ar ? "الموديل" : "Style",
                ar ? "اتصنع" : "Made",
                factory ? (ar ? "خرج" : "Out") : (ar ? "وصلك" : "Received"),
                factory ? (ar ? "فاتورة" : "Invoiced") : (ar ? "اتباع" : "Sold"),
                factory ? (ar ? "قيمة الفاتورة" : "Invoiced value") : (ar ? "الإيراد" : "Revenue"),
                ar ? "التكلفة" : "Cost",
                ar ? "الربح" : "Margin",
                "%",
                ar ? "نسبة البيع" : "Sell-through",
                ar ? "فاضل" : "On hand",
              ]}
              empty={ar ? "مافيش موديلات" : "No styles"}
              rows={c.styles
                .filter((s) => s.units > 0 || s.produced > 0 || s.onHand.greaterThan(0))
                .map((s) => [
                  <Thumb key="t" imageName={s.imageName} alt={styleName(s)} />,
                  <Link
                    key="n"
                    href={`/styles?style=${s.id}`}
                    className="font-medium text-ink-900 hover:underline"
                  >
                    {styleName(s)}
                    <span className="ms-2 num text-xs text-ink-400" dir="ltr">{s.code}</span>
                  </Link>,
                  <span key="p" className="num">{formatNumber(s.produced)}</span>,
                  <span key="tr" className="num">{formatNumber(Number(s.transferred))}</span>,
                  <span key="u" className="num font-medium">{formatNumber(s.units)}</span>,
                  <span key="r" className="num">{formatMoney(s.revenue.toString())}</span>,
                  <span key="c" className="num text-ink-500">{formatMoney(s.cost.toString())}</span>,
                  <span key="m" className="num font-medium">{formatMoney(s.grossMargin.toString())}</span>,
                  <span key="mp" className="num text-xs">{pct(s.marginPct)}</span>,
                  s.sellThrough ? (
                    <Badge
                      key="st"
                      tone={
                        s.sellThrough.greaterThanOrEqualTo("0.7")
                          ? "good"
                          : s.sellThrough.greaterThanOrEqualTo("0.3")
                            ? "warn"
                            : "bad"
                      }
                    >
                      {formatPercent(s.sellThrough.toString())}
                    </Badge>
                  ) : (
                    <span key="st" className="text-ink-300">—</span>
                  ),
                  <span key="oh" className="num text-xs text-ink-500">
                    {formatNumber(Number(s.onHand))}
                    {s.onHandValue.greaterThan(0) && (
                      <span className="ms-1">({formatMoney(s.onHandValue.toString())})</span>
                    )}
                  </span>,
                ])}
            />

            <p className="mt-3 text-xs text-ink-400">
              {factory
                ? ar
                  ? "«نسبة البيع» هنا معناها كام قطعة من اللي صنعتها خرجت للبراند فعلًا."
                  : "Sell-through here means how much of what you made actually left for the Brand."
                : ar
                  ? "«نسبة البيع» محسوبة على اللي وصلك فعلًا، مش على اللي المصنع صنعه — البضاعة اللي ماوصلتش مش مسؤوليتك."
                  : "Sell-through is measured against what actually reached you, not against what the Factory made."}
            </p>
          </Card>
        </div>
      ))}
    </>
  );
}
