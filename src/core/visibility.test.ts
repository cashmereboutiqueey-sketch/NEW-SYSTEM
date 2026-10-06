import { describe, expect, it } from "vitest";
import { canNavigate, canViewFinancials, canViewInventoryValue } from "./visibility";
import { ROLES, type Role } from "./permissions";
import { navigation } from "@/lib/navigation";

describe("role-aware navigation and financial read boundaries", () => {
  it("maps every shipped menu destination for the owner", () => {
    for (const item of navigation.flatMap((section) => section.items)) {
      if (item.shipped) expect(canNavigate("OWNER", item.href), item.href).toBe(true);
    }
  });

  it("fails closed for an unmapped destination", () => {
    expect(canNavigate("OWNER", "/future-sensitive-page")).toBe(false);
  });

  it.each<Role>(["MODERATOR", "POS_CASHIER", "SERVICE_ACCOUNT", "MARKETING"])(
    "%s can work with sales without seeing cost/margin reports", (role) => {
      expect(canNavigate(role, "/sales")).toBe(true);
      expect(canViewFinancials(role)).toBe(false);
      expect(canViewInventoryValue(role)).toBe(false);
      expect(canNavigate(role, "/materials/ledger")).toBe(false);
      for (const href of ["/reports/gmroi", "/sales/markdown", "/sales/sell-through", "/reports/entity-pnl?entity=BRAND"]) {
        expect(canNavigate(role, href), href).toBe(false);
      }
    },
  );

  it("keeps finance/account administration out of non-owner menus", () => {
    for (const role of ROLES.filter((role) => role !== "OWNER")) {
      expect(canNavigate(role, "/users"), role).toBe(false);
      expect(canNavigate(role, "/settings"), role).toBe(false);
    }
  });

  it("gives HR only the home, report index and people destinations", () => {
    const visible = navigation.flatMap((section) => section.items).filter((item) => canNavigate("HR", item.href));
    expect(visible.map((item) => item.href).sort()).toEqual(["/", "/hr", "/hr/attendance", "/reports"]);
  });

  it("keeps production and warehouse away from HR, salary and journals", () => {
    for (const role of ["PRODUCTION", "WAREHOUSE"] as const) {
      for (const href of ["/hr", "/journal", "/users"]) expect(canNavigate(role, href)).toBe(false);
      expect(canNavigate(role, "/production")).toBe(true);
    }
  });

  it("allows the accountant to close tills without giving marketing access", () => {
    expect(canNavigate("ACCOUNTANT", "/pos")).toBe(true);
    expect(canNavigate("ACCOUNTANT", "/marketing")).toBe(false);
    expect(canNavigate("POS_CASHIER", "/marketing/spend")).toBe(false);
  });
});
