import { requireUser } from "@/lib/auth";
import { redirect } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { pendingApprovals, recentDecisions } from "@/lib/approvals";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { DecisionButtons } from "./decision-buttons";

/**
 * الاعتمادات — everything waiting on a second signature.
 *
 * An approver opens one list. They do not go hunting through expenses,
 * purchasing and payroll for things that might need them, because a control
 * that requires someone to go looking is a control that gets skipped on a
 * busy day.
 *
 * Anything they raised themselves is shown but not actionable. Offering a
 * button that will refuse them teaches people to ignore refusals, and these
 * are the refusals that matter.
 */
export default async function ApprovalsPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayExpense = can(session.role, "expense:approve");
  const mayPurchase = can(session.role, "purchase_order:approve");
  const mayPayroll = can(session.role, "payroll:approve");
  if (!mayExpense && !mayPurchase && !mayPayroll) redirect("/");

  const [inbox, decisions] = await Promise.all([
    pendingApprovals(session.userId),
    recentDecisions(),
  ]);

  const expenseValue = inbox.expenses.reduce((s, e) => s.plus(dec(e.amount)), dec(0));
  const orderValue = inbox.purchaseOrders.reduce((s, o) => s.plus(dec(o.value)), dec(0));
  const payrollValue = inbox.payrollRuns.reduce((s, r) => s.plus(dec(r.total)), dec(0));

  const waiting =
    inbox.expenses.length + inbox.purchaseOrders.length + inbox.payrollRuns.length;

  const dateText = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : "—";

  return (
    <>
      <PageHeader
        title={ar ? "الاعتمادات" : "Approvals"}
        subtitle={
          ar
            ? `اللي مستني توقيع تاني. الحد ${formatMoney(inbox.threshold)} — تحته مش بيقف على حد.`
            : `Waiting on a second signature. Anything under ${formatMoney(inbox.threshold)} does not stop for anyone.`
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "مستني" : "Waiting"}
          value={formatNumber(waiting)}
          tone={waiting > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "مصروفات" : "Expenses"}
          value={formatMoney(expenseValue.toString())}
          hint={`${inbox.expenses.length}`}
        />
        <StatTile
          label={ar ? "أوامر شراء" : "Purchase orders"}
          value={formatMoney(orderValue.toString())}
          hint={`${inbox.purchaseOrders.length}`}
        />
        <StatTile
          label={ar ? "مرتبات" : "Payroll"}
          value={formatMoney(payrollValue.toString())}
          hint={`${inbox.payrollRuns.length}`}
        />
      </div>

      {mayExpense && (
        <div className="mb-5">
          <Card
            title={ar ? "مصروفات مستنية" : "Expenses"}
            description={
              ar
                ? "المصروف مايتدفعش قبل ما يتعتمد — والاعتماد مش من نفس اللي كتبه."
                : "An expense cannot be paid before it is approved, and not by whoever raised it."
            }
          >
            <DataTable
              headers={[
                ar ? "البيان" : "What",
                ar ? "البند" : "Category",
                ar ? "الكيان" : "Entity",
                ar ? "المبلغ" : "Amount",
                ar ? "الاستحقاق" : "Due",
                ar ? "طلبها" : "Raised by",
                "",
              ]}
              empty={ar ? "مفيش مصروف مستني" : "Nothing waiting"}
              rows={inbox.expenses.map((e) => [
                <span key="d">
                  {e.description}
                  {e.rejectedAt && (
                    <span className="ms-2 text-xs text-bad">
                      {ar ? "اترجّع: " : "sent back: "}
                      {e.rejectionReason}
                    </span>
                  )}
                </span>,
                <span key="c" className="text-xs text-ink-500">{e.category}</span>,
                <span key="en" className="text-xs text-ink-500">{e.entity}</span>,
                <span key="a" className="num font-medium">{formatMoney(e.amount)}</span>,
                <span key="due" className="num text-xs" dir="ltr">{dateText(e.dueDate)}</span>,
                <span key="r" className="text-xs">{e.raisedBy ?? "—"}</span>,
                <DecisionButtons
                  key="b"
                  ar={ar}
                  kind="expense"
                  id={e.id}
                  isOwn={e.isOwn}
                />,
              ])}
            />
          </Card>
        </div>
      )}

      {mayPurchase && (
        <div className="mb-5">
          <Card
            title={ar ? "أوامر شراء مستنية" : "Purchase orders"}
            description={
              ar
                ? "لحد ما تتعتمد، الأمر عرض مش التزام — والبضاعة ماتتستلمش عليه."
                : "Until approved it is a proposal, not a commitment, and goods cannot be received against it."
            }
          >
            <DataTable
              headers={[
                ar ? "الأمر" : "Order",
                ar ? "المورد" : "Supplier",
                ar ? "القيمة" : "Value",
                ar ? "أصناف" : "Lines",
                ar ? "متوقع" : "Expected",
                ar ? "طلبه" : "Raised by",
                "",
              ]}
              empty={ar ? "مفيش أمر مستني" : "Nothing waiting"}
              rows={inbox.purchaseOrders.map((o) => [
                <span key="n" className="num text-xs" dir="ltr">
                  {o.orderNumber}
                  {o.rejectedAt && (
                    <span className="ms-2 text-bad">
                      {ar ? "اترجّع" : "sent back"}
                    </span>
                  )}
                </span>,
                o.supplier,
                <span key="v" className="num font-medium">{formatMoney(o.value)}</span>,
                <span key="l" className="num">{o.lines}</span>,
                <span key="e" className="num text-xs" dir="ltr">{dateText(o.expectedDate)}</span>,
                <span key="r" className="text-xs">{o.raisedBy ?? "—"}</span>,
                <DecisionButtons
                  key="b"
                  ar={ar}
                  kind="purchaseOrder"
                  id={o.id}
                  isOwn={o.isOwn}
                />,
              ])}
            />
          </Card>
        </div>
      )}

      {mayPayroll && (
        <div className="mb-5">
          <Card
            title={ar ? "مرتبات مستنية" : "Payroll"}
            description={
              ar
                ? "الاعتماد بيقيّد المرتبات في الدفاتر ويضيفها لمجمع تكلفة المصنع."
                : "Approving posts the payroll and adds it to the factory cost pool."
            }
          >
            <DataTable
              headers={[
                ar ? "المسيّر" : "Run",
                ar ? "الكيان" : "Entity",
                ar ? "الشهر" : "Period",
                ar ? "موظفين" : "People",
                ar ? "الإجمالي" : "Total",
                ar ? "جهّزه" : "Prepared by",
                "",
              ]}
              empty={ar ? "مفيش مسيّر مستني" : "Nothing waiting"}
              rows={inbox.payrollRuns.map((r) => [
                <span key="n" className="num text-xs" dir="ltr">{r.runNumber}</span>,
                r.entity,
                <span key="p" className="num text-xs" dir="ltr">{r.period}</span>,
                <span key="e" className="num">{formatNumber(r.employees)}</span>,
                <span key="t" className="num font-medium">{formatMoney(r.total)}</span>,
                <span key="pb" className="text-xs">{r.preparedBy ?? "—"}</span>,
                <DecisionButtons
                  key="b"
                  ar={ar}
                  kind="payroll"
                  id={r.id}
                  isOwn={r.isOwn}
                  approveOnly
                />,
              ])}
            />
          </Card>
        </div>
      )}

      <Card
        title={ar ? "قرارات سابقة" : "Recent decisions"}
        description={
          ar
            ? "مين وافق على إيه وإمتى — عشان القرار يتراجع بعدين."
            : "Who decided what, and when."
        }
      >
        <DataTable
          headers={[
            ar ? "إمتى" : "When",
            ar ? "مين" : "Who",
            ar ? "القرار" : "Decision",
          ]}
          empty={ar ? "لسه مفيش قرارات" : "No decisions yet"}
          rows={decisions.slice(0, 25).map((d) => [
            <span key="w" className="num text-xs" dir="ltr">
              {new Date(d.createdAt).toISOString().slice(0, 16).replace("T", " ")}
            </span>,
            d.user?.name ?? "—",
            <Badge key="a" tone={d.action.includes("REJECTED") ? "bad" : "good"}>
              {d.action.replace(/_/g, " ").toLowerCase()}
            </Badge>,
          ])}
        />
      </Card>
    </>
  );
}
