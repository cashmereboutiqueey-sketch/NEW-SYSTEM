# Cashmere OS — Accounting, GL, COA, Tax, AP/AR, Cash & Month-End Close Specification

## Purpose
Define the accounting backbone so Factory, Brand and Group economics are financially complete, accrual-based, auditable and drillable to source transactions.

## 1. Accounting basis
Accrual accounting is mandatory. Costs and revenue belong to the period in which they are incurred/earned, not when cash moves.

Cash movements settle receivables/payables; they do not retroactively move operating expense into the payment month.

## 2. Entities
Three reporting lenses:
- Factory
- Brand
- Group

Factory and Brand maintain separate books/source ledgers even though they may use one bank account operationally. Group reporting eliminates intercompany activity.

## 3. Chart of accounts
COA supports configurable account codes, names AR/EN, account type, normal balance, tax treatment, entity applicability and reporting classification.

Core classes:
- Assets
- Liabilities
- Equity
- Revenue
- Cost of goods sold
- Operating expenses
- Other income/expense
- Tax

## 4. Dimensions
Every material journal line should support:
- entity
- department/cost centre
- location
- collection/style/SKU where relevant
- supplier/customer where relevant
- source transaction
- period

This enables drilldown without creating thousands of duplicate accounts.

## 5. Double-entry invariants
Posted journals must balance exactly: total debits = total credits.

Use Decimal(18,4) for money and never floating-point arithmetic.

## 6. Journal lifecycle
`Draft → Review → Posted → Locked`

Posted/locked journals are immutable through normal UI workflows. Corrections use reversal/adjustment entries with a reason and source reference.

## 7. Factory accounting
Factory revenue includes Brand transfer-price invoices and external CMT revenue.

Factory conversion costs include labour, rent, utilities, depreciation, maintenance, factory admin and other configured conversion overhead. Fabric/trims enter separately through inventory/material costing.

## 8. Brand accounting
Brand inventory cost is the Factory transfer price. Brand operating expenses include packaging, shipping, payment fees, marketing, returns/handling and Brand-only fixed costs according to classification.

Factory overhead already embedded in transfer price must not be added again to Brand fixed costs.

## 9. Intercompany
Factory → Brand transfer invoices create matching receivable/payable source records.

Group consolidation eliminates:
- Factory intercompany revenue
- Brand intercompany COGS/transfer cost
- related intercompany receivable/payable

## 10. Unrealised intercompany profit
Group consolidation must also eliminate Factory profit embedded in Brand finished-goods inventory that has not yet been sold externally.

Example: Factory invoices 1,000 units with margin; Brand sells 400. Profit attributable to the remaining 600 remains deferred in Group inventory until external sale.

The elimination must be lot/cost-snapshot traceable.

## 11. Material inventory accounting
Raw materials are recorded at landed cost including purchase price, freight and applicable customs/clearing capitalised according to policy.

Inventory movements are ledger events, not mutable balances.

FIFO lot valuation is the approved policy unless changed by configuration and accounting governance.

## 12. WIP and finished goods
Raw material consumption transfers value to WIP/production and completed production transfers value to Finished Goods using the locked production cost snapshot.

Scrap, rework and abnormal losses use explicit disposition/accounting treatment.

## 13. Cost snapshots
Production-order confirmation creates an immutable CostSnapshot containing material prices/quantities, landed costs, SMV, minute rate/period, intermediate subtotals, factory margin and transfer price.

Subsequent price changes never rewrite historical cost.

## 14. Sales accounting
A Brand sale records, as applicable:
- gross retail revenue
- discount
- VAT/output tax
- net revenue
- payment/receivable
- inventory COGS
- shipping/customer charges

Returns reverse the relevant revenue/tax/payment/COGS effects according to return status and original cost.

## 15. VAT
System supports configurable VAT rate; current default is 14% for Egypt.

Store tax-exclusive accounting values as the canonical basis if the commercial price policy is ex-VAT. If Shopify retail prices are VAT-inclusive, normalize them correctly before posting revenue.

Tax reporting must distinguish output VAT, input VAT and net VAT payable/receivable.

## 16. Accounts payable
Supplier invoices support:
- supplier
- invoice date
- due date
- received/approved date
- currency
- lines
- tax
- payment status
- partial payments

Aging is based on due date.

Buckets: current, 1–30, 31–60, 61–90, 90+ days.

## 17. Accounts receivable
Customer/channel receivables support invoice/order, due date, payment, partial payment, refund and aging.

COD is not treated as cash merely because an order is placed; collection occurs when the courier/payment process confirms collection.

## 18. Cash and bank
Track cash accounts, bank accounts, POS cash drawers and payment clearing accounts.

One physical bank account may fund both entities operationally, but the internal books must preserve entity attribution and intercompany/owner clearing classifications.

Never classify an unexplained bank movement as expense merely to make cash reconcile.

## 19. Owner transactions
Owner drawings are distributions/equity movements, not operating expense.

Owner salary for genuine work is payroll expense under the relevant entity.

Owner funding is recorded separately from revenue.

## 20. Shared expenses
Shared expenses must have an allocation rule and documented basis, such as headcount, usage, revenue, floor area or another approved driver.

The allocation produces entity-specific entries while preserving the original supplier transaction.

## 21. Expense capture
Provide a central expense form with:
- entity
- category/account
- supplier/payee
- invoice/reference
- incurred date
- due date
- amount
- VAT
- payment status
- payment account
- cost centre
- attachment
- recurring flag
- allocation basis

This is the place where the owner/accountant can enter all business expenses and explicitly decide or validate whether each belongs to Brand, Factory, Shared or requires allocation.

## 22. Recurring accruals
Recurring rent, salaries and configured monthly costs generate period accruals even before supplier invoices arrive.

When the actual invoice arrives, the accrual is matched/reversed and the actual payable is recognized without double counting.

## 23. Prepayments
Prepaid expenses are recorded as assets and amortized to the relevant periods. Examples include annual software, insurance or prepaid rent.

## 24. Fixed assets
Assets support acquisition date, supplier, cost, useful life, residual value, depreciation method, location, entity and disposal.

Default depreciation is straight-line where configured.

Depreciation is an accrued real cost and enters the appropriate Factory/Brand cost pool.

## 25. Accrued liabilities
Support accrued utilities, payroll, services and other obligations where cost is known/estimated but invoice/payment is pending.

Accruals are reversed or adjusted when actual invoices are recognized.

## 26. Cash conversion cycle
`CCC = raw_material_days + production_lead_days + finished_goods_days + collection_days − supplier_credit_days`

`Working Capital Locked = CCC × (Monthly COGS / 30)`

Raw-material holding time is explicitly included by approved decision.

Dashboard shows CCC and locked capital permanently.

## 27. Month-end close
Close checklist:
1. bank/cash reconciliation
2. payment gateway reconciliation
3. POS shift reconciliation
4. Shopify reconciliation
5. AR/AP aging review
6. inventory reconciliation
7. WIP/FG valuation
8. accruals/prepayments
9. depreciation
10. payroll accrual
11. intercompany reconciliation
12. VAT/tax review
13. marketing spend reconciliation
14. review unusual variances
15. management approval
16. period lock

## 28. Period lock
Once a month is locked, prior-period operational/accounting values cannot be edited to change reported history. Corrections are posted as controlled adjustments in the appropriate period.

## 29. Financial statements
Generate:
- Balance Sheet
- P&L
- Cash Flow
- Trial Balance
- General Ledger
- AP Aging
- AR Aging
- VAT/tax reports
- Inventory valuation
- Intercompany reconciliation

Statements support Factory, Brand and Group views.

## 30. P&L views
Factory P&L shows external CMT revenue, Brand transfer revenue and conversion/material economics.

Brand P&L shows external revenue, transfer-price COGS, Brand operating costs and Brand result.

Group P&L eliminates intercompany revenue/COGS and unrealised transfer margin in unsold inventory.

## 31. Expense classification guardrails
The system must not allow factory overhead to be accidentally added to Brand contribution as another variable cost when it is already inside transfer price.

The fixed-cost pool drilldown must show exactly which accounts are included in break-even.

## 32. Tax and VAT controls
Tax rates are versioned by effective date. Historical transactions retain the tax rate used at posting.

VAT-inclusive external prices are normalized into net revenue and VAT before accounting.

## 33. Audit drilldown
Every financial number should drill:
`Report → Journal → Source Event → Order/Invoice/Payment/Inventory Movement → Counterparty → Attachment/Reference`

Calculated KPIs also expose their calculation inputs.

## 34. Accountant workspace
Provide a dedicated accountant view for:
- transaction entry
- invoice capture
- AP/AR
- bank reconciliation
- journal review
- accruals
- fixed assets
- VAT
- month-end close
- financial reports
- audit trail

## 35. Acceptance criteria
Accounting is complete when all Brand/Factory/Group reports are accrual-based, double-entry balanced, VAT-aware, entity-attributed, inventory-integrated, intercompany-eliminated, period-lockable and drillable to source transactions, including a complete expense-entry workflow that explicitly captures Brand vs Factory vs Shared classification.
