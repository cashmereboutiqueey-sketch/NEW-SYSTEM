import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge } from "@/components/ui";
import { cairoParts, scheduledMinutesOf } from "@/core/attendance";
import { ShiftForm, AssignForm } from "./shift-forms";

/**
 * Working patterns, and who is on which.
 *
 * Not everybody works the same hours, and pretending otherwise is how a night
 * shift becomes eight hours of lateness every morning. A shift is defined once
 * and assigned from a date, so changing somebody's hours in March leaves what
 * they were judged against in February exactly as it was.
 */
export default async function ShiftsPage() {
  const session = await requirePermission("attendance:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayEdit = can(session.role, "attendance:correct");

  const [shifts, lines, employees] = await Promise.all([
    db.shift.findMany({
      orderBy: { code: "asc" },
      include: {
        line: { select: { nameEn: true, nameAr: true } },
        _count: { select: { assignments: true } },
      },
    }),
    db.productionLine.findMany({ where: { isActive: true }, orderBy: { code: "asc" } }),
    db.employee.findMany({
      where: { status: { not: "TERMINATED" } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        code: true,
        department: true,
        shiftAssignments: {
          where: { effectiveTo: null },
          orderBy: { effectiveFrom: "desc" },
          take: 1,
          include: { shift: { select: { code: true, nameEn: true, nameAr: true } } },
        },
      },
    }),
  ]);

  const today = cairoParts(new Date()).dateKey;
  const hhmm = (minute: number) =>
    `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  const dayNames = ar
    ? ["أحد", "اثنين", "ثلاثاء", "أربعاء", "خميس", "جمعة", "سبت"]
    : ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

  return (
    <>
      <PageHeader
        title={ar ? "الورديات" : "Shifts"}
        subtitle={
          ar
            ? "نمط شغل بيتعرّف مرة وبيتعيّن من تاريخ — تغيير مواعيد حد النهارده مبيغيّرش الشهر اللي فات"
            : "A pattern defined once and assigned from a date — changing somebody's hours today does not rewrite last month"
        }
      />

      {mayEdit && (
        <Card className="mb-4" title={ar ? "وردية جديدة" : "A new shift"}>
          <ShiftForm
            ar={ar}
            lines={lines.map((l) => ({ id: l.id, label: ar ? l.nameAr : l.nameEn }))}
          />
        </Card>
      )}

      <Card className="mb-4" title={ar ? "الورديات المعرّفة" : "Defined shifts"}>
        <DataTable
          headers={[
            ar ? "الكود" : "Code",
            ar ? "الاسم" : "Name",
            ar ? "المواعيد" : "Hours",
            ar ? "الأيام" : "Days",
            ar ? "الراحة" : "Break",
            ar ? "السماح" : "Grace",
            ar ? "المجدول" : "Scheduled",
            ar ? "عليها" : "Assigned",
          ]}
          empty={ar ? "مفيش ورديات لسه" : "No shifts yet"}
          rows={shifts.map((s) => [
            <code key={`${s.id}-c`} dir="ltr" className="text-xs">{s.code}</code>,
            <span key={`${s.id}-n`}>
              {ar ? s.nameAr : s.nameEn}
              {s.line && (
                <span className="ms-2 text-xs text-ink-400">{ar ? s.line.nameAr : s.line.nameEn}</span>
              )}
              {s.department && <span className="ms-2 text-xs text-ink-400">{s.department}</span>}
            </span>,
            <span key={`${s.id}-h`} className="num text-xs" dir="ltr">
              {hhmm(s.startMinute)}–{hhmm(s.endMinute)}
              {s.crossesMidnight && (
                <Badge tone="info" >{ar ? "ليلي" : "overnight"}</Badge>
              )}
            </span>,
            <span key={`${s.id}-d`} className="text-xs text-ink-600">
              {s.workingDays.map((d) => dayNames[d]).join("، ")}
            </span>,
            <span key={`${s.id}-b`} className="num text-xs">
              {s.breakMinutes}
              <span className="ms-1 text-ink-400">{s.breakPaid ? (ar ? "مدفوعة" : "paid") : (ar ? "مخصومة" : "unpaid")}</span>
            </span>,
            <span key={`${s.id}-g`} className="num text-xs">{s.graceMinutes}</span>,
            <span key={`${s.id}-s`} className="num">
              {scheduledMinutesOf({
                startMinute: s.startMinute,
                endMinute: s.endMinute,
                crossesMidnight: s.crossesMidnight,
                workingDays: s.workingDays,
                breakMinutes: s.breakMinutes,
                breakPaid: s.breakPaid,
                graceMinutes: s.graceMinutes,
                overtimeAfterMinutes: s.overtimeAfterMinutes,
              })}
            </span>,
            <span key={`${s.id}-a`} className="num">{s._count.assignments}</span>,
          ])}
        />
      </Card>

      {mayEdit && shifts.length > 0 && (
        <Card className="mb-4" title={ar ? "تعيين وردية" : "Assign a shift"}>
          <AssignForm
            ar={ar}
            today={today}
            employees={employees.map((e) => ({ id: e.id, label: `${e.name} · ${e.code}` }))}
            shifts={shifts.map((s) => ({ id: s.id, label: `${s.code} · ${ar ? s.nameAr : s.nameEn}` }))}
          />
        </Card>
      )}

      <Card
        title={ar ? "مين على أنهي وردية" : "Who works what"}
        description={
          ar
            ? "اللي من غير وردية بيتحسب من غير جدول — يعني مفيش تأخير ولا إضافي"
            : "Anybody with no shift is judged against no schedule, which means no lateness and no overtime"
        }
      >
        <DataTable
          headers={[
            ar ? "الموظف" : "Employee",
            ar ? "القسم" : "Department",
            ar ? "الوردية" : "Shift",
            ar ? "من" : "Since",
          ]}
          empty={ar ? "مفيش موظفين" : "No employees"}
          rows={employees.map((e) => {
            const current = e.shiftAssignments[0];
            return [
              <span key={`${e.id}-n`}>
                {e.name}
                <code className="ms-1 text-[10px] text-ink-400" dir="ltr">{e.code}</code>
              </span>,
              <span key={`${e.id}-d`} className="text-xs text-ink-500">{e.department ?? "—"}</span>,
              current ? (
                <span key={`${e.id}-s`}>{ar ? current.shift.nameAr : current.shift.nameEn}</span>
              ) : (
                <Badge key={`${e.id}-s`} tone="warn">{ar ? "بدون وردية" : "none"}</Badge>
              ),
              <span key={`${e.id}-f`} className="num text-xs" dir="ltr">
                {current ? cairoParts(current.effectiveFrom).dateKey : "—"}
              </span>,
            ];
          })}
        />
      </Card>
    </>
  );
}
