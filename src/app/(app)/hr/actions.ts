"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createEmployee, setEmploymentStatus, PeopleError } from "@/lib/people";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof PeopleError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled employee error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createEmployeeAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Adding staff sets pay, so it sits behind the payroll capability rather
    // than general employee viewing.
    const session = await authorize("payroll:prepare");

    const employee = await createEmployee(
      {
        code: String(formData.get("code") ?? ""),
        name: String(formData.get("name") ?? ""),
        entityId: String(formData.get("entityId") ?? ""),
        costCenterId: (formData.get("costCenterId") as string) || null,
        department: (formData.get("department") as string) || null,
        jobTitle: (formData.get("jobTitle") as string) || null,
        hiredAt: String(formData.get("hiredAt") ?? ""),
        baseSalary: Number(formData.get("baseSalary") ?? 0),
        phone: (formData.get("phone") as string) || null,
        biometricDeviceUserId: (formData.get("biometricDeviceUserId") as string) || null,
        productionLineId: (formData.get("productionLineId") as string) || null,
      },
      { userId: session.userId },
    );

    revalidatePath("/hr");
    return { success: `${employee.name} added as ${employee.code}.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setEmploymentStatusAction(formData: FormData): Promise<void> {
  const session = await authorize("payroll:prepare");
  await setEmploymentStatus(
    {
      employeeId: String(formData.get("employeeId") ?? ""),
      status: String(formData.get("status") ?? "ACTIVE") as never,
    },
    { userId: session.userId },
  );
  revalidatePath("/hr");
}
