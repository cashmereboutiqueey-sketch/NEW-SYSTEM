import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { openAlerts } from "@/lib/alerts";
import { PageHeader, Card, Badge, StatTile } from "@/components/ui";
import { RunAlertsForm, AcknowledgeForm } from "./alert-forms";

/**
 * التنبيهات — the system tells you, rather than you going to look.
 *
 * Each alert is a condition, not an event. The same problem seen on three
 * mornings is one open alert, not three, and one that goes away closes itself.
 * That is what keeps the list short enough to be read.
 */
export default async function AlertsPage() {
  const session = await requirePermission("alert:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const mayRun = can(session.role, "alert:view");
  const mayAck = can(session.role, "alert:acknowledge");

  const [alerts, rules] = await Promise.all([
    openAlerts(),
    db.alertRule.findMany({ orderBy: { code: "asc" } }),
  ]);

  const now = Date.now();
  const live = alerts.filter(
    (a) => a.status !== "SNOOZED" || (a.snoozedUntil?.getTime() ?? 0) <= now,
  );
  const snoozed = alerts.filter(
    (a) => a.status === "SNOOZED" && (a.snoozedUntil?.getTime() ?? 0) > now,
  );

  const critical = live.filter((a) => a.severity === "CRITICAL");
  const warning = live.filter((a) => a.severity === "WARNING");
  const lastRun = rules
    .map((r) => r.lastRunAt)
    .filter((d): d is Date => d != null)
    .sort((a, b) => b.getTime() - a.getTime())[0];

  const severityTone = (s: string) =>
    s === "CRITICAL" ? "bad" : s === "WARNING" ? "warn" : "info";
  const severityLabel = (s: string) =>
    ar
      ? { CRITICAL: "حرج", WARNING: "تحذير", INFO: "للعلم" }[s] ?? s
      : { CRITICAL: "Critical", WARNING: "Warning", INFO: "Note" }[s] ?? s;

  return (
    <>
      <PageHeader
        title={ar ? "التنبيهات" : "Alerts"}
        subtitle={
          ar
            ? "الحدود بتتظبط في قواعد التنبيه نفسها — مش مكتوبة في الكود"
            : "Thresholds live in the rules themselves, never in the code"
        }
        actions={mayRun ? <RunAlertsForm locale={locale} /> : undefined}
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "حرج" : "Critical"}
          value={String(critical.length)}
          tone={critical.length > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "تحذير" : "Warnings"}
          value={String(warning.length)}
          tone={warning.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "مؤجّلة" : "Snoozed"}
          value={String(snoozed.length)}
          hint={ar ? "بترجع لو المشكلة لسه موجودة" : "Return if still true"}
        />
        <StatTile
          label={ar ? "آخر فحص" : "Last checked"}
          value={lastRun ? lastRun.toISOString().slice(0, 10) : ar ? "لسه" : "Never"}
          tone={lastRun ? "neutral" : "warn"}
          hint={lastRun ? lastRun.toISOString().slice(11, 16) : undefined}
        />
      </div>

      {live.length === 0 ? (
        <Card className="mb-4">
          <p className="py-8 text-center text-sm text-ink-400">
            {lastRun
              ? ar
                ? "مفيش حاجة خارجة عن الحدود."
                : "Nothing is outside its threshold."
              : ar
                ? "لسه مفيش فحص اتعمل. دوس افحص دلوقتي."
                : "No check has been run yet. Press check now."}
          </p>
        </Card>
      ) : (
        <div className="mb-4 space-y-3">
          {live.map((a) => (
            <Card key={a.id}>
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <Badge tone={severityTone(a.severity)}>{severityLabel(a.severity)}</Badge>
                    <span className="font-medium">{ar ? a.titleAr : a.titleEn}</span>
                    {a.status === "ACKNOWLEDGED" && (
                      <Badge tone="neutral">
                        {ar ? "متشافة" : "Seen"}
                        {a.acknowledgedBy ? ` · ${a.acknowledgedBy.name}` : ""}
                      </Badge>
                    )}
                  </div>
                  <p className="text-sm text-ink-600">{ar ? a.bodyAr : a.bodyEn}</p>
                  <p className="mt-1 text-xs text-ink-400">
                    <code dir="ltr">{a.alertRule.code}</code>
                    {" · "}
                    <span className="num" dir="ltr">
                      {a.createdAt.toISOString().slice(0, 10)}
                    </span>
                  </p>
                </div>
                {mayAck && (
                  <AcknowledgeForm locale={locale} alertId={a.id} status={a.status} />
                )}
              </div>
            </Card>
          ))}
        </div>
      )}

      {snoozed.length > 0 && (
        <Card className="mb-4" title={ar ? "مؤجّلة" : "Snoozed"}>
          <ul className="space-y-2 text-sm">
            {snoozed.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <Badge tone="neutral">{severityLabel(a.severity)}</Badge>
                <span className="flex-1">{ar ? a.titleAr : a.titleEn}</span>
                <span className="text-xs text-ink-400" dir="ltr">
                  {ar ? "بترجع" : "back"} {a.snoozedUntil?.toISOString().slice(0, 10)}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <Card
        title={ar ? "القواعد" : "The rules"}
        description={
          ar
            ? "الحدود دي بتتغيّر من غير أي تعديل في الكود"
            : "These thresholds change without touching the code"
        }
      >
        <ul className="divide-y divide-ink-100 text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center gap-3 py-2">
              <Badge tone={r.isEnabled ? severityTone(r.severity) : "neutral"}>
                {r.isEnabled ? severityLabel(r.severity) : ar ? "مقفولة" : "Off"}
              </Badge>
              <span className="flex-1">
                {ar ? r.nameAr : r.nameEn}
                <span className="ms-2 text-xs text-ink-400">
                  {ar ? r.descriptionAr : r.descriptionEn}
                </span>
              </span>
              <code dir="ltr" className="text-xs text-ink-500">
                {JSON.stringify(r.parameters)}
              </code>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
