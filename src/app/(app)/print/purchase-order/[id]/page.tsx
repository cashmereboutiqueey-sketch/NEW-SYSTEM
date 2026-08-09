import { notFound } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { Invoice } from "@/components/print-documents";
import { PrintButton } from "@/components/print-button";
import { purchaseOrderDocumentFor, businessDetails } from "@/lib/print";

/** A purchase order to send to a supplier. */
export default async function PurchaseOrderPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("purchase_order:view");
  const { locale } = await getPrefs();
  const { id } = await params;

  const [data, business] = await Promise.all([
    purchaseOrderDocumentFor(id),
    businessDetails(),
  ]);
  if (!data) notFound();

  return (
    <>
      <div className="print-controls no-print mx-auto mb-4 flex max-w-[190mm] justify-end">
        <PrintButton label={locale === "ar" ? "اطبع أمر الشراء" : "Print purchase order"} />
      </div>
      <Invoice data={data} business={business} locale={locale} />
    </>
  );
}
