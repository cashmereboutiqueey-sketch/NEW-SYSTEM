import Link from "next/link";
import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { formatNumber } from "@/lib/money";
import { cairoParts, shiftDateKey } from "@/core/attendance";
import { unresolvedCount } from "@/lib/attendance";
import { DayActions, LinkBadgeForm } from "./day-actions";
import { DeriveForm, LockForm } from "./range-forms";

/**
 * The attendance day, as somebody has to work it.
 *
 * Built around exceptions rather than around a calendar: nobody needs a screen
 * of days that were fine. What needs a person is a badge nobody recognises, a
 * day with one punch, a scheduled day with none, hours worked beyond a shift
 * that nobody has agreed to pay for.
 *
 * Every row shows the raw punches beside what was derived from them, because
 * the question being answered is always "why does it say that", and the answer
 * is always in the evidence.
 */
export default async function AttendanceReviewPage({
  searchParams,
}: {
  searchParams: Promise<{ from?: string; to?: string; status?: string; employee?: string }>;
}) {
  const session = await requirePermission("attendance:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const params = await searchParams;

  const mayReview = can(session.role, "attendance:review");
  const mayCorrect = can(session.role, "attendance:correct");
  const mayApproveOvertime = can(session.role, "overtime:approve");
  const mayLock = can(session.role, "attendance:lock");
  const mayImport = can(session.role, "attendance:import");

  const today = cairoParts(new Date()).dateKey;
  const from = params.from || shiftDateKey(today, -13);
  const to = params.to || today;
  const monthKey = to.slice(0, 7);

  const fromDate = new Date(`${from}T00:00:00.000Z`);
  const toDate = new Date(`${to}T00:00:00.000Z`);

  const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

  const [days, orphans, employees, period] = await Promise.all([
    db.attendanceDay.findMany({
      where: {
        workDate: { gte: fromDate, lte: toDate },
        ...(params.status ? { status: params.status as never } : {}),
        ...(params.employee ? { employeeId: params.employee } : {}),
      },
      include: {
        employee: { select: { id: true, name: true, code: true, department: true } },
        shift: { select: { code: true, nameEn: true, nameAr: true } },
      },
      orderBy: [{ workDate: "desc" }, { employeeId: "asc" }],
      take: 300,
    }),
    // Punches whose badge belongs to nobody. Grouped by badge, because the
    // action is one link per badge, not one per punch.
    db.biometricPunch.groupBy({
      by: ["deviceUserId"],
      where: { employeeId: null },
      _count: { _all: true },
      _min: { punchedAt: true },
      _max: { punchedAt: true },
    }),
    db.employee.findMany({
      where: { status: { not: "TERMINATED" } },
      select: { id: true, name: true, code: true },
      orderBy: { name: "asc" },
    }),
    db.attendancePeriod.findUnique({
      where: {
        entityId_year_month: {
          entityId: factory.id,
          year: Number(monthKey.slice(0, 4)),
          month: Number(monthKey.slice(5, 7)),
        },
      },
    }),
  ]);

  // The punches behind the days on screen, so evidence sits beside judgement.
  const punches = await db.biometricPunch.findMany({
    where: {
      employeeId: { in: [...new Set(days.map((d) => d.employeeId))] },
      punchedAt: {
        gte: new Date(`${shiftDateKey(from, -1)}T00:00:00.000Z`),
        lt: new Date(`${shiftDateKey(to, 2)}T00:00:00.000Z`),
      },
    },
    select: { employeeId: true, punchedAt: true },
    orderBy: { punchedAt: "asc" },
  });
  const punchesFor = (employeeId: string, workDate: Date) => {
    const key = cairoParts(workDate).dateKey;
    return punches
      .filter((p) => p.employeeId === employeeId && cairoParts(p.punchedAt).dateKey === key)
      .map((p) => {
        const parts = cairoParts(p.punchedAt);
        return `${String(Math.floor(parts.minuteOfDay / 60)).padStart(2, "0")}:${String(parts.minuteOfDay % 60).padStart(2, "0")}`;
      });
  };

  const unresolved = await unresolvedCount(
    factory.id,
    Number(monthKey.slice(0, 4)),
    Number(monthKey.slice(5, 7)),
  );

  const statusTone: Record<string, "good" | "warn" | "bad" | "neutral" | "info"> = {
    PRESENT: "good",
    LATE: "warn",
    EARLY_LEAVE: "warn",
    INCOMPLETE: "bad",
    ABSENT: "bad",
    LEAVE: "info",
    OFF: "neutral",
    NEEDS_REVIEW: "bad",
  };
  const statusLabel: Record<string, string> = ar
    ? {
        PRESENT: "حاضر", LATE: "متأخر", EARLY_LEAVE: "خرج بدري", INCOMPLETE: "بصمة ناقصة",
        ABSENT: "غياب", LEAVE: "إجازة", OFF: "راحة", NEEDS_REVIEW: "محتاج مراجعة",
      }
    : {
        PRESENT: "Present", LATE: "Late", EARLY_LEAVE: "Left early", INCOMPLETE: "Missing punch",
        ABSENT: "Absent", LEAVE: "Leave", OFF: "Off", NEEDS_REVIEW: "Needs review",
      };

  const mins = (value: unknown) => formatNumber(Math.round(Number(value)), locale);
  const queue = (status: string) => days.filter((d) => d.status === status).length;

  return (
    <>
      <PageHeader
        title={ar ? "الحضور والمراجعة" : "Attendance review"}
        subtitle={
          ar
            ? "البصمة دليل خام مبيتغيّرش؛ اليوم حكم بيتصحّح بسبب مكتوب — والاتنين جنب بعض هنا"
            : "A punch is raw evidence and never changes; a day is a judgement and can be corrected with a stated reason — both are side by side here"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <StatTile
          label={ar ? "محتاج مراجعة" : "Needs review"}
          value={String(queue("NEEDS_REVIEW"))}
          tone={queue("NEEDS_REVIEW") > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "بصمة ناقصة" : "Missing punch"}
          value={String(queue("INCOMPLETE"))}
          tone={queue("INCOMPLETE") > 0 ? "bad" : "good"}
        />
        <StatTile
          label={ar ? "تأخير" : "Late"}
          value={String(queue("LATE"))}
          tone={queue("LATE") > 0 ? "warn" : "neutral"}
        />
        <StatTile
          label={ar ? "بصمات مجهولة" : "Unknown badges"}
          value={String(orphans.length)}
          tone={orphans.length > 0 ? "warn" : "good"}
        />
        <StatTile
          label={ar ? "إضافي مستني موافقة" : "Overtime pending"}
          value={String(unresolved.overtimePending)}
          tone={unresolved.overtimePending > 0 ? "warn" : "neutral"}
          hint={ar ? "الشهر كله" : "this month"}
        />
      </div>

      {/* --------------------------------------------------------- filters */}
      <Card className="mb-4" title={ar ? "المدى" : "The range"}>
        <form method="get" className="flex flex-wrap items-end gap-3">
          <div>
            <label className="mb-1 block text-xs text-ink-600" htmlFor="f-from">
              {ar ? "من" : "From"}
            </label>
            <input
              id="f-from" name="from" type="date" defaultValue={from} dir="ltr"
              className="rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-600" htmlFor="f-to">
              {ar ? "إلى" : "To"}
            </label>
            <input
              id="f-to" name="to" type="date" defaultValue={to} dir="ltr"
              className="rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-600" htmlFor="f-status">
              {ar ? "الحالة" : "Status"}
            </label>
            <select
              id="f-status" name="status" defaultValue={params.status ?? ""}
              className="rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm"
            >
              <option value="">{ar ? "الكل" : "All"}</option>
              {Object.keys(statusLabel).map((s) => (
                <option key={s} value={s}>{statusLabel[s]}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs text-ink-600" htmlFor="f-emp">
              {ar ? "الموظف" : "Employee"}
            </label>
            <select
              id="f-emp" name="employee" defaultValue={params.employee ?? ""}
              className="rounded-lg border border-ink-200 bg-panel px-3 py-2 text-sm"
            >
              <option value="">{ar ? "الكل" : "Everyone"}</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>{e.name}</option>
              ))}
            </select>
          </div>
          <button type="submit" className="rounded-lg bg-ink-900 px-4 py-2 text-sm font-medium text-white">
            {ar ? "اعرض" : "Show"}
          </button>

          {mayReview && <DeriveForm ar={ar} from={from} to={to} />}

          {mayImport && (
            <Link
              href="/hr/attendance/import"
              className="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700"
            >
              {ar ? "استيراد بصمات" : "Import punches"}
            </Link>
          )}
          <Link
            href="/hr/attendance/shifts"
            className="rounded-lg border border-ink-200 px-3 py-2 text-sm text-ink-700"
          >
            {ar ? "الورديات" : "Shifts"}
          </Link>
        </form>
      </Card>

      {/* --------------------------------------------------- unknown badges */}
      {orphans.length > 0 && (
        <Card
          className="mb-4"
          title={ar ? "بصمات مالهاش موظف" : "Badges nobody is linked to"}
          description={
            ar
              ? "البصمة اتسجّلت زي ما هي — ماترميش ساعات شغل لمجرد إن الكارت مش معروف"
              : "The punches are stored as they are — hours are not thrown away because a card is unrecognised"
          }
        >
          <DataTable
            headers={[
              ar ? "رقم البصمة" : "Badge",
              ar ? "عدد" : "Punches",
              ar ? "من" : "First",
              ar ? "إلى" : "Last",
              mayReview ? (ar ? "اربطها بمين" : "Link to") : "",
            ]}
            rows={orphans.map((o) => [
              <code key={`${o.deviceUserId}-b`} dir="ltr" className="text-xs">{o.deviceUserId}</code>,
              <span key={`${o.deviceUserId}-c`} className="num">{formatNumber(o._count._all, locale)}</span>,
              <span key={`${o.deviceUserId}-f`} className="num text-xs" dir="ltr">
                {o._min.punchedAt ? cairoParts(o._min.punchedAt).dateKey : "—"}
              </span>,
              <span key={`${o.deviceUserId}-l`} className="num text-xs" dir="ltr">
                {o._max.punchedAt ? cairoParts(o._max.punchedAt).dateKey : "—"}
              </span>,
              mayReview ? (
                <LinkBadgeForm
                  key={`${o.deviceUserId}-a`}
                  ar={ar}
                  deviceUserId={o.deviceUserId}
                  employees={employees.map((e) => ({ id: e.id, label: `${e.name} · ${e.code}` }))}
                  from={o._min.punchedAt ? cairoParts(o._min.punchedAt).dateKey : from}
                  to={o._max.punchedAt ? cairoParts(o._max.punchedAt).dateKey : to}
                />
              ) : (
                <span key={`${o.deviceUserId}-a`} />
              ),
            ])}
          />
        </Card>
      )}

      {/* ------------------------------------------------------ the lock */}
      {mayLock && (
        <Card
          className="mb-4"
          title={ar ? "قفل الشهر للمرتبات" : "Lock the month for payroll"}
          description={
            ar
              ? `حالة ${monthKey}: ${period?.status === "LOCKED" ? "مقفول" : "مفتوح"} — بعد القفل أي تعديل بيتسجّل كتسوية`
              : `${monthKey} is ${period?.status === "LOCKED" ? "locked" : "open"} — after locking, a change is recorded as an adjustment`
          }
        >
          <LockForm
            ar={ar}
            entityId={factory.id}
            month={monthKey}
            blocked={unresolved.needsReview + unresolved.incomplete}
          />
        </Card>
      )}

      {/* ---------------------------------------------------------- days */}
      <Card title={ar ? "الأيام" : "Days"}>
        <DataTable
          headers={[
            ar ? "اليوم" : "Day",
            ar ? "الموظف" : "Employee",
            ar ? "الوردية" : "Shift",
            ar ? "البصمات" : "Punches",
            ar ? "دخول" : "In",
            ar ? "خروج" : "Out",
            ar ? "شغل" : "Worked",
            ar ? "تأخير" : "Late",
            ar ? "إضافي" : "Overtime",
            ar ? "الحالة" : "Status",
            "",
          ]}
          empty={ar ? "مفيش أيام في المدى ده" : "No days in this range"}
          rows={days.map((d) => {
            const raw = punchesFor(d.employeeId, d.workDate);
            const hhmm = (value: Date | null) => {
              if (!value) return "—";
              const p = cairoParts(value);
              return `${String(Math.floor(p.minuteOfDay / 60)).padStart(2, "0")}:${String(p.minuteOfDay % 60).padStart(2, "0")}`;
            };
            return [
              <span key={`${d.id}-d`} className="num text-xs" dir="ltr">
                {cairoParts(d.workDate).dateKey}
              </span>,
              <span key={`${d.id}-e`}>
                {d.employee.name}
                <code className="ms-1 text-[10px] text-ink-400" dir="ltr">{d.employee.code}</code>
              </span>,
              <span key={`${d.id}-s`} className="text-xs text-ink-500">
                {d.shift ? (ar ? d.shift.nameAr : d.shift.nameEn) : "—"}
              </span>,
              // The evidence itself, next to what was made of it.
              <span key={`${d.id}-p`} className="num text-[11px] text-ink-500" dir="ltr">
                {raw.length > 0 ? raw.join(" · ") : "—"}
              </span>,
              <span key={`${d.id}-i`} className="num text-xs" dir="ltr">{hhmm(d.firstIn)}</span>,
              <span key={`${d.id}-o`} className="num text-xs" dir="ltr">{hhmm(d.lastOut)}</span>,
              <span key={`${d.id}-w`} className="num">{mins(d.workedMinutes)}</span>,
              <span key={`${d.id}-l`} className={Number(d.lateMinutes) > 0 ? "num text-warn" : "num text-ink-300"}>
                {mins(d.lateMinutes)}
              </span>,
              <span key={`${d.id}-ot`} className="num">
                {Number(d.overtimeMinutes) > 0 ? (
                  <span className="text-good">{mins(d.overtimeMinutes)}</span>
                ) : Number(d.overtimeCandidateMinutes) > 0 ? (
                  <span className="text-warn" title={ar ? "مستني موافقة" : "awaiting approval"}>
                    ({mins(d.overtimeCandidateMinutes)})
                  </span>
                ) : (
                  <span className="text-ink-300">0</span>
                )}
              </span>,
              <span key={`${d.id}-st`} className="flex items-center gap-1">
                <Badge tone={statusTone[d.status] ?? "neutral"}>{statusLabel[d.status] ?? d.status}</Badge>
                {d.lockedAt && (
                  <span className="text-[10px] text-ink-400" title={ar ? "مقفول" : "locked"}>
                    {ar ? "مقفول" : "locked"}
                  </span>
                )}
              </span>,
              <DayActions
                key={`${d.id}-a`}
                ar={ar}
                dayId={d.id}
                status={d.status}
                locked={d.lockedAt !== null}
                overtimeCandidate={Math.round(Number(d.overtimeCandidateMinutes))}
                mayCorrect={mayCorrect}
                mayReview={mayReview}
                mayApproveOvertime={mayApproveOvertime}
                mayLock={mayLock}
              />,
            ];
          })}
        />
      </Card>
    </>
  );
}
