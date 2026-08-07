# Cashmere OS — HR, Attendance, Payroll & Biometric Integration Specification

**Status:** Draft for implementation
**Scope:** Employees, organization, contracts, attendance, shifts, leave, payroll inputs, fingerprint/biometric integration, factory productivity, Brand HR allocation, audit and approvals.

## 1. Purpose

HR is the workforce source of truth for both entities while preserving separate economic ownership:

- Factory employees and production workforce
- Brand employees
- Shared employees where explicitly configured

HR must never silently move an employee's cost between Factory and Brand.

## 2. Employee master

Each employee has:

- employee code
- legal name
- preferred name
- AR/EN display name
- phone/contact fields as permitted
- national/identity reference as permitted by policy
- hire date
- termination date
- employment status
- department
- job title
- manager
- entity assignment
- location
- employment type
- payroll profile
- attendance profile

Sensitive identity data must have restricted permissions.

## 3. Organizational structure

Support:

`Entity → Department → Team → Employee`

Factory examples:

- Production
- Cutting
- Sewing
- Finishing
- QC
- Maintenance
- Warehouse
- Factory administration

Brand examples:

- Sales
- Marketing
- Customer service/moderation
- E-commerce
- Showroom
- Finance
- Administration

## 4. Entity assignment

Every employee has a primary economic entity.

A shared employee may have an explicit allocation rule:

- percentage by entity
- fixed amount
- timesheet-based
- activity-based

The allocation must be effective-dated.

No shared employee cost should be allocated by an invisible assumption.

## 5. Employment contracts

Contract/version stores:

- effective dates
- salary/base pay
- allowances
- overtime rules
- working schedule
- entity
- department
- payroll frequency
- benefits/deductions where applicable

Historical contracts remain immutable after payroll processing.

## 6. Attendance

Attendance records support:

- date
- employee
- clock-in
- clock-out
- breaks
- worked minutes
- scheduled minutes
- late minutes
- early departure
- overtime minutes
- absence
- attendance status
- source

Attendance corrections require audit trail and approval.

## 7. Fingerprint/biometric integration

The system should support importing attendance events from a biometric/fingerprint device or vendor through a connector layer.

Architecture:

`Biometric Device → Connector/Adapter → Raw Attendance Event → Normalized Attendance → Approval/Correction → Payroll/Capacity/Productivity`

The connector must be replaceable by vendor.

The core HR model must not depend on a specific fingerprint machine.

### Raw event

Store:

- device ID
- employee/device identifier
- event timestamp
- event type if provided
- source
- import batch
- raw payload/reference

Raw events are immutable.

## 8. Employee-device mapping

Store an explicit mapping:

`Employee ↔ BiometricDevice ↔ DeviceEmployeeId`

An employee can have mappings to multiple devices.

A device ID must never be used as the primary employee identity.

## 9. Attendance normalization

Raw punches are converted into attendance intervals according to shift rules.

The system must handle:

- duplicate punches
- missing clock-out
- overnight shifts
- multiple punches
- breaks
- device clock drift where configured
- manual corrections

Exceptions are surfaced instead of silently guessed.

## 10. Shifts and schedules

Shift definitions include:

- start/end
- break rules
- grace period
- working days
- overtime policy
- location
- department eligibility

Employees may have effective-dated schedules.

## 11. Leave

Leave types are configurable.

Leave request lifecycle:

`Draft → Submitted → Approved/Rejected → Taken → Closed`

Store:

- employee
- leave type
- dates
- duration
- balance impact
- approval
- reason where permitted

Leave should explain attendance gaps rather than overwrite raw biometric events.

## 12. Overtime

Overtime requires policy and approval.

The system records:

- eligible minutes
- approved minutes
- overtime rate/rule
- payroll amount
- related entity

Unapproved overtime must not automatically become payroll cost.

## 13. Payroll

Payroll engine scope can be staged, but HR must provide authoritative payroll inputs.

Payroll period contains:

- employee
- base salary
- allowances
- overtime
- deductions
- leave effects
- attendance adjustments
- employer costs where applicable
- net pay
- entity allocation

Payroll records become immutable after posting.

## 14. Factory labour costing

Factory operators whose salaries are included in `total_factory_monthly_cost` must not also be charged as direct per-style labour outside the minute-rate model.

Attendance/productivity data informs:

- available minutes
- actual worked minutes
- efficiency
- overtime
- absenteeism

The Cost Engine remains authoritative for style CMT cost.

## 15. Brand labour costing

Brand salaries are Brand fixed/operating costs according to their configured classification.

Examples:

- showroom salaries
- brand administration
- marketing salaries
- e-commerce staff
- moderators/customer service

They feed the Brand fixed-cost pool where configured.

## 16. Shared employee allocation

If an employee works for both Factory and Brand, allocation must be explicit.

Example:

`60% Factory / 40% Brand`

or approved timesheet/activity allocation.

The system should warn if a shared employee has no current allocation.

## 17. Attendance → productivity

For Factory production employees, normalized attendance can feed the productivity layer.

Conceptual relationship:

`Scheduled minutes → Attendance available minutes → Productive/earned minutes → Efficiency`

Attendance does not automatically equal productive minutes.

Idle time, meetings, machine downtime, material shortage, and other non-productive periods must remain distinguishable.

## 18. Cost classification

Every payroll cost must be classified as applicable:

- Factory conversion cost
- Factory administration
- Brand fixed cost
- Brand variable cost
- Shared/allocated
- Other

This classification drives accounting and cost-pool reporting.

## 19. Employee expenses

Employee-related expenses can include:

- salary
- overtime
- bonuses
- transport
- meals
- insurance/benefits
- approved reimbursements

Each expense must have entity/cost-center classification.

## 20. Performance

HR may track operational performance references:

- attendance rate
- punctuality
- overtime
- productivity
- quality
- rework
- output

Factory productivity metrics remain linked to Production records.

## 21. Approvals

Configurable approval chains should support:

- leave
- attendance corrections
- overtime
- salary changes
- bonuses
- employee expenses
- termination

Approval events are auditable.

## 22. Security

Sensitive HR data is role-restricted.

Examples of restricted data:

- identity documents
- salary details
- bank/payroll information
- disciplinary records
- private employee notes

Operational managers see only what their role requires.

## 23. Integrations

HR may integrate with:

- biometric/fingerprint systems
- payroll/payment systems
- accounting
- Factory productivity
- capacity planning
- workflow/approvals

Integration failures must not overwrite or delete source attendance data.

## 24. Required HR reports

1. Employee master
2. Headcount by entity
3. Headcount by department
4. Attendance summary
5. Late/absence report
6. Overtime report
7. Leave balances
8. Payroll summary
9. Payroll by entity
10. Payroll by cost center
11. Shared employee allocation
12. Factory labour cost
13. Brand payroll cost
14. Operator productivity
15. Attendance exceptions
16. Missing biometric punches
17. Payroll variance
18. Employee turnover

## 25. Acceptance criteria

HR is correct when:

- employees have explicit entity ownership
- shared employees have explicit allocation
- raw fingerprint events are immutable
- biometric device identity is separate from employee identity
- attendance corrections are auditable
- shifts and overnight cases work
- leave explains absence without rewriting punches
- overtime requires approval
- payroll periods become immutable after posting
- Factory labour is not double-counted outside the minute-rate model
- Brand salaries feed the correct Brand cost pool
- attendance can inform Factory productivity without confusing attendance with production
- sensitive HR information is permission-controlled
