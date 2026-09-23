import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { openingBatches, estimatedStockValue } from "@/lib/opening-balance";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec, safeDiv } from "@/lib/money";
import { formatPercent } from "@/lib/money";
import { OPENING_TEMPLATE_HEADER } from "@/core/opening-balance";
import { OpeningForm } from "./opening-form";

/**
 * The stock the business already had, on the day it starts keeping books.
 *
 * Every system that replaces a notebook has this problem and most of them
 * solve it with a script somebody runs once and nobody can find afterwards.
 * Here it is a batch with a number, a date, a file, a person and every line it
 * refused, because "where did this stock come from and who said it was worth
 * that" is asked about opening balances more than about anything else, usually
 * a year later by somebody who was not there.
 *
 * Behind `journal:create`: posting one creates an asset out of a count, and
 * the other side of it is equity.
 */
export default async function OpeningBalancesPage() {
  await requirePermission("journal:create");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [entities, locations, batches, estimate, materials, variants] = await Promise.all([
    db.entity.findMany({ where: { kind: { in: ["FACTORY", "BRAND"] } }, orderBy: { kind: "asc" } }),
    db.location.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    openingBatches(),
    estimatedStockValue(),
    db.material.findMany({ select: { code: true, nameAr: true, nameEn: true }, orderBy: { code: "asc" } }),
    db.variant.findMany({
      where: { isActive: true },
      select: { sku: true, style: { select: { nameAr: true, nameEn: true } } },
      orderBy: { sku: "asc" },
    }),
  ]);

  /*
   * A template already filled with every code the shop has.
   *
   * The alternative is somebody typing four hundred SKUs into a spreadsheet by
   * hand, which is where the wrong ones come from: a file whose codes all
   * resolve is a file whose refusals are about quantities and costs, which are
   * the things worth arguing over.
   */
  const template = [
    OPENING_TEMPLATE_HEADER,
    ...materials.map((m) => `FABRIC,${m.code},,,`),
    ...variants.map((v) => `GARMENT,${v.sku},,,`),
    "",
  ].join("\n");

  const share = safeDiv(estimate.estimated, estimate.total);
  const posted = batches.filter((b) => b.status === "COMMITTED");

  const statusLabel = (s: string) =>
    ar
      ? { PREVIEWED: "معروض", COMMITTED: "اتقيّد", CANCELLED: "اتلغى" }[s] ?? s
      : { PREVIEWED: "Counted", COMMITTED: "Posted", CANCELLED: "Cancelled" }[s] ?? s;

  return (
    <>
      <PageHeader
        title={ar ? "الأرصدة الافتتاحية" : "Opening balances"}
        subtitle={
          ar
            ? "البضاعة اللي موجودة فعلًا قبل ما النظام يشتغل — بتدخل مخزون، والطرف التاني حساب أرصدة افتتاحية."
            : "The stock that was already there before the system started — in as inventory, out against opening balances."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "دفعات اتقيّدت" : "Batches posted"}
          value={formatNumber(posted.length, locale)}
          hint={ar ? "من إجمالي" : "of"}
        />
        <StatTile
          label={ar ? "قيمة المخزون كله" : "All stock at cost"}
          value={formatMoney(estimate.total.toString(), locale)}
        />
        <StatTile
          label={ar ? "منها قايمة على تقدير" : "of that, resting on an estimate"}
          value={formatMoney(estimate.estimated.toString(), locale)}
          hint={estimate.total.greaterThan(0) ? formatPercent(share, locale) : undefined}
          tone={estimate.estimated.greaterThan(0) ? "warn" : "good"}
        />
      </div>

      {estimate.estimated.greaterThan(0) && (
        <Card className="mb-5" title={ar ? "اقرا الأرقام دي وانت واخد بالك" : "Read these figures knowing this"}>
          <p className="text-sm text-ink-700">
            {ar
              ? `${formatMoney(estimate.estimated.toString(), locale)} من قيمة المخزون محدش يعرف تكلفتها الحقيقية — اتقدّرت من سعر البيع. يعني الربح على البضاعة دي رقم تقريبي، ومش هيبقى حقيقي غير لما تتباع وتتعوّض ببضاعة متكلّفة صح من الإنتاج.`
              : `${formatMoney(estimate.estimated.toString(), locale)} of the stock value is a cost nobody actually knew: it was estimated from the selling price. Margins on it are approximate and stay that way until it sells through and is replaced by stock costed from production.`}
          </p>
        </Card>
      )}

      <Card
        className="mb-5"
        title={ar ? "جرد جديد" : "A new count"}
        description={
          ar
            ? "نزّل القالب وهتلاقي كل أكوادك فيه — املا الكمية والتكلفة بس."
            : "Download the template and every code you have is already in it — fill in the quantity and the cost."
        }
      >
        <OpeningForm
          ar={ar}
          entities={entities.map((e) => ({ id: e.id, label: ar ? e.nameAr : e.nameEn }))}
          locations={locations.map((l) => ({
            code: l.code,
            label: `${ar ? l.nameAr : l.nameEn} · ${l.code}`,
            entityId: l.entityId ?? "",
          }))}
          template={template}
        />
      </Card>

      <Card title={ar ? "اللي اتعمل قبل كده" : "What has been loaded"}>
        <DataTable
          headers={[
            ar ? "رقم" : "No.",
            ar ? "الحالة" : "Status",
            ar ? "بتاريخ" : "As at",
            ar ? "الدفاتر" : "Books",
            ar ? "سطور" : "Lines",
            ar ? "دفعات" : "Lots",
            ar ? "القيمة" : "Value",
            ar ? "منها تقدير" : "Estimated",
            ar ? "مين" : "By",
          ]}
          empty={ar ? "لسه مفيش أرصدة افتتاحية" : "No opening balances yet"}
          rows={batches.map((b) => [
            <span key="n" className="num text-xs" dir="ltr">{b.number}</span>,
            <Badge key="s" tone={b.status === "COMMITTED" ? "good" : b.status === "CANCELLED" ? "neutral" : "warn"}>
              {statusLabel(b.status)}
            </Badge>,
            <span key="d" className="num text-xs" dir="ltr">
              {b.asOfDate.toISOString().slice(0, 10)}
            </span>,
            <span key="e" className="text-xs">{ar ? b.entityAr : b.entityEn}</span>,
            <span key="l" className="num">{formatNumber(b.lines, locale)}</span>,
            <span key="t" className="num">{formatNumber(b.lots, locale)}</span>,
            <span key="v" className="num">{formatMoney(b.totalValue, locale)}</span>,
            dec(b.estimatedValue).greaterThan(0) ? (
              <span key="x" className="num text-warn">{formatMoney(b.estimatedValue, locale)}</span>
            ) : (
              <span key="x" className="text-ink-300">—</span>
            ),
            <span key="b" className="text-xs text-ink-500">{b.by ?? "—"}</span>,
          ])}
        />
      </Card>
    </>
  );
}
