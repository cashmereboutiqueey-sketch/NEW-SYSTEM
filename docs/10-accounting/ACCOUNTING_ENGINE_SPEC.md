# Cashmere OS — Accounting Engine Specification

**Status:** Draft for implementation
**Entities:** Factory / Brand / Group
**Accounting basis:** Accrual
**Currency:** EGP

## 1. Purpose

This is the financial source of truth for Cashmere OS. Every operational transaction must be capable of producing auditable accounting entries without requiring manual re-entry.

The system separates Factory and Brand economics while allowing Group reporting to eliminate intercompany activity and unrealised Factory profit in Brand inventory.

## 2. Core principles

1. Accrual accounting: recognise costs and revenue when incurred/earned, not when cash moves.
2. Double-entry only: every posted journal balances exactly.
3. Immutable posted entries: corrections use reversing/adjusting entries.
4. Decimal arithmetic only.
5. Entity ownership is mandatory for economic transactions.
6. Every financial number has a traceable source.
7. Subledgers reconcile to the general ledger.
8. VAT is separately identifiable.
9. Inventory movements drive inventory accounting.
10. Intercompany balances must reconcile on both sides.

## 3. Chart of Accounts

Support a configurable chart of accounts with account code, name AR/EN, type, normal balance, entity scope and reporting group.

Core account classes:

### Assets
- Cash
- Bank
- Accounts Receivable
- Inventory — Raw Materials
- Inventory — WIP
- Inventory — Finished Goods
- Inventory — Packaging
- Prepayments
- Employee Advances
- Fixed Assets
- Accumulated Depreciation
- Other Receivables

### Liabilities
- Accounts Payable
- Payroll Payable
- VAT Payable
- VAT Recoverable where applicable
- Accrued Expenses
- Customer Deposits
- Employee Loans Payable/related balances where applicable
- Intercompany Payable

### Equity
- Owner Capital
- Retained Earnings
- Current Period Result
- Owner Drawings / Distributions

### Revenue
- Brand Product Sales
- Factory CMT Revenue
- Other Operating Revenue
- Sales Returns
- Sales Discounts

### Cost of Sales
- Brand Transfer-Price COGS
- Factory Material Cost
- Factory Conversion Cost
- Inventory Adjustments
- Scrap / Write-off
- Return Handling

### Operating Expenses
- Brand Marketing
- Brand Shipping
- Payment Fees
- Brand Salaries
- Showroom Expenses
- Rent
- Utilities
- Software
- Professional Fees
- Factory Administration
- Maintenance
- Other Operating Expenses

The exact COA is configurable, but reporting mappings must remain stable.

## 4. Journal structure

A JournalEntry contains:

- entry ID
- entity
- posting date
- accounting period
- source type
- source ID
- description
- status
- created by
- approved by where required
- created timestamp

JournalLine contains:

- account
- debit
- credit
- currency
- entity
- cost center
- department
- dimensions
- source reference

Validation:

`SUM(debits) = SUM(credits)`

No posted journal may violate this rule.

## 5. Accounting periods

Periods have:

`Open → Soft Close → Closed`

Closed periods reject normal postings.

A correction after close creates an adjusting entry in the permitted period.

## 6. Source documents

Every journal must reference a source transaction such as:

- supplier invoice
- expense
- purchase order/receipt
- production order
- material issue
- inventory movement
- Brand sale
- POS sale
- Shopify order
- moderator order
- customer refund
- payroll
- fixed asset
- depreciation
- bank transaction
- intercompany invoice
- owner distribution

## 7. Accounts Payable

Supplier invoices are accrued when goods/services are received or expense is incurred according to the accounting policy, not merely when cash is paid.

Typical purchase of raw material:

`Dr Raw Material Inventory`

`Cr Accounts Payable`

Payment:

`Dr Accounts Payable`

`Cr Bank/Cash`

## 8. AP aging

Aging is based on due date.

Buckets:

- Current
- 1–30
- 31–60
- 61–90
- 90+

Partial payments reduce the outstanding balance without changing the original invoice.

## 9. Accrued expenses

Recurring monthly costs such as rent, salaries and utilities can be accrued at period open/close even when the supplier invoice has not arrived.

Example:

`Dr Rent Expense`

`Cr Accrued Expenses`

When the invoice arrives, reconcile the accrual rather than creating duplicate expense.

## 10. Accounts Receivable

Credit sales create receivables where applicable.

Cash/card/COD settlement reduces the appropriate receivable or clearing account.

AR aging uses due date.

## 11. Brand sales

For a Brand sale, the system separates:

- gross retail price
- discount
- net selling price
- VAT component if applicable
- returns/refunds
- payment fee
- shipping
- inventory COGS

The exact journal depends on channel and payment state.

## 12. Shopify / POS / Moderator sales

All Brand channels feed the same accounting model.

Sources:

- Shopify
- Alexandria POS
- Cairo POS
- Bazaar POS/event sales
- Moderator-created social orders

A channel is not an accounting entity.

Idempotency is mandatory: importing the same external order twice must not duplicate revenue, payment, inventory or COGS.

## 13. Sales returns

A resellable return:

- reverses relevant revenue/receivable components
- restores finished goods at the original inventory cost
- records return handling cost separately

A damaged return writes inventory off according to policy.

## 14. VAT

All product prices are stored according to the configured ex-VAT/inclusive policy.

The system must support VAT rate configuration and separate:

- output VAT
- recoverable input VAT where applicable
- VAT payable/receivable

The current configured rate is 14%, but the rate must never be hard-coded into historical entries.

VAT reports must reconcile to posted tax lines.

## 15. Inventory accounting

Inventory is a perpetual ledger.

Inventory states:

`Raw Material → WIP → Finished Goods → Sold/Returned/Write-off`

Every movement has:

- lot
- SKU/material
- quantity
- unit cost
- total value
- source
- timestamp
- from location/state
- to location/state

Inventory balance is reconstructible from movements.

## 16. FIFO valuation

Use FIFO by InventoryLot for valuation.

When inventory is consumed/sold, the system consumes oldest eligible lots first.

A sale COGS entry must identify the lots consumed.

## 17. Raw material receipt

Typical receipt:

`Dr Raw Material Inventory`

`Dr Recoverable Input VAT` where applicable

`Cr Accounts Payable`

Freight and clearing capitalised into material effective cost must increase inventory cost rather than create a normal-period expense.

## 18. Material issue to production

When raw material is issued to a production order:

`Dr WIP / Production Cost`

`Cr Raw Material Inventory`

Actual material usage remains traceable to MaterialIssue and cutting ticket.

## 19. WIP

WIP represents accumulated production cost for incomplete work.

The system should support material and conversion components so WIP can be reconciled to production orders.

## 20. Finished goods completion

When production is completed:

`Dr Finished Goods Inventory`

`Cr WIP`

The completed cost must come from the production-order cost engine and approved actual/variance policy.

## 21. Brand transfer purchase

Factory invoices Brand at the frozen transfer price.

Factory:

`Dr Intercompany Receivable`

`Cr Factory CMT Revenue`

Brand:

`Dr Finished Goods Inventory`

`Cr Intercompany Payable`

The Brand's landed COGS is therefore the transfer price.

## 22. Factory margin

Transfer price is:

`Factory Total Cost × (1 + Factory Margin)`

Factory margin must respect the configured arm's-length floor.

A below-floor override requires explicit authorization and audit reason.

## 23. Intercompany reconciliation

For every Factory/Brand period:

`Factory Intercompany Receivable = Brand Intercompany Payable`

Differences must be visible and explainable before Group close.

## 24. Group elimination

Group P&L eliminates:

- Factory intercompany revenue
- Brand transfer-price cost
- intercompany receivable/payable

But elimination must also remove unrealised Factory profit embedded in unsold Brand inventory.

Example:

Factory produces 1,000 units with transfer margin.
Brand sells 400.
Profit on 600 unsold units remains embedded in Brand inventory and is eliminated from Group profit until those units are sold externally.

## 25. Unrealised profit elimination

The system must calculate the Factory margin component contained in Brand inventory lots.

Group elimination:

`Dr Group COGS / inventory profit elimination`

`Cr Inventory`

or equivalent consolidation presentation, preserving the underlying entity ledgers.

When the Brand later sells the inventory externally, the previously deferred profit is released through the consolidation layer.

Entity ledgers are never rewritten for Group consolidation.

## 26. Factory CMT revenue credit

External CMT revenue can credit the Factory cost pool according to the locked operating model.

The MinuteRatePeriod stores:

- gross capacity
- utilisation
- efficiency
- factory cost pool
- external CMT revenue credit
- net cost pool
- resulting rates

This allows external CMT activity to reduce the effective burden on Brand production without pretending the external order is a normal Brand sale.

## 27. Minute rate accounting connection

The accounting engine must expose:

`Minute Rate → Cost Pool → Payroll / Rent / Utilities / Depreciation / Maintenance / Factory Admin`

Material costs are excluded from the conversion pool because they enter style costing separately.

## 28. Fixed assets

Fixed assets include:

- machine equipment
- sewing machines
- cutting equipment
- furniture
- computers
- showroom fixtures
- other qualifying assets

Asset fields:

- acquisition date
- supplier
- cost
- useful life
- residual value
- depreciation method
- entity
- location
- asset category
- status

## 29. Depreciation

Default method: straight line.

Monthly depreciation is accrued automatically according to asset schedule.

Typical entry:

`Dr Depreciation Expense`

`Cr Accumulated Depreciation`

Factory assets feed Factory conversion cost where appropriate.

Brand assets feed Brand operating costs where appropriate.

## 30. Cash and bank

Support multiple cash/bank accounts.

Every payment/receipt must identify:

- account
- date
- amount
- source
- entity
- counterparty
- reconciliation status

## 31. Bank reconciliation

Import bank transactions where integration is available.

Match against:

- supplier payments
- payroll
- customer receipts
- transfers
- fees
- other transactions

Unmatched items remain reconciliation exceptions.

## 32. Payment clearing

Card, COD and other channels may use clearing accounts.

Example:

`Sale → Payment Clearing`

then:

`Settlement → Bank`

Payment fees are separately recorded and tied to the SalesChannel.

## 33. Owner drawings

Owner drawings are not business expenses.

Typical entry:

`Dr Owner Drawings / Equity`

`Cr Bank/Cash`

No Factory or Brand P&L impact.

Owner salary for actual work is a payroll expense and follows HR/payroll rules.

## 34. Expense capture

Provide a central expense workspace where the user can enter:

- expense date
- incurred date
- due date
- supplier/payee
- amount
- VAT
- category/account
- entity
- cost center
- recurring/non-recurring
- attachment
- payment status
- payment method
- approval

This is the main place to answer: **"المصروف ده بتاع البراند ولا المصنع؟"**

Entity is mandatory unless explicitly marked Group/shared.

## 35. Shared expenses

A shared expense must have an allocation rule.

Supported methods:

- fixed percentage
- headcount
- usage
- revenue share
- custom allocation

The system creates entity-level allocation lines while retaining the original source expense.

Example:

`EGP 100,000 shared software`

`Factory 40,000`

`Brand 60,000`

No shared expense may silently land in one entity.

## 36. Expense approval

Expense workflow:

`Draft → Submitted → Approved → Posted → Paid`

Approval threshold is configurable.

## 37. Prepayments

Prepaid expenses are assets until consumed.

Example annual insurance:

At payment:

`Dr Prepaid Expense`

`Cr Bank`

Monthly recognition:

`Dr Insurance Expense`

`Cr Prepaid Expense`

## 38. Accrual reversals

Recurring accruals should be reversible and reconciled against actual invoices.

Never allow duplicate expense recognition merely because both accrual and invoice exist.

## 39. Profit & Loss views

### Factory P&L

Revenue:
- Brand transfer revenue
- External CMT revenue

Costs:
- Materials
- Conversion cost
- Factory operating expenses

Result:
- Factory gross/operating profit
- margin

### Brand P&L

Revenue:
- retail sales
- less discounts
- less returns

Costs:
- transfer-price COGS
- packaging
- shipping
- payment fees
- marketing
- return handling
- Brand fixed costs

### Group P&L

External revenue only.

Eliminate:
- intercompany Factory revenue
- Brand transfer-price cost
- unrealised intercompany profit in inventory

## 40. Balance sheet

Support at minimum:

- cash/bank
- receivables
- inventory by state
- fixed assets/net book value
- payables
- payroll payable
- VAT balances
- accruals
- intercompany balances
- equity

## 41. Cash flow

Provide operating, investing and financing classifications.

Cash flow must be based on actual cash movements, not merely P&L.

Useful operating metrics:

- cash from operations
- supplier payments
- payroll payments
- marketing payments
- inventory investment
- customer collections

## 42. Cash Conversion Cycle

`CCC = raw_material_days + production_lead_days + finished_goods_days + collection_days − supplier_credit_days`

Working capital locked:

`CCC × (monthly COGS / 30)`

The dashboard shows both days and EGP locked.

## 43. Inventory ageing

Finished goods age buckets:

- 0–30
- 31–60
- 61–90
- 90+

Show quantity, cost value and percentage of finished-goods inventory.

Dead-stock threshold is configurable.

## 44. Trial balance

Trial balance must support:

- entity
- period
- account
- debit
- credit
- closing balance

It must balance before period close.

## 45. Financial statements

Generate:

- Profit & Loss
- Balance Sheet
- Cash Flow
- Trial Balance
- General Ledger
- AP Aging
- AR Aging
- VAT summary
- Inventory valuation
- Intercompany reconciliation

All statements are drillable to source transactions.

## 46. Closing process

Recommended month-end checklist:

1. Attendance/payroll close
2. Inventory movements complete
3. Production orders reconciled
4. Supplier invoices/accruals reconciled
5. Customer returns/refunds reconciled
6. Bank reconciliation
7. VAT review
8. Depreciation posted
9. Intercompany reconciliation
10. Inventory ageing review
11. Group unrealised-profit elimination
12. Trial balance review
13. P&L/Balance Sheet approval
14. Period close

## 47. Audit trail

For every posted financial number expose:

`Report → Account → Journal Entry → Source Transaction → Operational Detail`

Examples:

`Factory Minute Rate → Factory Cost Pool → Rent Expense → Supplier Invoice → Payment`

`Brand COGS → Transfer Invoice → Production Order → Cost Snapshot → BOM / SMV / Minute Rate`

`Inventory → FIFO Lot → Goods Receipt → Supplier Invoice`

## 48. Accounting dimensions

Every relevant entry may carry:

- entity
- department
- cost center
- location
- channel
- collection
- product/style
- SKU
- production order
- campaign

This enables management reporting without creating hundreds of duplicate GL accounts.

## 49. Corrections

Posted entries cannot be edited.

Correction types:

- reversal
- adjusting journal
- credit note
- debit note
- inventory adjustment with reason

Original and correction remain linked.

## 50. Accounting controls

Hard controls:

- balanced journals only
- closed periods protected
- mandatory entity on P&L transactions
- mandatory source for system-generated entries
- no negative inventory unless explicitly configured and alerted
- no duplicate external order posting
- no below-floor transfer price without approval
- no unallocated shared expense posting
- intercompany mismatch visible
- inventory subledger must reconcile to GL

## 51. Acceptance criteria

Accounting is complete when:

- every major operational module can post or feed an auditable financial transaction
- Factory and Brand have separate books within one system
- Group consolidation eliminates intercompany activity correctly
- unrealised Factory profit in unsold Brand inventory is eliminated
- FIFO inventory valuation is supported
- AP/AR are accrual-based and aged by due date
- recurring expenses can accrue before invoices arrive
- payroll accrues before payment
- fixed assets depreciate automatically
- VAT is separately tracked
- shared expenses are allocated explicitly
- owner drawings do not pollute P&L
- Shopify/POS/Moderator sales reconcile without duplicates
- inventory movements reconcile to accounting
- financial statements drill to source records
- posted entries are immutable
- month-end close is controlled and auditable
