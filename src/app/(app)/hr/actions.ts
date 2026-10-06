"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createEmployee, setEmploymentStatus, PeopleError } from "@/lib/people";
import type { FormState } from "@/components/entity-form";
import { z } from "zod";
import { preparePayrollRun, PayrollError } from "@/lib/payroll";
import { CommandError, formCommand } from "@/lib/command";

function toMessage(error: unknown): string {
  if (error instanceof PeopleError || error instanceof PayrollError || error instanceof CommandError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled employee error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function preparePayrollAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    const session = await authorize("payroll:prepare");
    const values = z.object({ entityId: z.string().min(1), fiscalPeriodId: z.string().min(1) })
      .parse(Object.fromEntries(formData));
    const result = await formCommand("hr.preparePayroll", formData, { userId: session.userId }, () =>
      preparePayrollRun(values, { userId: session.userId }),
    );
    revalidatePath("/hr");
    revalidatePath("/approvals");
    return { success: `${result.runNumber}: ${result.employees} employees. Draft ready for a different approver. / المسودة جاهزة لاعتماد شخص آخر.${result.warnings.length ? ` Review / راجع: ${result.warnings.join(" ")}` : ""}` };
  } catch (error) {
    return { error: toMessage(error) };
  }
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
        payFrequency: String(formData.get("payFrequency") ?? "MONTHLY") as
          "MONTHLY" | "WEEKLY" | "DAILY" | "PIECE_RATE",
        baseSalary: Number(formData.get("baseSalary") ?? 0),
        pieceRate: formData.get("pieceRate") ? Number(formData.get("pieceRate")) : null,
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
