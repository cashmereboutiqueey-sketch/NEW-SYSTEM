import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { clientsWithHistory } from "@/lib/cmt";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatMoney, formatNumber, formatPercent, dec } from "@/lib/money";
import { ClientForm } from "../cmt-forms";

/**
 * عملاء التصنيع — the people who buy the factory's spare minutes.
 *
 * Worth watching as closely as the Brand's own customers. Every minute sold
 * here above the full-capacity floor comes off the rate the Brand pays, so a
 * good CMT client makes the Brand's own garments cheaper.
 */
export default async function CmtClientsPage() {
  const session = await requireUser();
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayCreate = can(session.role, "cmt_quote:create");
  const clients = await clientsWithHistory();

  const minutesSold = clients.reduce((s, c) => s.plus(c.minutesSold), dec(0));
  const contractValue = clients.reduce((s, c) => s.plus(c.contractValue), dec(0));

  return (
    <>
      <PageHeader
        title={ar ? "عملاء التصنيع للغير" : "External CMT clients"}
        subtitle={
          ar
            ? "كل دقيقة بتتباع هنا فوق سعر كامل الطاقة بتنزّل تكلفة الدقيقة اللي البراند بيدفعها"
            : "Every minute sold here above the full-capacity rate lowers what the Brand itself pays"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "عملاء" : "Clients"}
          value={formatNumber(clients.length, locale)}
        />
        <StatTile
          label={ar ? "دقائق متباعة" : "Minutes sold"}
          value={formatNumber(minutesSold, locale)}
          tone={minutesSold.greaterThan(0) ? "good" : "neutral"}
        />
        <StatTile
          label={ar ? "قيمة التعاقدات" : "Contract value"}
          value={formatMoney(contractValue, locale)}
        />
      </div>

      {mayCreate && (
        <Card className="mb-4" title={ar ? "عميل جديد" : "New client"}>
          <ClientForm locale={locale} />
        </Card>
      )}

      <Card title={ar ? "العملاء" : "Clients"}>
        {clients.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لسه مفيش عملاء تصنيع. الطاقة العاطلة بتتكلّف سواء اتباعت أو لأ."
              : "No external clients yet. Idle capacity costs the same whether or not it is sold."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "العميل" : "Client",
              ar ? "المسؤول" : "Contact",
              ar ? "عروض" : "Quotes",
              ar ? "نسبة القبول" : "Win rate",
              ar ? "أوامر" : "Orders",
              ar ? "دقائق" : "Minutes",
              ar ? "قيمة التعاقد" : "Contract value",
              ar ? "الائتمان" : "Credit",
            ]}
            rows={clients.map((c) => [
              <span key={`${c.id}-n`}>
                <code dir="ltr" className="text-xs text-ink-500">{c.code}</code>
                <span className="ms-2">{c.name}</span>
                {!c.isActive && (
                  <Badge key={`${c.id}-i`} tone="neutral">{ar ? "موقوف" : "Inactive"}</Badge>
                )}
              </span>,
              <span key={`${c.id}-c`} className="text-ink-500">
                {c.contactPerson ?? "—"}
                {c.phone && <span className="ms-2 num" dir="ltr">{c.phone}</span>}
              </span>,
              <span key={`${c.id}-q`} className="num">{c.quoteCount}</span>,
              c.winRate == null ? (
                <span key={`${c.id}-w`} className="num text-ink-400">—</span>
              ) : (
                <span
                  key={`${c.id}-w`}
                  className={c.winRate.greaterThan(0.4) ? "num text-good" : "num text-warn"}
                >
                  {formatPercent(c.winRate, locale)}
                </span>
              ),
              <span key={`${c.id}-o`} className="num">{c.orderCount}</span>,
              <span key={`${c.id}-m`} className="num">{formatNumber(c.minutesSold, locale)}</span>,
              <span key={`${c.id}-v`} className="num">{formatMoney(c.contractValue, locale)}</span>,
              <span key={`${c.id}-cd`} className="num text-ink-500">
                {c.creditDays} {ar ? "يوم" : "d"}
              </span>,
            ])}
          />
        )}
      </Card>
    </>
  );
}
