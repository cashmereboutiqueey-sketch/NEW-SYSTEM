import type { DictKey } from "./i18n";
import type { EntityScope } from "./session";

/**
 * The shape of the whole system, declared once. Items from later phases are
 * shown but disabled, so the map of where things will live is visible from
 * day one rather than appearing by surprise.
 */
export type NavItem = {
  key: DictKey;
  href: string;
  /// Which delivery phase the screen belongs to. The plan runs to 15, so this
  /// is a plain number rather than a union that has to be widened each time.
  phase: number;
  /** Which entity lenses this screen makes sense in. */
  scopes: EntityScope[];
  icon: string;
  /**
   * Set only once the screen actually works end to end. Gating by phase
   * instead would light up every phase-2 link the moment the first phase-2
   * screen shipped, linking to pages that do not exist yet.
   */
  shipped?: boolean;
};

export type NavSection = {
  key: DictKey;
  items: NavItem[];
};

export const ALL_SCOPES: EntityScope[] = ["FACTORY", "BRAND", "GROUP"];

export const navigation: NavSection[] = [
  {
    key: "dashboard",
    items: [
      { key: "dashboard", href: "/", phase: 1, scopes: ALL_SCOPES, icon: "home" , shipped: true },
      { key: "alerts", href: "/alerts", phase: 3, scopes: ALL_SCOPES, icon: "bell", shipped: true },
    ],
  },
  {
    key: "expenses",
    items: [
      { key: "expenses", href: "/expenses", phase: 2, scopes: ALL_SCOPES, icon: "receipt" , shipped: true },
      { key: "apAging", href: "/expenses/aging", phase: 2, scopes: ALL_SCOPES, icon: "clock", shipped: true },
      { key: "cashFlowForecast", href: "/cash-flow", phase: 5, scopes: ALL_SCOPES, icon: "wallet", shipped: true },
      { key: "reconciliation", href: "/reconciliation", phase: 5, scopes: ALL_SCOPES, icon: "refresh", shipped: true },
    ],
  },
  {
    key: "minuteRate",
    items: [
      { key: "capacity", href: "/capacity", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "gauge" , shipped: true },
      { key: "minuteRate", href: "/minute-rate", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "timer" , shipped: true },
      { key: "mrp", href: "/mrp", phase: 9, scopes: ["FACTORY", "GROUP"], icon: "calendar", shipped: true },
      { key: "capacityPlanning", href: "/capacity/planning", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "calendar" , shipped: true },
    ],
  },
  {
    key: "materials",
    items: [
      { key: "materials", href: "/materials", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "layers" , shipped: true },
      { key: "suppliers", href: "/suppliers", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "truck" , shipped: true },
      { key: "purchasing", href: "/purchasing", phase: 4, scopes: ["FACTORY", "GROUP"], icon: "file", shipped: true },
      { key: "supplierScore", href: "/suppliers/scorecard", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "star", shipped: true },
    ],
  },
  {
    key: "production",
    items: [
      { key: "collectionPerformance", href: "/styles", phase: 2, scopes: ALL_SCOPES, icon: "shirt" , shipped: true },
      { key: "transferPrice", href: "/costing", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "calculator" , shipped: true },
      { key: "productionOrder", href: "/production", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "factory" , shipped: true },
      { key: "transferToBrand", href: "/transfers", phase: 4, scopes: ["FACTORY", "GROUP"], icon: "truck", shipped: true },
      { key: "lineEfficiency", href: "/production/lines", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "activity" , shipped: true },
      { key: "scrap", href: "/production/scrap", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "scissors" , shipped: true },
    ],
  },
  {
    key: "inventory",
    items: [
      { key: "goodsIn", href: "/goods-in", phase: 4, scopes: ["BRAND", "GROUP"], icon: "truck", shipped: true },
      { key: "inventory", href: "/inventory", phase: 4, scopes: ALL_SCOPES, icon: "boxes" , shipped: true },
      { key: "deadStock", href: "/inventory/dead-stock", phase: 4, scopes: ["BRAND", "GROUP"], icon: "alert", shipped: true },
      { key: "pos", href: "/pos", phase: 6, scopes: ["BRAND", "GROUP"], icon: "cart", shipped: true },
      { key: "exhibitions", href: "/exhibitions", phase: 6, scopes: ["BRAND", "GROUP"], icon: "tag", shipped: true },
      { key: "sales", href: "/sales", phase: 4, scopes: ["BRAND", "GROUP"], icon: "cart" , shipped: true },
      { key: "customers", href: "/customers", phase: 7, scopes: ["BRAND", "GROUP"], icon: "users", shipped: true },
      { key: "customOrders", href: "/custom-orders", phase: 7, scopes: ["BRAND", "GROUP"], icon: "scissors", shipped: true },
      { key: "customerCredit", href: "/receivables", phase: 7, scopes: ["BRAND", "GROUP"], icon: "wallet", shipped: true },
      { key: "marketing", href: "/marketing", phase: 10, scopes: ["BRAND", "GROUP"], icon: "sparkles", shipped: true },
      { key: "recovery", href: "/recovery", phase: 10, scopes: ["BRAND", "GROUP"], icon: "cart", shipped: true },
      { key: "people", href: "/hr", phase: 8, scopes: ALL_SCOPES, icon: "users", shipped: true },
      { key: "sellThrough", href: "/sales/sell-through", phase: 5, scopes: ["BRAND", "GROUP"], icon: "trending", shipped: true },
      { key: "markdown", href: "/sales/markdown", phase: 5, scopes: ["BRAND", "GROUP"], icon: "tag", shipped: true },
    ],
  },
  {
    key: "groupPnl",
    items: [
      { key: "factoryPnl", href: "/reports/entity-pnl?entity=FACTORY", phase: 5, scopes: ["FACTORY", "GROUP"], icon: "chart", shipped: true },
      { key: "brandPnl", href: "/reports/entity-pnl?entity=BRAND", phase: 5, scopes: ["BRAND", "GROUP"], icon: "chart", shipped: true },
      { key: "groupPnl", href: "/reports/group-pnl", phase: 5, scopes: ["GROUP"], icon: "chart" , shipped: true },
      { key: "breakEven", href: "/reports/break-even", phase: 5, scopes: ["BRAND", "GROUP"], icon: "target", shipped: true },
      { key: "cashCycle", href: "/reports/cash-cycle", phase: 5, scopes: ALL_SCOPES, icon: "refresh", shipped: true },
      { key: "gmroi", href: "/reports/gmroi", phase: 5, scopes: ["BRAND", "GROUP"], icon: "percent", shipped: true },
    ],
  },
  {
    key: "cmt",
    items: [
      { key: "cmtClients", href: "/cmt/clients", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "users" , shipped: true },
      { key: "cmtQuote", href: "/cmt/quotes", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "file" , shipped: true },
    ],
  },
  {
    key: "scenarioSimulator",
    items: [
      { key: "whatIf", href: "/scenarios", phase: 3, scopes: ALL_SCOPES, icon: "sparkles", shipped: true },
      { key: "integrations", href: "/integrations", phase: 9, scopes: ALL_SCOPES, icon: "refresh", shipped: true },
      { key: "users", href: "/users", phase: 1, scopes: ALL_SCOPES, icon: "users", shipped: true },
      { key: "settings", href: "/settings", phase: 1, scopes: ALL_SCOPES, icon: "settings" , shipped: true },
    ],
  },
];

/** Everything not marked shipped renders disabled, labelled with its phase. */
export function isShipped(item: NavItem): boolean {
  return item.shipped === true;
}
