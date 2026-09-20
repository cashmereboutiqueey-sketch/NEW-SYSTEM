"use server";

import { revalidatePath } from "next/cache";
import { authorize, ForbiddenError } from "@/lib/auth";
import { createCustomer, setCustomerCredit, MasterDataError } from "@/lib/master-data";
import { mergeCustomers, CrmError } from "@/lib/crm";
import { can } from "@/core/permissions";
import type { FormState } from "@/components/entity-form";

function toMessage(error: unknown): string {
  if (error instanceof MasterDataError || error instanceof CrmError) return error.message;
  if (error instanceof ForbiddenError) return "You do not have permission to do that.";
  if (error && typeof error === "object" && "issues" in error) {
    return (error as { issues: { message: string }[] }).issues
      .map((i) => i.message)
      .join(" ");
  }
  console.error("Unhandled customer error:", error);
  return "Something went wrong. Nothing was saved.";
}

export async function createCustomerAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Whoever can raise an order can add the customer it belongs to — a
    // cashier or moderator must not be blocked mid-sale.
    const session = await authorize("sales_order:create");

    const consentRaw = String(formData.get("marketingConsent") ?? "");
    const { customer, possibleDuplicate } = await createCustomer(
      {
        code: (formData.get("code") as string) || undefined,
        name: String(formData.get("name") ?? ""),
        phone: (formData.get("phone") as string) || null,
        email: (formData.get("email") as string) || null,
        city: (formData.get("city") as string) || null,
        acquiredVia: (formData.get("acquiredVia") as string) || null,
        // Silence is not consent, so an unticked box stays undecided rather
        // than becoming a no.
        marketingConsent: consentRaw === "on" ? true : null,
        notes: (formData.get("notes") as string) || null,
        // Only where the person adding them may give credit at all; a cashier
        // filling in a walk-in cannot set a limit for them.
        ...(can(session.role, "sales_order:credit")
          ? {
              creditLimit: Number(formData.get("creditLimit") ?? 0) || 0,
              creditDays: Number(formData.get("creditDays") ?? 0) || 0,
            }
          : {}),
      } as never,
      { userId: session.userId },
    );

    revalidatePath("/customers");

    return {
      success: possibleDuplicate
        ? `${customer.name} added as ${customer.code}. Note: ${possibleDuplicate.name} (${possibleDuplicate.code}) shares that phone — review the duplicates list if they are the same person.`
        : `${customer.name} added as ${customer.code}.`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function mergeCustomersAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Merging rewrites who owns an order history, so it needs the elevated
    // customer-export capability rather than everyday order entry.
    const session = await authorize("customer:export");

    const result = await mergeCustomers(
      {
        keepId: String(formData.get("keepId") ?? ""),
        mergeId: String(formData.get("mergeId") ?? ""),
        reason: String(formData.get("reason") ?? ""),
      },
      { userId: session.userId },
    );

    revalidatePath("/customers");
    return { success: `Merged. ${result.ordersMoved} order(s) moved to the surviving record.` };
  } catch (error) {
    return { error: toMessage(error) };
  }
}

export async function setCustomerCreditAction(
  _prev: FormState,
  formData: FormData,
): Promise<FormState> {
  try {
    // Granting credit is the right that governs it, not the right to edit a
    // customer's details.
    const session = await authorize("sales_order:credit");

    const customer = await setCustomerCredit(
      {
        customerId: String(formData.get("customerId") ?? ""),
        creditLimit: String(formData.get("creditLimit") ?? "0"),
        creditDays: String(formData.get("creditDays") ?? "0"),
      },
      { userId: session.userId },
    );

    revalidatePath("/customers");
    revalidatePath("/pos");
    revalidatePath("/receivables");

    return {
      success:
        `${customer.name} may now owe up to ${Number(customer.creditLimit).toFixed(2)}, ` +
        `due in ${customer.creditDays} day(s).`,
    };
  } catch (error) {
    return { error: toMessage(error) };
  }
}
