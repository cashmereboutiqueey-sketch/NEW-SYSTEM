import "server-only";
import { z } from "zod";
import { db } from "./db";
import { writeAudit, type AuditContext } from "./audit";
import { dec } from "./money";

/**
 * Employee records.
 *
 * The cost centre is the load-bearing field: it decides which account a
 * person's wage is charged to, and because the minute rate reads those
 * accounts, putting a showroom assistant on the factory cost centre would
 * quietly inflate the cost of every garment.
 */

export class PeopleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeopleError";
  }
}

export const employeeSchema = z.object({
  code: z
    .string()
    .min(2, "A code needs at least two characters.")
    .transform((s) => s.trim().toUpperCase().replace(/\s+/g, "-")),
  name: z.string().min(1, "A name is required."),
  entityId: z.string().min(1, "Choose which entity employs them."),
  costCenterId: z.string().min(1).nullable().optional(),
  department: z.string().nullable().optional(),
  jobTitle: z.string().nullable().optional(),
  hiredAt: z.coerce.date(),
  payFrequency: z.enum(["MONTHLY", "WEEKLY", "DAILY", "PIECE_RATE"]).default("MONTHLY"),
  baseSalary: z.coerce.number().min(0),
  phone: z.string().nullable().optional(),
  nationalId: z.string().nullable().optional(),
  biometricDeviceUserId: z.string().nullable().optional(),
  /** Sewing operators are also production operators, on a line. */
  productionLineId: z.string().min(1).nullable().optional(),
});

export type EmployeeInput = z.input<typeof employeeSchema>;

export async function createEmployee(input: EmployeeInput, ctx: AuditContext) {
  const data = employeeSchema.parse(input);

  const clash = await db.employee.findUnique({ where: { code: data.code } });
  if (clash) throw new PeopleError(`Employee code ${data.code} is already in use.`);

  if (data.biometricDeviceUserId) {
    // Two people on one badge means one of them is paid for the other's
    // attendance, so the badge is treated as unique.
    const badgeTaken = await db.employee.findFirst({
      where: { biometricDeviceUserId: data.biometricDeviceUserId },
    });
    if (badgeTaken) {
      throw new PeopleError(
        `Badge ${data.biometricDeviceUserId} is already assigned to ${badgeTaken.name}.`,
      );
    }
  }

  return db.$transaction(async (tx) => {
    const employee = await tx.employee.create({
      data: {
        code: data.code,
        name: data.name,
        entityId: data.entityId,
        costCenterId: data.costCenterId ?? null,
        department: data.department ?? null,
        jobTitle: data.jobTitle ?? null,
        hiredAt: data.hiredAt,
        payFrequency: data.payFrequency,
        baseSalary: dec(data.baseSalary).toString(),
        phone: data.phone ?? null,
        nationalId: data.nationalId ?? null,
        biometricDeviceUserId: data.biometricDeviceUserId ?? null,
      },
    });

    // The opening salary is written to history straight away, so a payroll run
    // from last month can still be explained after a rise.
    await tx.salaryHistory.create({
      data: {
        employeeId: employee.id,
        baseSalary: employee.baseSalary,
        effectiveFrom: data.hiredAt,
        reason: "Opening salary",
      },
    });

    if (data.productionLineId) {
      await tx.operator.create({
        data: {
          code: data.code,
          name: data.name,
          lineId: data.productionLineId,
          hiredAt: data.hiredAt,
          employeeId: employee.id,
        },
      });
    }

    await writeAudit(tx, {
      action: "EMPLOYEE_CREATED",
      entityName: "Employee",
      entityId: employee.id,
      after: {
        code: employee.code,
        name: employee.name,
        costCentre: data.costCenterId ?? null,
        onALine: Boolean(data.productionLineId),
      },
      ctx,
    });

    return employee;
  });
}

/**
 * Changes pay, recording the new figure as history rather than an edit.
 *
 * Payroll runs already posted keep the salary they were calculated on.
 */
export async function changeSalary(
  input: { employeeId: string; baseSalary: number; effectiveFrom: Date; reason: string },
  ctx: AuditContext,
) {
  if (!input.reason.trim()) {
    throw new PeopleError("A pay change needs a reason; it becomes part of the record.");
  }

  return db.$transaction(async (tx) => {
    const before = await tx.employee.findUnique({ where: { id: input.employeeId } });
    if (!before) throw new PeopleError("Employee not found.");

    await tx.salaryHistory.create({
      data: {
        employeeId: input.employeeId,
        baseSalary: dec(input.baseSalary).toString(),
        effectiveFrom: input.effectiveFrom,
        reason: input.reason,
      },
    });

    const after = await tx.employee.update({
      where: { id: input.employeeId },
      data: { baseSalary: dec(input.baseSalary).toString() },
    });

    await writeAudit(tx, {
      action: "SALARY_CHANGED",
      entityName: "Employee",
      entityId: after.id,
      before: { baseSalary: before.baseSalary.toString() },
      after: { baseSalary: after.baseSalary.toString() },
      ctx: { ...ctx, reason: input.reason },
    });

    return after;
  });
}

export async function setEmploymentStatus(
  input: { employeeId: string; status: "ACTIVE" | "ON_LEAVE" | "TERMINATED"; endedAt?: Date | null },
  ctx: AuditContext,
) {
  return db.$transaction(async (tx) => {
    const before = await tx.employee.findUnique({ where: { id: input.employeeId } });
    if (!before) throw new PeopleError("Employee not found.");

    const after = await tx.employee.update({
      where: { id: input.employeeId },
      data: {
        status: input.status,
        endedAt: input.status === "TERMINATED" ? input.endedAt ?? new Date() : null,
      },
    });

    // A terminated operator stops consuming line capacity, but the record and
    // its attendance history stay.
    if (input.status === "TERMINATED") {
      await tx.operator.updateMany({
        where: { employeeId: input.employeeId },
        data: { isActive: false },
      });
    }

    await writeAudit(tx, {
      action: "EMPLOYMENT_STATUS_CHANGED",
      entityName: "Employee",
      entityId: after.id,
      before: { status: before.status },
      after: { status: after.status },
      ctx,
    });

    return after;
  });
}
