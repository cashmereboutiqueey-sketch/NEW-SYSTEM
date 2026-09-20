import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { PageHeader, Card, DataTable, Badge } from "@/components/ui";
import { formatNumber } from "@/lib/money";
import { ImportForm } from "./import-form";

/**
 * Loading a fingerprint reader's export.
 *
 * No vendor is named anywhere on this screen, and none should be: the device
 * produces a table, the operator says which column is which, and that mapping
 * is kept with the batch. A device that sends its readings over the network
 * later produces the same table and lands in the same place.
 */
export default async function AttendanceImportPage() {
  await requirePermission("attendance:import");
  const { locale } = await getPrefs();
  const ar = locale === "ar";

  const imports = await db.attendanceImport.findMany({
    orderBy: { createdAt: "desc" },
    take: 20,
    include: { importedBy: { select: { name: true } } },
  });

  const statusTone: Record<string, "good" | "warn" | "neutral"> = {
    COMMITTED: "good",
    PREVIEWED: "warn",
    CANCELLED: "neutral",
  };
  const statusLabel: Record<string, string> = ar
    ? { COMMITTED: "تم", PREVIEWED: "مراجعة", CANCELLED: "ملغي" }
    : { COMMITTED: "Imported", PREVIEWED: "Previewed", CANCELLED: "Cancelled" };

  return (
    <>
      <PageHeader
        title={ar ? "استيراد بصمات" : "Import punches"}
        subtitle={
          ar
            ? "الملف بيتقرا ويتعدّ قبل ما يتسجّل حاجة — البصمة نفسها دليل، مبتتعدّلش ومبتتمسحش"
            : "The file is read and counted before anything is stored — a punch is evidence, never edited and never deleted"
        }
      />

      <Card className="mb-4" title={ar ? "ملف جديد" : "A new file"}>
        <ImportForm locale={locale} />
      </Card>

      <Card
        title={ar ? "آخر الاستيرادات" : "Recent imports"}
        description={
          ar
            ? "مين استورد إيه ومن أي جهاز — عشان سؤال «البصمة دي جت منين» يبقى ليه إجابة"
            : "Who loaded what, and from which device — so that where a punch came from has an answer"
        }
      >
        <DataTable
          headers={[
            ar ? "التاريخ" : "When",
            ar ? "الجهاز" : "Device",
            ar ? "الملف" : "File",
            ar ? "مين" : "Who",
            ar ? "سطور" : "Rows",
            ar ? "اتسجّل" : "Imported",
            ar ? "مكرر" : "Duplicate",
            ar ? "مرفوض" : "Refused",
            ar ? "الحالة" : "Status",
          ]}
          empty={ar ? "مفيش استيرادات لسه" : "Nothing imported yet"}
          rows={imports.map((i) => [
            <span key={`${i.id}-d`} className="num text-xs" dir="ltr">
              {i.createdAt.toISOString().slice(0, 16).replace("T", " ")}
            </span>,
            <code key={`${i.id}-v`} dir="ltr" className="text-xs">{i.deviceId}</code>,
            <span key={`${i.id}-f`} className="text-xs text-ink-600">{i.filename}</span>,
            <span key={`${i.id}-u`} className="text-xs">{i.importedBy?.name ?? "—"}</span>,
            <span key={`${i.id}-t`} className="num">{formatNumber(i.totalRows, locale)}</span>,
            <span key={`${i.id}-i`} className="num text-good">{formatNumber(i.importedRows, locale)}</span>,
            <span key={`${i.id}-dup`} className="num text-ink-500">{formatNumber(i.duplicateRows, locale)}</span>,
            <span
              key={`${i.id}-bad`}
              className={i.invalidRows > 0 ? "num text-bad" : "num text-ink-400"}
            >
              {formatNumber(i.invalidRows, locale)}
            </span>,
            <Badge key={`${i.id}-s`} tone={statusTone[i.status] ?? "neutral"}>
              {statusLabel[i.status] ?? i.status}
            </Badge>,
          ])}
        />
      </Card>
    </>
  );
}
