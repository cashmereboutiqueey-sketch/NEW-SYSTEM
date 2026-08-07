import { describe, it, expect } from "vitest";
import {
  can,
  permissionsFor,
  violatesSeparationOfDuties,
  SEGREGATED_DUTIES,
  PERMISSIONS,
  type Role,
} from "./permissions";

const ALL_ROLES: Role[] = [
  "OWNER", "ACCOUNTANT", "PRODUCTION", "VIEWER", "BRAND_MANAGER", "MODERATOR",
  "POS_CASHIER", "WAREHOUSE", "HR", "MARKETING", "FINANCE_APPROVER", "SERVICE_ACCOUNT",
];

describe("capabilities", () => {
  it("gives the owner everything", () => {
    expect(permissionsFor("OWNER")).toHaveLength(PERMISSIONS.length);
    expect(can("OWNER", "period:close")).toBe(true);
  });

  it("grants no role an unknown capability", () => {
    for (const role of ALL_ROLES) {
      for (const p of permissionsFor(role)) {
        expect(PERMISSIONS).toContain(p);
      }
    }
  });

  it("keeps payroll and salary away from production and warehouse", () => {
    for (const role of ["PRODUCTION", "WAREHOUSE"] as Role[]) {
      expect(can(role, "salary:view")).toBe(false);
      expect(can(role, "payroll:prepare")).toBe(false);
      expect(can(role, "payroll:approve")).toBe(false);
    }
  });

  it("stops a moderator posting journals, discounting or adjusting stock", () => {
    // The spec calls this out by name: moderators create social orders only.
    expect(can("MODERATOR", "sales_order:create")).toBe(true);
    expect(can("MODERATOR", "journal:post")).toBe(false);
    expect(can("MODERATOR", "sales_order:discount")).toBe(false);
    expect(can("MODERATOR", "sales_order:refund")).toBe(false);
    expect(can("MODERATOR", "inventory:adjust")).toBe(false);
    expect(can("MODERATOR", "transfer_price:override")).toBe(false);
  });

  it("stops a POS cashier discounting or refunding without a supervisor", () => {
    expect(can("POS_CASHIER", "pos:operate")).toBe(true);
    expect(can("POS_CASHIER", "sales_order:discount")).toBe(false);
    expect(can("POS_CASHIER", "sales_order:refund")).toBe(false);
    expect(can("POS_CASHIER", "pos:close_shift")).toBe(false);
  });

  it("keeps the service account out of human-user functions", () => {
    expect(can("SERVICE_ACCOUNT", "sales_order:create")).toBe(true);
    expect(can("SERVICE_ACCOUNT", "journal:post")).toBe(false);
    expect(can("SERVICE_ACCOUNT", "user:manage")).toBe(false);
    expect(can("SERVICE_ACCOUNT", "settings:manage")).toBe(false);
    expect(can("SERVICE_ACCOUNT", "salary:view")).toBe(false);
  });

  it("makes the viewer read-only", () => {
    const writeish = permissionsFor("VIEWER").filter(
      (p) => !p.endsWith(":view") && !p.startsWith("report:"),
    );
    expect(writeish).toEqual([]);
  });

  it("lets only the owner override a transfer price", () => {
    const allowed = ALL_ROLES.filter((r) => can(r, "transfer_price:override"));
    expect(allowed).toEqual(["OWNER"]);
  });

  it("restricts customer export, which is personal data leaving the system", () => {
    const allowed = ALL_ROLES.filter((r) => can(r, "customer:export"));
    expect(allowed).toEqual(["OWNER"]);
  });
});

describe("segregation of duties", () => {
  it("never grants both halves of a segregated pair to one non-owner role", () => {
    const conflicts: string[] = [];
    for (const role of ALL_ROLES) {
      if (role === "OWNER") continue; // owner may override, but it is audited
      for (const [create, approve] of SEGREGATED_DUTIES) {
        if (can(role, create) && can(role, approve)) {
          conflicts.push(`${role} holds both ${create} and ${approve}`);
        }
      }
    }
    expect(conflicts).toEqual([]);
  });

  it("separates preparing the books from sealing them", () => {
    expect(can("ACCOUNTANT", "journal:create")).toBe(true);
    expect(can("ACCOUNTANT", "period:close")).toBe(false);
    expect(can("FINANCE_APPROVER", "period:close")).toBe(true);
    expect(can("FINANCE_APPROVER", "journal:create")).toBe(false);
  });

  it("separates preparing payroll from approving it", () => {
    expect(can("HR", "payroll:prepare")).toBe(true);
    expect(can("HR", "payroll:approve")).toBe(false);
    expect(can("FINANCE_APPROVER", "payroll:approve")).toBe(true);
    expect(can("FINANCE_APPROVER", "payroll:prepare")).toBe(false);
  });

  it("separates adjusting stock from approving the adjustment", () => {
    expect(can("WAREHOUSE", "inventory:adjust")).toBe(true);
    expect(can("WAREHOUSE", "inventory:approve_adjustment")).toBe(false);
  });

  it("blocks a user approving their own document", () => {
    expect(
      violatesSeparationOfDuties({
        creatorUserId: "user-1",
        approverUserId: "user-1",
        createPermission: "expense:create",
        approvePermission: "expense:approve",
      }),
    ).toBe(true);
  });

  it("allows a different user to approve", () => {
    expect(
      violatesSeparationOfDuties({
        creatorUserId: "user-1",
        approverUserId: "user-2",
        createPermission: "expense:create",
        approvePermission: "expense:approve",
      }),
    ).toBe(false);
  });

  it("ignores pairs that are not segregated", () => {
    expect(
      violatesSeparationOfDuties({
        creatorUserId: "user-1",
        approverUserId: "user-1",
        createPermission: "sales_order:create",
        approvePermission: "sales_order:refund",
      }),
    ).toBe(false);
  });

  it("does not trip on a system-created document with no author", () => {
    // An imported Shopify order has no human creator; that must not block
    // whoever reviews it.
    expect(
      violatesSeparationOfDuties({
        creatorUserId: null,
        approverUserId: "user-1",
        createPermission: "expense:create",
        approvePermission: "expense:approve",
      }),
    ).toBe(false);
  });
});
