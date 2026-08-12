/**
 * Bilingual dictionary. Arabic is primary, English secondary.
 *
 * The costing vocabulary is fixed and must stay consistent across every
 * screen — an accountant reading this system should meet the same word for
 * the same concept everywhere:
 *   تكلفة الدقيقة · سعر التحويل · هامش المساهمة · نقطة التعادل ·
 *   الطاقة العاطلة · دورة الكاش · المخزون الراكد
 */

export type Locale = "ar" | "en";

export const LOCALES: Locale[] = ["ar", "en"];

export const DEFAULT_LOCALE: Locale =
  (process.env.DEFAULT_LOCALE as Locale) ?? "ar";

export function isRtl(locale: Locale): boolean {
  return locale === "ar";
}

type Entry = { ar: string; en: string };

export const dictionary = {
  // --- brand / shell ---
  appName: { ar: "كاشمير أو إس", en: "Cashmere OS" },
  appTagline: {
    ar: "نظام تشغيل المصنع والبراند",
    en: "Factory & Brand Operating System",
  },

  // --- entities ---
  factory: { ar: "المصنع", en: "Factory" },
  brand: { ar: "البراند", en: "Brand" },
  group: { ar: "المجموعة", en: "Group" },
  entity: { ar: "الكيان", en: "Entity" },
  switchEntity: { ar: "تبديل الكيان", en: "Switch entity" },

  // --- the fixed costing vocabulary (rule 7) ---
  minuteRate: { ar: "تكلفة الدقيقة", en: "Minute rate" },
  transferPrice: { ar: "سعر التحويل", en: "Transfer price" },
  transferToBrand: { ar: "الشحن للبراند", en: "Despatch to Brand" },
  goodsIn: { ar: "الوارد من المصنع", en: "Goods in" },
  exhibitions: { ar: "البازارات", en: "Bazaars" },
  customerCredit: { ar: "ذمم العملاء", en: "Customer credit" },
  customOrders: { ar: "أوردرات خاصة", en: "Made to order" },
  approvals: { ar: "الاعتمادات", en: "Approvals" },
  consignment: { ar: "بضاعة الأمانة", en: "Consignment" },
  users: { ar: "المستخدمون", en: "Users" },
  reconciliation: { ar: "التسويات", en: "Reconciliation" },
  moderatorOrder: { ar: "أوردر مودريتور", en: "Moderator order" },
  contributionMargin: { ar: "هامش المساهمة", en: "Contribution margin" },
  breakEven: { ar: "نقطة التعادل", en: "Break-even" },
  idleCapacity: { ar: "الطاقة العاطلة", en: "Idle capacity" },
  cashCycle: { ar: "دورة الكاش", en: "Cash conversion cycle" },
  deadStock: { ar: "المخزون الراكد", en: "Dead stock" },

  // --- costing detail ---
  actualMinuteRate: { ar: "تكلفة الدقيقة الفعلية", en: "Actual minute rate" },
  fullCapacityMinuteRate: {
    ar: "تكلفة الدقيقة عند الطاقة الكاملة",
    en: "Full-capacity minute rate",
  },
  idlePenaltyPerMinute: {
    ar: "عبء الطاقة العاطلة للدقيقة",
    en: "Idle penalty per minute",
  },
  idlePenaltyPerUnit: {
    ar: "عبء الطاقة العاطلة للقطعة",
    en: "Idle penalty per unit",
  },
  materialCost: { ar: "تكلفة الخامات", en: "Material cost" },
  fabricCost: { ar: "تكلفة القماش", en: "Fabric cost" },
  trimCost: { ar: "تكلفة الإكسسوارات", en: "Trim cost" },
  cmtCost: { ar: "تكلفة التصنيع", en: "CMT cost" },
  factoryTotalCost: { ar: "إجمالي تكلفة المصنع", en: "Factory total cost" },
  factoryMargin: { ar: "هامش المصنع", en: "Factory margin" },
  wasteRate: { ar: "نسبة الهالك", en: "Waste rate" },
  plannedWaste: { ar: "الهالك المخطط", en: "Planned waste" },
  actualWaste: { ar: "الهالك الفعلي", en: "Actual waste" },
  smv: { ar: "الدقيقة المعيارية", en: "SMV" },
  costSnapshot: { ar: "لقطة التكلفة", en: "Cost snapshot" },

  // --- capacity ---
  capacity: { ar: "الطاقة الإنتاجية", en: "Capacity" },
  capacityPlanning: { ar: "تخطيط الطاقة", en: "Capacity planning" },
  availableMinutes: { ar: "الدقائق المتاحة", en: "Available minutes" },
  bookedMinutes: { ar: "الدقائق المحجوزة", en: "Booked minutes" },
  idleMinutes: { ar: "الدقائق العاطلة", en: "Idle minutes" },
  utilisation: { ar: "نسبة التشغيل", en: "Utilisation" },
  efficiency: { ar: "الكفاءة", en: "Efficiency" },
  lineEfficiency: { ar: "كفاءة الخط", en: "Line efficiency" },
  operatorProductivity: { ar: "إنتاجية العامل", en: "Operator productivity" },
  productionLine: { ar: "خط الإنتاج", en: "Production line" },

  // --- accounting ---
  expenses: { ar: "المصروفات", en: "Expenses" },
  accruedLiabilities: { ar: "المستحقات غير المدفوعة", en: "Accrued liabilities" },
  cashSpend: { ar: "المدفوع نقدًا", en: "Cash spend" },
  apAging: { ar: "أعمار الذمم الدائنة", en: "AP aging" },
  incurredDate: { ar: "تاريخ الاستحقاق الفعلي", en: "Incurred date" },
  dueDate: { ar: "تاريخ السداد", en: "Due date" },
  paid: { ar: "مدفوع", en: "Paid" },
  unpaid: { ar: "غير مدفوع", en: "Unpaid" },
  partiallyPaid: { ar: "مدفوع جزئيًا", en: "Partially paid" },

  // --- P&L ---
  factoryPnl: { ar: "قائمة دخل المصنع", en: "Factory P&L" },
  brandPnl: { ar: "قائمة دخل البراند", en: "Brand P&L" },
  groupPnl: { ar: "قائمة دخل المجموعة", en: "Group P&L" },
  revenue: { ar: "الإيرادات", en: "Revenue" },
  cogs: { ar: "تكلفة المبيعات", en: "COGS" },
  grossProfit: { ar: "مجمل الربح", en: "Gross profit" },
  netProfit: { ar: "صافي الربح", en: "Net profit" },
  intercompanyElimination: {
    ar: "استبعاد المعاملات البينية",
    en: "Intercompany elimination",
  },

  // --- production ---
  production: { ar: "الإنتاج", en: "Production" },
  productionOrder: { ar: "أمر الإنتاج", en: "Production order" },
  cuttingTicket: { ar: "تذكرة القص", en: "Cutting ticket" },
  planned: { ar: "المخطط", en: "Planned" },
  actual: { ar: "الفعلي", en: "Actual" },
  variance: { ar: "الانحراف", en: "Variance" },
  scrap: { ar: "القصاصات", en: "Scrap" },
  rework: { ar: "إعادة التشغيل", en: "Rework" },
  fabricUtilisation: { ar: "استغلال القماش", en: "Fabric utilisation" },
  qc: { ar: "الجودة", en: "QC" },

  // --- inventory & commercial ---
  inventory: { ar: "المخزون", en: "Inventory" },
  rawMaterials: { ar: "الخامات", en: "Raw materials" },
  wip: { ar: "تحت التشغيل", en: "WIP" },
  finishedGoods: { ar: "الإنتاج التام", en: "Finished goods" },
  aging: { ar: "الأعمار", en: "Aging" },
  sellThrough: { ar: "معدل التصريف", en: "Sell-through" },
  markdown: { ar: "تحليل الخصومات", en: "Markdown analysis" },
  gmroi: { ar: "العائد على المخزون", en: "GMROI" },
  collectionPerformance: { ar: "أداء التشكيلة", en: "Collection performance" },
  styles: { ar: "الموديلات", en: "Styles" },
  customers: { ar: "العملاء", en: "Customers" },
  pos: { ar: "نقطة البيع", en: "Point of sale" },
  purchasing: { ar: "المشتريات", en: "Purchasing" },
  integrations: { ar: "التكاملات", en: "Integrations" },
  mrp: { ar: "تخطيط الاحتياجات", en: "Requirements planning" },
  marketing: { ar: "التسويق", en: "Marketing" },
  recovery: { ar: "العربيات المتروكة", en: "Abandoned baskets" },
  people: { ar: "الموظفون والأجور", en: "People and payroll" },
  customerProfitability: { ar: "ربحية العميل", en: "Customer profitability" },
  sales: { ar: "المبيعات", en: "Sales" },
  returns: { ar: "المرتجعات", en: "Returns" },

  // --- suppliers ---
  suppliers: { ar: "الموردين", en: "Suppliers" },
  supplierScore: { ar: "تقييم المورد", en: "Supplier score" },
  supplierStatements: { ar: "كشف حساب الموردين", en: "Supplier statements" },
  purchasePriceVariance: { ar: "انحراف سعر الشراء", en: "Purchase price variance" },
  moq: { ar: "الحد الأدنى للطلب", en: "MOQ" },
  materials: { ar: "الخامات", en: "Materials" },

  // --- cash ---
  cashFlowForecast: { ar: "توقعات التدفق النقدي", en: "Cash flow forecast" },
  workingCapitalLocked: { ar: "رأس المال المحبوس", en: "Working capital locked" },
  receivables: { ar: "المحصلات المتوقعة", en: "Receivables" },
  shortage: { ar: "العجز", en: "Shortage" },

  // --- CMT ---
  cmt: { ar: "التصنيع للغير", en: "External CMT" },
  cmtClients: { ar: "عملاء التصنيع", en: "CMT clients" },
  cmtQuote: { ar: "عرض سعر", en: "CMT quote" },
  floorPrice: { ar: "الحد الأدنى للسعر", en: "Floor price" },

  // --- intelligence ---
  alerts: { ar: "التنبيهات", en: "Alerts" },
  scenarioSimulator: { ar: "محاكاة السيناريوهات", en: "Scenario simulator" },
  whatIf: { ar: "ماذا لو", en: "What if" },
  dashboard: { ar: "الرئيسية", en: "Dashboard" },
  settings: { ar: "الإعدادات", en: "Settings" },

  // --- auth & common ---
  signIn: { ar: "تسجيل الدخول", en: "Sign in" },
  signOut: { ar: "تسجيل الخروج", en: "Sign out" },
  email: { ar: "البريد الإلكتروني", en: "Email" },
  password: { ar: "كلمة المرور", en: "Password" },
  invalidCredentials: {
    ar: "البريد الإلكتروني أو كلمة المرور غير صحيحة",
    en: "Invalid email or password",
  },
  save: { ar: "حفظ", en: "Save" },
  cancel: { ar: "إلغاء", en: "Cancel" },
  loading: { ar: "جارٍ التحميل…", en: "Loading…" },
  comingInPhase: { ar: "يأتي في المرحلة", en: "Arrives in phase" },
  noData: { ar: "لا توجد بيانات بعد", en: "No data yet" },
} as const satisfies Record<string, Entry>;

export type DictKey = keyof typeof dictionary;

export function t(key: DictKey, locale: Locale): string {
  return dictionary[key][locale];
}

/** Curried translator for components that hold a locale in scope. */
export function translator(locale: Locale) {
  return (key: DictKey) => t(key, locale);
}
