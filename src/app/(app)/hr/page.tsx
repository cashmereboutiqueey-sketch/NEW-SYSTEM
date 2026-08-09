import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requireUser } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { formatMoney, formatNumber } from "@/lib/money";
import { dec } from "@/lib/money";
import { createEmployeeAction, setEmploymentStatusAction } from "./actions";

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
  const session = await requireUser();
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
    db.attendanceDay.count({ where: { adjustmentReason: { contains: "Missing clock-out" } } }),
    db.entity.findMany({ orderBy: { kind: "asc" } }),
    db.costCenter.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
    db.productionLine.findMany({ where: { isActive: true }, orderBy: { sortOrder: "asc" } }),
  ]);

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
                kind: "number", name: "baseSalary", labelEn: "Base salary", labelAr: "الأجر الأساسي",
                required: true, step: "0.01", min: "0", ltr: true,
                hintEn: "Gross per period. A later change is recorded as history, never an edit.",
                hintAr: "الإجمالي للفترة. أي تغيير بعدين بيتسجّل كتاريخ مش تعديل.",
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
