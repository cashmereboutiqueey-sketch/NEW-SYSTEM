import { notFound } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { Receipt } from "@/components/print-documents";
import { PrintButton } from "@/components/print-button";
import { receiptFor, businessDetails } from "@/lib/print";

/** A till receipt, reprintable for a returns desk. */
export default async function ReceiptPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await requirePermission("sales_order:view");
  const { locale } = await getPrefs();
  const { id } = await params;

  const [data, business] = await Promise.all([receiptFor(id), businessDetails()]);
  if (!data) notFound();

  return (
    <>
      <div className="print-controls no-print mx-auto mb-4 flex max-w-[80mm] justify-end">
        <PrintButton label={locale === "ar" ? "اطبع الإيصال" : "Print receipt"} />
      </div>
      <Receipt data={data} business={business} locale={locale} />
    </>
  );
}
