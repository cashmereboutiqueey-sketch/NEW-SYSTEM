import { beforeEach, describe, expect, it, vi } from "vitest";
import { ROLES, can } from "@/core/permissions";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));
vi.mock("./session", () => ({ getSession: mocks.getSession }));
vi.mock("./db", () => ({ db: {} }));
vi.mock("next/navigation", () => ({ redirect: (url: string) => { throw new Error(`REDIRECT:${url}`); } }));

import { authorize, ForbiddenError, requireAnyPermission, requirePermission } from "./auth";

beforeEach(() => mocks.getSession.mockReset());

describe("server authorization (direct requests, without navigation)", () => {
  it("blocks anonymous actions and pages", async () => {
    mocks.getSession.mockResolvedValue(null);
    await expect(authorize("user:manage")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requirePermission("journal:view")).rejects.toThrow("REDIRECT:/login");
  });

  it.each(ROLES)("checks %s against the current session role", async (role) => {
    mocks.getSession.mockResolvedValue({ userId: "test-user", role, mustChangePassword: false });
    for (const permission of ["journal:post", "payroll:approve", "salary:view", "user:manage", "inventory:adjust"] as const) {
      if (can(role, permission)) await expect(authorize(permission)).resolves.toMatchObject({ role });
      else await expect(authorize(permission)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("blocks even an owner with a temporary password", async () => {
    mocks.getSession.mockResolvedValue({ userId: "test-user", role: "OWNER", mustChangePassword: true });
    await expect(authorize("user:manage")).rejects.toBeInstanceOf(ForbiddenError);
    await expect(requireAnyPermission(["journal:view", "transfer_price:view"])).rejects.toThrow("REDIRECT:/change-password");
  });

  it("requires one financial permission, never just a valid sales login", async () => {
    mocks.getSession.mockResolvedValue({ userId: "test-user", role: "MODERATOR", mustChangePassword: false });
    await expect(requireAnyPermission(["journal:view", "transfer_price:view"])).rejects.toThrow("REDIRECT:/");
    mocks.getSession.mockResolvedValue({ userId: "test-user", role: "BRAND_MANAGER", mustChangePassword: false });
    await expect(requireAnyPermission(["journal:view", "transfer_price:view"])).resolves.toMatchObject({ role: "BRAND_MANAGER" });
    await expect(requireAnyPermission([])).rejects.toThrow("REDIRECT:/");
  });
});
