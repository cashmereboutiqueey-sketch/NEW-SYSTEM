/**
 * Capability-based permissions.
 *
 * A role names a job; this map decides what that job may do. Rank-based checks
 * ("accountant outranks production") are deliberately not used — they cannot
 * express that production sees work in progress but never payroll, or that a
 * moderator creates orders but never posts a journal.
 *
 * The map lives in code rather than the database on purpose: permissions are
 * policy, and policy changes should go through review and land in the commit
 * history, not be edited silently in a settings screen at 2am. Adding a role
 * touches this file and the `UserRole` enum; adding a capability touches only
 * this file.
 */

export const PERMISSIONS = [
  // --- accounting -------------------------------------------------------
  "journal:view",
  "journal:create",
  "journal:post",
  "journal:reverse",
  "period:close",
  "expense:view",
  "expense:create",
  "expense:approve",
  "payment:create",
  "payment:approve",
  "account:manage",

  // --- purchasing -------------------------------------------------------
  "purchase_order:view",
  "purchase_order:create",
  "purchase_order:approve",
  "goods_receipt:create",

  // --- inventory --------------------------------------------------------
  /// How much of something is where. A quantity, and nothing about money.
  "inventory:view",
  /// What that stock is worth: unit costs, the capital standing in it, the
  /// value of what has aged. Separate from `inventory:view` because a shop
  /// floor needs to know whether a size is on the rail and has no business
  /// knowing what the company paid for it. Named like `salary:view` and
  /// `transfer_price:view`, which is what it is: permission to see a figure.
  "stock_value:view",
  /// The factory's raw materials and their ledger. Separate again: finished
  /// goods are the shop's business and fabric is not.
  "material:view",
  "inventory:transfer",
  "inventory:adjust",
  "inventory:approve_adjustment",

  // --- production -------------------------------------------------------
  "production:view",
  "production:create",
  "production:record",
  "production:confirm_cost",

  // --- costing and pricing ---------------------------------------------
  "minute_rate:view",
  "minute_rate:calculate",
  "transfer_price:view",
  "transfer_price:override",
  "retail_price:manage",

  // --- commercial -------------------------------------------------------
  "sales_order:view",
  "sales_order:create",
  "sales_order:discount",
  /// Letting a customer walk out owing money. Separate from discounting: a
  /// cashier may be trusted to take the full price and not to decide who is
  /// good for a debt.
  "sales_order:credit",
  "sales_order:refund",
  "pos:operate",
  "pos:close_shift",
  "customer:view",
  "customer:export",

  // --- marketing --------------------------------------------------------
  "campaign:view",
  "campaign:manage",

  // --- people -----------------------------------------------------------
  "employee:view",
  "payroll:prepare",
  "payroll:approve",
  "salary:view",

  // --- attendance -------------------------------------------------------
  /// Who was on the floor, and when. Deliberately separate from salary: a
  /// line supervisor needs to know who is late and must never see what they
  /// are paid.
  "attendance:view",
  /// Loading a device file.
  "attendance:import",
  /// Working the exception queue: accepting days, linking unknown badges.
  "attendance:review",
  /// Changing what a day says, which always leaves the punches alone.
  "attendance:correct",
  /// Agreeing that hours beyond the shift are to be paid.
  "overtime:approve",
  /// Sealing a month so payroll has something that cannot move under it.
  "attendance:lock",

  // --- alerts and planning ----------------------------------------------
  "alert:view",
  "alert:acknowledge",
  "scenario:run",
  "cmt_quote:view",
  "cmt_quote:create",

  // --- system -----------------------------------------------------------
  "settings:manage",
  "user:manage",
  "audit:view",
  "report:factory",
  "report:brand",
  "report:group",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/// Must stay in step with the `UserRole` enum in the Prisma schema.
export const ROLES = [
  "OWNER",
  "ACCOUNTANT",
  "PRODUCTION",
  "VIEWER",
  "BRAND_MANAGER",
  "MODERATOR",
  "POS_CASHIER",
  "WAREHOUSE",
  "HR",
  "MARKETING",
  "FINANCE_APPROVER",
  "SERVICE_ACCOUNT",
] as const;

export type Role = (typeof ROLES)[number];

/**
 * Owner is the only role with a blanket grant. Every owner action still passes
 * through the same audit trail, and overrides are recorded as such.
 */
const ROLE_PERMISSIONS: Record<Role, readonly Permission[] | "ALL"> = {
  OWNER: "ALL",

  ACCOUNTANT: [
    "journal:view", "journal:create", "journal:post", "journal:reverse",
    "expense:view", "expense:create",
    "payment:create",
    "account:manage",
    "purchase_order:view",
    "inventory:view", "stock_value:view", "material:view",
    "production:view",
    "minute_rate:view", "minute_rate:calculate",
    "transfer_price:view",
    "sales_order:view",
    "customer:view",
    // Counts the drawer at the end of a shift. Deliberately without
    // `pos:operate`: the accountant closes tills and never sells on one, so
    // the person who took the money is never the person who counted it.
    "pos:close_shift",
    "employee:view", "payroll:prepare", "salary:view",
    "audit:view",
    "alert:view", "alert:acknowledge",
    "scenario:run",
    "cmt_quote:view",
    "report:factory", "report:brand", "report:group",
    // Deliberately excluded: expense:approve, payment:approve, payroll:approve
    // and period:close. Whoever prepares the books does not also get to
    // approve them, release the money or seal the period.
  ],

  FINANCE_APPROVER: [
    "journal:view",
    "expense:view", "expense:approve",
    "payment:approve",
    "purchase_order:view", "purchase_order:approve",
    "inventory:view", "stock_value:view", "material:view",
    // Not inventory:approve_adjustment. Writing stock off — a count that does
    // not match, a bazaar that came back short — is the owner's decision by
    // instruction, because it is the one approval whose cost never appears on
    // an invoice anybody else checks.
    "payroll:approve",
    // Seals the month the payroll will be built from, having not been the one
    // editing the days inside it.
    "attendance:view", "attendance:lock",
    "period:close",
    "audit:view",
    "report:factory", "report:brand", "report:group",
    // Cannot create the documents it approves.
  ],

  PRODUCTION: [
    "production:view", "production:create", "production:record",
    "inventory:view", "stock_value:view", "material:view", "inventory:transfer",
    "purchase_order:view", "purchase_order:create",
    "goods_receipt:create",
    "minute_rate:view",
    "alert:view", "alert:acknowledge",
    "cmt_quote:view", "cmt_quote:create",
    "report:factory",
    // Who turned up, and who is late. A supervisor plans the line around
    // that and cannot plan around what they cannot see.
    "attendance:view",
    // No payroll, no salary, no journal posting — and no attendance
    // correction: the person whose line benefits from the hours is not the
    // person who decides what the hours were.
  ],

  WAREHOUSE: [
    "inventory:view", "stock_value:view", "material:view", "inventory:transfer", "inventory:adjust",
    "goods_receipt:create",
    "purchase_order:view",
    "production:view",
    // Adjusts stock but cannot approve its own adjustment.
  ],

  BRAND_MANAGER: [
    "sales_order:view", "sales_order:create", "sales_order:discount",
    "sales_order:credit", "sales_order:refund",
    "customer:view",
    "campaign:view", "campaign:manage",
    "inventory:view", "stock_value:view", "material:view", "inventory:transfer",
    "retail_price:manage",
    "transfer_price:view",
    "pos:operate", "pos:close_shift",
    "alert:view", "alert:acknowledge",
    "scenario:run",
    "report:brand",
  ],

  MODERATOR: [
    "sales_order:view", "sales_order:create",
    "customer:view",
    // Quantities only, for the same reason as the till.
    "inventory:view",
    // Creates social orders only. No discounting, no refunds, no journals,
    // no stock adjustments.
  ],

  POS_CASHIER: [
    "pos:operate",
    // Enough to read back an order, a return, a delivery and what a customer
    // owes. Not enough to open the sales register, which is a report.
    "sales_order:view", "sales_order:create",
    // Quantities only, and only where the job needs them: counting in a
    // delivery from the factory. Not the stock register, not what any of it
    // is worth, and not the factory bill.
    "inventory:view",
    // Deliberately not `customer:view`. A customer is chosen by name while a
    // sale is being rung up, which `pos:operate` and `sales_order:create`
    // already allow; browsing the whole customer base is a different act and
    // a different screen.
    //
    // Discounting and taking part of the price were a supervisor's to grant,
    // and by instruction they are the cashier's: a shop where the only person
    // who may knock ten pounds off is upstairs is a shop that loses the sale.
    // What still holds the line is elsewhere — a debt must name a customer,
    // and it is refused above that customer's credit limit.
    "sales_order:discount", "sales_order:credit",
    // Refund stays out: taking money back is a different decision from
    // deciding what to charge.
  ],

  HR: [
    "employee:view", "payroll:prepare", "salary:view",
    // Runs attendance end to end: loads the device file, works the
    // exceptions, corrects days, agrees overtime and seals the month.
    "attendance:view", "attendance:import", "attendance:review",
    "attendance:correct", "overtime:approve",
    // Not attendance:lock. Whoever spent the month correcting days does not
    // also get to declare them final: sealing belongs with the party that
    // has to rely on the figures, which is the same party that approves the
    // payroll built from them.
    // Prepares payroll; approval belongs to finance.
  ],

  MARKETING: [
    "campaign:view", "campaign:manage",
    "sales_order:view",
    "customer:view",
    "report:brand",
  ],

  VIEWER: [
    "journal:view", "expense:view", "production:view",
    "inventory:view", "stock_value:view", "material:view",
    "sales_order:view", "customer:view", "minute_rate:view",
    "report:factory", "report:brand", "report:group",
  ],

  SERVICE_ACCOUNT: [
    // Shopify/biometric connectors: import data, nothing else.
    "sales_order:view", "sales_order:create",
    "customer:view",
    // A connector writes orders and reads stock levels. It has no eyes to
    // show a figure to, so it is given none.
    "inventory:view",
  ],
};

export function can(role: Role, permission: Permission): boolean {
  const grants = ROLE_PERMISSIONS[role];
  if (grants === "ALL") return true;
  return grants.includes(permission);
}

export function permissionsFor(role: Role): readonly Permission[] {
  const grants = ROLE_PERMISSIONS[role];
  return grants === "ALL" ? PERMISSIONS : grants;
}

/**
 * Segregation of duties: pairs of capabilities that must not be exercised by
 * the same person on the same document.
 *
 * This is a *runtime* rule, not a static one — a role may legitimately hold
 * both capabilities across different documents. `violatesSeparationOfDuties`
 * is what enforces it at the point of approval.
 */
export const SEGREGATED_DUTIES: ReadonlyArray<[Permission, Permission]> = [
  ["expense:create", "expense:approve"],
  ["payment:create", "payment:approve"],
  ["purchase_order:create", "purchase_order:approve"],
  ["inventory:adjust", "inventory:approve_adjustment"],
  ["payroll:prepare", "payroll:approve"],
  // Whoever changed a day is not the person who seals the month it is in.
  ["attendance:correct", "attendance:lock"],
  ["journal:create", "period:close"],
];

/**
 * True when the same user is about to approve something they created.
 *
 * Owner is not exempt: the owner may override, but the override must be an
 * explicit, audited act rather than an invisible bypass. Callers handle that
 * by recording a reason — see the `ctx.reason` on the audit writer.
 */
export function violatesSeparationOfDuties(input: {
  creatorUserId: string | null;
  approverUserId: string;
  createPermission: Permission;
  approvePermission: Permission;
}): boolean {
  const isSegregated = SEGREGATED_DUTIES.some(
    ([c, a]) => c === input.createPermission && a === input.approvePermission,
  );
  if (!isSegregated) return false;
  return input.creatorUserId !== null && input.creatorUserId === input.approverUserId;
}
