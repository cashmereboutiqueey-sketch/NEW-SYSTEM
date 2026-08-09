import { notFound } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { LabelSheet } from "@/components/print-documents";
import { PrintButton } from "@/components/print-button";
import { labelsForStyle } from "@/lib/print";

/**
 * Garment labels for a style.
 *
 * By default one label per SKU in stock, so a run of 388 garments produces
 * 388 labels rather than one somebody photocopies.
 */
export default async function LabelsPage({
  params,
  searchParams,
}: {
  params: Promise<{ styleId: string }>;
  searchParams: Promise<{ per?: string; stock?: string }>;
}) {
  await requirePermission("production:view");
  const { locale } = await getPrefs();
  const { styleId } = await params;
  const query = await searchParams;

  const useStock = query.stock !== "0";
  const labels = await labelsForStyle(styleId, {
    useStock,
    perSku: query.per ? Number(query.per) : 1,
  });
  if (labels.length === 0) notFound();

  const ar = locale === "ar";

  return (
    <>
      <div className="print-controls no-print mx-auto mb-4 flex max-w-[198mm] items-center justify-between">
        <span className="text-sm text-ink-600">
          {labels.length} {ar ? "ملصق" : "labels"}
          {useStock ? (ar ? " — حسب المخزون الحالي" : " — from stock on hand") : ""}
        </span>
        <PrintButton label={ar ? "اطبع الملصقات" : "Print labels"} />
      </div>
      <LabelSheet labels={labels} locale={locale} />
    </>
  );
}
