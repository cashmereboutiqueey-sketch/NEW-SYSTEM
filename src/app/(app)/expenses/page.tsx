import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney } from "@/lib/money";
import { ExpenseForm } from "./expense-form";

/**
 * Expenses — the accrual subledger.
 *
 * Every row here has a matching journal entry; the "Posted" column links the
 * two so any figure can be traced from this screen to the general ledger.
 */
export default async function ExpensesPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const [entities, categories, suppliers, costCenters, expenses] = await Promise.all([
    db.entity.findMany({ orderBy: { kind: "asc" } }),
    db.costCategory.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.supplier.findMany({ where: { isActive: true }, orderBy: { nameEn: "asc" } }),
    db.costCenter.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.expense.findMany({
      orderBy: [{ incurredDate: "desc" }, { createdAt: "desc" }],
      take: 100,
      include: { costCategory: true, supplier: true, entity: true },
    }),
  ]);

  // Each expense carries its journal number so the ledger link is visible.
  const journals = await db.journalEntry.findMany({
    where: { sourceType: "EXPENSE", sourceId: { in: expenses.map((e) => e.id) } },
    select: { sourceId: true, entryNumber: true },
  });
  const journalBySource = new Map(journals.map((j) => [j.sourceId, j.entryNumber]));

  const outstanding = expenses.reduce(
    (s, e) => s + Number(e.amount) - Number(e.paidAmount),
    0,
  );
  const overdue = expenses.filter(
    (e) => e.status !== "PAID" && e.dueDate < new Date(),
  );

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);

  const categoriesByEntity = entities.reduce<Record<string, { id: string; label: string }[]>>(
    (acc, entity) => {
      acc[entity.id] = categories
        .filter((c) => c.entityId === entity.id)
        .map((c) => ({ id: c.id, label: name(c) }));
      return acc;
    },
    {},
  );

  const statusTone = { PAID: "good", PARTIALLY_PAID: "warn", UNPAID: "neutral" } as const;
  const statusLabel = ar
    ? { PAID: "مدفوع", PARTIALLY_PAID: "مدفوع جزئيًا", UNPAID: "غير مدفوع" }
    : { PAID: "Paid", PARTIALLY_PAID: "Part paid", UNPAID: "Unpaid" };

  return (
    <>
      <PageHeader
        title={t("expenses", locale)}
        subtitle={
          ar
            ? "التكلفة تُسجَّل عند نشأتها، والسداد حدث منفصل يسوّي الالتزام"
            : "Cost is recognised when incurred; payment is a separate event that settles the liability"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "المستحق للموردين" : "Outstanding payables"}
          value={formatMoney(outstanding, locale)}
          tone={outstanding > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "متأخر عن السداد" : "Overdue"}
          value={String(overdue.length)}
          tone={overdue.length > 0 ? "bad" : "good"}
          hint={ar ? "حسب تاريخ السداد" : "By due date"}
        />
        <StatTile
          label={ar ? "عدد المصروفات" : "Expenses recorded"}
          value={String(expenses.length)}
        />
      </div>

      {can(session.role, "expense:create") && (
        <Card
          className="mb-4"
          title={ar ? "تسجيل مصروف" : "Record an expense"}
          description={
            ar
              ? "يُرحَّل تلقائيًا: مدين بند التكلفة، دائن الموردون"
              : "Posts automatically: debit the cost account, credit trade payables"
          }
        >
          <ExpenseForm
            locale={locale}
            entities={entities.map((e) => ({ id: e.id, label: name(e) }))}
            categoriesByEntity={categoriesByEntity}
            suppliers={suppliers.map((s) => ({ id: s.id, label: name(s) }))}
            costCenters={costCenters.map((c) => ({ id: c.id, label: name(c) }))}
            today={new Date().toISOString().slice(0, 10)}
          />
        </Card>
      )}

      <Card title={ar ? "المصروفات المسجلة" : "Recorded expenses"}>
        {expenses.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "لا توجد مصروفات بعد. سجّل أول مصروف من النموذج أعلاه."
              : "No expenses yet. Record the first one using the form above."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الوصف" : "Description",
              ar ? "الجهة" : "Entity",
              ar ? "البند" : "Category",
              ar ? "المبلغ" : "Amount",
              ar ? "المتبقي" : "Outstanding",
              ar ? "تاريخ السداد" : "Due",
              ar ? "الحالة" : "Status",
              ar ? "القيد" : "Journal",
            ]}
            rows={expenses.map((e) => {
              const due = Number(e.amount) - Number(e.paidAmount);
              const isOverdue = e.status !== "PAID" && e.dueDate < new Date();
              return [
                <span key={`${e.id}-d`}>
                  {e.description}
                  {e.supplier && (
                    <span className="mt-0.5 block text-xs text-ink-400">
                      {name(e.supplier)}
                    </span>
                  )}
                </span>,
                <span key={`${e.id}-e`}>{name(e.entity)}</span>,
                <span key={`${e.id}-c`}>{name(e.costCategory)}</span>,
                <span key={`${e.id}-a`} className="num">{formatMoney(Number(e.amount), locale)}</span>,
                <span key={`${e.id}-o`} className="num">{formatMoney(due, locale)}</span>,
                <span key={`${e.id}-du`} className={isOverdue ? "num text-bad" : "num"} dir="ltr">
                  {e.dueDate.toISOString().slice(0, 10)}
                </span>,
                <Badge key={`${e.id}-s`} tone={statusTone[e.status]}>
                  {statusLabel[e.status]}
                </Badge>,
                <code key={`${e.id}-j`} dir="ltr" className="text-xs text-ink-500">
                  {journalBySource.get(e.id) ?? "—"}
                </code>,
              ];
            })}
          />
        )}
      </Card>
    </>
  );
}
