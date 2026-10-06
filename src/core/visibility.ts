import { can, type Permission, type Role } from "./permissions";

/** Read access to product costs and commercial margins, not salary details. */
export const FINANCIAL_READ_PERMISSIONS = ["journal:view", "transfer_price:view"] as const;

export function canViewFinancials(role: Role): boolean {
  return FINANCIAL_READ_PERMISSIONS.some((permission) => can(role, permission));
}

export const INVENTORY_VALUE_PERMISSIONS = [...FINANCIAL_READ_PERMISSIONS, "goods_receipt:create"] as const;
export function canViewInventoryValue(role: Role): boolean {
  return INVENTORY_VALUE_PERMISSIONS.some((permission) => can(role, permission));
}

const ROUTE_PERMISSIONS: Record<string, readonly Permission[]> = {
  "/alerts": ["alert:view"],
  "/approvals": ["expense:approve", "purchase_order:approve", "payroll:approve", "inventory:approve_adjustment"],
  "/expenses": ["expense:view"], "/expenses/aging": ["expense:view"],
  "/cash-flow": ["journal:view"], "/reconciliation": ["journal:view"],
  "/journal": ["journal:view"], "/accounts": ["journal:view"], "/tax": ["journal:view"],
  "/opening-balances": ["journal:create"],
  "/audit": ["audit:view"],
  "/capacity": ["minute_rate:view"], "/capacity/planning": ["minute_rate:view"],
  "/minute-rate": ["minute_rate:view"], "/mrp": ["production:view"],
  "/materials": ["inventory:view"], "/materials/ledger": ["inventory:view"],
  "/suppliers": ["purchase_order:view"], "/suppliers/scorecard": ["purchase_order:view"],
  "/suppliers/statements": ["expense:view"], "/purchasing": ["purchase_order:view"],
  "/styles": ["production:view"], "/collections": ["production:view"],
  "/costing": ["transfer_price:view"], "/pricing": ["retail_price:manage"],
  "/production": ["production:view"], "/production/lines": ["production:view"],
  "/production/operators": ["production:view"], "/production/cutting": ["production:view"],
  "/production/quality": ["production:view"], "/production/scrap": ["production:view"],
  "/transfers": ["inventory:view"], "/goods-in": ["inventory:view"],
  "/inventory": ["inventory:view"], "/inventory/dead-stock": ["inventory:view"],
  "/pos": ["pos:operate", "pos:close_shift"], "/exhibitions": ["inventory:view"],
  "/sales": ["sales_order:view"], "/shipping": ["sales_order:view"],
  "/my-orders": ["sales_order:create"], "/moderator": ["sales_order:view"],
  "/commissions": ["journal:view"],
  "/customers": ["customer:view"], "/consignment": ["inventory:view"],
  "/returns": ["sales_order:view"], "/custom-orders": ["sales_order:view"],
  "/receivables": ["sales_order:view"], "/recovery": ["campaign:view"],
  "/marketing": ["campaign:view"], "/marketing/spend": ["campaign:view"],
  "/hr": ["employee:view"], "/hr/attendance": ["attendance:view"],
  "/sales/sell-through": ["sales_order:view"], "/sales/markdown": ["sales_order:view"],
  "/reports/entity-pnl?entity=FACTORY": ["report:factory"],
  "/reports/entity-pnl?entity=BRAND": ["report:brand"],
  "/reports/group-pnl": ["report:group"],
  "/reports/break-even": ["journal:view"], "/reports/cash-cycle": ["journal:view"],
  "/reports/gmroi": ["inventory:view"],
  "/cmt/clients": ["cmt_quote:view"], "/cmt/quotes": ["cmt_quote:view"],
  "/cmt/orders": ["cmt_quote:view"], "/scenarios": ["scenario:run"],
  "/integrations": ["settings:manage"], "/settings": ["settings:manage"],
  "/users": ["user:manage"],
};

const FINANCIAL_ROUTES = new Set([
  "/reports/entity-pnl?entity=BRAND", "/reports/gmroi",
  "/sales/markdown", "/sales/sell-through",
]);

/** Navigation mirrors server guards. Unknown destinations fail closed. */
export function canNavigate(role: Role, href: string): boolean {
  if (["/materials", "/materials/ledger", "/inventory/dead-stock"].includes(href) && !canViewInventoryValue(role)) return false;
  if (href === "/" || href === "/reports") return true;
  if (FINANCIAL_ROUTES.has(href) && !canViewFinancials(role)) return false;
  return ROUTE_PERMISSIONS[href]?.some((permission) => can(role, permission)) ?? false;
}
