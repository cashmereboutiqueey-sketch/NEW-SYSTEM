import { code128Svg, canEncode } from "@/core/barcode";
import { amountInArabicWords } from "@/core/arabic-words";
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
    /** Colour and size in their own columns, as the printed invoice sets them. */
    colourEn: string;
    colourAr: string;
    size: string;
    quantity: number;
    /** Before the line discount. The column headed السعر. */
    retailPrice: string;
    /** After it. The column headed القيمة. */
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
  /** What was taken in cash, printed beside the totals as النقدى. */
  cashTaken?: string | null;
  /** Whoever rang it up, printed at the foot as المستخدم. */
  user?: string | null;
};

/**
 * An 80mm till receipt.
 *
 * Sized in millimetres for a thermal roll, monospaced so figures line up, and
 * with the barcode at the bottom where a returns desk expects to find it.
 */
/**
 * The shop's own sales invoice, as it has always been printed.
 *
 * Copied from the paper: the name across the top, the invoice number, branch
 * and customer boxed on the right with the date and time boxed on the left,
 * the garment in six columns, the totals in a box of their own with the cash
 * beside it, and the sum written out in words underneath.
 *
 * The line in words is the part worth keeping rather than tidying away. It is
 * what a printed invoice is checked against when the figure is smudged or
 * argued over, which is why it has been on invoices here for a century.
 *
 * Two fields the old till left at nought are filled in: what the customer
 * handed over and what they got back. They are labelled المدفوع and الباقى,
 * which is what they mean, and printing zeroes under them was the old
 * machine's habit rather than a fact about the sale.
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
  const ar = locale !== "en";
  const money = (v: string) => formatMoney(v, "ar", false);

  const gross = dec(data.grossAmount);
  const discount = dec(data.discountAmount);
  const net = dec(data.netAmount);
  const cash = data.cashTaken ? dec(data.cashTaken) : null;
  const tendered = data.tendered ? dec(data.tendered) : null;
  const change = data.change ? dec(data.change) : null;

  // The date and the time as the paper sets them: American date, twelve-hour
  // clock. Deliberately not the ISO string — this is a copy of a document the
  // shop's customers already recognise.
  const when = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Africa/Cairo",
    day: "numeric",
    month: "numeric",
    year: "numeric",
  }).format(data.date);
  const at = new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  }).format(data.date);
  const stamp = `${when}  ${new Intl.DateTimeFormat("en-US", {
    timeZone: "Africa/Cairo",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(data.date)}`;

  const cell: React.CSSProperties = {
    border: "1px solid #000",
    padding: "0.8mm 1mm",
    textAlign: "center",
  };
  const label: React.CSSProperties = {
    border: "1px dashed #000",
    padding: "0.6mm 1.2mm",
    fontWeight: 700,
    whiteSpace: "nowrap",
  };
  const value: React.CSSProperties = { padding: "0.6mm 1.2mm", whiteSpace: "nowrap" };

  const phones = (business.phone ?? "")
    .split(/[,\n\/]+/)
    .map((x) => x.trim())
    .filter(Boolean);

  return (
    <div className="print-sheet sheet-thermal sheet-arabic-invoice" dir="rtl" style={{ fontSize: "8pt" }}>
      {/* ------------------------------------------------------------ head */}
      <div style={{ textAlign: "start", fontSize: "15pt", fontWeight: 700, letterSpacing: "0.5mm" }}>
        {business.nameEn || "CASHMERE"}
      </div>
      <div style={{ textAlign: "start", marginBottom: "2mm" }}>فاتورة بيع</div>

      <table style={{ width: "100%", marginBottom: "1.5mm" }}>
        <tbody>
          <tr>
            <td style={label}>م الفاتورة</td>
            <td style={{ ...value, fontSize: "12pt", fontWeight: 700 }} className="num">
              {data.orderNumber}
            </td>
            <td style={{ ...value, textAlign: "end" }} className="num ltr">{when}</td>
            <td style={label}>التاريخ</td>
          </tr>
          <tr>
            <td style={label}>الفرع</td>
            <td style={value}>{data.locationAr || data.locationEn}</td>
            <td style={{ ...value, textAlign: "end" }} className="num ltr">{at}</td>
            <td style={label}>الوقت</td>
          </tr>
          <tr>
            <td style={label}>العميل</td>
            <td style={value} colSpan={3}>{data.customerName ?? "مبيعات نقدية"}</td>
          </tr>
        </tbody>
      </table>

      {/* ----------------------------------------------------------- lines */}
      <table style={{ width: "100%", borderCollapse: "collapse", marginBottom: "2mm" }}>
        <thead>
          <tr>
            <th style={{ ...cell, textDecoration: "underline" }}>الصنف</th>
            <th style={{ ...cell, textDecoration: "underline" }}>اللون</th>
            <th style={{ ...cell, textDecoration: "underline" }}>مقاس</th>
            <th style={{ ...cell, textDecoration: "underline" }}>الكمية</th>
            <th style={{ ...cell, textDecoration: "underline" }}>السعر</th>
            <th style={{ ...cell, textDecoration: "underline" }}>القيمة</th>
          </tr>
        </thead>
        <tbody>
          {data.lines.map((l, i) => (
            <tr key={`${l.sku}-${i}`} className="keep-together">
              <td style={{ ...cell, textAlign: "start" }}>{ar ? l.nameAr : l.nameEn}</td>
              <td style={cell}>{ar ? l.colourAr : l.colourEn}</td>
              <td style={cell} className="ltr">{l.size}</td>
              <td style={cell} className="num">{l.quantity}</td>
              <td style={cell} className="num">{money(l.retailPrice)}</td>
              <td style={cell} className="num">{money(l.lineTotal)}</td>
            </tr>
          ))}
        </tbody>
      </table>

      {/* ---------------------------------------------------------- totals */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: "2mm", marginBottom: "2mm" }}>
        {cash !== null && cash.greaterThan(0) && (
          <div style={{ border: "1px dashed #000", padding: "1mm 2mm", whiteSpace: "nowrap" }}>
            <span style={{ fontWeight: 700 }}>النقدى</span>{" "}
            <span className="num" style={{ fontSize: "11pt", fontWeight: 700 }}>{money(cash.toString())}</span>
          </div>
        )}
        <table style={{ marginInlineStart: "auto", borderCollapse: "collapse", border: "2px solid #000" }}>
          <tbody>
            <tr>
              <td style={{ ...cell, fontWeight: 700 }}>الأجمالى</td>
              <td style={cell} className="num">{money(gross.toString())}</td>
            </tr>
            {discount.greaterThan(0) && (
              <tr>
                <td style={{ ...cell, fontWeight: 700 }}>الخصم</td>
                <td style={cell} className="num">{money(discount.toString())}</td>
              </tr>
            )}
            {dec(data.shippingAmount).greaterThan(0) && (
              <tr>
                <td style={{ ...cell, fontWeight: 700 }}>الشحن</td>
                <td style={cell} className="num">{money(data.shippingAmount)}</td>
              </tr>
            )}
            <tr>
              <td style={{ ...cell, fontWeight: 700 }}>الصافى</td>
              <td style={{ ...cell, fontWeight: 700 }} className="num">{money(net.toString())}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <table style={{ marginBottom: "2mm" }}>
        <tbody>
          <tr>
            <td style={label}>المدفوع</td>
            <td style={{ ...value, fontSize: "11pt" }} className="num">
              {money((tendered ?? cash ?? net).toString())}
            </td>
          </tr>
          <tr>
            <td style={label}>الباقى</td>
            <td style={{ ...value, fontSize: "11pt" }} className="num">
              {money((change ?? dec(0)).toString())}
            </td>
          </tr>
        </tbody>
      </table>

      {/* ------------------------------------------- the figure, in words */}
      <div style={{ textAlign: "center", marginBottom: "2.5mm" }}>
        {amountInArabicWords(net.toString())}
      </div>

      {/* ----------------------------------------------------------- foot */}
      {phones.length > 0 && (
        <div style={{ textAlign: "center", marginBottom: "1.5mm" }}>
          <span style={{ fontWeight: 700 }}>للتواصل معنا :</span>{" "}
          <span className="num ltr">{phones.join("  ")}</span>
        </div>
      )}

      {business.addressLine && (
        <div style={{ marginBottom: "2mm" }}>
          <div style={{ fontWeight: 700 }}>العنوان</div>
          <div>{business.addressLine}</div>
        </div>
      )}

      <div style={{ display: "flex", alignItems: "baseline", gap: "2mm", fontSize: "8pt" }}>
        <span style={label}>المستخدم</span>
        <span>{data.user ?? data.cashier}</span>
        <span className="num ltr" style={{ marginInlineStart: "auto" }}>{stamp}</span>
      </div>

      <div style={{ textAlign: "center", marginTop: "1.5mm" }} className="num">
        {data.orderNumber}
      </div>
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
  /** The code on this particular garment. Unique to the piece, not the SKU. */
  serial: string;
  sku: string;
  nameEn: string;
  nameAr: string;
  colourEn: string;
  colourAr: string;
  size: string;
  price?: string | null;
};

/** The physical roll. Every measurement the label depends on, in millimetres. */
export type LabelFormat = {
  widthMm: number;
  heightMm: number;
  /** Gap between one label and the next on the roll. */
  gapMm: number;
  /** Width of the narrowest bar. Below about 0.2mm a thermal head smears. */
  moduleWidthMm: number;
  barcodeHeightMm: number;
  showPrice: boolean;
};

export const DEFAULT_LABEL_FORMAT: LabelFormat = {
  widthMm: 40,
  heightMm: 20,
  gapMm: 2,
  moduleWidthMm: 0.25,
  barcodeHeightMm: 8,
  showPrice: true,
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
  format = DEFAULT_LABEL_FORMAT,
}: {
  labels: LabelData[];
  locale: Locale;
  format?: LabelFormat;
}) {
  const ar = locale === "ar";

  // The page is one label. A roll printer advances to the next gap after each
  // page, so a sheet-shaped grid would print three labels' worth of content
  // onto one label and throw the rest away.
  const pageCss = `
    @page {
      size: ${format.widthMm}mm ${format.heightMm}mm;
      margin: 0;
    }
    .roll-label {
      width: ${format.widthMm}mm;
      height: ${format.heightMm}mm;
    }
  `;

  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: pageCss }} />
      <div className="sheet-roll">
        {labels.map((l) => (
          /*
           * Each label is its own print-sheet.
           *
           * They were all one sheet with `break-after: page` on each label,
           * which Chrome ignored — two garments printed on one label, and the
           * overflow then clipped the name and raised scrollbars that looked
           * like a dozen other faults.
           *
           * print-sheet already carries `page-break-after: always`, and it is
           * what makes every invoice and despatch note come out one per page.
           * Using the mechanism that demonstrably works beats a second attempt
           * at the one that does not.
           */
          <div
            key={l.serial}
            className="print-sheet roll-label"
            dir={ar ? "rtl" : "ltr"}
          >
            <div className="roll-label-name">
              {ar ? l.nameAr : l.nameEn} · {ar ? l.colourAr : l.colourEn} · {l.size}
            </div>
            <Barcode
              value={l.serial}
              moduleWidthMm={format.moduleWidthMm}
              heightMm={format.barcodeHeightMm}
              // The serial is printed below, by .roll-label-serial, which sets
              // the size and letter-spacing this label was designed around.
              // Left to its default the barcode draws it a second time, and on
              // twenty millimetres of height the duplicate pushes the garment's
              // own name out of the label entirely.
              showText={false}
            />
            <div className="roll-label-serial num" dir="ltr">
              {l.serial}
            </div>
            {format.showPrice && l.price && (
              <div className="roll-label-price num">{formatMoney(l.price, locale)}</div>
            )}
          </div>
        ))}
      </div>
    </>
  );
}
