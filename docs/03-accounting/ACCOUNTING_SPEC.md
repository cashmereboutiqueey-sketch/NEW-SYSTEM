# Cashmere OS — Accounting Specification

**Status:** Draft for implementation
**Authority:** Master Specification v1
**Accounting basis:** Accrual
**Currency:** EGP
**Tax presentation:** Ex-VAT internally; VAT 14% calculated at display/reporting unless the commercial tax-inclusive pricing decision is explicitly changed.

---

## 1. Purpose

The accounting engine exists to show the economic reality of the Factory, the Brand, and the Group separately while preserving a complete audit trail from financial statement numbers back to operational events.

The system must never confuse cash movement with economic activity. A cost is recognized when incurred; payment settles the liability later.

The accounting engine is therefore an event-driven subledger and general-ledger system, not a cash-book replacement.

---

## 2. Legal/management entities

### 2.1 Factory

- Contract manufacturer.
- Current customer: Brand.
- May later serve external CMT customers.
- Records manufacturing revenue and factory costs.
- Issues an internal invoice to Brand for every confirmed production order.

### 2.2 Brand

- Owns the consumer-facing commercial operation.
- Purchases finished goods from Factory at arm's-length transfer price.
- Sells through Shopify, moderator-entered social orders, POS/showrooms, bazaars/exhibitions, and future channels.
- Bears Brand-only commercial and fixed costs.

### 2.3 Group

- Management consolidation of Factory + Brand.
- Eliminates intercompany balances, revenue, COGS, and unrealized profit in unsold finished goods.
- Never treats internal Factory-to-Brand invoicing as external Group revenue.

---

## 3. Chart of accounts principles

The chart of accounts must support:

- Assets
- Liabilities
- Equity
- Revenue
- Cost of goods sold
- Factory conversion costs
- Brand variable selling costs
- Brand fixed costs
- Marketing
- Other income/expense
- VAT receivable/payable
- Intercompany balances
- Inventory by state
- Fixed assets and accumulated depreciation
- Owner distributions

Accounts must have:

- entity scope
- account type
- parent account
- active/inactive state
- reporting category
- cost-center compatibility
- tax behavior where applicable
- whether the account may enter Factory cost pool
- whether the account may enter Brand fixed-cost pool

No business calculation may hardcode an account number.

---

## 4. Double-entry rule

Every posted accounting event must balance:

`Σ debits = Σ credits`

Journal entries are immutable after posting. Corrections are reversing/adjusting entries linked to the original entry.

Draft journals may be edited. Posted journals may not.

Every posted entry must carry:

- source event type
- source record ID
- entity
- period
- posting date
- currency
- lines
- created by
- approval status where required
- audit timestamp

---

## 5. Accrual expense lifecycle

An expense may exist before an invoice and may be paid in multiple installments.

### States

`Draft → Accrued → Approved → Partially Paid → Paid`

A recurring expense such as rent or salary is accrued at period open even if the supplier invoice has not arrived.

### Core fields

- amount ex-VAT
- VAT amount
- incurred date
- due date
- supplier
- entity
- cost center
- expense category
- payment status
- paid amount
- remaining AP balance
- supporting document

AP aging uses **due date**, not incurred date.

### Example

Factory rent of EGP 55,000 for March is incurred on March 1 and due March 10.

March P&L recognizes the expense on accrual, even if payment occurs April 5.

---

## 6. Payments

A payment settles an existing payable/receivable. It does not create the underlying expense or revenue.

One liability may have many payments.
One payment may allocate across multiple documents where explicitly supported.

Payment methods include configurable bank/cash accounts and electronic methods.

Bank reconciliation must compare bank transactions with recorded payments without rewriting the underlying accounting event.

---

## 7. Recurring costs

Recurring monthly costs are generated as accruals at period open.

Examples:

- factory rent
- showroom rent
- salaries
- software subscriptions
- utilities where predictable
- depreciation
- recurring service contracts

Each recurring template has:

- entity
- account
- cost center
- amount or calculation rule
- effective start/end dates
- frequency
- due-day rule
- VAT behavior
- approval rule

---

## 8. Factory cost pool

`total_factory_monthly_cost` is **conversion cost only**.

Included:

- direct sewing labor carried by factory payroll
- factory rent
- utilities
- depreciation
- maintenance
- factory administration
- other approved conversion overhead

Excluded:

- fabric
- trims
- packaging belonging to Brand
- Brand marketing
- Brand showroom costs
- owner drawings

Materials enter product cost through the BOM/material costing engine and are therefore never included in the minute-rate conversion pool.

### 8.1 Depreciation

Depreciation is an accrued real cost.

Assets use straight-line schedules unless a later approved policy adds another method.

Each asset must preserve:

- acquisition cost
- acquisition date
- useful life
- residual value
- depreciation method
- monthly depreciation
- accumulated depreciation
- net book value
- entity
- cost center

---

## 9. Cost centers

At minimum:

### Factory
- factory overhead
- production lines
- maintenance
- cutting
- finishing
- quality
- factory administration
- external CMT

### Brand
- Alexandria showroom/warehouse
- Cairo store
- online commerce
- marketing
- customer service/moderators
- management
- software
- exhibitions/bazaars

A cost must have a cost-center assignment or an explicit allocation rule.

---

## 10. Intercompany accounting

Factory-to-Brand transactions are real entity-level transactions.

Factory:

`Dr Intercompany Receivable — Brand`
`Cr Factory Revenue — Transfer Sales`

Brand:

`Dr Finished Goods Inventory / COGS`
`Cr Intercompany Payable — Factory`

Settlement clears the intercompany balance.

The Group view eliminates:

1. intercompany revenue
2. intercompany COGS/inventory cost component
3. intercompany receivable/payable
4. unrealized Factory margin embedded in unsold Brand inventory

---

## 11. Unrealized intercompany profit

For every Brand finished-goods lot originating from Factory, the system retains:

- Factory cost
- transfer price
- Factory margin component
- quantity received
- quantity sold
- quantity remaining

At Group reporting time:

`unrealized_profit = remaining_units × per_unit_factory_margin_embedded`

This amount is eliminated from Group profit and from the Group inventory carrying amount until the unit is sold externally.

When the Brand sells the unit to a customer, the corresponding portion of Factory margin becomes realized at Group level.

The elimination must be lot-aware and quantity-aware.

---

## 12. Owner transactions

Owner drawings/distributions are **not expenses**.

They reduce equity/capital or are posted to the appropriate distribution account.

A salary paid to the owner for actual work is an expense only when there is a documented employment/compensation arrangement and the work is genuinely performed.

The UI must prevent accidental classification of drawings as operating expense.

---

## 13. VAT

Internal accounting values are stored ex-VAT.

VAT is represented separately so that:

- revenue is not inflated by VAT
- purchase cost is not silently inflated by recoverable VAT
- VAT payable/receivable can be reconciled

Current configured rate: **14%**.

Tax-inclusive retail pricing remains a business configuration decision and must not be assumed by the calculation engine.

---

## 14. Financial statements

### Factory P&L

- external CMT revenue
- Brand transfer revenue
- material consumption
- factory conversion cost
- gross/operating result
- other income/expense

### Brand P&L

- external revenue
- transfer-price COGS
- packaging
- shipping
- payment fees
- marketing
- return handling
- Brand fixed costs
- operating result

### Group P&L

- external customer revenue only
- external COGS at Group economic cost
- Group operating expenses
- realized profit
- eliminated unrealized intercompany margin

The Group view must never double-count Factory overhead through both transfer price and a second Brand allocation.

---

## 15. AP and AR aging

AP and AR aging buckets are based on due date.

Default buckets:

- Current
- 1–30
- 31–60
- 61–90
- 90+

Aging reports must drill down to document, supplier/customer, entity, due date, original amount, paid amount, and remaining balance.

---

## 16. Accounting traceability

Every financial number must expose its parent chain.

Example:

`Factory P&L → Factory conversion cost → Factory cost pool → utilities expense → supplier invoice → payment`

Example:

`Brand COGS → transfer-price lot → CostSnapshot → BOM line → material lot → purchase receipt → supplier invoice`

No dashboard number may be a black box.

---

## 17. Period close

A period may be:

`Open → Closing → Locked`

Locking prevents ordinary edits to:

- posted journals
- cost snapshots
- inventory valuation events
- minute-rate periods
- historical sales cost

Corrections after close use adjustment entries in the permitted correction period and reference the original record.

---

## 18. Required accounting reports

1. Factory P&L
2. Brand P&L
3. Group P&L
4. Trial balance
5. General ledger
6. AP aging
7. AR aging
8. Cash/bank position
9. VAT summary
10. Expense by entity
11. Expense by cost center
12. Factory cost-pool composition
13. Brand fixed-cost pool composition
14. Intercompany reconciliation
15. Unrealized intercompany profit elimination
16. Inventory valuation
17. Owner distributions
18. Cash-flow forecast
19. Capital locked by inventory state
20. Audit trail

---

## 19. Accounting controls

The system must block or warn on:

- unbalanced journal
- posting to locked period
- negative inventory where policy forbids it
- transfer price below arm's-length floor
- expense with no entity
- expense with no cost center where required
- VAT inconsistency
- payment greater than outstanding payable
- duplicate supplier invoice
- duplicate intercompany invoice
- deleting posted financial records
- changing historical cost snapshots

---

## 20. Acceptance criteria

The accounting engine is considered correct only when:

- every posted event balances
- cash and accrual views reconcile
- Factory and Brand ledgers reconcile with intercompany balances
- Group elimination removes both intercompany trade and unrealized margin
- AP aging is based on due dates
- locked periods cannot be rewritten
- every report can drill to source transactions
- owner drawings never inflate operating expenses
- VAT is separated from ex-VAT economics
- Factory cost pool cannot accidentally contain materials
