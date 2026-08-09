/**
 * Cashmere OS — chart of accounts.
 *
 * Kept separate from `seed.ts` because this is the accounting backbone, not
 * sample data: the same structure is used to open the books on a real
 * installation.
 *
 * Numbering follows the usual class-leading convention (1 assets, 2
 * liabilities, 3 equity, 4 revenue, 5 COGS, 6 expenses, 7 other) purely for
 * human readability. No application code may branch on an account code —
 * lookups go through the semantic flags (`includeInMinuteRate`,
 * `includeInBrandFixedPool`, `isIntercompany`) or a `settings` key, so the
 * numbering can be changed without touching business logic.
 */

type AccountSeed = {
  code: string;
  nameEn: string;
  nameAr: string;
  type:
    | "ASSET"
    | "LIABILITY"
    | "EQUITY"
    | "REVENUE"
    | "COGS"
    | "EXPENSE"
    | "OTHER_INCOME"
    | "OTHER_EXPENSE";
  normalBalance: "DEBIT" | "CREDIT";
  scope?: "FACTORY" | "BRAND" | "BOTH";
  parent?: string;
  isPostable?: boolean;
  reportingCategory?: string;
  includeInMinuteRate?: boolean;
  includeInBrandFixedPool?: boolean;
  isIntercompany?: boolean;
};

export const CHART_OF_ACCOUNTS: AccountSeed[] = [
  // ---------------------------------------------------------------------
  // 1 — ASSETS
  // ---------------------------------------------------------------------
  { code: "1000", nameEn: "Assets", nameAr: "الأصول", type: "ASSET", normalBalance: "DEBIT", isPostable: false, reportingCategory: "ASSETS" },

  { code: "1100", nameEn: "Current assets", nameAr: "الأصول المتداولة", type: "ASSET", normalBalance: "DEBIT", parent: "1000", isPostable: false, reportingCategory: "CURRENT_ASSET" },
  { code: "1110", nameEn: "Cash on hand", nameAr: "النقدية بالخزينة", type: "ASSET", normalBalance: "DEBIT", parent: "1100", reportingCategory: "CASH" },
  { code: "1115", nameEn: "POS cash drawer", nameAr: "درج كاشير نقاط البيع", type: "ASSET", normalBalance: "DEBIT", parent: "1100", scope: "BRAND", reportingCategory: "CASH" },
  { code: "1120", nameEn: "Bank current account", nameAr: "الحساب الجاري بالبنك", type: "ASSET", normalBalance: "DEBIT", parent: "1100", reportingCategory: "CASH" },
  // Money taken by a card processor or courier but not yet settled to the bank
  // is neither cash nor a customer receivable — it needs its own account or
  // reconciliation silently swallows the gap.
  { code: "1130", nameEn: "Payment gateway clearing", nameAr: "حساب تسوية بوابات الدفع", type: "ASSET", normalBalance: "DEBIT", parent: "1100", scope: "BRAND", reportingCategory: "CASH_CLEARING" },
  { code: "1135", nameEn: "COD courier clearing", nameAr: "حساب تسوية التحصيل عند الاستلام", type: "ASSET", normalBalance: "DEBIT", parent: "1100", scope: "BRAND", reportingCategory: "CASH_CLEARING" },

  { code: "1200", nameEn: "Accounts receivable", nameAr: "العملاء", type: "ASSET", normalBalance: "DEBIT", parent: "1100", reportingCategory: "RECEIVABLE" },
  { code: "1210", nameEn: "Trade receivables", nameAr: "عملاء تجاريون", type: "ASSET", normalBalance: "DEBIT", parent: "1200", reportingCategory: "RECEIVABLE" },
  { code: "1250", nameEn: "Intercompany receivable — Brand", nameAr: "مدينون بين الشركات — البراند", type: "ASSET", normalBalance: "DEBIT", parent: "1200", scope: "FACTORY", reportingCategory: "INTERCOMPANY", isIntercompany: true },

  { code: "1300", nameEn: "Inventory", nameAr: "المخزون", type: "ASSET", normalBalance: "DEBIT", parent: "1100", isPostable: false, reportingCategory: "INVENTORY" },
  { code: "1310", nameEn: "Raw materials", nameAr: "مخزون الخامات", type: "ASSET", normalBalance: "DEBIT", parent: "1300", scope: "FACTORY", reportingCategory: "INVENTORY_RAW" },
  { code: "1320", nameEn: "Work in progress", nameAr: "إنتاج تحت التشغيل", type: "ASSET", normalBalance: "DEBIT", parent: "1300", scope: "FACTORY", reportingCategory: "INVENTORY_WIP" },
  { code: "1330", nameEn: "Finished goods — Factory", nameAr: "إنتاج تام — المصنع", type: "ASSET", normalBalance: "DEBIT", parent: "1300", scope: "FACTORY", reportingCategory: "INVENTORY_FG" },
  { code: "1340", nameEn: "Finished goods — Brand", nameAr: "بضاعة جاهزة — البراند", type: "ASSET", normalBalance: "DEBIT", parent: "1300", scope: "BRAND", reportingCategory: "INVENTORY_FG" },

  { code: "1400", nameEn: "Prepayments and other current assets", nameAr: "مصروفات مقدمة وأصول أخرى", type: "ASSET", normalBalance: "DEBIT", parent: "1100", reportingCategory: "PREPAYMENT" },
  { code: "1450", nameEn: "Input VAT receivable", nameAr: "ضريبة القيمة المضافة — مدخلات", type: "ASSET", normalBalance: "DEBIT", parent: "1100", reportingCategory: "TAX_RECEIVABLE" },

  { code: "1500", nameEn: "Fixed assets", nameAr: "الأصول الثابتة", type: "ASSET", normalBalance: "DEBIT", parent: "1000", isPostable: false, reportingCategory: "FIXED_ASSET" },
  { code: "1510", nameEn: "Machinery and equipment", nameAr: "آلات ومعدات", type: "ASSET", normalBalance: "DEBIT", parent: "1500", scope: "FACTORY", reportingCategory: "FIXED_ASSET" },
  { code: "1520", nameEn: "Furniture and fittings", nameAr: "أثاث وتجهيزات", type: "ASSET", normalBalance: "DEBIT", parent: "1500", reportingCategory: "FIXED_ASSET" },
  { code: "1590", nameEn: "Accumulated depreciation", nameAr: "مجمع الإهلاك", type: "ASSET", normalBalance: "CREDIT", parent: "1500", reportingCategory: "ACCUM_DEPRECIATION" },

  // ---------------------------------------------------------------------
  // 2 — LIABILITIES
  // ---------------------------------------------------------------------
  { code: "2000", nameEn: "Liabilities", nameAr: "الالتزامات", type: "LIABILITY", normalBalance: "CREDIT", isPostable: false, reportingCategory: "LIABILITIES" },

  { code: "2100", nameEn: "Accounts payable", nameAr: "الموردون", type: "LIABILITY", normalBalance: "CREDIT", parent: "2000", reportingCategory: "PAYABLE" },
  { code: "2110", nameEn: "Trade payables", nameAr: "موردون تجاريون", type: "LIABILITY", normalBalance: "CREDIT", parent: "2100", reportingCategory: "PAYABLE" },
  { code: "2150", nameEn: "Intercompany payable — Factory", nameAr: "دائنون بين الشركات — المصنع", type: "LIABILITY", normalBalance: "CREDIT", parent: "2100", scope: "BRAND", reportingCategory: "INTERCOMPANY", isIntercompany: true },

  { code: "2200", nameEn: "Accrued liabilities", nameAr: "مصروفات مستحقة", type: "LIABILITY", normalBalance: "CREDIT", parent: "2000", reportingCategory: "ACCRUAL" },
  { code: "2210", nameEn: "Accrued payroll", nameAr: "أجور مستحقة", type: "LIABILITY", normalBalance: "CREDIT", parent: "2200", reportingCategory: "ACCRUAL" },
  { code: "2220", nameEn: "Accrued utilities and services", nameAr: "مرافق وخدمات مستحقة", type: "LIABILITY", normalBalance: "CREDIT", parent: "2200", reportingCategory: "ACCRUAL" },

  { code: "2300", nameEn: "Output VAT payable", nameAr: "ضريبة القيمة المضافة — مخرجات", type: "LIABILITY", normalBalance: "CREDIT", parent: "2000", reportingCategory: "TAX_PAYABLE" },
  { code: "2400", nameEn: "Customer deposits and unearned revenue", nameAr: "دفعات مقدمة من العملاء", type: "LIABILITY", normalBalance: "CREDIT", parent: "2000", scope: "BRAND", reportingCategory: "UNEARNED" },

  // ---------------------------------------------------------------------
  // 3 — EQUITY
  //
  // Owner drawings live here, never in operating expenses. Owner salary for
  // genuine work is payroll expense and belongs in the 6000s instead.
  // ---------------------------------------------------------------------
  { code: "3000", nameEn: "Equity", nameAr: "حقوق الملكية", type: "EQUITY", normalBalance: "CREDIT", isPostable: false, reportingCategory: "EQUITY" },
  { code: "3100", nameEn: "Owner capital", nameAr: "رأس المال", type: "EQUITY", normalBalance: "CREDIT", parent: "3000", reportingCategory: "EQUITY" },
  { code: "3200", nameEn: "Owner drawings", nameAr: "مسحوبات المالك", type: "EQUITY", normalBalance: "DEBIT", parent: "3000", reportingCategory: "EQUITY_DRAWINGS" },
  { code: "3300", nameEn: "Retained earnings", nameAr: "الأرباح المرحلة", type: "EQUITY", normalBalance: "CREDIT", parent: "3000", reportingCategory: "EQUITY" },

  // ---------------------------------------------------------------------
  // 4 — REVENUE
  // ---------------------------------------------------------------------
  { code: "4000", nameEn: "Revenue", nameAr: "الإيرادات", type: "REVENUE", normalBalance: "CREDIT", isPostable: false, reportingCategory: "REVENUE" },

  { code: "4100", nameEn: "Brand retail revenue", nameAr: "إيرادات البيع للمستهلك", type: "REVENUE", normalBalance: "CREDIT", parent: "4000", scope: "BRAND", isPostable: false, reportingCategory: "REVENUE_EXTERNAL" },
  { code: "4110", nameEn: "Website (Shopify) sales", nameAr: "مبيعات الموقع", type: "REVENUE", normalBalance: "CREDIT", parent: "4100", scope: "BRAND", reportingCategory: "REVENUE_EXTERNAL" },
  { code: "4120", nameEn: "Moderator/social sales", nameAr: "مبيعات السوشيال", type: "REVENUE", normalBalance: "CREDIT", parent: "4100", scope: "BRAND", reportingCategory: "REVENUE_EXTERNAL" },
  { code: "4130", nameEn: "POS showroom sales", nameAr: "مبيعات المعارض", type: "REVENUE", normalBalance: "CREDIT", parent: "4100", scope: "BRAND", reportingCategory: "REVENUE_EXTERNAL" },
  { code: "4140", nameEn: "Exhibition/bazaar sales", nameAr: "مبيعات البازارات", type: "REVENUE", normalBalance: "CREDIT", parent: "4100", scope: "BRAND", reportingCategory: "REVENUE_EXTERNAL" },
  { code: "4150", nameEn: "Wholesale sales", nameAr: "مبيعات الجملة", type: "REVENUE", normalBalance: "CREDIT", parent: "4100", scope: "BRAND", reportingCategory: "REVENUE_EXTERNAL" },

  // Contra-revenue: discounts and returns reduce revenue, they are not costs.
  { code: "4200", nameEn: "Sales discounts", nameAr: "خصومات المبيعات", type: "REVENUE", normalBalance: "DEBIT", parent: "4000", scope: "BRAND", reportingCategory: "CONTRA_REVENUE" },
  { code: "4210", nameEn: "Sales returns", nameAr: "مرتجعات المبيعات", type: "REVENUE", normalBalance: "DEBIT", parent: "4000", scope: "BRAND", reportingCategory: "CONTRA_REVENUE" },

  { code: "4300", nameEn: "Factory external CMT revenue", nameAr: "إيرادات التصنيع للغير", type: "REVENUE", normalBalance: "CREDIT", parent: "4000", scope: "FACTORY", reportingCategory: "REVENUE_EXTERNAL" },
  { code: "4400", nameEn: "Factory intercompany revenue — Brand", nameAr: "إيرادات التحويل للبراند", type: "REVENUE", normalBalance: "CREDIT", parent: "4000", scope: "FACTORY", reportingCategory: "INTERCOMPANY", isIntercompany: true },

  // ---------------------------------------------------------------------
  // 5 — COST OF GOODS SOLD
  // ---------------------------------------------------------------------
  { code: "5000", nameEn: "Cost of goods sold", nameAr: "تكلفة المبيعات", type: "COGS", normalBalance: "DEBIT", isPostable: false, reportingCategory: "COGS" },
  { code: "5100", nameEn: "Factory COGS — materials", nameAr: "تكلفة الخامات المنصرفة", type: "COGS", normalBalance: "DEBIT", parent: "5000", scope: "FACTORY", reportingCategory: "COGS_MATERIAL" },
  { code: "5200", nameEn: "Factory COGS — conversion", nameAr: "تكلفة التشغيل المحملة", type: "COGS", normalBalance: "DEBIT", parent: "5000", scope: "FACTORY", reportingCategory: "COGS_CONVERSION" },
  { code: "5300", nameEn: "Brand COGS at transfer price", nameAr: "تكلفة البضاعة بسعر التحويل", type: "COGS", normalBalance: "DEBIT", parent: "5000", scope: "BRAND", reportingCategory: "INTERCOMPANY", isIntercompany: true },
  { code: "5400", nameEn: "Scrap and abnormal loss", nameAr: "الهالك والفاقد غير الطبيعي", type: "COGS", normalBalance: "DEBIT", parent: "5000", scope: "FACTORY", reportingCategory: "COGS_LOSS" },
  { code: "5500", nameEn: "Rework cost", nameAr: "تكلفة إعادة التشغيل", type: "COGS", normalBalance: "DEBIT", parent: "5000", scope: "FACTORY", reportingCategory: "COGS_LOSS" },

  // ---------------------------------------------------------------------
  // 6 — OPERATING EXPENSES
  //
  // `includeInMinuteRate` marks the Factory conversion pool — the numerator of
  // the minute rate. Materials and finance costs are deliberately excluded, or
  // fabric would be counted twice.
  //
  // `includeInBrandFixedPool` marks the Brand-only fixed costs used by
  // break-even. Factory overhead is already absorbed into transfer price, so
  // no 62xx account may carry this flag.
  // ---------------------------------------------------------------------
  { code: "6000", nameEn: "Operating expenses", nameAr: "المصروفات التشغيلية", type: "EXPENSE", normalBalance: "DEBIT", isPostable: false, reportingCategory: "OPEX" },

  { code: "6100", nameEn: "Factory conversion costs", nameAr: "تكاليف تشغيل المصنع", type: "EXPENSE", normalBalance: "DEBIT", parent: "6000", scope: "FACTORY", isPostable: false, reportingCategory: "FACTORY_CONVERSION" },
  { code: "6110", nameEn: "Direct sewing labour", nameAr: "أجور عمال الإنتاج", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6115", nameEn: "Supervisors, mechanics, QC", nameAr: "مشرفين وفنيين وجودة", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6120", nameEn: "Factory rent", nameAr: "إيجار المصنع", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6125", nameEn: "Factory utilities", nameAr: "كهرباء ومياه المصنع", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6130", nameEn: "Machine maintenance", nameAr: "صيانة المكن", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6135", nameEn: "Factory depreciation", nameAr: "إهلاك أصول المصنع", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6140", nameEn: "Factory administration", nameAr: "إدارة المصنع", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6145", nameEn: "Internal transport", nameAr: "نقل داخلي", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },
  { code: "6150", nameEn: "Production consumables", nameAr: "مستهلكات الإنتاج", type: "EXPENSE", normalBalance: "DEBIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_CONVERSION", includeInMinuteRate: true },

  // Contra-expense. Conversion cost is incurred as a period expense in the
  // 61xx accounts, then absorbed into inventory at the minute rate as garments
  // are produced. The balance left here is the under- or over-absorption — in
  // other words, the cost of the capacity that produced nothing. It is
  // excluded from the minute-rate pool, or absorption would feed its own rate.
  { code: "6190", nameEn: "Conversion cost absorbed into inventory", nameAr: "تكلفة التشغيل المحمّلة على المخزون", type: "EXPENSE", normalBalance: "CREDIT", parent: "6100", scope: "FACTORY", reportingCategory: "FACTORY_ABSORPTION" },

  { code: "6200", nameEn: "Brand variable selling costs", nameAr: "تكاليف البيع المتغيرة", type: "EXPENSE", normalBalance: "DEBIT", parent: "6000", scope: "BRAND", isPostable: false, reportingCategory: "BRAND_VARIABLE" },
  { code: "6210", nameEn: "Retail packaging", nameAr: "تغليف التجزئة", type: "EXPENSE", normalBalance: "DEBIT", parent: "6200", scope: "BRAND", reportingCategory: "BRAND_VARIABLE" },
  { code: "6220", nameEn: "Shipping and delivery", nameAr: "الشحن والتوصيل", type: "EXPENSE", normalBalance: "DEBIT", parent: "6200", scope: "BRAND", reportingCategory: "BRAND_VARIABLE" },
  { code: "6230", nameEn: "Payment and COD fees", nameAr: "رسوم الدفع والتحصيل", type: "EXPENSE", normalBalance: "DEBIT", parent: "6200", scope: "BRAND", reportingCategory: "BRAND_VARIABLE" },
  { code: "6240", nameEn: "Return handling", nameAr: "معالجة المرتجعات", type: "EXPENSE", normalBalance: "DEBIT", parent: "6200", scope: "BRAND", reportingCategory: "BRAND_VARIABLE" },

  { code: "6300", nameEn: "Brand fixed costs", nameAr: "التكاليف الثابتة للبراند", type: "EXPENSE", normalBalance: "DEBIT", parent: "6000", scope: "BRAND", isPostable: false, reportingCategory: "BRAND_FIXED" },
  { code: "6310", nameEn: "Brand salaries", nameAr: "رواتب البراند", type: "EXPENSE", normalBalance: "DEBIT", parent: "6300", scope: "BRAND", reportingCategory: "BRAND_FIXED", includeInBrandFixedPool: true },
  { code: "6320", nameEn: "Showroom and office rent", nameAr: "إيجار المعرض والمكتب", type: "EXPENSE", normalBalance: "DEBIT", parent: "6300", scope: "BRAND", reportingCategory: "BRAND_FIXED", includeInBrandFixedPool: true },
  { code: "6330", nameEn: "Software and subscriptions", nameAr: "برمجيات واشتراكات", type: "EXPENSE", normalBalance: "DEBIT", parent: "6300", scope: "BRAND", reportingCategory: "BRAND_FIXED", includeInBrandFixedPool: true },
  { code: "6340", nameEn: "Brand depreciation", nameAr: "إهلاك أصول البراند", type: "EXPENSE", normalBalance: "DEBIT", parent: "6300", scope: "BRAND", reportingCategory: "BRAND_FIXED", includeInBrandFixedPool: true },

  // Marketing is variable in behaviour and allocated by units sold, so it is
  // deliberately NOT in the break-even fixed pool.
  { code: "6400", nameEn: "Marketing and advertising", nameAr: "التسويق والإعلان", type: "EXPENSE", normalBalance: "DEBIT", parent: "6000", scope: "BRAND", isPostable: false, reportingCategory: "MARKETING" },
  { code: "6410", nameEn: "Paid advertising", nameAr: "إعلانات مدفوعة", type: "EXPENSE", normalBalance: "DEBIT", parent: "6400", scope: "BRAND", reportingCategory: "MARKETING" },
  { code: "6420", nameEn: "Influencers and affiliates", nameAr: "المؤثرون والتسويق بالعمولة", type: "EXPENSE", normalBalance: "DEBIT", parent: "6400", scope: "BRAND", reportingCategory: "MARKETING" },
  { code: "6430", nameEn: "Content and creative production", nameAr: "إنتاج المحتوى", type: "EXPENSE", normalBalance: "DEBIT", parent: "6400", scope: "BRAND", reportingCategory: "MARKETING" },

  { code: "6500", nameEn: "General and administrative", nameAr: "مصروفات عمومية وإدارية", type: "EXPENSE", normalBalance: "DEBIT", parent: "6000", isPostable: false, reportingCategory: "ADMIN" },
  { code: "6510", nameEn: "Owner salary", nameAr: "راتب المالك", type: "EXPENSE", normalBalance: "DEBIT", parent: "6500", reportingCategory: "ADMIN" },
  { code: "6520", nameEn: "Professional fees", nameAr: "أتعاب مهنية", type: "EXPENSE", normalBalance: "DEBIT", parent: "6500", reportingCategory: "ADMIN" },
  { code: "6530", nameEn: "Government fees and licences", nameAr: "رسوم حكومية وتراخيص", type: "EXPENSE", normalBalance: "DEBIT", parent: "6500", reportingCategory: "ADMIN" },

  // ---------------------------------------------------------------------
  // 7 — OTHER INCOME AND EXPENSE
  // ---------------------------------------------------------------------
  { code: "7000", nameEn: "Other income", nameAr: "إيرادات أخرى", type: "OTHER_INCOME", normalBalance: "CREDIT", isPostable: false, reportingCategory: "OTHER" },
  { code: "7100", nameEn: "Scrap sales income", nameAr: "إيراد بيع الهالك", type: "OTHER_INCOME", normalBalance: "CREDIT", parent: "7000", scope: "FACTORY", reportingCategory: "OTHER" },

  { code: "7500", nameEn: "Other expense", nameAr: "مصروفات أخرى", type: "OTHER_EXPENSE", normalBalance: "DEBIT", isPostable: false, reportingCategory: "OTHER" },
  { code: "7510", nameEn: "Interest and bank charges", nameAr: "فوائد ومصاريف بنكية", type: "OTHER_EXPENSE", normalBalance: "DEBIT", parent: "7500", reportingCategory: "FINANCE_COST" },
  { code: "7520", nameEn: "Foreign exchange difference", nameAr: "فروق أسعار صرف", type: "OTHER_EXPENSE", normalBalance: "DEBIT", parent: "7500", reportingCategory: "FINANCE_COST" },
];

/**
 * Cost centres. Deliberately broader than the two entities so a Brand cost can
 * be attributed to the showroom that incurred it.
 */
export const COST_CENTERS = [
  { code: "CC-FACTORY", nameEn: "Factory", nameAr: "المصنع", entityKind: "FACTORY" as const },
  { code: "CC-BRAND", nameEn: "Brand", nameAr: "البراند", entityKind: "BRAND" as const },
  { code: "CC-SHOWROOM-ALX", nameEn: "Alexandria showroom", nameAr: "معرض الإسكندرية", entityKind: "BRAND" as const },
  { code: "CC-STORE-CAI", nameEn: "Cairo store", nameAr: "فرع القاهرة", entityKind: "BRAND" as const },
  { code: "CC-MARKETING", nameEn: "Marketing", nameAr: "التسويق", entityKind: "BRAND" as const },
  { code: "CC-CORPORATE", nameEn: "Corporate", nameAr: "الإدارة العامة", entityKind: null },
];

/**
 * Physical stock locations.
 *
 * The Alexandria site is both showroom and the Brand's warehouse — online and
 * moderator orders ship from it — so it is one location, not two.
 */
export const LOCATIONS = [
  {
    code: "LOC-FAC", nameEn: "Factory warehouse", nameAr: "مخزن المصنع",
    kind: "FACTORY_WAREHOUSE" as const, entityKind: "FACTORY" as const, city: "Alexandria",
  },
  {
    // Goods despatched but not yet counted in by the shop. They stay the
    // factory's while they are on the road, which is what makes a shortfall
    // the factory's loss rather than a mystery in the brand's books.
    code: "LOC-TRANSIT", nameEn: "In transit to the Brand", nameAr: "في الطريق للبراند",
    kind: "TRANSIT" as const, entityKind: "FACTORY" as const, city: null,
  },
  {
    code: "LOC-ALX", nameEn: "Alexandria showroom and warehouse", nameAr: "معرض ومخزن الإسكندرية",
    kind: "SHOWROOM" as const, entityKind: "BRAND" as const, city: "Alexandria",
  },
  {
    code: "LOC-CAI", nameEn: "Cairo store", nameAr: "فرع القاهرة",
    kind: "STORE" as const, entityKind: "BRAND" as const, city: "Cairo",
  },
];

/**
 * Egyptian VAT. Versioned by effective date so a future rate change never
 * restates a posted transaction.
 */
export const TAX_RATES = [
  {
    code: "VAT-EG",
    nameEn: "Egyptian VAT (standard)",
    nameAr: "ضريبة القيمة المضافة",
    rate: "0.14",
    effectiveFrom: "2017-07-01",
  },
  {
    code: "VAT-EXEMPT",
    nameEn: "VAT exempt",
    nameAr: "معفى من الضريبة",
    rate: "0",
    effectiveFrom: "2017-07-01",
  },
];
