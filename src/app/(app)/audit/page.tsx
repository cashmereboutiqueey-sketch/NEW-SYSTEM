import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { auditTrail, auditFilterOptions, auditSummary } from "@/lib/journal";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatNumber } from "@/lib/money";

/**
 * سجل التدقيق — who did what.
 *
 * Written on every consequential action since the first migration and readable
 * from nowhere. An audit trail nobody can open is a trail that exists only to
 * be believed in; the whole point of writing one is that somebody can check it
 * afterwards without asking an engineer to run a query.
 *
 * `audit:view` is its own permission for a reason. The trail records what
 * everybody did, including the people who can approve and post, so being able
 * to read it is not the same authority as being able to act.
 */
export default async function AuditPage({
  searchParams,
}: {
  searchParams: Promise<{ action?: string; user?: string; entity?: string; id?: string }>;
}) {
  await requirePermission("audit:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const query = await searchParams;

  const [rows, options, summary] = await Promise.all([
    auditTrail({
      action: query.action || null,
      userId: query.user || null,
      entityName: query.entity || null,
      entityId: query.id || null,
      limit: 250,
    }),
    auditFilterOptions(),
    auditSummary(),
  ]);

  const field =
    "rounded-lg border border-ink-200 bg-white px-2.5 py-1.5 text-sm outline-none focus:border-ink-500";

  const when = (d: Date) => {
    const x = new Date(d);
    return `${x.toISOString().slice(0, 10)} ${x.toISOString().slice(11, 16)}`;
  };

  /** A JSON blob is unreadable in a table cell; the changed fields are not. */
  const summarise = (value: unknown): string => {
    if (value == null) return "—";
    if (typeof value !== "object") return String(value);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "—";
    return entries
      .slice(0, 4)
      .map(([k, v]) => `${k}: ${v == null ? "—" : String(v)}`)
      .join(" · ");
  };

  return (
    <>
      <PageHeader
        title={ar ? "سجل التدقيق" : "Audit trail"}
        subtitle={
          ar
            ? "مين عمل إيه وإمتى. بيتكتب على كل حاجة ليها أثر، وما بيتعدلش."
            : "Who did what, and when. Written on every consequential action, and never edited."
        }
      />

      <div className="mb-5 grid gap-3 sm:grid-cols-4">
        <StatTile
          label={ar ? "إجمالي السجل" : "Entries recorded"}
          value={formatNumber(summary.total)}
        />
        <StatTile
          label={ar ? `آخر ${summary.sinceDays} يوم` : `Last ${summary.sinceDays} days`}
          value={formatNumber(summary.recent)}
          tone="info"
        />
        <StatTile
          label={ar ? "معروض دلوقتي" : "Shown"}
          value={formatNumber(rows.length)}
          hint={rows.length >= 250 ? (ar ? "أول ٢٥٠ — صفّي أكتر" : "first 250 — filter further") : undefined}
        />
        <StatTile
          label={ar ? "أكتر إجراء" : "Most common"}
          value={summary.topActions[0]?.action ?? "—"}
          hint={
            summary.topActions[0]
              ? `${formatNumber(summary.topActions[0].count)} ${ar ? "مرة" : "times"}`
              : undefined
          }
        />
      </div>

      <div className="mb-5">
        <Card title={ar ? "تصفية" : "Filter"}>
          <form method="get" action="/audit" className="flex flex-wrap items-end gap-2">
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="action">
                {ar ? "الإجراء" : "Action"}
              </label>
              <select id="action" name="action" className={field} defaultValue={query.action ?? ""}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {options.actions.map((a) => (
                  <option key={a} value={a}>{a}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="user">
                {ar ? "المستخدم" : "User"}
              </label>
              <select id="user" name="user" className={field} defaultValue={query.user ?? ""}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {options.users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name} ({u.role})
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="mb-1 block text-xs text-ink-500" htmlFor="entity">
                {ar ? "على إيه" : "On what"}
              </label>
              <select id="entity" name="entity" className={field} defaultValue={query.entity ?? ""}>
                <option value="">{ar ? "الكل" : "All"}</option>
                {options.entityNames.map((e) => (
                  <option key={e} value={e}>{e}</option>
                ))}
              </select>
            </div>
            <button type="submit" className="rounded-lg bg-ink-900 px-4 py-2 text-sm text-white">
              {ar ? "اعرض" : "Show"}
            </button>
            <a href="/audit" className="rounded-lg border border-line px-4 py-2 text-sm text-ink-600">
              {ar ? "امسح" : "Clear"}
            </a>
          </form>
        </Card>
      </div>

      {summary.topActions.length > 0 && (
        <div className="mb-5">
          <Card
            title={ar ? "أكتر الإجراءات" : "What happens most"}
            description={
              ar ? `آخر ${summary.sinceDays} يوم` : `Over the last ${summary.sinceDays} days`
            }
          >
            <div className="flex flex-wrap gap-2">
              {summary.topActions.map((a) => (
                <a
                  key={a.action}
                  href={`/audit?action=${encodeURIComponent(a.action)}`}
                  className="rounded-lg border border-line px-3 py-1.5 text-xs hover:border-ink-300"
                >
                  <span className="num">{a.action}</span>
                  <span className="ms-2 num text-ink-400">{formatNumber(a.count)}</span>
                </a>
              ))}
            </div>
          </Card>
        </div>
      )}

      <Card
        title={ar ? "السجل" : "The trail"}
        description={
          ar
            ? "«النظام» معناه إن اللي عمل ده مش شخص — بذرة، أو مهمة مجدولة، أو ترحيل."
            : "\"System\" means no person did it — a seed, a scheduled job, or a migration."
        }
      >
        <DataTable
          headers={[
            ar ? "إمتى" : "When",
            ar ? "مين" : "Who",
            ar ? "عمل إيه" : "Did what",
            ar ? "على إيه" : "On what",
            ar ? "التفاصيل" : "Detail",
            ar ? "السبب" : "Reason",
          ]}
          empty={
            ar
              ? "مفيش سجلات بالمواصفات دي."
              : "Nothing matches that."
          }
          rows={rows.map((r) => [
            <span key="w" className="num text-xs" dir="ltr">{when(r.at)}</span>,
            r.userName ? (
              <span key="u">
                {r.userName}
                {r.userRole && (
                  <span className="ms-2 text-xs text-ink-400">{r.userRole}</span>
                )}
              </span>
            ) : (
              <span key="u" className="text-xs text-ink-400">{ar ? "النظام" : "System"}</span>
            ),
            <Badge key="a" tone="neutral">{r.action}</Badge>,
            <span key="e" className="text-xs">
              {r.entityName}
              <span className="ms-2 num text-ink-400" dir="ltr">
                {r.entityId.slice(0, 8)}
              </span>
            </span>,
            <span key="d" className="text-xs text-ink-500">{summarise(r.after)}</span>,
            <span key="r" className="text-xs text-ink-600">{r.reason ?? "—"}</span>,
          ])}
        />
      </Card>
    </>
  );
}
