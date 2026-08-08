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
  phase: 1 | 2 | 3 | 4 | 5 | 6;
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
      { key: "alerts", href: "/alerts", phase: 3, scopes: ALL_SCOPES, icon: "bell" },
    ],
  },
  {
    key: "expenses",
    items: [
      { key: "expenses", href: "/expenses", phase: 2, scopes: ALL_SCOPES, icon: "receipt" , shipped: true },
      { key: "apAging", href: "/expenses/aging", phase: 2, scopes: ALL_SCOPES, icon: "clock" },
      { key: "cashFlowForecast", href: "/cash-flow", phase: 5, scopes: ALL_SCOPES, icon: "wallet" },
    ],
  },
  {
    key: "minuteRate",
    items: [
      { key: "capacity", href: "/capacity", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "gauge" },
      { key: "minuteRate", href: "/minute-rate", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "timer" , shipped: true },
      { key: "capacityPlanning", href: "/capacity/planning", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "calendar" },
    ],
  },
  {
    key: "materials",
    items: [
      { key: "materials", href: "/materials", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "layers" },
      { key: "suppliers", href: "/suppliers", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "truck" },
      { key: "supplierScore", href: "/suppliers/scorecard", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "star" },
    ],
  },
  {
    key: "production",
    items: [
      { key: "collectionPerformance", href: "/styles", phase: 2, scopes: ALL_SCOPES, icon: "shirt" },
      { key: "transferPrice", href: "/costing", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "calculator" , shipped: true },
      { key: "productionOrder", href: "/production", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "factory" , shipped: true },
      { key: "lineEfficiency", href: "/production/lines", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "activity" },
      { key: "scrap", href: "/production/scrap", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "scissors" },
    ],
  },
  {
    key: "inventory",
    items: [
      { key: "inventory", href: "/inventory", phase: 4, scopes: ALL_SCOPES, icon: "boxes" , shipped: true },
      { key: "deadStock", href: "/inventory/dead-stock", phase: 4, scopes: ["BRAND", "GROUP"], icon: "alert" },
      { key: "sales", href: "/sales", phase: 4, scopes: ["BRAND", "GROUP"], icon: "cart" },
      { key: "sellThrough", href: "/sales/sell-through", phase: 5, scopes: ["BRAND", "GROUP"], icon: "trending" },
      { key: "markdown", href: "/sales/markdown", phase: 5, scopes: ["BRAND", "GROUP"], icon: "tag" },
    ],
  },
  {
    key: "groupPnl",
    items: [
      { key: "factoryPnl", href: "/reports/factory-pnl", phase: 5, scopes: ["FACTORY", "GROUP"], icon: "chart" },
      { key: "brandPnl", href: "/reports/brand-pnl", phase: 5, scopes: ["BRAND", "GROUP"], icon: "chart" },
      { key: "groupPnl", href: "/reports/group-pnl", phase: 5, scopes: ["GROUP"], icon: "chart" },
      { key: "breakEven", href: "/reports/break-even", phase: 5, scopes: ["BRAND", "GROUP"], icon: "target" },
      { key: "cashCycle", href: "/reports/cash-cycle", phase: 5, scopes: ALL_SCOPES, icon: "refresh" },
      { key: "gmroi", href: "/reports/gmroi", phase: 5, scopes: ["BRAND", "GROUP"], icon: "percent" },
    ],
  },
  {
    key: "cmt",
    items: [
      { key: "cmtClients", href: "/cmt/clients", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "users" },
      { key: "cmtQuote", href: "/cmt/quotes", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "file" },
    ],
  },
  {
    key: "scenarioSimulator",
    items: [
      { key: "whatIf", href: "/scenarios", phase: 3, scopes: ALL_SCOPES, icon: "sparkles" },
      { key: "settings", href: "/settings", phase: 1, scopes: ALL_SCOPES, icon: "settings" , shipped: true },
    ],
  },
];

/** Everything not marked shipped renders disabled, labelled with its phase. */
export function isShipped(item: NavItem): boolean {
  return item.shipped === true;
}
