import { code128Svg, canEncode } from "@/core/barcode";
import { formatMoney, formatNumber, dec } from "@/lib/money";
import type { Locale } from "@/lib/i18n";

/**
 * Printable documents.
 *
 * Server components, so a document is finished markup by the time it reaches
 * the browser — nothing is still being fetched when the print dialogue opens,
 * which is how half-rendered invoices get printed.
 *
 * Barcodes are inline SVG generated here rather than fetched, for the same
 * reason: an image that has not loaded prints as a blank rectangle nobody
 * notices until the garment is on the shelf.
 */

function Barcode({
  value,
  moduleWidthMm,
  heightMm,
  showText = true,
}: {
  value: string;
  moduleWidthMm?: number;
  heightMm?: number;
  showText?: boolean;
}) {
  const check = canEncode(value);
  if (!check.ok) {
    // Said out loud on the page rather than left blank, so the problem is
    // caught before a sheet of labels is printed.
    return (
      <span className="text-xs text-bad">
        {value} — cannot be printed as a barcode
      </span>
    );
  }

  return (
    <span
      className="barcode"
      dangerouslySetInnerHTML={{
        __html: code128Svg(value, { moduleWidthMm, heightMm, showText }),
      }}
    />
  );
}

type Business = {
  nameEn: string;
  nameAr: string;
  addressLine?: string | null;
  phone?: string | null;
  taxId?: string | null;
};

// ------------------------------------------------------------------ receipt

export type ReceiptData = {
  orderNumber: string;
  date: Date;
  locationEn: string;
  locationAr: string;
  cashier: string;
  customerName?: string | null;
  lines: {
    sku: string;
    nameEn: string;
    nameAr: string;
    quantity: number;
    unitPrice: string;
    lineTotal: string;
  }[];
  grossAmount: string;
  discountAmount: string;
  shippingAmount: string;
  netAmount: string;
  paymentMethod?: string | null;
  tendered?: string | null;
  change?: string | null;
};

/**
 * An 80mm till receipt.
 *
 * Sized in millimetres for a thermal roll, monospaced so figures line up, and
 * with the barcode at the bottom where a returns desk expects to find it.
 */
export function Receipt({
  data,
  business,
  locale,
}: {
  data: ReceiptData;
  business: Business;
  locale: Locale;
}) {
  const ar = locale === "ar";
  const money = (v: string) => formatMoney(v, locale, false);

  return (
    <div className="print-sheet sheet-thermal" dir={ar ? "rtl" : "ltr"}>
      <div style={{ textAlign: "center", marginBottom: "3mm" }}>
        <div style={{ fontSize: "12pt", fontWeight: 700 }}>
          {ar ? business.nameAr : business.nameEn}
        </div>
        <div style={{ fontSize: "8pt" }}>{ar ? data.locationAr : data.locationEn}</div>
        {business.phone && (
          <div className="ltr" style={{ fontSize: "8pt" }}>{business.phone}</div>
        )}
      </div>

      <div style={{ borderTop: "1px dashed #000", paddingTop: "2mm", fontSize: "8pt" }}>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{ar ? "إيصال" : "Receipt"}</span>
          <span className="ltr">{data.orderNumber}</span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{ar ? "التاريخ" : "Date"}</span>
          <span className="ltr">
            {data.date.toISOString().slice(0, 16).replace("T", " ")}
          </span>
        </div>
        <div style={{ display: "flex", justifyContent: "space-between" }}>
          <span>{ar ? "الكاشير" : "Cashier"}</span>
          <span>{data.cashier}</span>
        </div>
        {data.customerName && (
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span>{ar ? "العميل" : "Customer"}</span>
            <span>{data.customerName}</span>
          </div>
        )}
      </div>

      <table style={{ marginTop: "2mm", borderTop: "1px dashed #000", fontSize: "8pt" }}>
        <tbody>
          {data.lines.map((l) => (
            <tr key={l.sku} className="keep-together">
              <td colSpan={2} style={{ paddingTop: "1.5mm" }}>
                <div>{ar ? l.nameAr : l.nameEn}</div>
                <div className="ltr" style={{ fontSize: "7pt", color: "#444" }}>{l.sku}</div>
                <div style={{ display: "flex", justifyContent: "space-between" }}>
                  <span className="num">
                    {l.quantity} × {money(l.unitPrice)}
                  </span>
                  <span className="num">{money(l.lineTotal)}</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div
        className="totals"
        style={{ marginTop: "2mm", borderTop: "1px dashed #000", paddingTop: "2mm", fontSize: "9pt" }}
      >
        {dec(data.discountAmount).greaterThan(0) && (
          <>
            <Row label={ar ? "الإجمالي" : "Subtotal"} value={money(data.grossAmount)} />
            <Row label={ar ? "الخصم" : "Discount"} value={`−${money(data.discountAmount)}`} />
          </>
        )}
        {dec(data.shippingAmount).greaterThan(0) && (
          <Row label={ar ? "الشحن" : "Shipping"} value={money(data.shippingAmount)} />
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            fontWeight: 700,
            fontSize: "11pt",
            borderTop: "1px solid #000",
            marginTop: "1mm",
            paddingTop: "1mm",
          }}
        >
          <span>{ar ? "المطلوب" : "Total"}</span>
          <span className="num">{money(data.netAmount)}</span>
        </div>

        {data.tendered && (
          <>
            <Row label={ar ? "المدفوع" : "Tendered"} value={money(data.tendered)} />
            <Row label={ar ? "الباقي" : "Change"} value={money(data.change ?? "0")} />
          </>
        )}
      </div>

      <div style={{ textAlign: "center", marginTop: "4mm" }}>
        <Barcode value={data.orderNumber} moduleWidthMm={0.3} heightMm={10} />
      </div>

      <div style={{ textAlign: "center", marginTop: "3mm", fontSize: "7pt" }}>
        {ar
          ? "الاستبدال خلال ١٤ يومًا بالإيصال والقطعة كما هي"
          : "Exchange within 14 days with this receipt and the item unworn"}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between" }}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

// ------------------------------------------------------------------ invoice

export type InvoiceData = {
  documentTitleEn: string;
  documentTitleAr: string;
  number: string;
  date: Date;
  dueDate?: Date | null;
  partyNameEn: string;
  partyNameAr: string;
  partyAddress?: string | null;
  reference?: string | null;
  lines: {
    code: string;
    descriptionEn: string;
    descriptionAr: string;
    quantity: string;
    unit?: string | null;
    unitPrice: string;
    lineTotal: string;
  }[];
  subtotal: string;
  discount?: string | null;
  shipping?: string | null;
  total: string;
  noteEn?: string | null;
  noteAr?: string | null;
};

/**
 * An A4 document: internal transfer invoice, purchase order or supplier
 * document, depending on what it is given.
 *
 * The table header repeats on a continuation page and no row is allowed to
 * split, because a quantity on one page and its price on the next is how a
 * disputed invoice starts.
 */
export function Invoice({
  data,
  business,
  locale,
}: {
  data: InvoiceData;
  business: Business;
  locale: Locale;
}) {
  const ar = locale === "ar";
  const money = (v: string) => formatMoney(v, locale, false);

  return (
    <div className="print-sheet sheet-a4" dir={ar ? "rtl" : "ltr"}>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          borderBottom: "2px solid #000",
          paddingBottom: "4mm",
          marginBottom: "5mm",
        }}
        className="sheet-rule"
      >
        <div>
          <div style={{ fontSize: "16pt", fontWeight: 700 }}>
            {ar ? business.nameAr : business.nameEn}
          </div>
          {business.addressLine && (
            <div style={{ fontSize: "9pt" }}>{business.addressLine}</div>
          )}
          {business.phone && (
            <div className="ltr" style={{ fontSize: "9pt" }}>{business.phone}</div>
          )}
          {business.taxId && (
            <div style={{ fontSize: "9pt" }}>
              {ar ? "الرقم الضريبي" : "Tax ID"}: <span className="ltr">{business.taxId}</span>
            </div>
          )}
        </div>

        <div style={{ textAlign: ar ? "left" : "right" }}>
          <div style={{ fontSize: "14pt", fontWeight: 700 }}>
            {ar ? data.documentTitleAr : data.documentTitleEn}
          </div>
          <div className="num ltr" style={{ fontSize: "11pt" }}>{data.number}</div>
          <div style={{ marginTop: "2mm" }}>
            <Barcode value={data.number} moduleWidthMm={0.3} heightMm={10} showText={false} />
          </div>
        </div>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "5mm" }}>
        <div>
          <div style={{ fontSize: "8pt", color: "#444" }} className="muted-print">
            {ar ? "إلى" : "To"}
          </div>
          <div style={{ fontWeight: 600 }}>{ar ? data.partyNameAr : data.partyNameEn}</div>
          {data.partyAddress && <div style={{ fontSize: "9pt" }}>{data.partyAddress}</div>}
        </div>
        <div style={{ textAlign: ar ? "left" : "right", fontSize: "9pt" }}>
          <div>
            {ar ? "التاريخ" : "Date"}:{" "}
            <span className="num ltr">{data.date.toISOString().slice(0, 10)}</span>
          </div>
          {data.dueDate && (
            <div>
              {ar ? "الاستحقاق" : "Due"}:{" "}
              <span className="num ltr">{data.dueDate.toISOString().slice(0, 10)}</span>
            </div>
          )}
          {data.reference && (
            <div>
              {ar ? "المرجع" : "Reference"}: <span className="ltr">{data.reference}</span>
            </div>
          )}
        </div>
      </div>

      <table style={{ fontSize: "9.5pt" }}>
        <thead>
          <tr style={{ borderBottom: "1px solid #000" }} className="sheet-rule">
            <th style={{ textAlign: ar ? "right" : "left", padding: "2mm 1mm" }}>
              {ar ? "الصنف" : "Item"}
            </th>
            <th style={{ textAlign: ar ? "left" : "right", padding: "2mm 1mm", width: "20mm" }}>
              {ar ? "الكمية" : "Qty"}
            </th>
            <th style={{ textAlign: ar ? "left" : "right", padding: "2mm 1mm", width: "28mm" }}>
              {ar ? "السعر" : "Price"}
            </th>
            <th style={{ textAlign: ar ? "left" : "right", padding: "2mm 1mm", width: "30mm" }}>
              {ar ? "الإجمالي" : "Amount"}
            </th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={`${l.code}-${i}`} style={{ borderBottom: "1px solid #ddd" }}>
              <td style={{ padding: "2mm 1mm" }}>
                <div>{ar ? l.descriptionAr : l.descriptionEn}</div>
                <div className="ltr muted-print" style={{ fontSize: "8pt", color: "#444" }}>
                  {l.code}
                </div>
              </td>
              <td className="num" style={{ textAlign: ar ? "left" : "right", padding: "2mm 1mm" }}>
                {formatNumber(l.quantity, locale)}
                {l.unit ? ` ${l.unit}` : ""}
              </td>
              <td className="num" style={{ textAlign: ar ? "left" : "right", padding: "2mm 1mm" }}>
                {money(l.unitPrice)}
              </td>
              <td className="num" style={{ textAlign: ar ? "left" : "right", padding: "2mm 1mm" }}>
                {money(l.lineTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div className="totals" style={{ marginTop: "4mm", marginInlineStart: "auto", width: "70mm" }}>
        <TotalRow label={ar ? "الإجمالي" : "Subtotal"} value={money(data.subtotal)} />
        {data.discount && dec(data.discount).greaterThan(0) && (
          <TotalRow label={ar ? "الخصم" : "Discount"} value={`−${money(data.discount)}`} />
        )}
        {data.shipping && dec(data.shipping).greaterThan(0) && (
          <TotalRow label={ar ? "الشحن" : "Shipping"} value={money(data.shipping)} />
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            borderTop: "2px solid #000",
            paddingTop: "2mm",
            marginTop: "1mm",
            fontWeight: 700,
            fontSize: "12pt",
          }}
          className="sheet-rule"
        >
          <span>{ar ? "المستحق" : "Total"}</span>
          <span className="num">{money(data.total)} {ar ? "ج.م" : "EGP"}</span>
        </div>
      </div>

      {(data.noteEn || data.noteAr) && (
        <div
          style={{ marginTop: "8mm", fontSize: "9pt", borderTop: "1px solid #ddd", paddingTop: "3mm" }}
        >
          {ar ? data.noteAr : data.noteEn}
        </div>
      )}
    </div>
  );
}

function TotalRow({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "1mm 0" }}>
      <span>{label}</span>
      <span className="num">{value}</span>
    </div>
  );
}

// --------------------------------------------------------------- label sheet

export type LabelData = {
  sku: string;
  nameEn: string;
  nameAr: string;
  colourEn: string;
  colourAr: string;
  size: string;
  price?: string | null;
};

/**
 * A sheet of garment labels, three across.
 *
 * The barcode is printed at a fixed module width rather than stretched to fit
 * the cell: a barcode scaled to fill space no longer has the geometry its
 * quiet zone was calculated for, and stops scanning.
 */
export function LabelSheet({
  labels,
  locale,
}: {
  labels: LabelData[];
  locale: Locale;
}) {
  const ar = locale === "ar";

  return (
    <div className="print-sheet sheet-labels">
      {labels.map((l, i) => (
        <div key={`${l.sku}-${i}`} className="label-cell" dir={ar ? "rtl" : "ltr"}>
          <div className="name">
            {ar ? l.nameAr : l.nameEn}
          </div>
          <div style={{ fontSize: "7.5pt", color: "#444" }} className="muted-print">
            {ar ? l.colourAr : l.colourEn} · {l.size}
          </div>
          <div style={{ margin: "1mm 0" }}>
            <Barcode value={l.sku} moduleWidthMm={0.3} heightMm={9} />
          </div>
          {l.price && (
            <div className="price num">
              {formatMoney(l.price, locale)}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
