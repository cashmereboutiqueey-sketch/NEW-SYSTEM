import { notFound } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { LabelSheet } from "@/components/print-documents";
import { PrintButton } from "@/components/print-button";
import { labelsForConsignor, labelFormat } from "@/lib/print";
import { db } from "@/lib/db";

/**
 * Tags for goods the shop is holding for somebody else.
 *
 * The factory's own garments carry a serial, printed when the run closes.
 * Consigned pieces have none — nothing here made them — so this is the only
 * way they get a tag at all, and without one the cashier has to find them by
 * scrolling a list with a customer waiting.
 */
export default async function ConsignmentLabelsPage({
  params,
}: {
  params: Promise<{ consignorId: string }>;
}) {
  await requirePermission("inventory:view");
  const { locale } = await getPrefs();
  const { consignorId } = await params;

  const [consignor, labels, format] = await Promise.all([
    db.consignor.findUnique({ where: { id: consignorId }, select: { name: true } }),
    labelsForConsignor(consignorId),
    labelFormat(),
  ]);
  if (!consignor || labels.length === 0) notFound();

  const ar = locale === "ar";

  return (
    <>
      <div className="print-controls no-print mx-auto mb-4 flex max-w-[198mm] items-center justify-between">
        <span className="text-sm text-ink-600">
          {consignor.name} · {labels.length} {ar ? "ملصق" : "labels"} ·{" "}
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
