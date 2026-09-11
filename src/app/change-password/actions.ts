"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { changeOwnPassword, UserError } from "@/lib/users";
import { createSession } from "@/lib/session";

export type ChangePasswordState = { error?: string };

export async function changePasswordAction(
  _prev: ChangePasswordState,
  formData: FormData,
): Promise<ChangePasswordState> {
  const user = await requireUser();

  const current = String(formData.get("currentPassword") ?? "");
  const next = String(formData.get("newPassword") ?? "");
  const confirm = String(formData.get("confirmPassword") ?? "");

  // Caught here rather than in the service: mistyping the confirmation is a
  // typing mistake, not a rule about passwords.
  if (next !== confirm) {
    return { error: "التأكيد مش زي الباسورد الجديد." };
  }

  let sessionVersion: number;
  try {
    ({ sessionVersion } = await changeOwnPassword(
      { userId: user.userId, currentPassword: current, newPassword: next },
      { userId: user.userId, reason: null },
    ));
  } catch (error) {
    if (error instanceof UserError) return { error: error.message };
    console.error("Unhandled password change error:", error);
    return { error: "حصل خطأ. الباسورد ماتغيّرش." };
  }

  // The change signed out every session on the account, this one included.
  // The person who just proved the old password stays in; nobody else does.
  // Outside the try, because by now the password has changed and the message
  // above would be a lie.
  await createSession({ userId: user.userId, sessionVersion });

  // Also outside the try: redirect works by throwing, and catching it there
  // would report a successful change as a failure.
  redirect("/");
}
