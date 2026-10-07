import { db } from "@/lib/db";
import { getPrefs } from "@/lib/session";
import { requirePermission } from "@/lib/auth";
import { t } from "@/lib/i18n";
import { can } from "@/core/permissions";
import { PageHeader, Card, DataTable, Badge, StatTile } from "@/components/ui";
import { EntityForm } from "@/components/entity-form";
import { formatNumber, formatMoney, dec } from "@/lib/money";
import { createSupplierAction, toggleSupplierAction } from "./actions";
import { SupplierOpeningBalanceForm } from "./opening-balance-form";
import { PayForm } from "../expenses/pay-form";

/**
 * الموردون — suppliers.
 *
 * Credit days matter here beyond bookkeeping: they are what funds the cash
 * conversion cycle, so the figure entered on this screen changes how much
 * working capital the business appears to need.
 */
export default async function SuppliersPage() {
  const session = await requirePermission("purchase_order:view");
  const { locale } = await getPrefs();
  const ar = locale === "ar";
  const mayEdit = can(session.role, "purchase_order:create");
  const mayOpenBalance = can(session.role, "journal:create");
  const mayPay = can(session.role, "payment:create");

  const suppliers = await db.supplier.findMany({
    include: {
      _count: { select: { materials: true, purchaseOrders: true, expenses: true } },
    },
    orderBy: [{ isActive: "desc" }, { code: "asc" }],
  });
  const [entities, openingBalances] = await Promise.all([
    db.entity.findMany({ orderBy: { kind: "asc" } }),
    db.supplierOpeningBalance.findMany({
      include: { supplier: true, entity: true }, orderBy: { createdAt: "desc" },
    }),
  ]);

  const active = suppliers.filter((s) => s.isActive);
  const avgCredit =
    active.length > 0
      ? Math.round(active.reduce((s, x) => s + x.creditDays, 0) / active.length)
      : 0;

  return (
    <>
      <PageHeader
        title={t("suppliers", locale)}
        subtitle={
          ar
            ? "أيام الائتمان بتموّل دورة الكاش — الرقم هنا بيغيّر رأس المال المطلوب"
            : "Credit days fund the cash cycle — the figure here changes how much working capital is needed"
        }
      />

      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatTile
          label={ar ? "موردون نشطون" : "Active suppliers"}
          value={formatNumber(active.length, locale)}
          hint={`${suppliers.length} ${ar ? "إجمالي" : "on record"}`}
        />
        <StatTile
          label={ar ? "متوسط أيام الائتمان" : "Average credit days"}
          value={formatNumber(avgCredit, locale)}
        />
        <StatTile
          label={ar ? "خامات مرتبطة" : "Materials supplied"}
          value={formatNumber(
            suppliers.reduce((s, x) => s + x._count.materials, 0),
            locale,
          )}
        />
      </div>

      {mayOpenBalance && (
        <Card className="mb-4" title={ar ? "رصيد افتتاحي للموردين" : "Supplier opening balances"}
          description={ar ? "اكتب المبلغ القديم اللي عليك للمورد من غير إدخال قماش سابق." : "Record old supplier debt without entering historical fabric."}>
          <SupplierOpeningBalanceForm ar={ar}
            suppliers={suppliers.map((s) => ({ id: s.id, name: ar ? s.nameAr : s.nameEn }))}
            entities={entities.map((e) => ({ id: e.id, name: ar ? e.nameAr : e.nameEn }))} />
        </Card>
      )}

      {openingBalances.length > 0 && (
        <Card className="mb-4" title={ar ? "الأرصدة الافتتاحية المسجلة" : "Recorded opening balances"}>
          <DataTable
            headers={[ar ? "المورد" : "Supplier", ar ? "الشركة" : "Company",
              ar ? "الأصل" : "Original", ar ? "اتدفع" : "Paid",
              ar ? "الباقي" : "Remaining", ""]}
            rows={openingBalances.map((b) => [
              ar ? b.supplier.nameAr : b.supplier.nameEn,
              ar ? b.entity.nameAr : b.entity.nameEn,
              <span key="amount" className="num">{formatMoney(b.amount.toString(), locale)}</span>,
              <span key="paid" className="num">{formatMoney(b.paidAmount.toString(), locale)}</span>,
              <span key="remaining" className="num font-medium">{formatMoney(dec(b.amount).minus(dec(b.paidAmount)).toString(), locale)}</span>,
              mayPay && dec(b.amount).greaterThan(dec(b.paidAmount))
                ? <PayForm key="pay" ar={ar} openingBalanceId={b.id}
                    description={ar ? "رصيد افتتاحي" : "Opening balance"}
                    outstanding={dec(b.amount).minus(dec(b.paidAmount)).toNumber()} />
                : <span key="pay" />,
            ])}
          />
        </Card>
      )}

      {mayEdit && (
        <Card className="mb-4" title={ar ? "إضافة مورد" : "Add a supplier"}>
          <EntityForm
            locale={locale}
            action={createSupplierAction}
            submitEn="Add supplier"
            submitAr="أضف المورد"
            fields={[
              {
                kind: "text", name: "code", labelEn: "Code", labelAr: "الكود",
                required: true, placeholder: "SUP-XXX", ltr: true,
                hintEn: "Uppercase. Cannot be changed once the supplier has orders.",
                hintAr: "بحروف كبيرة. مايتغيّرش بعد ما يبقى للمورد أوامر شراء.",
              },
              { kind: "text", name: "nameEn", labelEn: "Name (English)", labelAr: "الاسم بالإنجليزية", required: true },
              { kind: "text", name: "nameAr", labelEn: "Name (Arabic)", labelAr: "الاسم بالعربية", required: true },
              { kind: "text", name: "contactPerson", labelEn: "Contact person", labelAr: "مسؤول التواصل" },
              { kind: "text", name: "phone", labelEn: "Phone", labelAr: "التليفون", ltr: true },
              { kind: "text", name: "email", labelEn: "Email", labelAr: "البريد", ltr: true },
              {
                kind: "number", name: "creditDays", labelEn: "Credit days", labelAr: "أيام الائتمان",
                defaultValue: 0, min: "0", max: "365", ltr: true,
                hintEn: "Days of credit granted. Feeds the cash conversion cycle.",
                hintAr: "أيام السماح. بتدخل في حساب دورة الكاش.",
              },
              { kind: "text", name: "notes", labelEn: "Notes", labelAr: "ملاحظات", span: 3 },
            ]}
          />
        </Card>
      )}

      <Card title={ar ? "الموردون" : "Suppliers"}>
        {suppliers.length === 0 ? (
          <p className="py-8 text-center text-sm text-ink-400">
            {ar ? "لا يوجد موردون بعد." : "No suppliers yet."}
          </p>
        ) : (
          <DataTable
            headers={[
              ar ? "الكود" : "Code",
              ar ? "الاسم" : "Name",
              ar ? "التواصل" : "Contact",
              ar ? "ائتمان" : "Credit",
              ar ? "خامات" : "Materials",
              ar ? "أوامر شراء" : "Orders",
              ar ? "الحالة" : "Status",
              ...(mayEdit ? [""] : []),
            ]}
            rows={suppliers.map((s) => [
              <code key={`${s.id}-c`} dir="ltr" className="text-xs text-ink-500">{s.code}</code>,
              <span key={`${s.id}-n`}>{ar ? s.nameAr : s.nameEn}</span>,
              <span key={`${s.id}-p`}>
                {s.contactPerson && <span className="block text-sm">{s.contactPerson}</span>}
                {s.phone && (
                  <code dir="ltr" className="text-xs text-ink-400">{s.phone}</code>
                )}
              </span>,
              <span key={`${s.id}-d`} className="num">
                {s.creditDays} {ar ? "يوم" : "d"}
              </span>,
              <span key={`${s.id}-m`} className="num">{s._count.materials}</span>,
              <span key={`${s.id}-o`} className="num">{s._count.purchaseOrders}</span>,
              <Badge key={`${s.id}-s`} tone={s.isActive ? "good" : "neutral"}>
                {s.isActive ? (ar ? "نشط" : "Active") : (ar ? "موقوف" : "Inactive")}
              </Badge>,
              ...(mayEdit
                ? [
                    <form key={`${s.id}-a`} action={toggleSupplierAction}>
                      <input type="hidden" name="id" value={s.id} />
                      <input type="hidden" name="isActive" value={String(!s.isActive)} />
                      <button
                        type="submit"
                        className="rounded-lg border border-ink-200 px-2 py-1 text-xs text-ink-600 hover:border-ink-400"
                      >
                        {s.isActive ? (ar ? "إيقاف" : "Deactivate") : (ar ? "تفعيل" : "Reactivate")}
                      </button>
                    </form>,
                  ]
                : []),
            ])}
          />
        )}
        {mayEdit && (
          <p className="mt-3 text-xs text-ink-500">
            {ar
              ? "المورد بيتوقف ولا بيتحذف — أوامر الشراء وتاريخ الأسعار المرتبطة بيه لازم تفضل."
              : "A supplier is deactivated, never deleted — the purchase orders and price history that point at it must survive."}
          </p>
        )}
      </Card>
    </>
  );
}
