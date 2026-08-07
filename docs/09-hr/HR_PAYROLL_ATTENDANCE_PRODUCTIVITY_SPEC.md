# Cashmere OS — HR, Payroll, Attendance & Workforce Intelligence Specification

**Status:** Draft for implementation  
**Entity:** Group HR with entity allocation  
**Scope:** Employee master, contracts, attendance, fingerprint integration, shifts, leave, payroll, payroll accruals, employee advances, deductions, loans, incentives, production productivity, cost-center allocation and accounting integration.

## 1. Purpose

HR is the workforce system for Cashmere OS. It must serve both Factory and Brand while preserving the economic entity to which each employee cost belongs.

The system must answer:

- Who works here?
- Which entity employs them?
- Where do they work?
- Were they present?
- How many hours did they actually work?
- What should they be paid?
- What has accrued versus what has been paid?
- How much payroll belongs to Factory versus Brand?
- For Factory operators, what production time/output did they generate?

## 2. Employee master

Each employee has:

- employee ID
- name
- national ID reference where legally appropriate
- mobile
- address
- emergency contact
- hire date
- employment status
- department
- job title
- location
- manager
- entity allocation
- payroll profile
- bank/payment method
- contract reference
- documents

Sensitive personal data must be access-controlled.

## 3. Entity ownership

Every employee has a primary employing entity:

- Factory
- Brand

An employee may also have approved allocation percentages across entities when legitimately working for both.

Example:

`Employee X → Factory 80% / Brand 20%`

Allocation must be effective-dated.

Do not allocate Factory labour to Brand merely because the employee occasionally supports the Brand.

## 4. Departments

Configurable departments include:

### Factory
- Production
- Cutting
- Sewing
- Finishing
- Quality
- Maintenance
- Warehouse
- Production Planning
- Factory Administration

### Brand
- Retail
- Sales
- Customer Service / Moderators
- Marketing
- E-commerce
- Warehouse
- Management
- Administration

## 5. Employee lifecycle

`Candidate → Hired → Active → Suspended/On Leave → Resigned/Terminated → Archived`

Historical payroll and accounting records remain immutable.

## 6. Contracts

Contract records include:

- contract type
- start date
- end date if applicable
- basic salary
- allowances
- working schedule
- overtime rules
- probation
- entity
- department
- approved deductions

Contract changes create new effective-dated versions rather than rewriting historical payroll.

## 7. Compensation structure

Separate:

- basic salary
- fixed allowances
- variable allowances
- overtime
- incentives
- production bonus
- commission where applicable
- deductions
- employee advances
- loans

Payroll must preserve gross earnings and deductions separately.

## 8. Attendance

Attendance sources:

- fingerprint/biometric device
- manual approved correction
- shift schedule
- leave
- holiday calendar

Raw fingerprint punches must be retained.

Normalized attendance records are derived from raw punches and rules.

## 9. Fingerprint integration

The system should support a fingerprint/attendance adapter rather than hard-code one device vendor.

Adapter responsibilities:

- employee/device mapping
- punch import
- timestamp normalization
- duplicate punch handling
- offline device sync
- import logs
- failed records

Preferred integration path:

`Fingerprint Device → Adapter/Connector → Cashmere OS Attendance`

The system should support API/network integration where the device permits it, and file-based import as a fallback.

## 10. Attendance calculations

Calculate:

- scheduled minutes
- actual clocked minutes
- late minutes
- early departure
- overtime
- absence
- approved leave
- unapproved absence
- break time according to policy

Do not overwrite raw punches when a supervisor corrects attendance.

## 11. Attendance corrections

Corrections require:

- original value
- corrected value
- reason
- requester
- approver
- timestamp

This protects payroll and prevents silent changes.

## 12. Shifts

Shift configuration includes:

- start/end time
- break rules
- working days
- grace period
- overtime threshold
- location
- department

Support multiple shifts and overnight shifts.

## 13. Leave

Leave types are configurable:

- annual
- sick
- emergency
- unpaid
- maternity/paternity where applicable
- official holidays
- other approved categories

Track entitlement, used, pending and remaining balance.

## 14. Payroll period

Payroll runs by defined period, normally monthly.

Lifecycle:

`Open → Attendance Locked → Calculated → Reviewed → Approved → Posted → Paid/Partially Paid → Closed`

Once posted, payroll cannot be silently edited.

Corrections create adjustment records.

## 15. Payroll calculation

Payroll engine calculates:

`Gross Pay = Basic + Fixed Allowances + Variable Earnings + Overtime + Incentives`

`Net Pay = Gross Pay − Employee Deductions`

Exact statutory deductions/taxes should be implemented as configurable rules and verified against current Egyptian requirements before production use.

## 16. Accrual accounting

Payroll expense is accrued when earned, not when cash is paid.

At month-end/open period according to policy:

`Dr Payroll Expense`

`Cr Payroll Payable`

Payment later reduces the payable.

This is essential for the OS's accrual-based accounting model.

## 17. Entity payroll allocation

Payroll postings must be allocated to:

- Factory
- Brand

according to the employee's effective allocation.

Factory production labour belongs in the Factory conversion-cost pool where appropriate.

Brand salaries belong in Brand fixed operating costs where appropriate.

## 18. Factory labour and minute rate

Factory operator salaries are included in the Factory conversion-cost pool.

They are not separately charged to every style.

The minute-rate engine absorbs eligible Factory labour through the capacity model.

The system must be able to drill:

`Minute Rate → Factory Cost Pool → Payroll → Employee/Department`

## 19. Productive time vs attendance time

Do not equate attendance minutes with productive SMV minutes.

Track separately:

- clocked minutes
- scheduled minutes
- available minutes
- productive production minutes
- downtime
- setup/changeover
- training
- maintenance
- quality/rework time

This supports the existing separation of **Utilisation × Efficiency**.

## 20. Operator productivity

For eligible Factory operators, capture:

- employee
- line
- operation
- production order
- units completed
- standard minutes
- actual minutes
- efficiency
- quality result
- rework

Example:

`Efficiency = Standard Minutes Produced / Actual Production Minutes`

This is an operational KPI, not a payroll deduction unless an explicit incentive policy exists.

## 21. Line productivity

Aggregate operator results by production line.

Show:

- attendance
- available minutes
- productive minutes
- SMV produced
- efficiency
- downtime
- rework
- output

This links directly to Factory Operations.

## 22. Utilisation

Utilisation measures whether available Factory capacity was used.

It is distinct from efficiency.

Recommended model:

`Gross Available Minutes = Operators × Working Days × Hours × 60`

`Available Minutes = Gross × Utilisation`

`Productive Minutes = Available × Efficiency`

The exact production-engine formula must use the locked system definition consistently across all reports.

## 23. Overtime

Overtime requires:

- employee
- date
- minutes/hours
- reason
- manager approval
- payroll treatment
- entity allocation

Overtime must flow to payroll and, where applicable, Factory cost analysis.

## 24. Incentives

Support incentive schemes for:

- production output
- efficiency
- quality
- attendance
- sales
- moderator conversion

Each scheme must specify:

- eligibility
- calculation basis
- period
- approval
- accounting treatment

## 25. Moderator compensation

Brand moderators may have:

- salary
- performance incentive
- sales/conversion bonus

CRM performance metrics may feed an approved incentive calculation, but payroll remains the financial source for employee compensation.

## 26. Advances

Employee advances must be tracked separately from expenses.

Lifecycle:

`Requested → Approved → Paid → Recovered → Closed`

Outstanding advances are employee receivables, not payroll expense.

## 27. Employee loans

Support installment-based employee loans where needed.

Track:

- principal
- schedule
- installments
- recovered amount
- remaining balance

## 28. Deductions

Deductions may include approved:

- loan repayment
- advance recovery
- absence deduction where legally/policy permitted
- other authorized deductions

Each deduction requires source and approval.

## 29. Payroll payment

Payroll payment records include:

- payroll period
- employee
- amount
- payment method
- bank reference/cash voucher
- payment date
- status

Partial payroll payment is supported.

Outstanding payroll remains a payable.

## 30. Payroll reconciliation

At period close reconcile:

`Payroll calculated = payroll approved = payroll posted`

Then separately:

`Payroll payable = opening payable + accruals − payments − adjustments`

Any variance becomes an accounting review item.

## 31. Expense integration

Employee-related expenses must distinguish:

- payroll expense
- employee reimbursement
- employee advance
- loan
- non-payroll expense

Do not put all employee cash movements into payroll.

## 32. Employee reimbursement

Employees may submit business expenses with:

- receipt
- category
- amount
- date
- entity
- cost center
- approval

Reimbursement becomes a payable until paid.

## 33. Cost centers

Factory cost centers may include:

- production
- cutting
- sewing
- finishing
- quality
- maintenance
- warehouse
- administration

Brand cost centers may include:

- Alexandria showroom
- Cairo store
- marketing
- e-commerce
- customer service
- administration

## 34. Accounting integration

Every payroll/accrual record should carry:

- entity
- department
- cost center
- account mapping
- period

Accounting entries should be generated from approved payroll, not manually retyped.

## 35. Employee documents

Support controlled document records:

- contract
- identification documents
- employment forms
- payroll/bank documents
- certifications where relevant

Documents require access permissions and retention policy.

## 36. HR dashboard

Show:

- headcount
- active employees
- new hires
- exits
- attendance rate
- absence
- overtime
- payroll cost
- payroll payable
- Factory labour cost
- Brand payroll cost
- productivity
- turnover

## 37. Factory workforce dashboard

Show:

- operators available today
- scheduled operators
- absent operators
- available minutes
- utilisation
- productive minutes
- efficiency
- output
- downtime
- overtime
- labour cost

## 38. Payroll dashboard

Show:

- gross payroll
- deductions
- net payroll
- payroll payable
- paid amount
- outstanding amount
- Factory share
- Brand share
- overtime
- incentives

## 39. Alerts

Recommended HR alerts:

1. Missing fingerprint punches
2. Unapproved attendance correction
3. Excessive absence
4. Overtime threshold exceeded
5. Payroll calculation variance
6. Payroll payable overdue
7. Contract expiring
8. Employee allocation missing
9. Unusually low production efficiency
10. High rework associated with operator/line
11. Missing payroll approval
12. Fingerprint integration failure

## 40. Security

Roles must control access to sensitive HR/payroll information.

Recommended permissions:

- Owner: full
- Accountant: payroll financial data
- HR/Manager: employee and attendance data
- Production: operational workforce data, not confidential payroll unless authorized
- Viewer: limited reporting

Salary information must not be visible to ordinary production users.

## 41. Privacy

National IDs, bank details, salary and sensitive employee information must be encrypted/protected appropriately and excluded from unnecessary logs.

## 42. Integration boundaries

HR integrates with:

`Fingerprint → Attendance`

`Attendance → Payroll`

`Payroll → Accounting`

`Payroll → Factory Cost Pool`

`Factory Operations → Productivity`

`CRM → Moderator Incentive Inputs`

`Brand Locations → Employee Assignment`

## 43. Acceptance criteria

HR is complete when:

- Factory and Brand employees are clearly separated economically
- shared employees can be allocated by effective-dated percentage
- raw fingerprint punches are retained
- attendance corrections are audited
- payroll accrues before cash payment
- partial payroll payments are supported
- advances and loans are not confused with expenses
- Factory labour flows into the conversion-cost pool correctly
- Brand payroll remains in Brand fixed costs where appropriate
- operator attendance is distinct from production efficiency
- productivity links to production orders and lines
- payroll can be traced into accounting
- sensitive salary data is role-protected
- fingerprint integration can be replaced without rewriting HR logic
