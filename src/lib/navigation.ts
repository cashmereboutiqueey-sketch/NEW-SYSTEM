import { can, type Permission, type Role } from "@/core/permissions";
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
   * What the page behind this link demands, mirroring its own guard.
   *
   * A list means any one of them is enough, which is how the few screens that
   * serve several jobs work: the approvals queue opens for whoever approves
   * anything, and the till for whoever either sells or counts the drawer.
   *
   * Omitted only where the page is genuinely for everybody. It is not a
   * second line of defence and was never meant to be — the page guards
   * itself, and this decides whether somebody is shown a door they cannot
   * open.
   */
  needs?: Permission | readonly Permission[];
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
      { key: "alerts", href: "/alerts", phase: 3, scopes: ALL_SCOPES, icon: "bell", shipped: true, needs: "alert:view" },
    ],
  },
  {
    key: "expenses",
    items: [
      { key: "approvals", href: "/approvals", phase: 2, scopes: ALL_SCOPES, icon: "check", shipped: true, needs: ["expense:approve", "purchase_order:approve", "payroll:approve", "inventory:approve_adjustment"] },
      { key: "expenses", href: "/expenses", phase: 2, scopes: ALL_SCOPES, icon: "receipt" , shipped: true, needs: "expense:view" },
      { key: "apAging", href: "/expenses/aging", phase: 2, scopes: ALL_SCOPES, icon: "clock", shipped: true, needs: "expense:view" },
      { key: "cashFlowForecast", href: "/cash-flow", phase: 5, scopes: ALL_SCOPES, icon: "wallet", shipped: true, needs: "journal:view" },
      { key: "reconciliation", href: "/reconciliation", phase: 5, scopes: ALL_SCOPES, icon: "refresh", shipped: true, needs: "journal:view" },
      // The ledger itself, and the only honest way to correct it. Postings are
      // immutable by design, which left nothing able to put a mistake right.
      { key: "journal", href: "/journal", phase: 2, scopes: ALL_SCOPES, icon: "file", shipped: true, needs: "journal:view" },
      { key: "auditTrail", href: "/audit", phase: 2, scopes: ALL_SCOPES, icon: "search", shipped: true, needs: "audit:view" },
      { key: "chartOfAccounts", href: "/accounts", phase: 2, scopes: ALL_SCOPES, icon: "layers", shipped: true, needs: "journal:view" },
      { key: "tax", href: "/tax", phase: 2, scopes: ALL_SCOPES, icon: "percent", shipped: true, needs: "journal:view" },
    ],
  },
  {
    key: "minuteRate",
    items: [
      { key: "capacity", href: "/capacity", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "gauge" , shipped: true, needs: "minute_rate:view" },
      { key: "minuteRate", href: "/minute-rate", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "timer" , shipped: true, needs: "minute_rate:view" },
      { key: "mrp", href: "/mrp", phase: 9, scopes: ["FACTORY", "GROUP"], icon: "calendar", shipped: true, needs: "production:view" },
      { key: "capacityPlanning", href: "/capacity/planning", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "calendar" , shipped: true, needs: "minute_rate:view" },
    ],
  },
  {
    key: "materials",
    items: [
      { key: "materials", href: "/materials", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "layers" , shipped: true, needs: "inventory:view" },
      { key: "materialLedger", href: "/materials/ledger", phase: 4, scopes: ["FACTORY", "GROUP"], icon: "boxes", shipped: true, needs: "inventory:view" },
      { key: "suppliers", href: "/suppliers", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "truck" , shipped: true, needs: "purchase_order:view" },
      { key: "purchasing", href: "/purchasing", phase: 4, scopes: ["FACTORY", "GROUP"], icon: "file", shipped: true, needs: "purchase_order:view" },
      { key: "supplierStatements", href: "/suppliers/statements", phase: 2, scopes: ALL_SCOPES, icon: "receipt", shipped: true, needs: "expense:view" },
      { key: "supplierScore", href: "/suppliers/scorecard", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "star", shipped: true, needs: "purchase_order:view" },
    ],
  },
  {
    key: "production",
    items: [
      { key: "styles", href: "/styles", phase: 2, scopes: ALL_SCOPES, icon: "shirt" , shipped: true, needs: "production:view" },
      // Pointed at /styles, which is the design screen and identical whichever
      // side you are on. It promised performance and delivered master data.
      { key: "collectionPerformance", href: "/collections", phase: 5, scopes: ALL_SCOPES, icon: "trending", shipped: true, needs: "production:view" },
      { key: "transferPrice", href: "/costing", phase: 2, scopes: ["FACTORY", "GROUP"], icon: "calculator" , shipped: true, needs: "transfer_price:view" },
      // The second engine. The factory prices its cost and stops; the brand
      // starts from the transfer price and still has a shop to pay for.
      { key: "brandPricing", href: "/pricing", phase: 5, scopes: ["BRAND", "GROUP"], icon: "tag", shipped: true, needs: "retail_price:manage" },
      { key: "productionOrder", href: "/production", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "factory" , shipped: true, needs: "production:view" },
      { key: "transferToBrand", href: "/transfers", phase: 4, scopes: ["FACTORY", "GROUP"], icon: "truck", shipped: true, needs: "inventory:view" },
      { key: "lineEfficiency", href: "/production/lines", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "activity" , shipped: true, needs: "production:view" },
      { key: "operatorProductivity", href: "/production/operators", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "users", shipped: true, needs: "production:view" },
      { key: "cuttingTicket", href: "/production/cutting", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "scissors", shipped: true, needs: "production:view" },
      { key: "quality", href: "/production/quality", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "check", shipped: true, needs: "production:view" },
      { key: "scrap", href: "/production/scrap", phase: 3, scopes: ["FACTORY", "GROUP"], icon: "scissors" , shipped: true, needs: "production:view" },
    ],
  },
  {
    key: "inventory",
    items: [
      { key: "goodsIn", href: "/goods-in", phase: 4, scopes: ["BRAND", "GROUP"], icon: "truck", shipped: true, needs: "inventory:view" },
      { key: "inventory", href: "/inventory", phase: 4, scopes: ALL_SCOPES, icon: "boxes" , shipped: true, needs: "inventory:view" },
      { key: "deadStock", href: "/inventory/dead-stock", phase: 4, scopes: ALL_SCOPES, icon: "alert", shipped: true, needs: "inventory:view" },
      { key: "pos", href: "/pos", phase: 6, scopes: ["BRAND", "GROUP"], icon: "cart", shipped: true, needs: ["pos:operate", "pos:close_shift"] },
      { key: "exhibitions", href: "/exhibitions", phase: 6, scopes: ["BRAND", "GROUP"], icon: "tag", shipped: true, needs: "inventory:view" },
      { key: "sales", href: "/sales", phase: 4, scopes: ["BRAND", "GROUP"], icon: "cart" , shipped: true, needs: "sales_order:view" },
      // The courier has no API: sheets out in its template, its report back in.
      { key: "shipping", href: "/shipping", phase: 6, scopes: ["BRAND", "GROUP"], icon: "truck", shipped: true, needs: "sales_order:view" },
      { key: "customers", href: "/customers", phase: 7, scopes: ["BRAND", "GROUP"], icon: "users", shipped: true, needs: "customer:view" },
      { key: "consignment", href: "/consignment", phase: 6, scopes: ["BRAND", "GROUP"], icon: "layers", shipped: true, needs: "inventory:view" },
      { key: "returns", href: "/returns", phase: 6, scopes: ["BRAND", "GROUP"], icon: "refresh", shipped: true, needs: "sales_order:view" },
      { key: "customOrders", href: "/custom-orders", phase: 7, scopes: ["BRAND", "GROUP"], icon: "scissors", shipped: true, needs: "sales_order:view" },
      { key: "customerCredit", href: "/receivables", phase: 7, scopes: ["BRAND", "GROUP"], icon: "wallet", shipped: true, needs: "sales_order:view" },
      { key: "marketing", href: "/marketing", phase: 10, scopes: ["BRAND", "GROUP"], icon: "sparkles", shipped: true, needs: "campaign:view" },
      { key: "recovery", href: "/recovery", phase: 10, scopes: ["BRAND", "GROUP"], icon: "cart", shipped: true, needs: "campaign:view" },
      { key: "people", href: "/hr", phase: 8, scopes: ALL_SCOPES, icon: "users", shipped: true, needs: "employee:view" },
      { key: "attendance", href: "/hr/attendance", phase: 8, scopes: ALL_SCOPES, icon: "clock", shipped: true, needs: "attendance:view" },
      { key: "sellThrough", href: "/sales/sell-through", phase: 5, scopes: ["BRAND", "GROUP"], icon: "trending", shipped: true, needs: "sales_order:view" },
      { key: "markdown", href: "/sales/markdown", phase: 5, scopes: ["BRAND", "GROUP"], icon: "tag", shipped: true, needs: "sales_order:view" },
    ],
  },
  {
    key: "groupPnl",
    items: [
      // The way in. Every report in the system is reachable from here,
      // arranged by the question rather than by which screen owns it.
      { key: "reports", href: "/reports", phase: 5, scopes: ALL_SCOPES, icon: "chart", shipped: true, needs: ["report:factory", "report:brand", "report:group"] },
      { key: "factoryPnl", href: "/reports/entity-pnl?entity=FACTORY", phase: 5, scopes: ["FACTORY", "GROUP"], icon: "chart", shipped: true, needs: "report:factory" },
      { key: "brandPnl", href: "/reports/entity-pnl?entity=BRAND", phase: 5, scopes: ["BRAND", "GROUP"], icon: "chart", shipped: true, needs: "report:brand" },
      { key: "groupPnl", href: "/reports/group-pnl", phase: 5, scopes: ["GROUP"], icon: "chart" , shipped: true, needs: "report:group" },
      { key: "breakEven", href: "/reports/break-even", phase: 5, scopes: ["BRAND", "GROUP"], icon: "target", shipped: true, needs: "journal:view" },
      { key: "cashCycle", href: "/reports/cash-cycle", phase: 5, scopes: ALL_SCOPES, icon: "refresh", shipped: true, needs: "journal:view" },
      { key: "gmroi", href: "/reports/gmroi", phase: 5, scopes: ["BRAND", "GROUP"], icon: "percent", shipped: true, needs: "inventory:view" },
    ],
  },
  {
    key: "cmt",
    items: [
      { key: "cmtClients", href: "/cmt/clients", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "users" , shipped: true, needs: "cmt_quote:view" },
      { key: "cmtQuote", href: "/cmt/quotes", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "file" , shipped: true, needs: "cmt_quote:view" },
      { key: "cmtOrders", href: "/cmt/orders", phase: 6, scopes: ["FACTORY", "GROUP"], icon: "factory", shipped: true, needs: "cmt_quote:view" },
    ],
  },
  {
    key: "scenarioSimulator",
    items: [
      { key: "whatIf", href: "/scenarios", phase: 3, scopes: ALL_SCOPES, icon: "sparkles", shipped: true, needs: "scenario:run" },
      { key: "integrations", href: "/integrations", phase: 9, scopes: ALL_SCOPES, icon: "refresh", shipped: true, needs: "settings:manage" },
      { key: "users", href: "/users", phase: 1, scopes: ALL_SCOPES, icon: "users", shipped: true, needs: "user:manage" },
      { key: "settings", href: "/settings", phase: 1, scopes: ALL_SCOPES, icon: "settings" , shipped: true, needs: "settings:manage" },
    ],
  },
];

/** Everything not marked shipped renders disabled, labelled with its phase. */
export function isShipped(item: NavItem): boolean {
  return item.shipped === true;
}

/**
 * Whether this role is shown the link at all.
 *
 * A menu full of doors that shut in your face is not a security measure, it is
 * a daily lie about what the system is for. The cashier's sidebar should be
 * the cashier's job, not the whole company with most of it unreachable.
 */
export function isPermitted(item: NavItem, role: Role): boolean {
  if (!item.needs) return true;
  const needed = typeof item.needs === "string" ? [item.needs] : item.needs;
  return needed.some((permission) => can(role, permission));
}

/** The sections a role actually sees, empty ones dropped. */
export function navigationFor(role: Role, scope: EntityScope): NavSection[] {
  return navigation
    .map((section) => ({
      ...section,
      items: section.items.filter((i) => i.scopes.includes(scope) && isPermitted(i, role)),
    }))
    .filter((section) => section.items.length > 0);
}
