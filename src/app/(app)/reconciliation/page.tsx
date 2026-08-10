import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import {
  awaitingSettlement,
  clearingBalance,
  recentSettlements,
  recentStatements,
  reconciliationView,
} from "@/lib/reconciliation";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, dec } from "@/lib/money";
import { SettlementForm } from "./settlement-form";
import {
  ImportStatementForm,
  AutoMatchForm,
  MatchLineForm,
  ExplainLineForm,
} from "./bank-forms";

/**
 * التسويات — proving the books against what actually happened.
 *
 * Two different jobs share this screen because they answer the same worry.
 *
 * A **remittance** clears money somebody else is holding: cash taken on a
 * doorstep is the courier's until they pay it over. The clearing account is
 * exactly what they owe, and clearing it order by order rather than by total
 * is what turns "they paid 4,000 short" into "they never paid for this
 * parcel".
 *
 * A **bank reconciliation** proves the ledger against the statement. The
 * useful output is never the two totals agreeing — it is the lines that appear
 * on one side and not the other.
 */
export default async function ReconciliationPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; statement?: string }>;
}) {
  const session = await requirePermission("journal:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const maySettle = can(session.role, "payment:create");
  const mayReconcile = can(session.role, "journal:create");
  const tab = query.tab === "bank" ? "bank" : "settlements";

  const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });

  const [courier, gateway, courierOwed, gatewayOwed, settlements, statements, entities, accounts] =
    await Promise.all([
      awaitingSettlement("COURIER"),
      awaitingSettlement("PAYMENT_GATEWAY"),
      clearingBalance("COURIER", brand.id),
      clearingBalance("PAYMENT_GATEWAY", brand.id),
      recentSettlements(),
      recentStatements(),
      db.entity.findMany({ where: { kind: { in: ["FACTORY", "BRAND"] } }, orderBy: { nameEn: "asc" } }),
      db.account.findMany({
        where: { reportingCategory: { in: ["CASH", "CASH_CLEARING"] }, isPostable: true },
        orderBy: { code: "asc" },
      }),
    ]);

  const channels = await db.salesChannel.findMany({
    where: { isActive: true },
    orderBy: { nameEn: "asc" },
  });

  const open = query.statement
    ? await reconciliationView(query.statement)
    : statements.length > 0
      ? await reconciliationView(statements[0].id)
      : null;

  // Ledger lines the open statement has not claimed, offered as candidates.
  const candidatesFor = (amount: string) =>
    (open?.inBooksNotOnStatement ?? [])
      .filter((l) => l.amount.toDecimalPlaces(2).equals(dec(amount).toDecimalPlaces(2)))
      .map((l) => ({
        id: l.id,
        label: `${l.entryNumber} · ${l.postingDate.toISOString().slice(0, 10)} · ${l.memo ?? l.description ?? ""}`.slice(0, 70),
      }));

  const courierExpected = courier.reduce((s, p) => s.plus(p.expected), dec(0));
  const gatewayExpected = gateway.reduce((s, p) => s.plus(p.expected), dec(0));
  const stale = courier.filter((p) => p.daysOutstanding > 30).length;

  const toRow = (p: (typeof courier)[number]) => ({
    paymentId: p.paymentId,
    orderNumber: p.orderNumber,
    orderDate: p.orderDate.toISOString().slice(0, 10),
    customer: p.customer,
    city: p.city,
    channel: ar ? p.channelAr : p.channelEn,
    gross: p.gross.toString(),
    fee: p.fee.toString(),
    expected: p.expected.toString(),
    daysOutstanding: p.daysOutstanding,
  });

  const statusLabel: Record<string, string> = ar
    ? { UNMATCHED: "مش مطابق", MATCHED: "مطابق", EXPLAINED: "مفسّر" }
    : { UNMATCHED: "Unmatched", MATCHED: "Matched", EXPLAINED: "Explained" };

  return (
    <>
      <PageHeader
        title={ar ? "التسويات" : "Reconciliation"}
        subtitle={
          ar
            ? "إثبات الدفاتر مقابل اللي حصل فعلًا — فلوس عند شركة الشحن، وكشف البنك"
            : "Proving the books against what actually happened — money others hold, and the bank statement"
        }
        actions={
          <div className="flex gap-2">
            <a
              href="/reconciliation"
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                tab === "settlements" ? "border-ink-900 bg-ink-900 text-white" : "border-ink-200"
              }`}
            >
              {ar ? "التوريدات" : "Remittances"}
            </a>
            <a
              href="/reconciliation?tab=bank"
              className={`rounded-lg border px-3 py-1.5 text-sm ${
                tab === "bank" ? "border-ink-900 bg-ink-900 text-white" : "border-ink-200"
              }`}
            >
              {ar ? "البنك" : "Bank"}
            </a>
          </div>
        }
      />

      {tab === "settlements" ? (
        <>
          <div className="mb-4 grid gap-3 sm:grid-cols-4">
            <StatTile
              label={ar ? "عند شركات الشحن" : "Held by couriers"}
              value={formatMoney(courierExpected, locale)}
              tone={courierExpected.greaterThan(0) ? "warn" : "good"}
              hint={`${courier.length} ${ar ? "أوردر" : "orders"}`}
            />
            <StatTile
              label={ar ? "عند بوابات الدفع" : "Held by gateways"}
              value={formatMoney(gatewayExpected, locale)}
              tone={gatewayExpected.greaterThan(0) ? "warn" : "good"}
              hint={`${gateway.length} ${ar ? "أوردر" : "orders"}`}
            />
            <StatTile
              label={ar ? "متأخر أكتر من شهر" : "Held over a month"}
              value={String(stale)}
              tone={stale > 0 ? "bad" : "good"}
              hint={ar ? "دي محتاجة مكالمة" : "These need a phone call"}
            />
            <StatTile
              label={ar ? "رصيد حساب التسوية" : "Clearing balance"}
              value={formatMoney(courierOwed.plus(gatewayOwed), locale)}
              hint={ar ? "من الدفاتر" : "From the ledger"}
            />
          </div>

          {maySettle && (
            <>
              <Card
                className="mb-4"
                title={ar ? "توريد من شركة شحن" : "Courier remittance"}
                description={
                  ar
                    ? "الفلوس اللي اتحصلت على الباب بتفضل ملك شركة الشحن لحد ما تورّدها"
                    : "Money taken on the doorstep is the courier's until they pay it over"
                }
              >
                <SettlementForm
                  locale={locale}
                  provider="COURIER"
                  entityId={brand.id}
                  today={new Date().toISOString().slice(0, 10)}
                  channels={channels.map((c) => ({ id: c.id, label: ar ? c.nameAr : c.nameEn }))}
                  payments={courier.map(toRow)}
                />
              </Card>

              <Card
                className="mb-4"
                title={ar ? "تحويل من بوابة دفع" : "Gateway payout"}
                description={
                  ar
                    ? "الكارت والمحفظة — الفلوس بتوصل البنك بعد يومين تلاتة"
                    : "Card and wallet — the money reaches the bank a few days later"
                }
              >
                <SettlementForm
                  locale={locale}
                  provider="PAYMENT_GATEWAY"
                  entityId={brand.id}
                  today={new Date().toISOString().slice(0, 10)}
                  channels={channels.map((c) => ({ id: c.id, label: ar ? c.nameAr : c.nameEn }))}
                  payments={gateway.map(toRow)}
                />
              </Card>
            </>
          )}

          <Card title={ar ? "توريدات سابقة" : "Past remittances"}>
            {settlements.length === 0 ? (
              <p className="py-8 text-center text-sm text-ink-400">
                {ar ? "لسه مفيش توريدات مسجّلة." : "No remittances recorded yet."}
              </p>
            ) : (
              <DataTable
                headers={[
                  ar ? "الرقم" : "Number",
                  ar ? "التاريخ" : "Date",
                  ar ? "الجهة" : "From",
                  ar ? "أوردرات" : "Orders",
                  ar ? "المتوقع" : "Expected",
                  ar ? "اللي وصل" : "Received",
                  ar ? "الفرق" : "Variance",
                ]}
                rows={settlements.map((s) => [
                  <code key={`${s.id}-n`} dir="ltr" className="text-xs text-ink-500">
                    {s.settlementNumber}
                  </code>,
                  <span key={`${s.id}-d`} className="num" dir="ltr">
                    {s.date.toISOString().slice(0, 10)}
                  </span>,
                  <span key={`${s.id}-p`}>
                    {s.provider === "COURIER"
                      ? ar ? "شركة شحن" : "Courier"
                      : ar ? "بوابة دفع" : "Gateway"}
                    {s.reference && (
                      <code dir="ltr" className="ms-2 text-xs text-ink-400">{s.reference}</code>
                    )}
                  </span>,
                  <span key={`${s.id}-c`} className="num">{s.cleared}</span>,
                  <span key={`${s.id}-e`} className="num text-ink-500">
                    {formatMoney(s.expected, locale)}
                  </span>,
                  <span key={`${s.id}-r`} className="num">{formatMoney(s.netReceived, locale)}</span>,
                  s.variance.isZero() ? (
                    <Badge key={`${s.id}-v`} tone="good">{ar ? "مطابق" : "Exact"}</Badge>
                  ) : (
                    <span key={`${s.id}-v`} className="num text-bad">
                      {formatMoney(s.variance, locale)}
                      {s.varianceNote && (
                        <span className="ms-2 text-xs text-ink-400">{s.varianceNote}</span>
                      )}
                    </span>
                  ),
                ])}
              />
            )}
          </Card>
        </>
      ) : (
        <>
          {mayReconcile && (
            <Card className="mb-4" title={ar ? "كشف حساب جديد" : "New statement"}>
              <ImportStatementForm
                locale={locale}
                today={new Date().toISOString().slice(0, 10)}
                entities={entities.map((e) => ({ id: e.id, label: ar ? e.nameAr : e.nameEn }))}
                accounts={accounts.map((a) => ({
                  code: a.code,
                  label: `${a.code} — ${ar ? a.nameAr : a.nameEn}`,
                }))}
              />
            </Card>
          )}

          {statements.length > 1 && (
            <Card className="mb-4" title={ar ? "الكشوف" : "Statements"}>
              <div className="flex flex-wrap gap-2">
                {statements.map((s) => (
                  <a
                    key={s.id}
                    href={`/reconciliation?tab=bank&statement=${s.id}`}
                    className={`rounded-lg border px-3 py-1.5 text-sm ${
                      open?.id === s.id ? "border-ink-900 bg-ink-900 text-white" : "border-ink-200"
                    }`}
                  >
                    <span className="num" dir="ltr">
                      {s.accountCode} · {s.statementDate.toISOString().slice(0, 10)}
                    </span>
                    {s.unmatched > 0 && (
                      <span className="ms-2 text-xs text-bad">{s.unmatched}</span>
                    )}
                  </a>
                ))}
              </div>
            </Card>
          )}

          {!open ? (
            <Card>
              <p className="py-8 text-center text-sm text-ink-400">
                {ar
                  ? "لسه مفيش كشوف. الصق كشف البنك فوق عشان تبدأ."
                  : "No statements yet. Paste one above to start."}
              </p>
            </Card>
          ) : (
            <>
              <div className="mb-4 grid gap-3 sm:grid-cols-4">
                <StatTile
                  label={ar ? "الرصيد الختامي" : "Closing balance"}
                  value={formatMoney(open.closingBalance, locale)}
                  hint={`${open.accountCode} · ${ar ? open.accountNameAr : open.accountNameEn}`}
                />
                <StatTile
                  label={ar ? "حركات الكشف" : "Statement lines"}
                  value={String(open.lines.length)}
                />
                <StatTile
                  label={ar ? "مش مطابق" : "Unmatched"}
                  value={String(open.unmatchedCount)}
                  tone={open.unmatchedCount > 0 ? "warn" : "good"}
                />
                <StatTile
                  label={ar ? "في الدفاتر مش في الكشف" : "In the books, not on the statement"}
                  value={String(open.inBooksNotOnStatement.length)}
                  tone={open.inBooksNotOnStatement.length > 0 ? "warn" : "good"}
                />
              </div>

              {!open.statementConsistent && (
                <Card className="mb-4">
                  <p className="text-sm text-bad">
                    {ar
                      ? "الافتتاحي زائد الحركات مش بيساوي الختامي — الكشف نفسه اتدخل غلط، وتطابقه كده مالوش معنى."
                      : "Opening plus the movements does not equal closing — the statement itself was entered wrong, and matching it would mean nothing."}
                  </p>
                </Card>
              )}

              <Card
                className="mb-4"
                title={ar ? "حركات الكشف" : "Statement lines"}
                description={
                  ar
                    ? "المطابقة التلقائية بتسيب أي سطر ليه أكتر من احتمال — التخمين الغلط أصعب في اللقيان بعدين"
                    : "Auto-matching leaves anything with more than one candidate alone — a wrong guess is far harder to find later"
                }
              >
                <div className="mb-3">
                  <AutoMatchForm locale={locale} statementId={open.id} />
                </div>

                <ul className="divide-y divide-ink-100">
                  {open.lines.map((l) => (
                    <li key={l.id} className="flex flex-wrap items-center gap-3 py-2">
                      <span className="num text-xs text-ink-500" dir="ltr">
                        {l.valueDate.toISOString().slice(0, 10)}
                      </span>
                      <span className="flex-1 text-sm">{l.description}</span>
                      <span
                        className={
                          l.amount.greaterThan(0) ? "num text-sm text-good" : "num text-sm"
                        }
                      >
                        {formatMoney(l.amount, locale)}
                      </span>
                      <Badge
                        tone={
                          l.status === "MATCHED"
                            ? "good"
                            : l.status === "EXPLAINED"
                              ? "info"
                              : "warn"
                        }
                      >
                        {statusLabel[l.status]}
                      </Badge>
                      {l.status === "UNMATCHED" && mayReconcile && (
                        <div className="flex w-full flex-wrap gap-3 ps-8">
                          <MatchLineForm
                            locale={locale}
                            bankStatementLineId={l.id}
                            candidates={candidatesFor(l.amount.toString())}
                          />
                          <ExplainLineForm locale={locale} bankStatementLineId={l.id} />
                        </div>
                      )}
                      {l.note && (
                        <span className="w-full ps-8 text-xs text-ink-400">{l.note}</span>
                      )}
                    </li>
                  ))}
                </ul>
              </Card>

              <Card
                title={ar ? "في الدفاتر ومش في الكشف" : "In the books, not on the statement"}
                description={
                  ar
                    ? "دفعات النظام شايفها والبنك عمره ما شافها — شيك مااتصرفش، أو قيد اتعمل مرتين"
                    : "Payments the books think happened and the bank has never seen — an uncashed cheque, or an entry made twice"
                }
              >
                {open.inBooksNotOnStatement.length === 0 ? (
                  <p className="py-6 text-center text-sm text-good">
                    {ar ? "كل حاجة في الدفاتر ظهرت في الكشف." : "Everything in the books appears on the statement."}
                  </p>
                ) : (
                  <DataTable
                    headers={[
                      ar ? "القيد" : "Entry",
                      ar ? "التاريخ" : "Date",
                      ar ? "البيان" : "Memo",
                      ar ? "المبلغ" : "Amount",
                    ]}
                    rows={open.inBooksNotOnStatement.map((l) => [
                      <code key={`${l.id}-n`} dir="ltr" className="text-xs text-ink-500">
                        {l.entryNumber}
                      </code>,
                      <span key={`${l.id}-d`} className="num" dir="ltr">
                        {l.postingDate.toISOString().slice(0, 10)}
                      </span>,
                      <span key={`${l.id}-m`}>{l.memo ?? l.description ?? "—"}</span>,
                      <span key={`${l.id}-a`} className="num">{formatMoney(l.amount, locale)}</span>,
                    ])}
                  />
                )}
              </Card>
            </>
          )}
        </>
      )}
    </>
  );
}
