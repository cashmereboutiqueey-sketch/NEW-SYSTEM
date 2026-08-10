import Link from "next/link";
import { requirePermission } from "@/lib/auth";
import { getPrefs } from "@/lib/session";
import { can } from "@/core/permissions";
import { exhibitionList, sourceLocations } from "@/lib/exhibitions";
import { PageHeader, Card, DataTable, StatTile, Badge } from "@/components/ui";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import { OpenExhibitionForm } from "./open-form";

/**
 * البازارات — stock that leaves the shop for a few days.
 *
 * A bazaar is modelled as a temporary location rather than as its own kind of
 * record, so the till, FIFO, stocktake and every report treat it as what it
 * is: somewhere stock can be. What this screen adds is the discipline around
 * it — goods go out against a named source, and the bazaar cannot be closed
 * without somebody counting what came back.
 */
export default async function ExhibitionsPage() {
  const session = await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayRun = can(session.role, "inventory:transfer");

  const [list, sources] = await Promise.all([exhibitionList(), sourceLocations()]);

  const open = list.filter((e) => e.isActive);
  const closed = list.filter((e) => !e.isActive);

  const onStand = open.reduce((s, e) => s.plus(dec(e.onStand)), dec(0));
  const takings = list.reduce((s, e) => s.plus(dec(e.revenue)), dec(0));

  const dateText = (d: Date | null) =>
    d ? new Date(d).toISOString().slice(0, 10) : "—";

  return (
    <>
      <PageHeader
        title={ar ? "البازارات" : "Bazaars"}
        subtitle={
          ar
            ? "بضاعة بتخرج كام يوم وترجع. اللي مايرجعش بيتقيد خسارة."
            : "Stock that goes out for a few days and comes back. What does not return is written off."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "بازارات شغالة" : "Open bazaars"}
          value={formatNumber(open.length)}
          tone={open.length > 0 ? "info" : "neutral"}
        />
        <StatTile
          label={ar ? "قطع برة دلوقتي" : "Pieces out now"}
          value={formatNumber(onStand.toNumber())}
          hint={ar ? "لسه على الاستاند" : "still on the stand"}
          tone={onStand.greaterThan(0) ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "مبيعات البازارات" : "Bazaar takings"}
          value={formatMoney(takings.toString())}
          tone="good"
        />
      </div>

      {mayRun && sources.length > 0 && (
        <div className="mb-5">
          <Card
            title={ar ? "افتح بازار جديد" : "Open a bazaar"}
            description={
              ar
                ? "اختار المعرض اللي البضاعة هتخرج منه — هي نفسها اللي هترجعله بعد ما يخلص."
                : "Pick where the stock comes from; that is where whatever does not sell goes back."
            }
          >
            <OpenExhibitionForm
              sources={sources.map((s) => ({
                id: s.id,
                name: ar ? s.nameAr : s.nameEn,
              }))}
              ar={ar}
            />
          </Card>
        </div>
      )}

      <div className="mb-5">
        <Card
          title={ar ? "شغالة دلوقتي" : "Running now"}
          description={
            ar
              ? "ادخل على البازار عشان تبعتله بضاعة أو تقفله."
              : "Open a bazaar to send stock to it or to close it."
          }
        >
          <DataTable
            headers={[
              ar ? "البازار" : "Bazaar",
              ar ? "من" : "From",
              ar ? "من — لـ" : "Dates",
              ar ? "على الاستاند" : "On stand",
              ar ? "مبيعات" : "Takings",
              "",
            ]}
            empty={ar ? "مفيش بازار شغال" : "No bazaar is running"}
            rows={open.map((e) => [
              <span key="n" className="font-medium text-ink-900">
                {ar ? e.nameAr : e.nameEn}
                <span className="ms-2 text-xs text-ink-400" dir="ltr">
                  {e.code}
                </span>
              </span>,
              e.parentName ?? "—",
              <span key="d" className="num text-xs" dir="ltr">
                {dateText(e.opensAt)} → {dateText(e.closesAt)}
              </span>,
              <span key="q" className="num">
                {formatNumber(Number(e.onStand))}
              </span>,
              <span key="r" className="num">
                {formatMoney(e.revenue)}
              </span>,
              <Link
                key="l"
                href={`/exhibitions/${e.id}`}
                className="text-sm font-medium text-ink-900 underline"
              >
                {ar ? "افتح" : "Open"}
              </Link>,
            ])}
          />
        </Card>
      </div>

      <Card
        title={ar ? "بازارات خلصت" : "Finished bazaars"}
        description={
          ar
            ? "اتقفلت واتسوّت، ومحصلتها اتقيدت."
            : "Closed, counted and reconciled."
        }
      >
        <DataTable
          headers={[
            ar ? "البازار" : "Bazaar",
            ar ? "من" : "From",
            ar ? "قفل يوم" : "Closed",
            ar ? "طلبات" : "Orders",
            ar ? "مبيعات" : "Takings",
            "",
          ]}
          empty={ar ? "لسه مفيش" : "Nothing yet"}
          rows={closed.map((e) => [
            <span key="n">
              {ar ? e.nameAr : e.nameEn}
              <span className="ms-2 text-xs text-ink-400" dir="ltr">
                {e.code}
              </span>
            </span>,
            e.parentName ?? "—",
            <span key="d" className="num text-xs" dir="ltr">
              {dateText(e.closesAt)}
            </span>,
            <span key="o" className="num">
              {formatNumber(e.orderCount)}
            </span>,
            <span key="r" className="num">
              {formatMoney(e.revenue)}
            </span>,
            Number(e.onStand) > 0 ? (
              <Badge key="b" tone="bad">
                {ar ? "لسه فيه بضاعة" : "stock left"}
              </Badge>
            ) : (
              <Link
                key="l"
                href={`/exhibitions/${e.id}`}
                className="text-sm text-ink-500 underline"
              >
                {ar ? "التفاصيل" : "Detail"}
              </Link>
            ),
          ])}
        />
      </Card>
    </>
  );
}
