/**
 * Cashmere OS — seed data.
 *
 * Realistic Egyptian figures for 2026 so the system can be evaluated before
 * real data is entered: EGP fabric prices, Cairo-typical factory wages, SMVs
 * for modest casual daily wear, and a factory running well below capacity.
 *
 * This seeds MASTER and REFERENCE data only. It deliberately does not compute
 * any minute rate, cost snapshot or transfer price — those are produced by the
 * Phase 2 costing engine, and a seeded "answer" would be a fiction.
 *
 * Run:  npm run db:seed
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/client";
import bcrypt from "bcryptjs";
import { CHART_OF_ACCOUNTS, COST_CENTERS, TAX_RATES, LOCATIONS } from "./chart-of-accounts";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const db = new PrismaClient({ adapter });

const YEAR = 2026;

function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

async function main() {
  console.log("→ Seeding Cashmere OS…");

  // -------------------------------------------------------------------------
  // Users
  // -------------------------------------------------------------------------
  const passwordHash = await bcrypt.hash("cashmere2026", 12);

  const users = [
    { email: "owner@cashmere.eg", name: "مالك كاشمير", role: "OWNER" as const },
    { email: "accountant@cashmere.eg", name: "المحاسب", role: "ACCOUNTANT" as const },
    { email: "production@cashmere.eg", name: "مدير الإنتاج", role: "PRODUCTION" as const },
  ];

  for (const u of users) {
    await db.user.upsert({
      where: { email: u.email },
      update: {},
      create: { ...u, passwordHash, locale: "ar" },
    });
  }
  console.log(`  users: ${users.length}`);

  // -------------------------------------------------------------------------
  // Entities — two separate books
  // -------------------------------------------------------------------------
  const factory = await db.entity.upsert({
    where: { kind: "FACTORY" },
    update: {},
    create: {
      kind: "FACTORY",
      nameEn: "Cashmere Manufacturing",
      nameAr: "مصنع كاشمير",
    },
  });

  const brand = await db.entity.upsert({
    where: { kind: "BRAND" },
    update: {},
    create: {
      kind: "BRAND",
      nameEn: "Cashmere Boutique",
      nameAr: "كاشمير بوتيك",
    },
  });
  console.log("  entities: 2");

  // -------------------------------------------------------------------------
  // Fiscal periods — calendar months, fiscal year starts January
  // -------------------------------------------------------------------------
  const periods = [];
  for (let m = 1; m <= 12; m++) {
    const start = new Date(Date.UTC(YEAR, m - 1, 1));
    const end = new Date(Date.UTC(YEAR, m, 0));
    const p = await db.fiscalPeriod.upsert({
      where: { year_month: { year: YEAR, month: m } },
      update: {},
      create: {
        year: YEAR,
        month: m,
        startDate: start,
        endDate: end,
        // Months before August 2026 are closed; August onwards open.
        status: m < 8 ? "CLOSED" : "OPEN",
        closedAt: m < 8 ? end : null,
      },
    });
    periods.push(p);
  }
  console.log(`  fiscal periods: ${periods.length}`);

  // -------------------------------------------------------------------------
  // Chart of accounts, cost centres and tax rates
  //
  // Parents are inserted before children so the self-referencing FK resolves;
  // CHART_OF_ACCOUNTS is authored in that order.
  // -------------------------------------------------------------------------
  const accountIdByCode = new Map<string, string>();
  for (const [i, a] of CHART_OF_ACCOUNTS.entries()) {
    const parentId = a.parent ? accountIdByCode.get(a.parent) : undefined;
    if (a.parent && !parentId) {
      throw new Error(`Account ${a.code} references parent ${a.parent}, which is not defined before it`);
    }
    const row = await db.account.upsert({
      where: { code: a.code },
      update: {},
      create: {
        code: a.code,
        nameEn: a.nameEn,
        nameAr: a.nameAr,
        type: a.type,
        normalBalance: a.normalBalance,
        scope: a.scope ?? "BOTH",
        parentId: parentId ?? null,
        isPostable: a.isPostable ?? true,
        reportingCategory: a.reportingCategory ?? null,
        includeInMinuteRate: a.includeInMinuteRate ?? false,
        includeInBrandFixedPool: a.includeInBrandFixedPool ?? false,
        isIntercompany: a.isIntercompany ?? false,
        sortOrder: i,
      },
    });
    accountIdByCode.set(a.code, row.id);
  }
  console.log(`  accounts: ${CHART_OF_ACCOUNTS.length}`);

  for (const [i, c] of COST_CENTERS.entries()) {
    const entityId =
      c.entityKind === "FACTORY" ? factory.id : c.entityKind === "BRAND" ? brand.id : null;
    await db.costCenter.upsert({
      where: { code: c.code },
      update: {},
      create: {
        code: c.code,
        nameEn: c.nameEn,
        nameAr: c.nameAr,
        entityId,
        sortOrder: i,
      },
    });
  }
  console.log(`  cost centres: ${COST_CENTERS.length}`);

  for (const t of TAX_RATES) {
    await db.taxRate.upsert({
      where: { code_effectiveFrom: { code: t.code, effectiveFrom: d(t.effectiveFrom) } },
      update: {},
      create: {
        code: t.code,
        nameEn: t.nameEn,
        nameAr: t.nameAr,
        rate: t.rate,
        effectiveFrom: d(t.effectiveFrom),
      },
    });
  }
  console.log(`  tax rates: ${TAX_RATES.length}`);

  for (const [i, l] of LOCATIONS.entries()) {
    await db.location.upsert({
      where: { code: l.code },
      update: {},
      create: {
        code: l.code, nameEn: l.nameEn, nameAr: l.nameAr, kind: l.kind,
        entityId: l.entityKind === "FACTORY" ? factory.id : brand.id,
        city: l.city, sortOrder: i,
      },
    });
  }
  console.log(`  locations: ${LOCATIONS.length}`);

  // -------------------------------------------------------------------------
  // Settings — every configurable number lives here, never in code
  // -------------------------------------------------------------------------
  const settings = [
    {
      key: "factory.margin.default",
      value: "0.18",
      type: "PERCENT" as const,
      group: "Transfer pricing",
      labelEn: "Default factory margin",
      labelAr: "هامش المصنع الافتراضي",
      descriptionEn: "Applied to factory total cost to produce the transfer price.",
      descriptionAr: "يُطبَّق على إجمالي تكلفة المصنع للوصول إلى سعر التحويل.",
    },
    {
      key: "factory.margin.armsLengthMinimum",
      value: "0.12",
      type: "PERCENT" as const,
      group: "Transfer pricing",
      labelEn: "Arm's-length minimum margin",
      labelAr: "الحد الأدنى للهامش العادل",
      descriptionEn:
        "Below this the transfer price is flagged: the factory would be subsidising the brand.",
      descriptionAr:
        "أقل من هذا الحد يُرفع تنبيه: المصنع يدعم البراند على حساب نفسه.",
    },
    {
      key: "waste.varianceThreshold",
      value: "0.02",
      type: "PERCENT" as const,
      group: "Production",
      labelEn: "Waste variance flag threshold",
      labelAr: "حد تنبيه انحراف الهالك",
      descriptionEn:
        "Flag a style when trailing actual waste exceeds planned waste by more than this.",
      descriptionAr:
        "يُعلَّم الموديل عندما يتجاوز الهالك الفعلي المخطط بأكثر من هذه النسبة.",
    },
    {
      key: "waste.trailingWindowDays",
      value: "90",
      type: "INTEGER" as const,
      group: "Production",
      labelEn: "Waste trailing window (days)",
      labelAr: "نافذة حساب الهالك الفعلي (يوم)",
      descriptionEn: "Rolling window used to compute actual waste from cutting tickets.",
      descriptionAr: "الفترة المتحركة لحساب الهالك الفعلي من تذاكر القص.",
    },
    {
      key: "breakEven.highRiskPct",
      value: "0.60",
      type: "PERCENT" as const,
      group: "Brand economics",
      labelEn: "Break-even high-risk threshold",
      labelAr: "حد الخطورة لنقطة التعادل",
      descriptionEn:
        "Break-even above this share of the production run is flagged high risk.",
      descriptionAr:
        "نقطة التعادل التي تتجاوز هذه النسبة من أمر الإنتاج تُعتبر عالية الخطورة.",
    },
    {
      key: "inventory.deadStockDays",
      value: "90",
      type: "INTEGER" as const,
      group: "Inventory",
      labelEn: "Dead stock threshold (days)",
      labelAr: "حد المخزون الراكد (يوم)",
      descriptionEn: "Finished goods older than this are flagged as dead stock.",
      descriptionAr: "الإنتاج التام الأقدم من هذه المدة يُعلَّم كمخزون راكد.",
    },
    {
      key: "inventory.agingBuckets",
      value: "[30,60,90]",
      type: "JSON" as const,
      group: "Inventory",
      labelEn: "Aging bucket boundaries (days)",
      labelAr: "حدود شرائح أعمار المخزون (يوم)",
      descriptionEn: "Produces the 0–30 / 31–60 / 61–90 / 90+ buckets.",
      descriptionAr: "تنتج شرائح ٠–٣٠ / ٣١–٦٠ / ٦١–٩٠ / ٩٠+.",
    },
    {
      key: "inventory.valuationMethod",
      value: "FIFO",
      type: "STRING" as const,
      group: "Inventory",
      labelEn: "Inventory valuation method",
      labelAr: "طريقة تقييم المخزون",
      descriptionEn: "FIFO by lot — required for accurate aging and dead-stock capital.",
      descriptionAr: "الوارد أولًا صادر أولًا حسب اللوط — لازمة لدقة الأعمار ورأس المال الراكد.",
    },
    {
      key: "marketing.allocationBasis",
      value: "UNITS_SOLD",
      type: "STRING" as const,
      group: "Brand economics",
      labelEn: "Marketing allocation basis",
      labelAr: "أساس توزيع تكلفة التسويق",
      descriptionEn:
        "Period marketing spend spread across units sold, with per-style override.",
      descriptionAr:
        "مصروف التسويق يوزَّع على الوحدات المباعة، مع إمكانية التخصيص لموديل بعينه.",
    },
    {
      key: "cmt.creditRevenueToCostPool",
      value: "true",
      type: "BOOLEAN" as const,
      group: "Capacity",
      labelEn: "Credit CMT revenue to the factory cost pool",
      labelAr: "خصم إيراد التصنيع للغير من تكلفة المصنع",
      descriptionEn:
        "Makes selling idle minutes visibly reduce the minute rate the brand pays.",
      descriptionAr:
        "يجعل بيع الدقائق العاطلة يخفض فعليًا تكلفة الدقيقة على البراند.",
    },
    {
      key: "ccc.includeRawMaterialDays",
      value: "true",
      type: "BOOLEAN" as const,
      group: "Cash",
      labelEn: "Include raw material days in CCC",
      labelAr: "احتساب أيام الخامات في دورة الكاش",
      descriptionEn: "Fabric sitting in the store before cutting is locked capital.",
      descriptionAr: "القماش في المخزن قبل القص رأس مال محبوس.",
    },
    {
      // Decision D-001: the business is not VAT-registered, so no output VAT
      // is recognised. Switching this on is a settings change, not a rewrite —
      // TaxRate rows are effective-dated and historical postings keep the rate
      // they were posted with.
      key: "vat.registered",
      value: "false",
      type: "BOOLEAN" as const,
      group: "Tax",
      labelEn: "VAT registered",
      labelAr: "مسجل في ضريبة القيمة المضافة",
      descriptionEn: "Off: sales post with no output VAT. Turn on after registration.",
      descriptionAr: "مغلق: المبيعات تُسجَّل بدون ضريبة. فعّله بعد التسجيل.",
    },
    {
      key: "vat.defaultRateCode",
      value: "VAT-EXEMPT",
      type: "STRING" as const,
      group: "Tax",
      labelEn: "Default tax rate code",
      labelAr: "كود الضريبة الافتراضي",
      descriptionEn: "Which TaxRate new transactions use. Set to VAT-EG after registration.",
      descriptionAr: "الضريبة المطبقة على المعاملات الجديدة. غيّره إلى VAT-EG بعد التسجيل.",
    },
    {
      key: "capacity.defaultWorkingDays",
      value: "26",
      type: "DECIMAL" as const,
      group: "Capacity",
      labelEn: "Default working days per month",
      labelAr: "أيام العمل الافتراضية بالشهر",
      descriptionEn: "Starting point for a new period's capacity configuration.",
      descriptionAr: "نقطة البداية لإعداد الطاقة في فترة جديدة.",
    },
    {
      key: "capacity.defaultHoursPerDay",
      value: "8",
      type: "DECIMAL" as const,
      group: "Capacity",
      labelEn: "Default hours per day",
      labelAr: "ساعات العمل الافتراضية باليوم",
      descriptionEn: "Starting point for a new period's capacity configuration.",
      descriptionAr: "نقطة البداية لإعداد الطاقة في فترة جديدة.",
    },
    {
      key: "sku.format",
      value: "{STYLE}-{COLOR}-{SIZE}",
      type: "STRING" as const,
      group: "Product",
      labelEn: "SKU format",
      labelAr: "صيغة كود الصنف",
      descriptionEn: "Existing convention — enforced by a shared generator and validator.",
      descriptionAr: "الصيغة المستخدمة بالفعل — يفرضها مولّد ومدقق موحّد.",
    },
  ];

  for (const s of settings) {
    await db.setting.upsert({
      where: { key: s.key },
      update: {},
      create: s,
    });
  }
  console.log(`  settings: ${settings.length}`);

  // -------------------------------------------------------------------------
  // Reference data — colours, sizes, units
  // -------------------------------------------------------------------------
  const colors = [
    { code: "BLK", nameEn: "Black", nameAr: "أسود", hex: "#12100f" },
    { code: "BLU", nameEn: "Blue", nameAr: "أزرق", hex: "#2b4a72" },
    { code: "CRM", nameEn: "Cream", nameAr: "كريمي", hex: "#efe6d5" },
    { code: "OLV", nameEn: "Olive", nameAr: "زيتي", hex: "#5c6647" },
    { code: "BRN", nameEn: "Brown", nameAr: "بني", hex: "#6b4a35" },
    { code: "YLW", nameEn: "Yellow", nameAr: "أصفر", hex: "#d8a83a" },
    { code: "BEI", nameEn: "Beige", nameAr: "بيج", hex: "#cdb99a" },
    { code: "GRY", nameEn: "Grey", nameAr: "رمادي", hex: "#8b8d8f" },
    { code: "BBL", nameEn: "Baby Blue", nameAr: "أزرق فاتح", hex: "#a8c4d9" },
    { code: "WHT", nameEn: "White", nameAr: "أبيض", hex: "#f7f6f3" },
  ];

  for (const [i, c] of colors.entries()) {
    await db.colorCode.upsert({
      where: { code: c.code },
      update: {},
      create: { ...c, sortOrder: i },
    });
  }

  // Consumption grows with size — the BOM is stated at the base size (M).
  const sizes = [
    { code: "M", nameEn: "Medium", nameAr: "متوسط", consumptionFactor: "1.00" },
    { code: "L", nameEn: "Large", nameAr: "كبير", consumptionFactor: "1.05" },
    { code: "XL", nameEn: "X-Large", nameAr: "كبير جدًا", consumptionFactor: "1.11" },
    { code: "2XL", nameEn: "2X-Large", nameAr: "٢ إكس", consumptionFactor: "1.18" },
    { code: "3XL", nameEn: "3X-Large", nameAr: "٣ إكس", consumptionFactor: "1.26" },
  ];

  for (const [i, s] of sizes.entries()) {
    await db.sizeCode.upsert({
      where: { code: s.code },
      update: {},
      create: { ...s, sortOrder: i },
    });
  }

  const uoms = [
    { code: "M", nameEn: "Metre", nameAr: "متر", kind: "LENGTH" as const },
    { code: "KG", nameEn: "Kilogram", nameAr: "كيلوجرام", kind: "MASS" as const },
    { code: "PC", nameEn: "Piece", nameAr: "قطعة", kind: "PIECE" as const },
    { code: "SET", nameEn: "Set", nameAr: "طقم", kind: "PIECE" as const },
  ];
  for (const u of uoms) {
    await db.unitOfMeasure.upsert({ where: { code: u.code }, update: {}, create: u });
  }
  const uomM = await db.unitOfMeasure.findUniqueOrThrow({ where: { code: "M" } });
  const uomPC = await db.unitOfMeasure.findUniqueOrThrow({ where: { code: "PC" } });
  console.log(`  reference: ${colors.length} colours, ${sizes.length} sizes, ${uoms.length} units`);

  // -------------------------------------------------------------------------
  // Cost categories
  //
  // `includeInMinuteRate` is the flag that keeps fabric from being counted
  // twice. Materials, financing and all brand costs are excluded from it.
  // -------------------------------------------------------------------------
  const factoryCategories = [
    { code: "FAC-DIRECT-LABOUR", accountCode: "6110", nameEn: "Direct sewing labour", nameAr: "أجور عمال الإنتاج", behaviour: "SEMI_VARIABLE" as const, includeInMinuteRate: true },
    { code: "FAC-INDIRECT-LABOUR", accountCode: "6115", nameEn: "Supervisors, mechanics, QC", nameAr: "مشرفين وفنيين وجودة", behaviour: "FIXED" as const, includeInMinuteRate: true },
    { code: "FAC-RENT", accountCode: "6120", nameEn: "Factory rent", nameAr: "إيجار المصنع", behaviour: "FIXED" as const, includeInMinuteRate: true },
    { code: "FAC-UTILITIES", accountCode: "6125", nameEn: "Electricity and water", nameAr: "كهرباء ومياه", behaviour: "SEMI_VARIABLE" as const, includeInMinuteRate: true },
    { code: "FAC-MAINTENANCE", accountCode: "6130", nameEn: "Machine maintenance", nameAr: "صيانة المكن", behaviour: "SEMI_VARIABLE" as const, includeInMinuteRate: true },
    { code: "FAC-DEPRECIATION", accountCode: "6135", nameEn: "Depreciation", nameAr: "الإهلاك", behaviour: "FIXED" as const, includeInMinuteRate: true },
    { code: "FAC-ADMIN", accountCode: "6140", nameEn: "Factory administration", nameAr: "إدارة المصنع", behaviour: "FIXED" as const, includeInMinuteRate: true },
    { code: "FAC-TRANSPORT", accountCode: "6145", nameEn: "Internal transport", nameAr: "نقل داخلي", behaviour: "SEMI_VARIABLE" as const, includeInMinuteRate: true },
    { code: "FAC-CONSUMABLES", accountCode: "6150", nameEn: "Production consumables", nameAr: "مستهلكات الإنتاج", behaviour: "VARIABLE" as const, includeInMinuteRate: true },
    // Excluded from the minute rate on purpose:
    { code: "FAC-MATERIALS", accountCode: "5100", nameEn: "Fabric and trims purchased", nameAr: "مشتريات الخامات", behaviour: "VARIABLE" as const, includeInMinuteRate: false },
    { code: "FAC-FINANCE", accountCode: "7510", nameEn: "Interest and bank charges", nameAr: "فوائد ومصاريف بنكية", behaviour: "FIXED" as const, includeInMinuteRate: false },
  ];

  const brandCategories = [
    { code: "BRD-SALARIES", accountCode: "6310", nameEn: "Brand salaries", nameAr: "رواتب البراند", behaviour: "FIXED" as const, includeInBrandFixedPool: true },
    { code: "BRD-RENT", accountCode: "6320", nameEn: "Showroom and office rent", nameAr: "إيجار المعرض والمكتب", behaviour: "FIXED" as const, includeInBrandFixedPool: true },
    { code: "BRD-MARKETING", accountCode: "6410", nameEn: "Marketing and advertising", nameAr: "التسويق والإعلان", behaviour: "VARIABLE" as const, includeInBrandFixedPool: false },
    { code: "BRD-SHIPPING", accountCode: "6220", nameEn: "Shipping and delivery", nameAr: "الشحن والتوصيل", behaviour: "VARIABLE" as const, includeInBrandFixedPool: false },
    { code: "BRD-PACKAGING", accountCode: "6210", nameEn: "Retail packaging", nameAr: "تغليف التجزئة", behaviour: "VARIABLE" as const, includeInBrandFixedPool: false },
    { code: "BRD-PAYMENT-FEES", accountCode: "6230", nameEn: "Payment and COD fees", nameAr: "رسوم الدفع والتحصيل", behaviour: "VARIABLE" as const, includeInBrandFixedPool: false },
    { code: "BRD-SOFTWARE", accountCode: "6330", nameEn: "Software and subscriptions", nameAr: "برمجيات واشتراكات", behaviour: "FIXED" as const, includeInBrandFixedPool: true },
    { code: "BRD-RETURNS", accountCode: "6240", nameEn: "Return handling", nameAr: "معالجة المرتجعات", behaviour: "VARIABLE" as const, includeInBrandFixedPool: false },
  ];

  // `accountCode` is what connects the expense subledger to the general
  // ledger — without it an expense could be recorded but never posted.
  const linkAccount = ({ accountCode, ...rest }: { accountCode: string } & Record<string, unknown>) => {
    const accountId = accountIdByCode.get(accountCode);
    if (!accountId) throw new Error(`Cost category ${rest.code} maps to unknown account ${accountCode}`);
    return { ...rest, accountId };
  };

  for (const [i, c] of factoryCategories.entries()) {
    const linked = linkAccount(c);
    await db.costCategory.upsert({
      where: { entityId_code: { entityId: factory.id, code: c.code } },
      // The account link is repaired on re-seed: a category that cannot reach
      // the ledger silently blocks every expense filed against it.
      update: { accountId: linked.accountId },
      create: { ...linked, entityId: factory.id, sortOrder: i } as never,
    });
  }
  for (const [i, c] of brandCategories.entries()) {
    const linked = linkAccount(c);
    await db.costCategory.upsert({
      where: { entityId_code: { entityId: brand.id, code: c.code } },
      update: { accountId: linked.accountId },
      create: { ...linked, entityId: brand.id, sortOrder: i } as never,
    });
  }
  console.log(`  cost categories: ${factoryCategories.length + brandCategories.length}`);

  // -------------------------------------------------------------------------
  // Production lines and operators
  // -------------------------------------------------------------------------
  const lineDefs = [
    { code: "LINE-A", nameEn: "Line A — Knits", nameAr: "خط أ — التريكو", count: 16 },
    { code: "LINE-B", nameEn: "Line B — Wovens", nameAr: "خط ب — المنسوجات", count: 14 },
    { code: "LINE-C", nameEn: "Line C — Finishing", nameAr: "خط ج — التشطيب", count: 10 },
  ];

  const operatorNames = [
    "أحمد سيد", "منى عبد الله", "هدى مصطفى", "سامح فتحي", "نادية رمضان",
    "إيمان شعبان", "محمود عادل", "سحر إبراهيم", "ولاء حسن", "كريم صابر",
    "أميرة جمال", "شيماء لطفي", "طارق زكي", "غادة نبيل", "رانيا سمير",
    "حسام الدين", "مروة عاطف", "نهى فاروق", "عمرو خالد", "دعاء يوسف",
    "سماح رفعت", "ياسر منصور", "هبة الله محمد", "أسماء صلاح", "خالد بدر",
    "نجلاء توفيق", "صفاء عزت", "مصطفى راضي", "فاطمة أنور", "زينب حمدي",
    "عبير طه", "إسلام رجب", "ريهام وحيد", "سعاد كمال", "تامر عصام",
    "منال شريف", "أحمد نصر", "وفاء عبد الحميد", "علياء ماهر", "سيد قرني",
  ];

  let opIndex = 0;
  for (const [li, l] of lineDefs.entries()) {
    const line = await db.productionLine.upsert({
      where: { code: l.code },
      update: {},
      create: { code: l.code, nameEn: l.nameEn, nameAr: l.nameAr, sortOrder: li },
    });
    for (let i = 0; i < l.count; i++) {
      const code = `OP-${String(opIndex + 1).padStart(3, "0")}`;
      await db.operator.upsert({
        where: { code },
        update: {},
        create: {
          code,
          name: operatorNames[opIndex % operatorNames.length],
          lineId: line.id,
          hiredAt: d(`${YEAR - 1}-03-15`),
        },
      });
      opIndex++;
    }
  }
  console.log(`  production lines: ${lineDefs.length}, operators: ${opIndex}`);

  // -------------------------------------------------------------------------
  // Capacity configuration per period
  //
  // Utilisation and efficiency are separate on purpose. The factory runs at
  // roughly 60–68% utilisation (not enough orders) at around 78–82% efficiency
  // (the floor performs reasonably when it has work).
  // -------------------------------------------------------------------------
  const utilisationByMonth = [
    "0.58", "0.61", "0.66", "0.70", "0.64", "0.59", "0.55",
    "0.62", "0.68", "0.72", "0.69", "0.60",
  ];
  const efficiencyByMonth = [
    "0.76", "0.78", "0.79", "0.81", "0.80", "0.77", "0.74",
    "0.78", "0.80", "0.82", "0.81", "0.79",
  ];

  for (const p of periods) {
    // Factory-wide config (lineId null). Uniqueness is guaranteed by a partial
    // index, which Prisma cannot express as an upsert target, so this is a
    // find-then-create rather than an upsert.
    const existingCapacity = await db.capacityConfig.findFirst({
      where: { entityId: factory.id, fiscalPeriodId: p.id, lineId: null },
    });
    if (!existingCapacity) {
      await db.capacityConfig.create({
        data: {
          entityId: factory.id,
          fiscalPeriodId: p.id,
          lineId: null,
          operators: opIndex,
          workingDays: "26",
          hoursPerDay: "8",
          utilisationRate: utilisationByMonth[p.month - 1],
          efficiencyRate: efficiencyByMonth[p.month - 1],
          notes:
            p.month === 7
              ? "توقف جزئي — إجازات الصيف / Partial shutdown, summer leave"
              : null,
        },
      });
    }
  }
  console.log(`  capacity configs: ${periods.length}`);

  // -------------------------------------------------------------------------
  // Suppliers — Egyptian textile trade, with real credit behaviour
  // -------------------------------------------------------------------------
  const supplierDefs = [
    { code: "SUP-MHL", nameEn: "El Mahalla Textiles", nameAr: "غزل ونسيج المحلة", creditDays: 45, contactPerson: "أ. سمير الجندي", phone: "+20 100 220 4411" },
    { code: "SUP-SHB", nameEn: "Shobra Knitting Co.", nameAr: "شبرا للتريكو", creditDays: 30, contactPerson: "أ. هاني عبد العال", phone: "+20 122 887 3390" },
    { code: "SUP-ALX", nameEn: "Alexandria Fabrics", nameAr: "أقمشة الإسكندرية", creditDays: 60, contactPerson: "أ. ماجد رشدي", phone: "+20 111 445 7782" },
    { code: "SUP-WKL", nameEn: "Wekalet El Balah Trims", nameAr: "وكالة البلح للإكسسوارات", creditDays: 15, contactPerson: "أ. رأفت لبيب", phone: "+20 128 330 9915" },
    { code: "SUP-OBR", nameEn: "Obour Packaging", nameAr: "العبور للتغليف", creditDays: 30, contactPerson: "أ. إيهاب فوزي", phone: "+20 106 774 2208" },
    { code: "SUP-DMT", nameEn: "Damietta Zippers & Buttons", nameAr: "دمياط للسوست والأزرار", creditDays: 21, contactPerson: "أ. وائل السيد", phone: "+20 115 662 8834" },
  ];

  const suppliers: Record<string, string> = {};
  for (const s of supplierDefs) {
    const rec = await db.supplier.upsert({
      where: { code: s.code },
      update: {},
      create: s,
    });
    suppliers[s.code] = rec.id;
  }
  console.log(`  suppliers: ${supplierDefs.length}`);

  // -------------------------------------------------------------------------
  // Materials — EGP prices at 2026 levels, landed cost via freight + duty
  // -------------------------------------------------------------------------
  const materialDefs = [
    // Fabrics (per metre)
    { code: "FAB-JER-180", nameEn: "Cotton single jersey 180gsm", nameAr: "قماش جيرسيه قطن ١٨٠", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-SHB", basePrice: "168.00", freightPct: "0.025", moq: "100", packSize: "50", leadTimeDays: 14, reorderPoint: "400", gsm: "180", widthCm: "180", composition: "100% Cotton" },
    { code: "FAB-JER-240", nameEn: "Cotton fleece 240gsm", nameAr: "قماش فليس قطن ٢٤٠", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-SHB", basePrice: "215.00", freightPct: "0.025", moq: "100", packSize: "50", leadTimeDays: 18, reorderPoint: "300", gsm: "240", widthCm: "180", composition: "80% Cotton 20% PE" },
    { code: "FAB-VIS-TWL", nameEn: "Viscose twill", nameAr: "قماش فيسكوز تويل", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-ALX", basePrice: "232.00", freightPct: "0.03", dutyPct: "0.02", moq: "150", packSize: "50", leadTimeDays: 25, reorderPoint: "350", gsm: "140", widthCm: "145", composition: "100% Viscose" },
    { code: "FAB-LIN-BLD", nameEn: "Linen blend", nameAr: "قماش كتان مخلوط", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-MHL", basePrice: "318.00", freightPct: "0.03", moq: "120", packSize: "40", leadTimeDays: 30, reorderPoint: "250", gsm: "165", widthCm: "150", composition: "55% Linen 45% Cotton" },
    { code: "FAB-POP-CTN", nameEn: "Cotton poplin", nameAr: "قماش بوبلين قطن", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-MHL", basePrice: "146.00", freightPct: "0.025", moq: "100", packSize: "50", leadTimeDays: 15, reorderPoint: "400", gsm: "120", widthCm: "150", composition: "100% Cotton" },
    { code: "FAB-RIB-2X2", nameEn: "Rib 2x2 cuffing", nameAr: "قماش ريب ٢×٢", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-SHB", basePrice: "192.00", freightPct: "0.025", moq: "50", packSize: "25", leadTimeDays: 12, reorderPoint: "120", gsm: "220", widthCm: "90", composition: "95% Cotton 5% Elastane" },
    { code: "FAB-LIN-VIS", nameEn: "Viscose lining", nameAr: "بطانة فيسكوز", type: "FABRIC" as const, uomId: uomM.id, supplier: "SUP-ALX", basePrice: "78.00", freightPct: "0.02", moq: "100", packSize: "50", leadTimeDays: 12, reorderPoint: "250", gsm: "75", widthCm: "150", composition: "100% Viscose" },

    // Trims (per piece)
    { code: "TRM-THR-CONE", nameEn: "Sewing thread (per garment)", nameAr: "خيط حياكة (للقطعة)", type: "TRIM" as const, uomId: uomPC.id, supplier: "SUP-WKL", basePrice: "3.20", moq: "500", leadTimeDays: 7, reorderPoint: "2000" },
    { code: "TRM-BTN-18", nameEn: "Button 18L matte", nameAr: "زرار ١٨ مطفي", type: "TRIM" as const, uomId: uomPC.id, supplier: "SUP-DMT", basePrice: "1.65", moq: "1000", packSize: "144", leadTimeDays: 10, reorderPoint: "3000" },
    { code: "TRM-ZIP-18", nameEn: "Nylon zipper 18cm", nameAr: "سوسته نايلون ١٨ سم", type: "TRIM" as const, uomId: uomPC.id, supplier: "SUP-DMT", basePrice: "13.40", moq: "500", packSize: "100", leadTimeDays: 14, reorderPoint: "800" },
    { code: "TRM-LBL-MAIN", nameEn: "Main woven label", nameAr: "تيكت رئيسي منسوج", type: "TRIM" as const, uomId: uomPC.id, supplier: "SUP-WKL", basePrice: "2.40", moq: "1000", leadTimeDays: 21, reorderPoint: "2500" },
    { code: "TRM-LBL-CARE", nameEn: "Care label", nameAr: "تيكت العناية", type: "TRIM" as const, uomId: uomPC.id, supplier: "SUP-WKL", basePrice: "0.95", moq: "1000", leadTimeDays: 21, reorderPoint: "2500" },
    { code: "TRM-ELS-30", nameEn: "Elastic band 30mm", nameAr: "أستك ٣٠ مم", type: "TRIM" as const, uomId: uomM.id, supplier: "SUP-WKL", basePrice: "6.80", moq: "200", leadTimeDays: 10, reorderPoint: "400" },

    // Packaging — production side (goes into the BOM)
    { code: "PKG-POLY", nameEn: "Polybag with print", nameAr: "كيس بولي مطبوع", type: "PACKAGING" as const, uomId: uomPC.id, supplier: "SUP-OBR", basePrice: "2.10", moq: "1000", leadTimeDays: 12, reorderPoint: "3000" },
    { code: "PKG-HANG", nameEn: "Hangtag with string", nameAr: "هانج تاج بخيط", type: "PACKAGING" as const, uomId: uomPC.id, supplier: "SUP-OBR", basePrice: "3.75", moq: "1000", leadTimeDays: 15, reorderPoint: "2500" },
  ];

  const materials: Record<string, string> = {};
  for (const m of materialDefs) {
    const { supplier, ...rest } = m;
    const rec = await db.material.upsert({
      where: { code: m.code },
      update: {},
      create: { ...rest, supplierId: suppliers[supplier] },
    });
    materials[m.code] = rec.id;

    // Opening price history entry so every material has a traceable origin.
    const base = Number(m.basePrice);
    const freight = Number(m.freightPct ?? 0);
    const duty = Number(m.dutyPct ?? 0);
    const existing = await db.materialPriceHistory.findFirst({
      where: { materialId: rec.id },
    });
    if (!existing) {
      await db.materialPriceHistory.create({
        data: {
          materialId: rec.id,
          basePrice: m.basePrice,
          freightPct: String(freight),
          dutyPct: String(duty),
          effectiveCost: (base * (1 + freight + duty)).toFixed(4),
          effectiveFrom: d(`${YEAR}-01-01`),
          source: "Opening balance / رصيد افتتاحي",
        },
      });
    }
  }
  console.log(`  materials: ${materialDefs.length}`);

  // -------------------------------------------------------------------------
  // Collections and styles
  // -------------------------------------------------------------------------
  const collectionDefs = [
    { code: "SS26", nameEn: "Summer 2026", nameAr: "صيف ٢٠٢٦", season: "Summer", year: 2026, startDate: d("2026-03-01"), endDate: d("2026-08-31") },
    { code: "AW26", nameEn: "Autumn/Winter 2026", nameAr: "خريف وشتاء ٢٠٢٦", season: "Autumn", year: 2026, startDate: d("2026-09-01"), endDate: d("2027-01-31") },
    { code: "RMD27", nameEn: "Ramadan 2027", nameAr: "رمضان ٢٠٢٧", season: "Ramadan", year: 2027, startDate: d("2026-12-01"), endDate: d("2027-03-31") },
  ];

  const collections: Record<string, string> = {};
  for (const c of collectionDefs) {
    const rec = await db.collection.upsert({ where: { code: c.code }, update: {}, create: c });
    collections[c.code] = rec.id;
  }

  /**
   * Styles with their BOM and their SMV broken down by operation. SMV is built
   * bottom-up so the minute count is drillable rather than asserted.
   */
  const styleDefs = [
    {
      code: "DALIA",
      nameEn: "Dalia relaxed tunic",
      nameAr: "تونيك داليا واسع",
      collection: "SS26",
      plannedWasteRate: "0.08",
      retailPrice: "1450.00",
      colors: ["BLK", "CRM", "OLV", "BEI"],
      bom: [
        { m: "FAB-VIS-TWL", qty: "2.30" },
        { m: "FAB-LIN-VIS", qty: "0.45" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-BTN-18", qty: "6" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "2.80", line: "LINE-B" },
        { nameEn: "Shoulder join", nameAr: "خياطة الكتف", smv: "3.20", line: "LINE-B" },
        { nameEn: "Side seams", nameAr: "خياطة الجوانب", smv: "4.10", line: "LINE-B" },
        { nameEn: "Sleeve attach", nameAr: "تركيب الكم", smv: "5.60", line: "LINE-B" },
        { nameEn: "Placket and buttons", nameAr: "الفتحة والأزرار", smv: "7.40", line: "LINE-B" },
        { nameEn: "Hemming", nameAr: "الكفّ", smv: "3.90", line: "LINE-B" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "3.50", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "2.60", line: "LINE-C" },
      ],
    },
    {
      code: "FAYROUZ",
      nameEn: "Fayrouz linen shirt dress",
      nameAr: "قميص فستان فيروز كتان",
      collection: "SS26",
      plannedWasteRate: "0.10",
      retailPrice: "2150.00",
      colors: ["BBL", "CRM", "BEI", "WHT"],
      bom: [
        { m: "FAB-LIN-BLD", qty: "2.85" },
        { m: "FAB-LIN-VIS", qty: "0.35" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-BTN-18", qty: "9" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "3.40", line: "LINE-B" },
        { nameEn: "Collar making", nameAr: "تجهيز الياقة", smv: "6.20", line: "LINE-B" },
        { nameEn: "Front placket", nameAr: "فتحة الأمام", smv: "5.80", line: "LINE-B" },
        { nameEn: "Shoulder and side seams", nameAr: "الكتف والجوانب", smv: "6.40", line: "LINE-B" },
        { nameEn: "Cuff and sleeve", nameAr: "الأساور والكم", smv: "7.10", line: "LINE-B" },
        { nameEn: "Buttonholes and buttons", nameAr: "العراوي والأزرار", smv: "5.30", line: "LINE-B" },
        { nameEn: "Hemming", nameAr: "الكفّ", smv: "3.60", line: "LINE-B" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "4.20", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "2.80", line: "LINE-C" },
      ],
    },
    {
      code: "NOUR",
      nameEn: "Nour everyday tee",
      nameAr: "تيشيرت نور اليومي",
      collection: "SS26",
      plannedWasteRate: "0.06",
      retailPrice: "690.00",
      colors: ["BLK", "WHT", "GRY", "OLV", "BRN"],
      bom: [
        { m: "FAB-JER-180", qty: "1.35" },
        { m: "FAB-RIB-2X2", qty: "0.12" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "1.60", line: "LINE-A" },
        { nameEn: "Shoulder join", nameAr: "خياطة الكتف", smv: "1.90", line: "LINE-A" },
        { nameEn: "Neck rib attach", nameAr: "تركيب الريب", smv: "3.10", line: "LINE-A" },
        { nameEn: "Sleeve attach", nameAr: "تركيب الكم", smv: "2.70", line: "LINE-A" },
        { nameEn: "Side seams", nameAr: "خياطة الجوانب", smv: "2.20", line: "LINE-A" },
        { nameEn: "Hemming", nameAr: "الكفّ", smv: "2.10", line: "LINE-A" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "1.80", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "1.70", line: "LINE-C" },
      ],
    },
    {
      code: "LAYAN",
      nameEn: "Layan wide-leg trouser",
      nameAr: "بنطلون ليان واسع",
      collection: "SS26",
      plannedWasteRate: "0.09",
      retailPrice: "1290.00",
      colors: ["BLK", "BEI", "OLV", "BRN"],
      bom: [
        { m: "FAB-VIS-TWL", qty: "1.95" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-ELS-30", qty: "0.95" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "2.40", line: "LINE-B" },
        { nameEn: "Pocket bags", nameAr: "أكياس الجيوب", smv: "4.60", line: "LINE-B" },
        { nameEn: "Inseam and outseam", nameAr: "الخياطة الداخلية والخارجية", smv: "6.10", line: "LINE-B" },
        { nameEn: "Crotch seam", nameAr: "خياطة الوسط", smv: "2.90", line: "LINE-B" },
        { nameEn: "Elastic waistband", nameAr: "الوسط بالأستك", smv: "5.40", line: "LINE-B" },
        { nameEn: "Hemming", nameAr: "الكفّ", smv: "3.20", line: "LINE-B" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "2.90", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "2.30", line: "LINE-C" },
      ],
    },
    {
      code: "SALMA",
      nameEn: "Salma poplin blouse",
      nameAr: "بلوزة سلمى بوبلين",
      collection: "SS26",
      plannedWasteRate: "0.07",
      retailPrice: "980.00",
      colors: ["WHT", "BBL", "CRM", "YLW"],
      bom: [
        { m: "FAB-POP-CTN", qty: "1.80" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-BTN-18", qty: "8" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "2.10", line: "LINE-B" },
        { nameEn: "Collar making", nameAr: "تجهيز الياقة", smv: "5.40", line: "LINE-B" },
        { nameEn: "Front placket", nameAr: "فتحة الأمام", smv: "4.80", line: "LINE-B" },
        { nameEn: "Shoulder and sides", nameAr: "الكتف والجوانب", smv: "5.20", line: "LINE-B" },
        { nameEn: "Sleeve and cuff", nameAr: "الكم والأسورة", smv: "6.30", line: "LINE-B" },
        { nameEn: "Buttonholes and buttons", nameAr: "العراوي والأزرار", smv: "4.60", line: "LINE-B" },
        { nameEn: "Hemming", nameAr: "الكفّ", smv: "2.80", line: "LINE-B" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "3.40", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "2.40", line: "LINE-C" },
      ],
    },
    {
      code: "YASMIN",
      nameEn: "Yasmin fleece hoodie",
      nameAr: "هودي ياسمين فليس",
      collection: "AW26",
      plannedWasteRate: "0.08",
      retailPrice: "1680.00",
      colors: ["BLK", "GRY", "OLV", "BRN", "CRM"],
      bom: [
        { m: "FAB-JER-240", qty: "2.10" },
        { m: "FAB-RIB-2X2", qty: "0.38" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "2.90", line: "LINE-A" },
        { nameEn: "Hood assembly", nameAr: "تجميع الكابوشون", smv: "6.80", line: "LINE-A" },
        { nameEn: "Shoulder and sides", nameAr: "الكتف والجوانب", smv: "4.40", line: "LINE-A" },
        { nameEn: "Sleeve attach", nameAr: "تركيب الكم", smv: "4.20", line: "LINE-A" },
        { nameEn: "Rib cuffs and hem", nameAr: "أساور وذيل الريب", smv: "5.10", line: "LINE-A" },
        { nameEn: "Kangaroo pocket", nameAr: "جيب كنجارو", smv: "4.60", line: "LINE-A" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "2.70", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "2.20", line: "LINE-C" },
      ],
    },
    {
      code: "MALAK",
      nameEn: "Malak knit cardigan",
      nameAr: "كارديجان ملاك",
      collection: "AW26",
      plannedWasteRate: "0.09",
      retailPrice: "1890.00",
      colors: ["BEI", "GRY", "BRN", "BLK"],
      bom: [
        { m: "FAB-JER-240", qty: "1.95" },
        { m: "FAB-RIB-2X2", qty: "0.42" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-BTN-18", qty: "7" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "2.70", line: "LINE-A" },
        { nameEn: "Shoulder join", nameAr: "خياطة الكتف", smv: "3.10", line: "LINE-A" },
        { nameEn: "Front bands", nameAr: "شرائط الأمام", smv: "6.40", line: "LINE-A" },
        { nameEn: "Sleeve attach", nameAr: "تركيب الكم", smv: "4.30", line: "LINE-A" },
        { nameEn: "Side seams", nameAr: "خياطة الجوانب", smv: "3.20", line: "LINE-A" },
        { nameEn: "Buttonholes and buttons", nameAr: "العراوي والأزرار", smv: "4.90", line: "LINE-A" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "2.60", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "2.10", line: "LINE-C" },
      ],
    },
    {
      code: "RETAJ",
      nameEn: "Retaj occasion abaya",
      nameAr: "عباية رتاج للمناسبات",
      collection: "RMD27",
      plannedWasteRate: "0.11",
      retailPrice: "2480.00",
      colors: ["BLK", "BLU", "BRN"],
      bom: [
        { m: "FAB-VIS-TWL", qty: "3.40" },
        { m: "FAB-LIN-VIS", qty: "1.10" },
        { m: "TRM-THR-CONE", qty: "1" },
        { m: "TRM-ZIP-18", qty: "1" },
        { m: "TRM-LBL-MAIN", qty: "1" },
        { m: "TRM-LBL-CARE", qty: "1" },
        { m: "PKG-POLY", qty: "1" },
        { m: "PKG-HANG", qty: "1" },
      ],
      ops: [
        { nameEn: "Cutting", nameAr: "القص", smv: "4.20", line: "LINE-B" },
        { nameEn: "Lining assembly", nameAr: "تجميع البطانة", smv: "7.60", line: "LINE-B" },
        { nameEn: "Body seams", nameAr: "خياطة الجسم", smv: "6.80", line: "LINE-B" },
        { nameEn: "Sleeve attach", nameAr: "تركيب الكم", smv: "5.40", line: "LINE-B" },
        { nameEn: "Zipper insert", nameAr: "تركيب السوسته", smv: "4.90", line: "LINE-B" },
        { nameEn: "Hemming", nameAr: "الكفّ", smv: "5.20", line: "LINE-B" },
        { nameEn: "Pressing", nameAr: "الكي", smv: "5.10", line: "LINE-C" },
        { nameEn: "Finishing and packing", nameAr: "التشطيب والتعبئة", smv: "3.20", line: "LINE-C" },
      ],
    },
  ];

  const allSizes = await db.sizeCode.findMany({ orderBy: { sortOrder: "asc" } });
  const allColors = await db.colorCode.findMany();
  const colorByCode = new Map(allColors.map((c) => [c.code, c]));
  const linesByCode = new Map(
    (await db.productionLine.findMany()).map((l) => [l.code, l]),
  );

  let variantCount = 0;
  let bomCount = 0;
  let opCount = 0;

  for (const s of styleDefs) {
    const totalSmv = s.ops.reduce((acc, o) => acc + Number(o.smv), 0);

    const style = await db.style.upsert({
      where: { code: s.code },
      update: {},
      create: {
        code: s.code,
        nameEn: s.nameEn,
        nameAr: s.nameAr,
        collectionId: collections[s.collection],
        plannedWasteRate: s.plannedWasteRate,
        retailPrice: s.retailPrice,
        totalSmvMinutes: totalSmv.toFixed(4),
      },
    });

    for (const [i, b] of s.bom.entries()) {
      await db.styleBomLine.upsert({
        where: {
          styleId_materialId: { styleId: style.id, materialId: materials[b.m] },
        },
        update: {},
        create: {
          styleId: style.id,
          materialId: materials[b.m],
          standardConsumption: b.qty,
          sortOrder: i,
        },
      });
      bomCount++;
    }

    for (const [i, o] of s.ops.entries()) {
      await db.styleOperation.upsert({
        where: { styleId_sequence: { styleId: style.id, sequence: i + 1 } },
        update: {},
        create: {
          styleId: style.id,
          sequence: i + 1,
          nameEn: o.nameEn,
          nameAr: o.nameAr,
          smvMinutes: o.smv,
          lineId: linesByCode.get(o.line)?.id ?? null,
        },
      });
      opCount++;
    }

    // Variants: colour × size, SKU = [STYLE]-[COLOR]-[SIZE]
    for (const colorCode of s.colors) {
      const color = colorByCode.get(colorCode);
      if (!color) continue;
      for (const size of allSizes) {
        const sku = `${s.code}-${color.code}-${size.code}`;
        await db.variant.upsert({
          where: {
            styleId_colorCodeId_sizeCodeId: {
              styleId: style.id,
              colorCodeId: color.id,
              sizeCodeId: size.id,
            },
          },
          update: {},
          create: {
            styleId: style.id,
            colorCodeId: color.id,
            sizeCodeId: size.id,
            sku,
          },
        });
        variantCount++;
      }
    }
  }
  console.log(
    `  styles: ${styleDefs.length}, BOM lines: ${bomCount}, operations: ${opCount}, variants: ${variantCount}`,
  );

  // -------------------------------------------------------------------------
  // Sales channels — payment behaviour differs sharply by channel in Egypt
  // -------------------------------------------------------------------------
  const channelDefs = [
    {
      code: "SHOPIFY", nameEn: "Online store (Shopify)", nameAr: "المتجر الإلكتروني",
      kind: "ONLINE" as const, paymentFeePct: "0.027", paymentFeeFixed: "3.50",
      shippingCostPerOrder: "68.00", defaultReturnRate: "0.14",
      defaultDiscountRate: "0.12", collectionDays: 9, city: "Cairo",
    },
    {
      code: "COD", nameEn: "Cash on delivery", nameAr: "الدفع عند الاستلام",
      kind: "ONLINE" as const, paymentFeePct: "0.015", paymentFeeFixed: "22.00",
      shippingCostPerOrder: "72.00", defaultReturnRate: "0.22",
      defaultDiscountRate: "0.10", collectionDays: 18, city: "Cairo",
    },
    {
      code: "STORE-CAI", nameEn: "Cairo boutique", nameAr: "فرع القاهرة",
      kind: "RETAIL_STORE" as const, paymentFeePct: "0.018", paymentFeeFixed: "0",
      shippingCostPerOrder: "0", defaultReturnRate: "0.05",
      defaultDiscountRate: "0.08", collectionDays: 2, city: "Cairo",
    },
    {
      code: "STORE-ALX", nameEn: "Alexandria boutique", nameAr: "فرع الإسكندرية",
      kind: "RETAIL_STORE" as const, paymentFeePct: "0.018", paymentFeeFixed: "0",
      shippingCostPerOrder: "0", defaultReturnRate: "0.06",
      defaultDiscountRate: "0.09", collectionDays: 2, city: "Alexandria",
    },
    {
      code: "WHOLESALE", nameEn: "Wholesale", nameAr: "الجملة",
      kind: "WHOLESALE" as const, paymentFeePct: "0", paymentFeeFixed: "0",
      shippingCostPerOrder: "150.00", defaultReturnRate: "0.02",
      defaultDiscountRate: "0.35", collectionDays: 45, city: "Cairo",
    },
  ];

  for (const c of channelDefs) {
    await db.salesChannel.upsert({ where: { code: c.code }, update: {}, create: c });
  }
  console.log(`  sales channels: ${channelDefs.length}`);

  // -------------------------------------------------------------------------
  // Scheduled cash items — the known outflows that have no invoice yet
  // -------------------------------------------------------------------------
  const factoryCats = await db.costCategory.findMany({ where: { entityId: factory.id } });
  const brandCats = await db.costCategory.findMany({ where: { entityId: brand.id } });
  const catId = (cats: typeof factoryCats, code: string) =>
    cats.find((c) => c.code === code)?.id ?? null;

  const cashItems = [
    { entityId: factory.id, costCategoryId: catId(factoryCats, "FAC-DIRECT-LABOUR"), nameEn: "Factory payroll", nameAr: "أجور المصنع", direction: "OUTFLOW" as const, amount: "268000.00", dayOfMonth: 28 },
    { entityId: factory.id, costCategoryId: catId(factoryCats, "FAC-RENT"), nameEn: "Factory rent", nameAr: "إيجار المصنع", direction: "OUTFLOW" as const, amount: "55000.00", dayOfMonth: 5 },
    { entityId: factory.id, costCategoryId: catId(factoryCats, "FAC-UTILITIES"), nameEn: "Electricity", nameAr: "الكهرباء", direction: "OUTFLOW" as const, amount: "47000.00", dayOfMonth: 12 },
    { entityId: brand.id, costCategoryId: catId(brandCats, "BRD-SALARIES"), nameEn: "Brand payroll", nameAr: "رواتب البراند", direction: "OUTFLOW" as const, amount: "94000.00", dayOfMonth: 28 },
    { entityId: brand.id, costCategoryId: catId(brandCats, "BRD-RENT"), nameEn: "Showroom rent", nameAr: "إيجار المعرض", direction: "OUTFLOW" as const, amount: "38000.00", dayOfMonth: 5 },
    { entityId: brand.id, costCategoryId: catId(brandCats, "BRD-MARKETING"), nameEn: "Media buying budget", nameAr: "ميزانية الإعلانات", direction: "OUTFLOW" as const, amount: "120000.00", dayOfMonth: 1 },
  ];

  for (const item of cashItems) {
    const exists = await db.scheduledCashItem.findFirst({
      where: { entityId: item.entityId, nameEn: item.nameEn },
    });
    if (!exists) {
      await db.scheduledCashItem.create({
        data: { ...item, frequency: "MONTHLY", startDate: d(`${YEAR}-01-01`) },
      });
    }
  }
  console.log(`  scheduled cash items: ${cashItems.length}`);

  // -------------------------------------------------------------------------
  // Alert rules — thresholds live here, never in code
  // -------------------------------------------------------------------------
  const alertRules = [
    {
      code: "WASTE_DRIFT", nameEn: "Waste above plan", nameAr: "الهالك أعلى من المخطط",
      descriptionEn: "A style's trailing actual waste exceeds its planned rate.",
      descriptionAr: "الهالك الفعلي لموديل تجاوز النسبة المخططة.",
      severity: "WARNING" as const,
      parameters: { thresholdPct: 0.02, windowDays: 90 },
    },
    {
      code: "IDLE_CAPACITY", nameEn: "Idle capacity this month", nameAr: "طاقة عاطلة هذا الشهر",
      descriptionEn: "Unbooked minutes remain in the current or next period.",
      descriptionAr: "توجد دقائق غير محجوزة في الفترة الحالية أو القادمة.",
      severity: "WARNING" as const,
      parameters: { minIdleMinutes: 50000, lookaheadDays: 45 },
    },
    {
      code: "LOW_STOCK", nameEn: "Material below reorder point", nameAr: "خامة تحت حد إعادة الطلب",
      descriptionEn: "Projected days of cover fall below the supplier lead time.",
      descriptionAr: "أيام التغطية المتوقعة أقل من مدة توريد المورد.",
      severity: "CRITICAL" as const,
      parameters: { coverDaysBuffer: 7 },
    },
    {
      code: "DEAD_STOCK", nameEn: "Dead stock aging", nameAr: "مخزون راكد",
      descriptionEn: "A SKU has gone unsold beyond the dead-stock threshold.",
      descriptionAr: "صنف لم يُبَع بعد تجاوز حد الركود.",
      severity: "WARNING" as const,
      parameters: { days: 90 },
    },
    {
      code: "SUPPLIER_PRICE_HIKE", nameEn: "Supplier raised price", nameAr: "مورد رفع السعر",
      descriptionEn: "A material's landed cost rose more than the threshold.",
      descriptionAr: "التكلفة النهائية لخامة ارتفعت أكثر من الحد المسموح.",
      severity: "WARNING" as const,
      parameters: { thresholdPct: 0.10 },
    },
    {
      code: "BREAK_EVEN_RISK", nameEn: "Break-even above safe share of run", nameAr: "نقطة التعادل مرتفعة",
      descriptionEn: "Break-even units exceed the configured share of the production run.",
      descriptionAr: "وحدات التعادل تتجاوز النسبة المسموحة من أمر الإنتاج.",
      severity: "CRITICAL" as const,
      parameters: { thresholdPct: 0.60 },
    },
    {
      code: "MARGIN_BELOW_ARMS_LENGTH", nameEn: "Transfer price below arm's length", nameAr: "سعر التحويل أقل من العادل",
      descriptionEn: "A transfer price was generated below the configured minimum margin.",
      descriptionAr: "تم توليد سعر تحويل بهامش أقل من الحد الأدنى.",
      severity: "CRITICAL" as const,
      parameters: { minimumMarginPct: 0.12 },
    },
    {
      code: "CASH_SHORTFALL", nameEn: "Projected cash shortfall", nameAr: "عجز نقدي متوقع",
      descriptionEn: "Forecast outflows exceed inflows plus balance within the horizon.",
      descriptionAr: "المدفوعات المتوقعة تتجاوز المتحصلات والرصيد خلال الفترة.",
      severity: "CRITICAL" as const,
      parameters: { horizonDays: 30 },
    },
    {
      code: "REWORK_RATE", nameEn: "Rework rate above threshold", nameAr: "نسبة إعادة التشغيل مرتفعة",
      descriptionEn: "Rework quantity on a production order exceeds the allowed share.",
      descriptionAr: "كمية إعادة التشغيل في أمر إنتاج تجاوزت النسبة المسموحة.",
      severity: "WARNING" as const,
      parameters: { thresholdPct: 0.05 },
    },
    {
      code: "LINE_EFFICIENCY_DROP", nameEn: "Line efficiency below target", nameAr: "كفاءة خط أقل من المستهدف",
      descriptionEn: "A production line's efficiency fell below the target rate.",
      descriptionAr: "كفاءة خط إنتاج انخفضت تحت المعدل المستهدف.",
      severity: "WARNING" as const,
      parameters: { targetPct: 0.70 },
    },
    {
      code: "MOQ_SHORTFALL", nameEn: "Order below supplier MOQ", nameAr: "الطلب أقل من الحد الأدنى",
      descriptionEn: "Required quantity is below the material's minimum order quantity.",
      descriptionAr: "الكمية المطلوبة أقل من الحد الأدنى لطلب الخامة.",
      severity: "INFO" as const,
      parameters: {},
    },
  ];

  for (const r of alertRules) {
    await db.alertRule.upsert({ where: { code: r.code }, update: {}, create: r });
  }
  console.log(`  alert rules: ${alertRules.length}`);

  console.log("✓ Seed complete.");
  console.log("");
  console.log("  Sign in with:");
  console.log("    owner@cashmere.eg / cashmere2026");
  console.log("    accountant@cashmere.eg / cashmere2026");
  console.log("    production@cashmere.eg / cashmere2026");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await db.$disconnect();
  });
