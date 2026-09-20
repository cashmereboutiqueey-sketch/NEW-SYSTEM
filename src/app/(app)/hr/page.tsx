import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import Link from "next/link";
import { formatMoney, formatNumber, formatPercent } from "@/lib/money";
import { cairoParts } from "@/core/attendance";
import { dec } from "@/lib/money";
import { createEmployeeAction } from "./actions";

/**
 * الموظفون والأجور — HR and payroll.
 *
 * Salary figures are gated behind the salary capability, so the page is
 * useful to a production supervisor without exposing what anyone is paid.
 *
 * Punches are shown as raw evidence separately from approved attendance,
 * because a broken reader must be correctable without rewriting what the
 * device actually recorded.
 */
export default async function HrPage() {
  const session = await requirePermission("employee:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const seeSalary = can(session.role, "salary:view");

  const mayManage = can(session.role, "payroll:prepare");

  const [employees, runs, unmatchedPunches, needsReview, entities, costCentres, lines] =
    await Promise.all([
    db.employee.findMany({
      where: { status: { not: "TERMINATED" } },
      include: { entity: true, costCenter: true },
      orderBy: { code: "asc" },
    }),
    db.payrollRun.findMany({
      include: {
        entity: true,
        fiscalPeriod: true,
        _count: { select: { lines: true } },
      },
      orderBy: [{ fiscalPeriod: { year: "desc" } }, { fiscalPeriod: { month: "desc" } }],
      take: 12,
    }),
    db.biometricPunch.count({ where: { employeeId: null } }),
    // Anything a person still has to settle, by its own status rather than by
    // matching words in a note.
    db.attendanceDay.count({ where: { status: { in: ["NEEDS_REVIEW", "INCOMPLETE"] } } }),
    db.entity.findMany({ orderBy: { kind: "asc" } }),
    db.costCenter.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.productionLine.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
  ]);

  /*
   * Today, and the month so far.
   *
   * The dashboard answers two questions a manager actually asks: who is on the
   * floor right now, and what is waiting for me. Everything here is countable
   * from the days themselves — no figure is a salary, so a line supervisor can
   * read it without seeing anybody's pay.
   */
  const today = cairoParts(new Date()).dateKey;
  const todayDate = new Date(`${today}T00:00:00.000Z`);
  const monthStart = new Date(`${today.slice(0, 7)}-01T00:00:00.000Z`);

  const [todayDays, monthDays, overtimePending, lastImport] = await Promise.all([
    db.attendanceDay.groupBy({
      by: ["status"],
      where: { workDate: todayDate },
      _count: { _all: true },
    }),
    db.attendanceDay.findMany({
      where: { workDate: { gte: monthStart, lte: todayDate } },
      select: { status: true, overtimeMinutes: true, scheduledMinutes: true },
    }),
    db.attendanceDay.count({
      where: { overtimeCandidateMinutes: { gt: 0 }, overtimeApprovedAt: null },
    }),
    db.attendanceImport.findFirst({
      orderBy: { createdAt: "desc" },
      include: { importedBy: { select: { name: true } } },
    }),
  ]);

  const todayCount = (status: string) =>
    todayDays.find((d) => d.status === status)?._count._all ?? 0;

  // Days somebody was expected and turned up, over days somebody was expected.
  const expected = monthDays.filter((d) => d.status !== "OFF" && d.status !== "LEAVE").length;
  const attended = monthDays.filter(
    (d) => d.status === "PRESENT" || d.status === "LATE" || d.status === "EARLY_LEAVE",
  ).length;
  const attendanceRate = expected > 0 ? attended / expected : null;
  const approvedOvertimeHours = monthDays.reduce(
    (sum, d) => sum + Number(d.overtimeMinutes) / 60,
    0,
  );

  const name = (e: { nameAr: string; nameEn: string }) => (ar ? e.nameAr : e.nameEn);
  const payroll = employees.reduce((s, e) => s.plus(dec(e.baseSalary)), dec(0));

  const statusTone: Record<string, "good" | "warn" | "neutral"> = {
    ACTIVE: "good", ON_LEAVE: "warn", TERMINATED: "neutral",
  };
  const runTone: Record<string, "neutral" | "info" | "good"> = {
    DRAFT: "neutral", APPROVED: "info", POSTED: "good",
  };
  const runLabel: Record<string, string> = ar
    ? { DRAFT: "مسودة", APPROVED: "معتمد", POSTED: "مُرحَّل" }
    : { DRAFT: "Draft", APPROVED: "Approved", POSTED: "Posted" };

  return (
    <>
      <PageHeader
        title={ar ? "الموظفون والأجور" : "People and payroll"}
        subtitle={
          ar
            ? "البصمة دليل، والحضور المعتمد هو الأساس — والأجر يدخل مجمع تكلفة المصنع مرة واحدة فقط"
            : "Punches are evidence, approved attendance is the record — and wages reach the factory cost pool exactly once"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatTile
          label={ar ? "الموظفون" : "Employees"}
          value={formatNumber(employees.length, locale)}
        />
        {seeSalary && (
          <StatTile
            label={ar ? "إجمالي الأجور الشهرية" : "Monthly payroll"}
            value={formatMoney(payroll, locale)}
            hint={ar ? "الأساسي قبل الإضافي والتأمينات" : "Base, before overtime and insurance"}
          />
        )}
        <StatTile
          label={ar ? "بصمات بلا موظف" : "Unmatched punches"}
          value={formatNumber(unmatchedPunches, locale)}
          tone={unmatchedPunches > 0 ? "warn" : "good"}
          hint={ar ? "كارت غير معروف" : "Unknown badge"}
        />
        <StatTile
          label={ar ? "أيام تحتاج مراجعة" : "Days needing review"}
          value={formatNumber(needsReview, locale)}
          tone={needsReview > 0 ? "bad" : "good"}
          hint={ar ? "بصمة انصراف ناقصة" : "Missing clock-out"}
        />
      </div>

      <Card
        className="mb-4"
        title={ar ? "النهارده" : "Today"}
        description={
          ar
            ? `${today} — كل رقم هنا يوصّلك للي محتاج تصرف فيه`
            : `${today} — every figure here leads to what needs doing about it`
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link href={`/hr/attendance?from=${today}&to=${today}&status=PRESENT`}>
            <StatTile
              label={ar ? "حاضر" : "Present"}
              value={formatNumber(todayCount("PRESENT") + todayCount("EARLY_LEAVE"), locale)}
              tone="good"
            />
          </Link>
          <Link href={`/hr/attendance?from=${today}&to=${today}&status=LATE`}>
            <StatTile
              label={ar ? "متأخر" : "Late"}
              value={formatNumber(todayCount("LATE"), locale)}
              tone={todayCount("LATE") > 0 ? "warn" : "neutral"}
            />
          </Link>
          <Link href={`/hr/attendance?from=${today}&to=${today}&status=ABSENT`}>
            <StatTile
              label={ar ? "غياب" : "Absent"}
              value={formatNumber(todayCount("ABSENT"), locale)}
              tone={todayCount("ABSENT") > 0 ? "bad" : "good"}
            />
          </Link>
          <Link href={`/hr/attendance?from=${today}&to=${today}&status=INCOMPLETE`}>
            <StatTile
              label={ar ? "بصمة ناقصة" : "Incomplete"}
              value={formatNumber(todayCount("INCOMPLETE"), locale)}
              tone={todayCount("INCOMPLETE") > 0 ? "bad" : "good"}
              hint={ar ? "مش غياب" : "not absence"}
            />
          </Link>
        </div>

        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link href="/hr/attendance">
            <StatTile
              label={ar ? "مستني مراجعة" : "Pending review"}
              value={formatNumber(needsReview, locale)}
              tone={needsReview > 0 ? "bad" : "good"}
            />
          </Link>
          <Link href="/hr/attendance">
            <StatTile
              label={ar ? "إضافي مستني موافقة" : "Overtime pending"}
              value={formatNumber(overtimePending, locale)}
              tone={overtimePending > 0 ? "warn" : "neutral"}
            />
          </Link>
          <StatTile
            label={ar ? "نسبة الحضور للشهر" : "Attendance this month"}
            value={attendanceRate == null ? "—" : formatPercent(attendanceRate, locale)}
            hint={ar ? "من الأيام المجدولة" : "of scheduled days"}
          />
          <StatTile
            label={ar ? "إضافي معتمد" : "Approved overtime"}
            value={`${formatNumber(Math.round(approvedOvertimeHours * 10) / 10, locale)} ${ar ? "ساعة" : "h"}`}
            hint={ar ? "الشهر ده" : "this month"}
          />
        </div>

        <p className="mt-3 text-xs text-ink-500">
          {lastImport
            ? ar
              ? `آخر استيراد: ${lastImport.filename} من ${lastImport.deviceId}، ${lastImport.createdAt.toISOString().slice(0, 10)}، بواسطة ${lastImport.importedBy?.name ?? "—"} — ${lastImport.status === "COMMITTED" ? "تم" : "لسه في المراجعة"}.`
              : `Last import: ${lastImport.filename} from ${lastImport.deviceId} on ${lastImport.createdAt.toISOString().slice(0, 10)} by ${lastImport.importedBy?.name ?? "—"} — ${lastImport.status === "COMMITTED" ? "imported" : "still previewed"}.`
            : ar
              ? "مفيش ملف بصمات اتحمّل لسه."
              : "No device file has been loaded yet."}
        </p>
      </Card>

      {(unmatchedPunches > 0 || needsReview > 0) && (
        <Card className="mb-4">
          <p className="text-sm text-warn">
            {ar
              ? "بصمة ناقصة لا تُحسَب غيابًا ولا تُقدَّر تلقائيًا — لازم مشرف يراجعها قبل ما تأثر على الأجر."
              : "A missing punch is neither treated as absence nor guessed at — a supervisor must resolve it before it affects pay."}
          </p>
        </Card>
      )}

      {mayManage && (
        <Card className="mb-4" title={ar ? "إضافة موظف" : "Add an employee"}>
          <EntityForm
            locale={locale}
            action={createEmployeeAction}
            submitEn="Add employee"
            submitAr="أضف الموظف"
            fields={[
              {
                kind: "text", name: "code", labelEn: "Employee code", labelAr: "كود الموظف",
                required: true, placeholder: "EMP-101", ltr: true,
              },
              { kind: "text", name: "name", labelEn: "Full name", labelAr: "الاسم", required: true, span: 2 },
              {
                kind: "select", name: "entityId", labelEn: "Employed by", labelAr: "جهة العمل",
                required: true,
                options: entities.map((e) => ({ value: e.id, label: name(e) })),
              },
              {
                kind: "select", name: "costCenterId", labelEn: "Cost centre", labelAr: "مركز التكلفة",
                options: costCentres.map((c) => ({ value: c.id, label: name(c) })),
                emptyLabel: ar ? "— بدون —" : "— none —",
                hintEn: "Decides which account the wage is charged to, and so which cost pool it lands in.",
                hintAr: "بيحدد الحساب اللي الأجر يتحمّل عليه، وبالتالي أي مجمّع تكلفة يدخله.",
              },
              {
                kind: "select", name: "productionLineId", labelEn: "Production line", labelAr: "خط الإنتاج",
                options: lines.map((l) => ({ value: l.id, label: name(l) })),
                emptyLabel: ar ? "— ليس عامل إنتاج —" : "— not a line operator —",
                hintEn: "Sewing operators also become production operators on a line.",
                hintAr: "عمال الإنتاج بيتسجّلوا كمان كعمال على خط.",
              },
              { kind: "text", name: "jobTitle", labelEn: "Job title", labelAr: "المسمى الوظيفي" },
              { kind: "text", name: "department", labelEn: "Department", labelAr: "القسم" },
              {
                kind: "date", name: "hiredAt", labelEn: "Hired on", labelAr: "تاريخ التعيين",
                required: true, defaultValue: new Date().toISOString().slice(0, 10), ltr: true,
              },
              {
                kind: "select", name: "payFrequency", labelEn: "Paid by", labelAr: "بيتحاسب بالـ",
                options: [
                  { value: "MONTHLY", label: ar ? "الشهر" : "Month" },
                  { value: "WEEKLY", label: ar ? "الأسبوع" : "Week" },
                  { value: "DAILY", label: ar ? "اليوم" : "Day" },
                  { value: "PIECE_RATE", label: ar ? "القطعة" : "Piece" },
                ],
                hintEn: "A month is an entitlement absence reduces; a week or a day is earned by turning up. Piece work is paid for what was made.",
                hintAr: "الشهري استحقاق بيقل بالغياب، والأسبوعي واليومي بيتكسبوا بالحضور. والقطعة بتتحاسب على اللي اتعمل فعلًا.",
              },
              {
                kind: "number", name: "baseSalary", labelEn: "Base salary", labelAr: "الأجر الأساسي",
                required: true, step: "0.01", min: "0", ltr: true,
                hintEn: "Gross per period — a month, a week, a day. Zero for piece work. A later change is recorded as history, never an edit.",
                hintAr: "الإجمالي للفترة — شهر أو أسبوع أو يوم. صفر لو بالقطعة. أي تغيير بعدين بيتسجّل كتاريخ مش تعديل.",
              },
              {
                kind: "number", name: "pieceRate", labelEn: "Per piece", labelAr: "أجر القطعة",
                step: "0.01", min: "0", ltr: true,
                hintEn: "Only for piece work: what one finished garment pays. Their pay comes from the garments recorded against them on the operators screen.",
                hintAr: "للشغل بالقطعة بس: القطعة الواحدة بكام. أجره بيتحسب من القطع المسجلة له في شاشة إنتاجية العمال.",
              },
              { kind: "text", name: "phone", labelEn: "Phone", labelAr: "التليفون", ltr: true },
              {
                kind: "text", name: "biometricDeviceUserId", labelEn: "Badge number", labelAr: "رقم البصمة",
                ltr: true,
                hintEn: "The number the fingerprint reader knows them by. Must be unique.",
                hintAr: "الرقم اللي جهاز البصمة بيعرفه بيه. لازم يكون فريد.",
              },
            ]}
          />
        </Card>
      )}

      <Card className="mb-4" title={ar ? "مسيّرات الأجور" : "Payroll runs"}>
        {runs.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar
              ? "لا توجد مسيّرات بعد. التحضير والاعتماد فعلان منفصلان لشخصين مختلفين."
              : "No payroll runs yet. Preparation and approval are separate acts by different people."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "المسيّر" : "Run",
              ar ? "الجهة" : "Entity",
              ar ? "الشهر" : "Period",
              ar ? "موظفون" : "Employees",
              ...(seeSalary
                ? [ar ? "الإجمالي" : "Gross", ar ? "تكلفة صاحب العمل" : "Employer cost"]
                : []),
              ar ? "الحالة" : "Status",
            ]}
            rows={runs.map((r) => [
              <code key={`${r.id}-n`} dir="ltr" className="text-xs text-ink-500">
                {r.runNumber}
              </code>,
              <span key={`${r.id}-e`}>{name(r.entity)}</span>,
              <span key={`${r.id}-p`} className="num" dir="ltr">
                {r.fiscalPeriod.year}-{String(r.fiscalPeriod.month).padStart(2, "0")}
              </span>,
              <span key={`${r.id}-c`} className="num">{r._count.lines}</span>,
              ...(seeSalary
                ? [
                    <span key={`${r.id}-g`} className="num">{formatMoney(r.grossPay, locale)}</span>,
                    <span key={`${r.id}-x`} className="num">{formatMoney(r.employerCost, locale)}</span>,
                  ]
                : []),
              <Badge key={`${r.id}-s`} tone={runTone[r.status]}>
                {runLabel[r.status]}
              </Badge>,
            ])}
          />
        )}
      </Card>

      <Card
        title={ar ? "الموظفون" : "Employees"}
        description={
          ar
            ? "مركز التكلفة هو اللي بيحدد الحساب اللي الأجر يتحمّل عليه"
            : "The cost centre decides which account the wage is charged to"
        }
      >
        {employees.length === 0 ? (
          <p className="py-6 text-center text-sm text-ink-400">
            {ar ? "لا يوجد موظفون مسجلون." : "No employees on record."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الكود" : "Code",
              ar ? "الاسم" : "Name",
              ar ? "الجهة" : "Entity",
              ar ? "مركز التكلفة" : "Cost centre",
              ...(seeSalary ? [ar ? "الأساسي" : "Base salary"] : []),
              ar ? "البصمة" : "Badge",
              ar ? "الحالة" : "Status",
            ]}
            rows={employees.map((e) => [
              <code key={`${e.id}-c`} dir="ltr" className="text-xs text-ink-500">{e.code}</code>,
              <span key={`${e.id}-n`}>
                {e.name}
                {e.jobTitle && (
                  <span className="mt-0.5 block text-xs text-ink-400">{e.jobTitle}</span>
                )}
              </span>,
              <span key={`${e.id}-e`}>{name(e.entity)}</span>,
              <span key={`${e.id}-cc`}>{e.costCenter ? name(e.costCenter) : "—"}</span>,
              ...(seeSalary
                ? [
                    <span key={`${e.id}-s`} className="num">
                      {formatMoney(e.baseSalary, locale)}
                    </span>,
                  ]
                : []),
              <code key={`${e.id}-b`} dir="ltr" className="text-xs text-ink-400">
                {e.biometricDeviceUserId ?? "—"}
              </code>,
              <Badge key={`${e.id}-st`} tone={statusTone[e.status]}>
                {e.status === "ACTIVE"
                  ? ar ? "على رأس العمل" : "Active"
                  : e.status === "ON_LEAVE"
                    ? ar ? "في إجازة" : "On leave"
                    : ar ? "انتهت الخدمة" : "Terminated"}
              </Badge>,
            ])}
          />
        )}
        {!seeSalary && (
          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "بيانات الأجور مخفية — تحتاج صلاحية الاطلاع على الرواتب."
              : "Salary figures are hidden — they need the salary viewing permission."}
          </p>
        )}
      </Card>
    </>
  );
}
