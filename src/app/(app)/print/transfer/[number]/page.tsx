import { notFound } from "next/navigation";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { Invoice } from "@/components/print-documents";
import { PrintButton } from "@/components/print-button";
import { transferInvoiceFor, businessDetails } from "@/lib/print";

/** The Factory's internal invoice to the Brand. */
export default async function TransferInvoicePage({
  params,
}: {
  params: Promise<{ number: string }>;
}) {
  await requirePermission("report:group");
  const { locale } = await getPrefs();
  const { number } = await params;

  const [data, business] = await Promise.all([
    transferInvoiceFor(decodeURIComponent(number)),
    businessDetails(),
  ]);
  if (!data) notFound();

  return (
    <>
      <div className="print-controls no-print mx-auto mb-4 flex max-w-[190mm] justify-end">
        <PrintButton label={locale === "ar" ? "اطبع الفاتورة" : "Print invoice"} />
      </div>
      <Invoice data={data} business={business} locale={locale} />
    </>
  );
}
