import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { customerBalances, openOrdersForCustomer } from "@/lib/receivables";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { CollectForm } from "./collect-form";
import { CreditTermsForm } from "./credit-terms-form";

/**
 * ذمم العملاء — who owes the shop money.
 *
 * The number that matters here is not the total: it is how much of it is
 * late. A customer on thirty-day terms who bought yesterday is not a problem,
 * and lumping them in with somebody four months overdue is how a shop ends up
 * chasing the wrong people and losing the right ones.
 */
export default async function ReceivablesPage() {
  const session = await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayCollect = can(session.role, "payment:create");
  const maySetTerms = can(session.role, "sales_order:credit");

  const balances = await customerBalances();

  // The collection form needs the open orders for whoever is owed money, and
  // there are rarely many of them, so they are fetched with the list.
  const openOrders = await Promise.all(
    balances.map(async (b) => ({
      customerId: b.customerId,
      orders: await openOrdersForCustomer(b.customerId),
    })),
  );
  const ordersFor = (customerId: string) =>
    openOrders.find((o) => o.customerId === customerId)?.orders ?? [];

  const total = balances.reduce((s, b) => s.plus(dec(b.outstanding)), dec(0));
  const overdue = balances.reduce((s, b) => s.plus(dec(b.overdue)), dec(0));
  const lateCount = balances.filter((b) => dec(b.overdue).greaterThan(0)).length;

  const dateText = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : "—";

  return (
    <>
      <PageHeader
        title={ar ? "ذمم العملاء" : "Customer receivables"}
        subtitle={
          ar
            ? "مين عليه فلوس، وكام منها بقى متأخر."
            : "Who owes money, and how much of it is late."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "إجمالي المستحق" : "Total outstanding"}
          value={formatMoney(total.toString())}
          hint={`${formatNumber(balances.length)} ${ar ? "عميل" : "customers"}`}
          tone={total.greaterThan(0) ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "متأخر" : "Overdue"}
          value={formatMoney(overdue.toString())}
          hint={`${formatNumber(lateCount)} ${ar ? "عميل" : "customers"}`}
          tone={overdue.greaterThan(0) ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "لسه في الميعاد" : "Not yet due"}
          value={formatMoney(total.minus(overdue).toString())}
          tone="neutral"
        />
      </div>

      <Card
        title={ar ? "الحسابات المفتوحة" : "Open accounts"}
        description={
          ar
            ? "المتأخرين الأول، والأقدم قبل الأحدث."
            : "The late ones first, oldest before newest."
        }
      >
        <DataTable
          headers={[
            ar ? "العميل" : "Customer",
            ar ? "تليفون" : "Phone",
            ar ? "المستحق" : "Outstanding",
            ar ? "منه متأخر" : "Overdue",
            ar ? "أقدم استحقاق" : "Oldest due",
            ar ? "الحد / المتاح" : "Limit / room",
            "",
          ]}
          empty={ar ? "محدش عليه حاجة" : "Nobody owes anything"}
          rows={balances.map((b) => [
            <span key="n" className="font-medium text-ink-900">
              {b.name}
            </span>,
            <span key="p" className="num text-xs" dir="ltr">
              {b.phone ?? "—"}
            </span>,
            <span key="o" className="num font-medium">
              {formatMoney(b.outstanding)}
            </span>,
            dec(b.overdue).greaterThan(0) ? (
              <Badge key="d" tone="bad">
                {formatMoney(b.overdue)}
              </Badge>
            ) : (
              <span key="d" className="text-ink-300">
                —
              </span>
            ),
            <span key="due" className="num text-xs" dir="ltr">
              {dateText(b.oldestDue)}
            </span>,
            <span key="l" className="num text-xs">
              {formatMoney(b.creditLimit)}
              <span
                className={
                  dec(b.headroom).lessThanOrEqualTo(0)
                    ? "ms-2 text-bad"
                    : "ms-2 text-ink-400"
                }
              >
                ({formatMoney(b.headroom)})
              </span>
            </span>,
            <div key="a" className="flex items-center gap-2">
              {mayCollect && ordersFor(b.customerId).length > 0 && (
                <CollectForm
                  customerName={b.name}
                  orders={ordersFor(b.customerId).map((o) => ({
                    id: o.id,
                    orderNumber: o.orderNumber,
                    outstanding: o.outstanding,
                    dueDate: o.dueDate ? dateText(o.dueDate) : null,
                  }))}
                  ar={ar}
                />
              )}
              {maySetTerms && (
                <CreditTermsForm
                  customerId={b.customerId}
                  customerName={b.name}
                  creditLimit={b.creditLimit}
                  creditDays={b.creditDays}
                  ar={ar}
                />
              )}
            </div>,
          ])}
        />
      </Card>

      <p className="mt-4 text-xs text-ink-500">
        {ar
          ? "الحد بيتحسب على كل اللي على العميل مش على الفاتورة الواحدة، وميقدرش ينزل تحت اللي عليه فعلاً."
          : "The limit is measured against everything a customer owes, not one invoice, and cannot be set below what they already owe."}
      </p>
    </>
  );
}
