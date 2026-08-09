import Link from "next/link";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { formatMoney, formatNumber } from "@/lib/money";
import { recoveryList } from "@/lib/shopify";
import { dec } from "@/lib/money";
import { pullCheckoutsAction, markContactedAction } from "./actions";

/**
 * العربيات المتروكة — abandoned baskets.
 *
 * The most directly useful thing the website produces for marketing: a named
 * person, the exact garments they wanted, what it was worth, and a link that
 * puts the basket back in front of them.
 *
 * Consent governs contact. Somebody who unsubscribed still appears, because
 * their basket says something real about demand, but they are marked so
 * nobody sends them a message they asked not to receive.
 */
export default async function RecoveryPage({
  searchParams,
}: {
  searchParams: Promise<{ all?: string }>;
}) {
  const session = await requirePermission("campaign:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;
  const includeRecovered = params.all === "1";

  const mayAct = can(session.role, "campaign:manage");
  const rows = await recoveryList({ includeRecovered });

  const open = rows.filter((r) => !r.recovered);
  const atRisk = open.reduce((s, r) => s.plus(r.totalValue), dec(0));
  const contactable = open.filter((r) => !r.isSuppressed && r.phone).length;
  const recoveredCount = rows.filter((r) => r.recovered).length;

  return (
    <>
      <PageHeader
        title={ar ? "العربيات المتروكة" : "Abandoned baskets"}
        subtitle={
          ar
            ? "ناس ملّت العربية وسابتها — الاسم والتليفون واللي كانوا عايزينه بالظبط"
            : "People who filled a basket and left — who they are, and exactly what they wanted"
        }
        actions={
          <Link
            href={includeRecovered ? "/recovery" : "/recovery?all=1"}
            className="rounded-lg border border-ink-300 px-3 py-1.5 text-sm text-ink-700"
          >
            {includeRecovered
              ? ar ? "المفتوحة فقط" : "Open only"
              : ar ? "أظهر اللي اشتروا بعدها" : "Show ones who bought later"}
          </Link>
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "عربيات مفتوحة" : "Open baskets"}
          value={formatNumber(open.length, locale)}
          tone={open.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "قيمة معلّقة" : "Value sitting there"}
          value={formatMoney(atRisk, locale)}
          tone={atRisk.greaterThan(0) ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "يمكن التواصل معهم" : "Reachable"}
          value={formatNumber(contactable, locale)}
          hint={ar ? "عندهم تليفون وغير موقوفين" : "Have a phone and are not suppressed"}
        />
        <StatTile
          label={ar ? "اشتروا بعدها" : "Bought anyway"}
          value={formatNumber(recoveredCount, locale)}
          tone="good"
          hint={ar ? "مش محتاجين متابعة" : "No follow-up needed"}
        />
      </div>

      {mayAct && (
        <Card
          className="mb-4"
          title={ar ? "سحب من Shopify" : "Pull from Shopify"}
          description={
            ar
              ? "العربيات المتروكة API عادي — مش محتاجة موافقة زي تحليلات الزيارات"
              : "Abandoned checkouts are a plain API call — unlike session analytics, no special approval is needed"
          }
        >
          <EntityForm
            locale={locale}
            action={pullCheckoutsAction}
            columns={2}
            submitEn="Pull abandoned baskets"
            submitAr="اسحب العربيات المتروكة"
            fields={[
              {
                kind: "number", name: "sinceDays", labelEn: "Look back (days)", labelAr: "الرجوع كام يوم",
                defaultValue: 30, min: "1", max: "90", ltr: true,
                hintEn: "Anyone who has since bought is marked recovered, not chased.",
                hintAr: "اللي اشترى بعد كده بيتعلّم إنه اتحوّل ومابيتلاحقش.",
              },
            ]}
          />
        </Card>
      )}

      <Card
        title={ar ? "الأولى بالمتابعة" : "Worth chasing first"}
        description={
          ar
            ? "مرتبة بالقيمة — أعلى عربية فوق"
            : "Ordered by value — the biggest basket first"
        }
      >
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar
              ? "لا توجد عربيات متروكة. اسحب من Shopify عشان تشوف."
              : "No abandoned baskets recorded. Pull from Shopify to see them."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الشخص" : "Person",
              ar ? "التواصل" : "Contact",
              ar ? "اللي في العربية" : "What they left",
              ar ? "القيمة" : "Value",
              ar ? "من إمتى" : "How long ago",
              ar ? "الحالة" : "Status",
              ...(mayAct ? [""] : []),
            ]}
            rows={rows.map((r) => [
              <span key={`${r.id}-n`}>
                {r.name}
                {r.city && <span className="mt-0.5 block text-xs text-ink-400">{r.city}</span>}
              </span>,
              <span key={`${r.id}-c`}>
                {r.phone && (
                  <code dir="ltr" className="block text-xs">{r.phone}</code>
                )}
                {r.email && (
                  <code dir="ltr" className="block text-xs text-ink-400">{r.email}</code>
                )}
                {!r.phone && !r.email && <span className="text-xs text-ink-400">—</span>}
              </span>,
              <span key={`${r.id}-i`} className="text-sm">
                {r.items.slice(0, 2).map((i, x) => (
                  <span key={x} className="block text-xs">
                    {i.quantity}× {i.title ?? i.sku ?? "—"}
                  </span>
                ))}
                {r.items.length > 2 && (
                  <span className="text-xs text-ink-400">
                    +{r.items.length - 2} {ar ? "أخرى" : "more"}
                  </span>
                )}
              </span>,
              <span key={`${r.id}-v`} className="num font-medium">
                {formatMoney(r.totalValue, locale)}
              </span>,
              <span key={`${r.id}-d`} className="num">
                {r.daysAgo} {ar ? "يوم" : "d"}
              </span>,
              <span key={`${r.id}-s`} className="flex flex-wrap gap-1">
                {r.recovered ? (
                  <Badge tone="good">{ar ? "اشترى بعدها" : "Bought later"}</Badge>
                ) : r.isSuppressed ? (
                  <Badge tone="bad">{ar ? "طلب عدم التواصل" : "Asked not to be contacted"}</Badge>
                ) : r.contactedAt ? (
                  <Badge tone="info">
                    {ar ? "تم التواصل" : "Contacted"} · {r.contactedVia}
                  </Badge>
                ) : (
                  <Badge tone="warn">{ar ? "لم يتم التواصل" : "Not contacted"}</Badge>
                )}
                {r.isKnownCustomer && !r.recovered && (
                  <Badge tone="neutral">{ar ? "عميل معروف" : "Known customer"}</Badge>
                )}
              </span>,
              ...(mayAct
                ? [
                    r.recovered || r.isSuppressed ? (
                      <span key={`${r.id}-a`} />
                    ) : (
                      <div key={`${r.id}-a`} className="flex flex-wrap gap-1">
                        {r.recoveryUrl && (
                          <a
                            href={r.recoveryUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-600"
                          >
                            {ar ? "رابط العربية" : "Basket link"}
                          </a>
                        )}
                        <form action={markContactedAction} className="flex gap-1">
                          <input type="hidden" name="id" value={r.id} />
                          <select
                            name="via"
                            className="rounded-lg border border-ink-200 px-1.5 py-1 text-xs"
                          >
                            <option value="WHATSAPP">{ar ? "واتساب" : "WhatsApp"}</option>
                            <option value="PHONE">{ar ? "مكالمة" : "Call"}</option>
                            <option value="EMAIL">{ar ? "إيميل" : "Email"}</option>
                            <option value="ADS">{ar ? "إعلان" : "Ads"}</option>
                          </select>
                          <button
                            type="submit"
                            className="rounded-lg border border-ink-300 px-2 py-1 text-xs text-ink-700"
                          >
                            {ar ? "تم" : "Done"}
                          </button>
                        </form>
                      </div>
                    ),
                  ]
                : []),
            ])}
          />
        )}

        <p className="mt-3 text-xs text-ink-500">
          {ar
            ? "اللي طلب عدم التواصل بيفضل ظاهر — عربيته بتقول حاجة حقيقية عن الطلب — بس من غير أزرار تواصل."
            : "Someone who asked not to be contacted still appears, because their basket says something real about demand, but without any way to message them."}
        </p>
      </Card>
    </>
  );
}
