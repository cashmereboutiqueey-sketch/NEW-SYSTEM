import { notFound } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { LabelSheet } from "@/components/print-documents";
import { PrintButton } from "@/components/print-button";
import { labelsForDespatch, labelFormat } from "@/lib/print";

/**
 * The tags for one delivery.
 *
 * This is what the receiving bay prints: exactly the garments in the box in
 * front of them, one label each, in the same order as the codes were issued.
 * Printing by style instead would produce labels for stock that is elsewhere.
 */
export default async function DespatchLabelsPage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const { number } = await params;

  const despatchNumber = decodeURIComponent(number);
  const [labels, format] = await Promise.all([
    labelsForDespatch(despatchNumber),
    labelFormat(),
  ]);
  if (labels.length === 0) notFound();

  const ar = locale === "ar";

  return (
    <>
      <div className="print-controls no-print mx-auto mb-4 flex max-w-[198mm] items-center justify-between">
        <span className="text-sm text-ink-600">
          <code dir="ltr">{despatchNumber}</code> · {labels.length}{" "}
          {ar ? "ملصق" : "labels"} ·{" "}
          <span className="num" dir="ltr">
            {format.widthMm} × {format.heightMm} mm
          </span>
        </span>
        <PrintButton label={ar ? "اطبع" : "Print"} />
      </div>
      <LabelSheet labels={labels} locale={locale} format={format} />
    </>
  );
}
