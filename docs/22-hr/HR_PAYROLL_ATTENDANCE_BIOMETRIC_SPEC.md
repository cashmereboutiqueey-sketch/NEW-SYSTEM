# Cashmere OS — HR, Payroll, Attendance & Biometric Integration Specification

## Purpose
Create a controlled HR layer for employees, attendance, payroll and factory productivity while keeping personal and salary data permissioned. Biometric devices are an input source, not the accounting authority.

## 1. Employee master
Store employee ID, name, role, department, entity, location, employment status, hire date, contract data, pay basis and skills/operations where relevant.

Separate sensitive personal data from operational fields and restrict access.

## 2. Entity assignment
An employee belongs primarily to Factory or Brand. Shared employees can have approved allocation rules when they genuinely work across entities.

## 3. Organisation structure
Support departments, teams, lines/work centres, supervisors and reporting relationships.

Factory examples include production lines, cutting, finishing, quality, warehouse and maintenance. Brand examples include showroom, e-commerce, customer service, marketing, administration and management.

## 4. Attendance
Track clock-in, clock-out, breaks, late arrival, early departure, absence, overtime and approved adjustments.

Attendance records are append-only after approval; corrections require an auditable adjustment.

## 5. Biometric integration
Support optional biometric/fingerprint device connectors. Imported punches are raw attendance evidence and are mapped to employees using device IDs.

Duplicate punches and device replay are idempotent. Device failures do not fabricate attendance.

A manual attendance adjustment remains possible with reason and approval.

## 6. Work schedules
Employees may have assigned schedules, working days, shift start/end, breaks, overtime rules and holidays.

Factory capacity planning uses scheduled working time and separately models utilisation and efficiency.

## 7. Payroll
Payroll period:
`Attendance + Contracted Pay + Overtime + Allowances − Approved Deductions = Gross/Net Payroll`

Exact statutory deductions and employer costs are configurable to applicable Egyptian rules and should be reviewed by the accountant/payroll administrator before production use.

## 8. Payroll accrual
Approved payroll creates an accrual in the accounting period earned, even if payment occurs later.

Payroll payment clears the liability; it does not move the expense into the payment month.

## 9. Factory labour costing
Factory direct sewing labour for salaried operators belongs in the factory conversion-cost pool and therefore feeds the minute-rate calculation.

Do not additionally charge the same salary per style unless a configured separate direct-cost policy exists.

## 10. Brand labour costing
Brand employees are Brand operating costs. They can feed Brand fixed-cost pools, departmental reporting and profitability analysis according to allocation rules.

## 11. Shared employee costing
If an employee genuinely works across entities, payroll remains one source transaction but accounting allocates the approved portion to each entity using a documented driver such as time records or scheduled allocation.

## 12. Operator productivity
Track operator productivity by eligible operation where data exists:
`Productive SMV Minutes / Attendance Clock Minutes`

Compare actual performance with expected efficiency without using productivity as a payroll penalty automatically.

## 13. Production linkage
Operator productivity can link to production stages, operations, style, production order and line. This supports line/operation efficiency analysis while protecting employee privacy.

## 14. Overtime
Overtime requires approval according to configured rules. Approved overtime feeds payroll and, where applicable, Factory conversion cost.

## 15. Leave and absence
Support leave requests, approval, attendance impact and payroll treatment. Absence contributes to capacity availability but should not be silently treated as operator inefficiency.

## 16. Employee documents
Support controlled document references for contracts and required HR records. Sensitive documents are permissioned and should not be exposed to ordinary production users.

## 17. Payroll privacy
Salary amounts, bank details, deductions and sensitive HR information are restricted to Owner/Accountant or explicitly permitted HR roles.

## 18. Performance
HR can store review periods, goals and notes. Performance data is separate from raw attendance and production metrics and requires appropriate permissions.

## 19. Fingerprint integration acceptance
A connector is complete when it can import punches, map device employees, handle duplicate/replayed events, flag unknown employees, preserve raw evidence and reconcile imported punches against approved attendance.

## 20. Accounting integration
Payroll journal output includes entity, department/cost centre, salary expense, employer costs where configured, deductions/payables and net payroll liability/payment clearing.

## 21. Controls
Require approval for:
- manual attendance edits
- overtime
- payroll finalization
- salary changes
- employee termination
- shared-employee allocation changes

## 22. Reporting
HR dashboard:
- headcount
- attendance
- absence
- overtime
- payroll cost
- Factory labour pool
- Brand payroll
- operator productivity
- capacity impact
- turnover

Sensitive reports are permission controlled.

## 23. Acceptance criteria
HR is complete when employee master data, attendance, payroll accruals, Factory/Brand allocation, operator productivity and optional biometric imports are connected without duplicating labour costs, exposing sensitive data improperly or allowing unapproved attendance/payroll changes.
