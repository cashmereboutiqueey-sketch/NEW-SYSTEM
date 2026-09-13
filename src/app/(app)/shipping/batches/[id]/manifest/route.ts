import { authorize, ForbiddenError } from "@/lib/auth";
import { manifestWorkbook, ShippingError } from "@/lib/shipping";

/**
 * One batch as the courier's import template, to download and upload to
 * MG Express. Generated from the shipments each time rather than stored, so a
 * sheet downloaded twice is the same sheet.
 */
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    await authorize("sales_order:view");
    const { id } = await params;
    const { fileName, data } = await manifestWorkbook(id);
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "Content-Disposition": `attachment; filename="${fileName}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof ForbiddenError) return new Response("Forbidden", { status: 403 });
    if (error instanceof ShippingError) return new Response(error.message, { status: 404 });
    console.error("Manifest download failed:", error);
    return new Response("Could not build the sheet.", { status: 500 });
  }
}
