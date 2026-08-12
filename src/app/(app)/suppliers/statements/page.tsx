import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { supplierStatements, supplierCommitments } from "@/lib/reports";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";

/**
 * كشف حساب الموردين — what each supplier is owed.
 *
 * The aging report answers "how much is overdue" across the business. It does
 * not answer the question a supplier actually asks on the phone, which is
 * "what do you owe me" — and working that out by eye from a list of invoices
 * is how somebody gets told a number that is wrong in their own favour.
 *
 * What has been ordered and not yet delivered is shown separately. It is not a
 * debt: a supplier is owed when their goods arrive. But leaving it out makes
 * the relationship look smaller than it is, and it is the number that matters
 * when deciding whether to order more.
 */
export default async function SupplierStatementsPage() {
  await requirePermission("expense:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [statements, commitments] = await Promise.all([
    supplierStatements(),
    supplierCommitments(),
  ]);

  const total = statements.reduce((s, x) => s.plus(dec(x.outstanding)), dec(0));
  const overdue = statements.reduce((s, x) => s.plus(dec(x.overdue)), dec(0));
  const ordered = commitments.reduce((s, x) => s.plus(dec(x.outstanding)), dec(0));
  const late = statements.filter((s) => dec(s.overdue).greaterThan(0));

  const dateText = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : "—";

  const committedFor = (supplierId: string) =>
    commitments
      .filter((c) => c.supplierId === supplierId)
      .reduce((s, c) => s.plus(dec(c.outstanding)), dec(0));

  return (
    <>
      <PageHeader
        title={ar ? "كشف حساب الموردين" : "Supplier statements"}
        subtitle={
          ar
            ? "كل مورد عايز منك كام، وكام منها فات ميعاده."
            : "What each supplier is owed, and how much of it is late."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "إجمالي المستحق" : "Total owed"}
          value={formatMoney(total.toString())}
          hint={`${formatNumber(statements.length)} ${ar ? "مورد" : "suppliers"}`}
          tone={total.greaterThan(0) ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "فات ميعاده" : "Overdue"}
          value={formatMoney(overdue.toString())}
          hint={`${formatNumber(late.length)} ${ar ? "مورد" : "suppliers"}`}
          tone={overdue.greaterThan(0) ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "لسه في الميعاد" : "Not yet due"}
          value={formatMoney(total.minus(overdue).toString())}
        />
        <StatTile
          label={ar ? "مطلوب ولسه ماوصلش" : "Ordered, not delivered"}
          value={formatMoney(ordered.toString())}
          hint={ar ? "مش دين — دين لما يوصل" : "not a debt until it arrives"}
          tone="neutral"
        />
      </div>

      <div className="mb-5">
        <Card
          title={ar ? "المستحق لكل مورد" : "Owed by supplier"}
          description={
            ar
              ? "المتأخرين الأول، والأقدم قبل الأحدث."
              : "The late ones first, oldest before newest."
          }
        >
          <DataTable
            headers={[
              ar ? "المورد" : "Supplier",
              ar ? "تليفون" : "Phone",
              ar ? "الأجل" : "Terms",
              ar ? "فواتير" : "Invoices",
              ar ? "المستحق" : "Owed",
              ar ? "منه متأخر" : "Overdue",
              ar ? "أقدم استحقاق" : "Oldest due",
              ar ? "مطلوب ولسه" : "On order",
            ]}
            empty={ar ? "مفيش مستحق لأي مورد" : "Nothing owed to anybody"}
            rows={statements.map((s) => [
              <span key="n" className="font-medium text-ink-900">
                {ar ? s.nameAr : s.nameEn}
                <span className="ms-2 num text-xs text-ink-400" dir="ltr">{s.code}</span>
              </span>,
              <span key="p" className="num text-xs" dir="ltr">{s.phone ?? "—"}</span>,
              <span key="t" className="num text-xs">
                {s.creditDays} {ar ? "يوم" : "days"}
              </span>,
              <span key="i" className="num">{formatNumber(s.invoices.length)}</span>,
              <span key="o" className="num font-medium">{formatMoney(s.outstanding)}</span>,
              dec(s.overdue).greaterThan(0) ? (
                <Badge key="d" tone="bad">{formatMoney(s.overdue)}</Badge>
              ) : (
                <span key="d" className="text-ink-300">—</span>
              ),
              <span key="due" className="num text-xs" dir="ltr">{dateText(s.oldestDue)}</span>,
              committedFor(s.supplierId).greaterThan(0) ? (
                <span key="c" className="num text-xs text-ink-500">
                  {formatMoney(committedFor(s.supplierId).toString())}
                </span>
              ) : (
                <span key="c" className="text-ink-300">—</span>
              ),
            ])}
          />
        </Card>
      </div>

      {statements.map((s) => (
        <div key={s.supplierId} className="mb-4">
          <Card
            title={`${ar ? s.nameAr : s.nameEn} — ${formatMoney(s.outstanding)}`}
            description={
              ar
                ? `${s.invoices.length} فاتورة مفتوحة · أجل ${s.creditDays} يوم`
                : `${s.invoices.length} open invoice(s) · ${s.creditDays}-day terms`
            }
          >
            <DataTable
              headers={[
                ar ? "البيان" : "What",
                ar ? "الكيان" : "Entity",
                ar ? "البند" : "Category",
                ar ? "الفاتورة" : "Invoiced",
                ar ? "اتدفع" : "Paid",
                ar ? "المتبقي" : "Outstanding",
                ar ? "الاستحقاق" : "Due",
              ]}
              rows={s.invoices.map((i) => [
                i.description,
                <span key="e" className="text-xs text-ink-500">{i.entity}</span>,
                <span key="c" className="text-xs text-ink-500">{i.category}</span>,
                <span key="a" className="num">{formatMoney(i.amount)}</span>,
                <span key="p" className="num text-ink-500">{formatMoney(i.paid)}</span>,
                <span key="o" className="num font-medium">{formatMoney(i.outstanding)}</span>,
                <span
                  key="d"
                  className={i.daysLate > 0 ? "num text-xs text-bad" : "num text-xs"}
                  dir="ltr"
                >
                  {dateText(i.dueDate)}
                  {i.daysLate > 0 && (
                    <span className="ms-1">
                      ({i.daysLate}
                      {ar ? " يوم متأخر" : "d late"})
                    </span>
                  )}
                </span>,
              ])}
            />
          </Card>
        </div>
      ))}

      {commitments.length > 0 && (
        <Card
          title={ar ? "مطلوب ولسه ماوصلش" : "Ordered, not yet delivered"}
          description={
            ar
              ? "دي مش ديون — المورد بيبقى ليه فلوس لما البضاعة توصل."
              : "Not debts: a supplier is owed when the goods arrive."
          }
        >
          <DataTable
            headers={[
              ar ? "الأمر" : "Order",
              ar ? "المورد" : "Supplier",
              ar ? "متوقع" : "Expected",
              ar ? "القيمة" : "Value",
              "",
            ]}
            rows={commitments.map((c) => [
              <span key="n" className="num text-xs" dir="ltr">{c.poNumber}</span>,
              c.supplierName,
              <span key="e" className="num text-xs" dir="ltr">{dateText(c.expectedDate)}</span>,
              <span key="v" className="num">{formatMoney(c.outstanding)}</span>,
              c.awaitingApproval ? (
                <Badge key="s" tone="warn">{ar ? "مستني اعتماد" : "awaiting approval"}</Badge>
              ) : (
                <span key="s" />
              ),
            ])}
          />
        </Card>
      )}
    </>
  );
}
