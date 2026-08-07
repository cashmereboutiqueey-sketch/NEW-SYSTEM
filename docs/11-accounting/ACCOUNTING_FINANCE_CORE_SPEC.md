# Cashmere OS — Accounting & Finance Core Specification

**Status:** Draft for implementation
**Scope:** Factory, Brand, Group accounting; accruals; AP/AR; inventory accounting; fixed assets; depreciation; VAT; payroll posting; bank reconciliation; intercompany; consolidation; management P&L; audit trail.

## 1. Accounting principles

Cashmere OS is accrual-based.

A cost or revenue is recognized when economically incurred/earned, not when cash is paid/received.

Cash movements are separate from profit recognition.

Every posted accounting transaction must be traceable to its source document and calculation inputs.

## 2. Accounting entities

Three reporting lenses:

- Factory
- Brand
- Group

Factory and Brand maintain separate books conceptually even when they share one physical bank account.

The Group view consolidates both and eliminates intercompany transactions.

## 3. Chart of accounts

The COA must support at minimum:

### Assets

- Bank
- Cash
- Accounts receivable
- Inventory — raw materials
- Inventory — WIP
- Inventory — finished goods
- Inventory — packaging
- Inventory adjustments
- Prepayments
- Fixed assets
- Accumulated depreciation
- Other assets

### Liabilities

- Accounts payable
- Accrued expenses
- Payroll payable
- VAT payable
- Customer deposits
- Supplier advances
- Intercompany payable — Factory/Brand
- Other liabilities

### Equity

- Owner capital
- Retained earnings
- Current-period profit
- Owner drawings/distributions

Owner drawings are distributions, not business expense.

### Revenue

- Brand retail sales
- Factory manufacturing revenue
- External CMT revenue
- Other operating revenue
- Sales returns
- Sales discounts

### Cost of sales

- Brand transfer-price COGS
- Brand packaging
- Brand shipping
- Brand payment fees
- Brand return handling
- Factory material consumption
- Factory conversion/CMT cost
- Other COGS

### Operating expenses

- Brand showroom costs
- Brand salaries
- Brand rent
- Marketing
- Software
- Factory administration
- Factory utilities
- Factory maintenance
- Factory depreciation
- Other operating expenses

The final COA is configurable and versioned.

## 4. Dimensions

Every material accounting entry should support dimensions:

- entity
- department
- cost center
- location
- style
- collection
- sales channel
- supplier/customer
- production order
- campaign where relevant

Not every account requires every dimension, but the source-to-ledger mapping must be deterministic.

## 5. Journal entries

Journal entry lifecycle:

`Draft → Approved → Posted → Reversed/Adjusted`

Posted entries are immutable.

Corrections create reversal and/or adjustment entries.

Each journal entry stores:

- number
- date
- accounting period
- description
- source type
- source ID
- entity
- created by
- approved by
- posted timestamp

Journal lines store account, debit, credit, currency, dimensions, and source references.

## 6. Double-entry invariant

Every posted journal must satisfy:

`total debits = total credits`

The application must reject unbalanced journals.

## 7. Accounting periods

Periods have states:

`Open → Soft Close → Closed`

Closed periods cannot receive ordinary edits.

Late corrections require controlled adjustment entries with an audit trail.

## 8. Accrual engine

Recurring monthly costs may be accrued at period open even before an invoice exists.

Examples:

- rent
- salaries
- utilities
- subscriptions
- depreciation
- recurring services

Accrual reversal/settlement must link back to the original accrual.

## 9. Expenses

Expense record supports:

- entity
- supplier
- category/account
- invoice/reference
- incurred date
- due date
- amount ex-VAT
- VAT
- gross amount
- payment status
- paid amount
- remaining payable
- cost center
- attachments
- approval status

An expense may be partially paid.

AP aging uses **due_date**, not incurred_date.

## 10. Accounts payable

AP lifecycle:

`Draft → Approved → Posted → Partially Paid → Paid`

A supplier invoice creates liability when incurred/accepted according to accounting policy, regardless of payment date.

AP aging buckets:

- current
- 1–30
- 31–60
- 61–90
- 90+

Aging is based on due date.

## 11. Accounts receivable

AR supports:

- Brand customer receivables where applicable
- external Factory customer receivables in Phase 6

Customer payments are separate from revenue recognition.

AR aging is based on due date.

## 12. Bank and cash

The system can represent a shared physical bank account while maintaining entity attribution for every transaction.

Every bank transaction should have:

- bank account
- transaction date
- value date where available
- amount
- direction
- counterparty
- entity allocation
- source/reference
- reconciliation status

A shared bank account must not cause Factory and Brand economics to merge.

## 13. Bank reconciliation

Workflow:

`Imported → Matched → Partially Matched → Exception → Reconciled`

Matching can use:

- amount
- date
- reference
- supplier/customer
- expected payment

Unmatched items remain visible.

## 14. Owner transactions

Owner drawings are posted to equity/distribution accounts.

They are never included in Factory or Brand operating expense.

If the owner receives a salary for actual work, it is processed as payroll expense according to the entity assignment.

## 15. VAT

Current assumed VAT rate: **14%**, configurable by effective date.

Internal price/cost calculations are ex-VAT unless explicitly defined otherwise.

Track separately:

- output VAT
- input VAT
- VAT payable/receivable
- VAT adjustments

VAT must not contaminate ex-VAT COGS or margin calculations.

Shopify VAT treatment must be explicitly configured before importing historical sales.

## 16. Purchases and landed material cost

Material purchase accounting separates:

- supplier invoice price
- freight
- customs/clearing
- other directly attributable landed cost

Landed cost is capitalized into material inventory cost according to the configured allocation rule.

It is not factory overhead.

## 17. Inventory accounting

Inventory uses the ledger model:

`InventoryLot + InventoryMovement`

The recommended valuation method is **FIFO**.

Inventory states:

`Raw Material → WIP → Finished Goods`

Every movement records quantity and value.

Inventory balances are derived from movements, not manually mutated balances.

## 18. Raw material purchase

Typical posting:

`Dr Raw Material Inventory`

`Dr Input VAT`

`Cr Accounts Payable / Bank`

Freight/customs directly attributable to the inventory are capitalized through landed-cost postings.

## 19. Material issue

When material is issued to production:

`Dr WIP / Production Cost`

`Cr Raw Material Inventory`

The actual lot and FIFO cost must be traceable.

## 20. WIP and finished goods

Production completion transfers accumulated factory production cost from WIP to Finished Goods.

Finished goods cost includes the appropriate factory material and conversion cost according to the production-cost engine.

## 21. Factory transfer invoice

For Brand production:

Factory recognizes:

`Dr Intercompany Receivable — Brand`

`Cr Factory Revenue`

Brand recognizes:

`Dr Finished Goods / Inventory`

`Cr Intercompany Payable — Factory`

The transfer price is based on the immutable production CostSnapshot and configured arm's-length margin.

## 22. Intercompany reconciliation

Factory and Brand intercompany balances must reconcile exactly.

Every internal invoice has:

- production order
- CostSnapshot
- units
- transfer price
- invoice date
- due date
- Factory receivable
- Brand payable

A mismatch dashboard identifies differences in quantity, price, invoice, or settlement.

## 23. Group elimination

Group reporting eliminates:

- Factory intercompany revenue
- Brand transfer-price COGS/inventory uplift
- intercompany receivable/payable

Critically, unrealized Factory profit inside unsold Brand finished goods must also be eliminated.

Example:

Factory produces 1,000 units and earns transfer margin.
Brand sells 400.

The margin embedded in the remaining 600 units is **unrealized Group profit** and remains in inventory at Group cost.

The elimination engine must calculate the embedded intercompany profit by inventory lot/quantity and reverse it from Group profit while preserving the Brand book value.

When those units are later sold, the corresponding deferred profit is released through the Group elimination process.

## 24. External CMT revenue credit

External CMT revenue may be credited against the Factory cost pool according to the locked business rule.

This affects the Factory's net cost pool used for minute-rate calculation.

External CMT remains Factory revenue in the entity P&L.

The allocation must be auditable by customer/order/minute.

## 25. Factory minute-rate accounting bridge

The monthly Factory pool feeds the MinuteRatePeriod.

Required bridge:

`Factory conversion cost
− eligible CMT revenue credit
= net conversion cost pool`

Then:

`gross capacity minutes`

`utilisation`

`efficiency`

`productive minutes`

`actual minute rate`

`full-capacity minute rate`

`idle penalty`

The accounting layer must retain the source expense lines behind the pool.

## 26. Depreciation

Fixed assets have:

- asset code
- category
- acquisition date
- cost
- useful life
- residual value
- depreciation method
- entity
- location
- cost center
- in-service date

Default method: straight-line.

Monthly depreciation is accrued regardless of whether cash is paid.

Factory depreciation enters the Factory conversion-cost pool when classified there.

Brand assets remain Brand costs.

## 27. Fixed asset lifecycle

`Draft → Acquired → In Service → Depreciating → Fully Depreciated/Disposed`

Disposal records:

- proceeds
- accumulated depreciation
- carrying value
- gain/loss
- disposal date

## 28. Payroll posting

Payroll output posts to accounting according to employee entity/cost-center allocation.

Factory operator salaries classified in the conversion pool feed the minute-rate pool.

Brand salaries classified as Brand fixed costs feed the Brand fixed-cost pool.

No payroll amount should enter two pools.

## 29. Marketing accounting

Marketing platform spend and supplier invoices are recognized through controlled expense/accrual records.

Imported platform metrics do not automatically create duplicate accounting entries.

Marketing allocation for management unit economics follows the locked rule:

**units sold**, with documented style-specific override.

## 30. Sales accounting

A Brand sale generally produces:

`Dr Cash / AR / Payment Clearing`

`Cr Sales Revenue`

`Cr Output VAT`

and separately:

`Dr COGS`

`Cr Finished Goods Inventory`

Exact entries depend on payment/fulfillment timing and configured accounting policy.

## 31. Payment clearing

For card/COD/platform payments, use clearing accounts where settlement occurs after the sale.

Example:

Sale → Payment Clearing

Settlement → Bank

Fees → Payment Fee Expense/COGS according to policy

This allows settlement reconciliation without changing the original sale.

## 32. Returns and refunds accounting

Resellable return:

- reverse relevant sales/revenue effect
- reverse/adjust COGS according to actual returned inventory
- restock at original cost
- record return handling expense where applicable

Damaged return:

- do not return to sellable inventory
- post inventory write-off/adjustment

Refund payment movement is separate from revenue recognition.

## 33. Packaging and shipping

Brand packaging, shipping, payment fees and return handling are separately classified so management contribution reports can expose each component.

Customer-paid shipping should be distinguished from actual shipping expense.

## 34. Break-even accounting bridge

Break-even uses Brand-only fixed costs:

- showroom
- Brand salaries
- Brand rent
- Brand software
- other configured Brand fixed costs

Factory overhead is already embedded in transfer price and must not be added again.

The system must show every account included in the fixed-cost pool.

## 35. Cash conversion cycle

CCC:

`raw_material_days + production_lead_days + finished_goods_days + collection_days − supplier_credit_days`

Working capital locked:

`CCC × monthly_COGS / 30`

Raw material days are included by the locked decision.

The dashboard must show both CCC and estimated locked capital.

## 36. Management P&L

Factory P&L:

`Factory Revenue + CMT Revenue − Factory Cost of Sales − Factory Operating Expenses`

Brand P&L:

`Retail Revenue − Brand COGS − Brand Operating Expenses`

Group P&L:

`Factory + Brand − Intercompany Eliminations`

Group reporting must show the elimination bridge separately.

## 37. Management balance sheet

At minimum show:

- cash/bank by entity allocation
- receivables
- inventory by state
- fixed assets
- payables
- accruals
- VAT balances
- payroll liabilities
- intercompany balances
- equity

## 38. Cash flow

Support indirect cash-flow reporting from accrual P&L and balance-sheet movement.

Management cash dashboard should also show:

- cash available
- scheduled payments
- expected collections
- working capital locked
- inventory cash exposure

Cash is not the same as profit.

## 39. Expense allocation

Every expense must have a clear classification:

`Factory | Brand | Shared | Group`

Shared expenses require an explicit allocation method:

- fixed percentage
- headcount
- usage
- revenue
- activity
- manual approved allocation

Allocation is effective-dated and auditable.

## 40. Month-end close

Recommended close checklist:

1. import bank transactions
2. reconcile cash
3. confirm AP/AR
4. post recurring accruals
5. post payroll
6. post depreciation
7. reconcile inventory
8. confirm production/WIP
9. reconcile intercompany
10. calculate minute-rate period
11. verify sales/returns/refunds
12. reconcile VAT
13. review unusual variances
14. close period

## 41. Financial controls

The system must prevent or flag:

- unbalanced journals
- duplicate supplier invoices
- duplicate platform spend
- negative inventory unless explicitly permitted
- posting to closed periods
- intercompany mismatch
- missing expense entity
- missing cost center where required
- payroll double allocation
- transfer price below configured arm's-length floor
- inventory movement without source
- sales without valid SKU
- refund without original transaction where required

## 42. Traceability

Every financial number must be drillable:

`P&L line → account → journal → source transaction → document → calculation inputs`

For cost:

`Style cost → CostSnapshot → BOM/operations → material price history / minute rate → source purchase/expense lines`

For inventory:

`SKU balance → InventoryMovement → InventoryLot → purchase/production/transfer source`

## 43. Audit and corrections

Never edit posted financial history.

Corrections use:

- reversal
- adjustment
- new version

Every correction records reason, user, timestamp and source.

## 44. Required finance reports

1. Trial balance
2. General ledger
3. Factory P&L
4. Brand P&L
5. Group P&L
6. Group elimination bridge
7. Balance sheet
8. Cash flow
9. AP aging
10. AR aging
11. Expense register
12. VAT report
13. Bank reconciliation
14. Inventory valuation
15. Inventory aging
16. WIP report
17. Fixed asset register
18. Depreciation schedule
19. Payroll cost by entity
20. Intercompany reconciliation
21. Transfer-price report
22. Minute-rate cost bridge
23. Break-even report
24. Working-capital/CCC report
25. Scheduled cash report
26. Audit trail

## 45. Acceptance criteria

Finance is production-safe when:

- accrual accounting is the source of P&L truth
- cash is separately reconciled
- Factory and Brand remain economically separate despite one bank account
- every transaction has entity attribution
- inventory is FIFO and ledger-based
- landed material cost is capitalized correctly
- depreciation is accrued monthly
- AP aging uses due dates
- recurring expenses accrue before payment
- intercompany invoices reconcile
- unrealized intercompany inventory profit is eliminated at Group level
- external CMT revenue credits the Factory cost pool according to policy
- payroll is not double-counted
- VAT is separated from ex-VAT economics
- transfer prices cannot violate the configured floor
- closed periods are protected
- every management number can be drilled to source data
