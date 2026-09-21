import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { navigation, navigationFor, isShipped, type NavItem } from "./navigation";
import { ROLES, can, type Permission, type Role } from "@/core/permissions";

/**
 * The menu against the pages it links to.
 *
 * A sidebar is a claim about what somebody may do, and the page is where that
 * claim is actually enforced. When the two drift apart the menu starts lying
 * in one of two directions: offering a door that shuts in your face, or —
 * after somebody loosens a page guard — quietly hiding a screen the role is
 * now entitled to. Neither is visible by looking at either file alone, so the
 * check reads both.
 */

const items = navigation.flatMap((s) => s.items);

/** The file that answers a link, ignoring anything after the `?`. */
function pageFor(item: NavItem): string | null {
  const route = item.href.split("?")[0];
  const file = `src/app/(app)${route === "/" ? "" : route}/page.tsx`;
  return existsSync(file) ? file : null;
}

/** The single capability a page demands, where it demands exactly one. */
function guardOf(file: string): Permission | null {
  const source = readFileSync(file, "utf8");
  const match = /requirePermission\(\s*"([a-z_:]+)"/.exec(source);
  return match ? (match[1] as Permission) : null;
}

describe("the menu and the pages it links to", () => {
  it("links to a page that exists", () => {
    const missing = items.filter(isShipped).filter((i) => pageFor(i) === null);
    expect(missing.map((i) => i.href)).toEqual([]);
  });

  it("asks for exactly what the page behind it asks for", () => {
    const drifted: string[] = [];
    for (const item of items.filter(isShipped)) {
      const file = pageFor(item);
      if (!file) continue;
      const guard = guardOf(file);
      if (!guard) continue; // A page serving several jobs; covered below.
      if (item.needs !== guard) drifted.push(`${item.href}: menu ${String(item.needs)}, page ${guard}`);
    }
    expect(drifted).toEqual([]);
  });

  it("names what it needs, unless the screen is genuinely for everybody", () => {
    const silent = items.filter(isShipped).filter((i) => !i.needs);
    // The landing page adapts to the role instead of refusing it, which is
    // why it cannot be guarded with a capability and why it is the only one.
    expect(silent.map((i) => i.href)).toEqual(["/"]);
  });

  it("offers a several-job screen to whoever holds any one of its jobs", () => {
    const approvals = items.find((i) => i.href === "/approvals")!;
    expect(can("FINANCE_APPROVER", "expense:approve")).toBe(true);
    expect(visible("FINANCE_APPROVER")).toContain(approvals.href);
    // Prepares the payroll, approves nothing.
    expect(visible("ACCOUNTANT")).not.toContain(approvals.href);

    const pos = items.find((i) => i.href === "/pos")!;
    // Sells on the till.
    expect(visible("POS_CASHIER")).toContain(pos.href);
    // Never sells, but counts the drawer at the end of the shift.
    expect(visible("ACCOUNTANT")).toContain(pos.href);
    expect(visible("PRODUCTION")).not.toContain(pos.href);
  });
});

/** Every href a role is shown, across every entity lens. */
function visible(role: Role): string[] {
  return [...new Set(
    (["FACTORY", "BRAND", "GROUP"] as const).flatMap((scope) =>
      navigationFor(role, scope).flatMap((s) => s.items.map((i) => i.href)),
    ),
  )];
}

describe("what each role is shown", () => {
  it("shows nobody a door they cannot open", () => {
    for (const role of ROLES) {
      for (const scope of ["FACTORY", "BRAND", "GROUP"] as const) {
        for (const section of navigationFor(role, scope)) {
          for (const item of section.items) {
            if (!item.needs) continue;
            const needed = typeof item.needs === "string" ? [item.needs] : item.needs;
            expect(
              needed.some((p) => can(role, p)),
              `${role} is shown ${item.href} and holds none of ${needed.join(", ")}`,
            ).toBe(true);
          }
        }
      }
    }
  });

  it("leaves no role staring at an empty menu", () => {
    for (const role of ROLES) {
      expect(visible(role).length, `${role} sees nothing`).toBeGreaterThan(0);
    }
  });

  it("drops a section entirely rather than showing an empty heading", () => {
    for (const role of ROLES) {
      for (const scope of ["FACTORY", "BRAND", "GROUP"] as const) {
        for (const section of navigationFor(role, scope)) {
          expect(section.items.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it("keeps the till operator out of the books", () => {
    const seen = visible("POS_CASHIER");
    for (const href of ["/journal", "/audit", "/hr", "/hr/attendance", "/expenses", "/users", "/settings"]) {
      expect(seen, `a cashier should not be offered ${href}`).not.toContain(href);
    }
    expect(seen).toContain("/pos");
    expect(seen).toContain("/inventory");
  });

  it("shows a line supervisor who is on the floor and nothing about pay", () => {
    const seen = visible("PRODUCTION");
    expect(seen).toContain("/hr/attendance");
    // `/hr` is the payroll screen and wants employee:view, which production
    // does not hold: a supervisor plans around who turned up and never sees
    // what anybody earns.
    expect(seen).not.toContain("/hr");
    expect(seen).toContain("/production");
  });

  it("shows the owner everything that has shipped", () => {
    const seen = visible("OWNER");
    const shipped = [...new Set(items.filter(isShipped).map((i) => i.href))];
    expect(seen.length).toBe(shipped.length);
  });

  it("shows a viewer no way to change anything", () => {
    const seen = visible("VIEWER");
    for (const href of ["/pos", "/approvals", "/users", "/settings", "/integrations", "/pricing"]) {
      expect(seen, `a viewer should not be offered ${href}`).not.toContain(href);
    }
  });
});
