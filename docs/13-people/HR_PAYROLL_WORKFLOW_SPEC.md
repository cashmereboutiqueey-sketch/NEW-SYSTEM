# Cashmere OS — HR, Payroll, Attendance & Employee Workflow Specification

## Purpose
Provide a controlled people layer for Factory and Brand employees, connecting attendance, payroll, incentives, production productivity and accounting without turning HR data into an uncontrolled expense ledger.

## 1. Entity separation
Every employee belongs to Factory, Brand, or Shared with an explicit allocation rule for shared employment.

Factory production employees can feed operator productivity and manufacturing efficiency. Brand employees feed Brand operating costs. Shared employees require documented allocation.

## 2. Employee master
Store employee code, name, entity, department, job title, employment status, hire date, termination date, salary basis, payment method, manager, branch/line, shift and emergency/admin fields subject to access controls.

Sensitive HR fields must be role-restricted.

## 3. Organisation
Support:
- Factory departments
- Production lines/work centres
- Brand departments
- Alexandria showroom
- Cairo showroom
- Marketing
- E-commerce
- Finance
- Operations

Employees can move departments/lines through effective-dated assignments so historical reports do not change.

## 4. Attendance
Attendance records clock-in, clock-out, breaks, lateness, absence, approved leave, overtime and attendance exceptions.

Integrate biometric/fingerprint devices where a compatible connector/API/export exists. The integration must import raw punches first; payroll uses approved attendance, not silently altered device data.

If no live API exists, support CSV/device export import with reconciliation and duplicate protection.

## 5. Shifts
Shift templates define working days, expected hours, break rules and overtime policy. Factory lines may have different shifts.

Attendance calculates expected vs actual time while preserving raw source punches.

## 6. Leave
Support leave types, entitlement, request, approval, balance, dates and payroll impact.

Leave approval is separate from attendance correction.

## 7. Overtime
Overtime requires policy and approval. Store requested, approved and actual overtime separately.

Payroll calculates overtime from approved rules; managers cannot silently alter payroll values after payroll lock.

## 8. Payroll
Monthly payroll supports:
- base salary
- overtime
- incentives/commissions
- allowances
- deductions
- advances/loans
- unpaid absence
- employer costs where configured
- payroll adjustments

Payroll is calculated per employee and then posted to the correct entity/cost centre.

## 9. Factory labour costing
Monthly-salaried direct operators are included in the Factory conversion cost pool and therefore the MinuteRatePeriod.

Production productivity remains a separate operational measure; do not double-charge the same salary as style-level direct labour.

## 10. Brand labour costing
Brand salaries are Brand-only fixed or operating costs according to configured cost classification. Examples: showroom staff, brand management, e-commerce and marketing salaries.

## 11. Incentives
Support approved incentive plans for:
- showroom sales
- moderator social orders
- production productivity where appropriate
- management-approved campaigns

Rules can consider net collected sales, returns, discounts and cancellations.

Incentives are linked to their source performance records and then posted to payroll/accounting.

## 12. Operator productivity
Track operator/team standard minutes, actual minutes, units completed, efficiency, quality, rework and attendance context.

Operator productivity must not be used to unfairly compare employees without considering style, operation, line and assigned work.

## 13. HR ↔ Manufacturing
Production stages can reference employee/team/work-centre assignments.

This enables analysis of efficiency and quality by line/team/operation while respecting permissions.

## 14. HR ↔ POS/CRM
Cashier and moderator IDs connect transactions to employees for operational reporting and incentive calculations.

Customer data is not exposed to employees beyond their authorized role.

## 15. Payroll accrual
At period close, payroll expense is accrued for the correct period even if salary payment occurs later.

Payment clears payroll payable; it does not create a second expense.

## 16. Employee advances and loans
Track opening balance, advances, repayments, payroll deductions and remaining balance separately from salary expense.

## 17. Termination/final settlement
Termination workflow calculates approved final salary, unused leave where applicable, deductions, advances and other configured settlement items.

Historical payroll remains immutable after lock.

## 18. Fingerprint integration
Preferred architecture:
`Biometric Device → Integration Layer → Raw Punches → Attendance Engine → Approval/Correction → Payroll`

Store device ID, employee mapping, punch timestamp and source. Corrections create audit records rather than overwriting raw punches.

## 19. Security
HR roles must restrict salary, personal and attendance information. Owner/accountant access is configurable; production managers see operational attendance/productivity without unnecessary salary visibility.

## 20. Payroll lock
Payroll periods have Draft → Calculating → Review → Approved → Locked → Paid states. Locked periods cannot be edited; corrections become adjustment records in a later period or controlled reversal.

## 21. Accounting integration
Payroll emits:
- salary expense
- overtime expense
- incentive expense
- employer cost
- payroll payable
- deductions/withholdings where configured
- employee advances/loans
- payment settlement

Each entry is tagged by entity, department/cost centre and period.

## 22. Dashboards
HR dashboard:
- headcount
- attendance rate
- absence
- overtime
- payroll cost
- payroll by entity/department
- turnover
- leave balances

Factory dashboard additionally shows labour minutes, operator efficiency, productivity and quality correlation.

## 23. Acceptance criteria
The module is complete when employee/entity ownership is explicit, attendance can ingest fingerprint data or exports, leave/overtime are controlled, payroll is accrual-based and lockable, Factory/Brand labour is separated correctly, incentives connect to source transactions, operator productivity feeds manufacturing analytics, and payroll posts automatically into accounting with full traceability.
