# Cashmere OS — Accounting, Financial Reporting, Tax & Consolidation Specification

## Purpose
Define the accounting engine as an accrual-based double-entry ledger with separate Factory, Brand and Group views, complete traceability, period controls and intercompany elimination.

## 1. Accounting basis
Transactions are recognized when incurred/earned under configured accounting policy, not when cash moves. Cash movements settle receivables/payables or other balances; they do not determine expense/revenue timing.

## 2. Entities
Factory and Brand have separate books/ledgers inside the same tenant. Group reporting consolidates them and eliminates intercompany activity.

## 3. Chart of accounts
Account master supports account type, entity applicability, normal balance, parent account, reporting category, tax treatment and active dates.

Minimum groups:
- Cash/bank
- Accounts receivable
- Inventory raw/WIP/finished goods
- Fixed assets
- Accounts payable
- Accrued liabilities
- Payroll liabilities
- Tax/VAT liabilities and recoverables
- Equity/drawings
- Factory revenue
- Material/production costs
- Factory conversion overhead
- Brand sales
- Transfer-price COGS
- Brand operating expenses
- Marketing
- Shipping/payment/returns
- Other income/expense

## 4. Double-entry journals
Every posted journal must balance debit = credit. Source transaction, entity, period, currency and audit metadata are mandatory.

Posted journals are immutable. Corrections use reversing/adjusting journals.

## 5. Subledgers
AP, AR, inventory, fixed assets, payroll, payments and tax records act as controlled subledgers and reconcile to the GL.

## 6. Accruals
Recurring monthly costs can be accrued at period open before supplier invoices arrive. Reversal/true-up logic must prevent duplicate recognition when the actual invoice is posted.

## 7. AP
Expense/vendor invoice captures incurred date, invoice date, due date, entity, supplier, category, tax and payment status. Aging uses due date as specified.

Partial payments are supported. Outstanding balance remains a liability until settled/adjusted.

## 8. AR
Customer invoices/sales receivables track due date, collection status, partial payments, refunds/credits and aging.

## 9. Inventory accounting
Inventory ledger movements create value changes. Raw materials, WIP and finished goods are separately identifiable. FIFO valuation follows approved lot sequence.

Inventory adjustments require reason and approval.

## 10. Cost of goods
Factory materials and conversion costs accumulate through production. Brand finished goods are received from Factory at the immutable transfer-price snapshot. Brand sale relieves inventory at that transfer cost.

## 11. Fixed assets
Asset register stores acquisition, useful life, depreciation method, accumulated depreciation, residual value, location and entity. Straight-line depreciation is the default assumption and depreciation accrues by period.

## 12. Factory P&L
Factory reports external CMT revenue and intercompany Brand revenue separately. Factory conversion costs, materials, depreciation and other operating costs are visible by category.

CMT revenue credits the Factory cost pool according to the approved minute-rate policy.

## 13. Brand P&L
Brand reports retail revenue net of approved discounts/returns, transfer-price COGS, packaging, shipping, payment fees, marketing and Brand fixed costs.

## 14. Group consolidation
Eliminate:
- Factory intercompany revenue to Brand
- Brand intercompany transfer-price COGS
- intercompany receivable/payable
- unrealised intercompany profit embedded in unsold finished goods

Unrealised margin is released into Group profit only when the relevant inventory is sold externally, subject to the configured consolidation method.

## 15. Intercompany control
Every Factory-to-Brand production transfer has a paired intercompany transaction with matching amount, quantity, SKU/style and source production order. Mismatches create reconciliation exceptions.

## 16. VAT
System supports VAT-exclusive internal storage with configurable display/reporting treatment. Current configured Egyptian VAT rate is 14%, but tax rates must be versioned and never hard-coded into historical transactions.

If retail prices are VAT-inclusive, a configured gross-to-net calculation is required before revenue reporting.

## 17. Tax periods
Tax reporting is period-based and locked after filing/approval according to accounting policy. Tax adjustments are explicit journal records.

## 18. Cash and bank
Bank accounts are ledger-controlled. Statement transactions enter reconciliation. Reconciliation differences remain visible until resolved.

## 19. Owner drawings
Owner drawings/distributions are equity transactions, not operating expenses. Owner salary for genuine work is payroll/expense according to the approved policy.

## 20. Closing
Period states:
`Open → Review → Approved → Locked`

Locked periods cannot be edited. Corrections use adjusting entries in an allowed open period with a reference to the original transaction.

## 21. Trial balance
Trial balance must reconcile at entity and group level. Any imbalance is a blocking system error, never a warning-only condition.

## 22. Financial statements
Generate:
- Profit & Loss
- Balance Sheet / Statement of Financial Position
- Cash Flow
- Trial Balance
- General Ledger
- AP Aging
- AR Aging
- Inventory valuation
- Fixed asset/depreciation schedule
- VAT reports
- Accrual schedule

## 23. Management vs statutory views
Management reporting may include contribution, break-even, minute-rate diagnostics and operational KPIs. Statutory accounting reports use the configured chart/accounting policy. Labels must distinguish the two.

## 24. Budget vs actual
Support budgets by entity/account/department/month and compare actual accruals to budget with variance explanations.

## 25. Expense classification
Every expense entry must identify:
- Factory or Brand
- department/cost centre
- account/category
- supplier/payee
- period incurred
- due date
- payment status
- tax treatment
- optional campaign/project/style/event link

This directly answers the owner requirement: every expense has a home and its entity is explicit.

## 26. Cost allocation
Shared expenses require an approved allocation driver. Examples: time, headcount, floor area or usage. Allocations are stored as separate records and are reversible/auditable.

## 27. Reconciliation controls
Reconcile:
- subledgers to GL
- bank to cash ledger
- AP to supplier balances
- AR to customer balances
- inventory ledger to valuation
- payroll to payroll liability
- intercompany Factory/Brand balances
- VAT/tax schedules to tax accounts

## 28. Reporting drill-down
Every financial number can drill to journal → source transaction → document/vendor/customer → external evidence where available.

## 29. Acceptance criteria
Accounting is complete when every operational transaction can produce balanced journals, accruals are separated from payment timing, Factory/Brand books remain distinct, Group consolidation eliminates unrealised intercompany margin, tax treatment is versioned, periods can be locked, and every expense can be traced to entity/category/source/payment status.
