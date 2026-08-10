"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import {
  createUser,
  setUserRole,
  setUserActive,
  resetPassword,
  unlockUser,
  UserError,
} from "@/lib/users";

export type UserState = { error?: string; success?: string };

function toMessage(error: unknown): string {
  if (error instanceof UserError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  console.error("Unhandled user admin error:", error);
  return "Something went wrong. Nothing was saved.";
}

function refresh() {
  revalidatePath("/users");
}

export async function createUserAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  try {
    const session = await authorize("user:manage");

    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirmPassword") ?? "");
    if (password !== confirm) return { error: "التأكيد مش زي الباسورد." };

    const result = await createUser(
      {
        name: String(formData.get("name") ?? ""),
        email: String(formData.get("email") ?? ""),
        role: String(formData.get("role") ?? ""),
        password,
        locale: String(formData.get("locale") ?? "ar"),
      },
      { userId: session.userId, reason: null },
    );

    refresh();
    return {
      success: `اتعمل حساب ${result.email}. إداله الباسورد المؤقت — أول ما يدخل هيغيّره بنفسه.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setRoleAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  try {
    const session = await authorize("user:manage");
    await setUserRole(
      {
        userId: String(formData.get("userId") ?? ""),
        role: String(formData.get("role") ?? ""),
      },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "الدور اتغيّر." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setActiveAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  try {
    const session = await authorize("user:manage");
    const isActive = String(formData.get("isActive") ?? "") === "true";

    await setUserActive(
      { userId: String(formData.get("userId") ?? ""), isActive },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: isActive ? "الحساب اترجّع." : "الحساب اتقفل." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function resetPasswordAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  try {
    const session = await authorize("user:manage");

    const password = String(formData.get("password") ?? "");
    const confirm = String(formData.get("confirmPassword") ?? "");
    if (password !== confirm) return { error: "التأكيد مش زي الباسورد." };

    await resetPassword(
      { userId: String(formData.get("userId") ?? ""), password },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "اتغيّر. إداله الباسورد المؤقت وهو هيغيّره أول ما يدخل." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function unlockAction(
  _prev: UserState,
  formData: FormData,
): Promise<UserState> {
  try {
    const session = await authorize("user:manage");
    await unlockUser(
      { userId: String(formData.get("userId") ?? "") },
      { userId: session.userId, reason: null },
    );
    refresh();
    return { success: "الحساب اتفتح." };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
