# Cashmere OS — Master Specification v1.0

**Status:** Draft for implementation
**Source of truth:** This document is the canonical business and technical specification for Cashmere OS. Code must not invent business rules that contradict it.
**Language:** Arabic primary, English secondary. `dir="rtl"` by default.
**Currency:** EGP. Money is stored ex-VAT unless explicitly stated otherwise.
**Tenant model:** Single tenant initially; architecture must not prevent future multi-tenant extraction.

---

## 1. Product Definition

Cashmere OS is an accrual-based operating and financial system for a fashion business consisting of two economically separate entities owned by the same owner:

1. **Factory / المصنع** — contract manufacturer. It currently has one customer: the Brand. It buys raw materials, manufactures garments, and invoices the Brand at an arm's-length transfer price.
2. **Brand / البراند** — Cashmere Boutique. It buys finished goods from the Factory, sells through website, moderator/social orders, showrooms, POS, bazaars/exhibitions and future channels.
3. **Group / المجموعة** — consolidated view that eliminates intercompany revenue/cost and unrealised intercompany profit in unsold inventory.

The system exists to answer the owner's core question: **Where is the money, what created or consumed it, and which entity/product/channel/customer is actually profitable?**

The accounting model is accrual-based: a cost is recognized when incurred, regardless of whether it has been paid.

### Primary operating lenses

The header must provide a switchable entity lens:

- المصنع — Factory
- البراند — Brand
- المجموعة — Group

The same underlying ledger and transactions are filtered or consolidated by entity; the system must not duplicate facts merely to present different lenses.

---

## 2. Business Structure

### 2.1 Factory economics

The Factory buys fabric and trims, incurs conversion costs, manufactures garments and sells finished goods to the Brand. Every production order can generate an internal invoice to the Brand.

Factory conversion cost includes:

- Direct sewing labour paid as salary
- Factory rent
- Utilities
- Depreciation
- Maintenance
- Factory administration
- Other configured factory conversion overhead

Factory conversion cost **excludes fabric and trims**, because materials enter style cost separately.

Owner drawings are distributions, never an expense. A salary paid to the owner for actual work is an expense.

### 2.2 Brand economics

The Brand purchases finished goods from the Factory at transfer price. Transfer price is the Brand's landed cost of goods before Brand-only costs.

Brand costs include, where applicable:

- Packaging
- Shipping
- Payment fees
- Marketing
- Return handling
- Brand salaries
- Showroom/store rent
- Brand software
- Other Brand fixed and variable costs

### 2.3 Arm's-length transfer price

Default formula:

```text
factory_total_cost = material_cost + cmt_cost
transfer_price = factory_total_cost × (1 + factory_margin)
```

`factory_margin` is the same margin the Factory would quote an outside customer. The system must enforce a configurable minimum floor.

A per-style margin override is permitted but must be visibly flagged as an override and cannot violate the configured minimum floor unless an explicit owner-level exception workflow is introduced later.

### 2.4 Group consolidation

Group P&L:

```text
Group P&L = Factory P&L + Brand P&L
            − intercompany revenue/cost
            − unrealised intercompany profit in unsold inventory
```

If the Factory invoices 1,000 units and the Brand sells 400, profit attached to the remaining 600 units is unrealised at Group level and remains embedded in inventory.

The consolidation engine must identify the intercompany profit component in inventory lots and eliminate it until the relevant goods are sold externally.

---

## 3. Product Model

### 3.1 Hierarchy

```text
Season
  → Collection
    → Style
      → Variant
        → SKU
```

### 3.2 Collection

A Collection groups styles launched or planned together. Collection must be a first-class entity and must support:

- season
- launch date
- status
- target audience
- planned budget
- campaign linkage
- sales performance
- sell-through
- markdowns
- collection-level profitability

### 3.3 Style

Style is the base garment design and the primary costing level.

Style contains:

- name/code
- collection
- planned waste rate
- trailing actual waste rate
- SMV operations
- BOM
- retail pricing
- transfer price/costing references
- default discount and return assumptions
- status

### 3.4 Variant and SKU

Variant = colour × size.

SKU format:

```text
[STYLENAME]-[COLORCODE]-[SIZE]
```

Uppercase. Exactly the configured ten colour codes are allowed. Sizes are configurable.

Size-based consumption differences are handled through a per-size BOM consumption multiplier, default `1.0`, rather than separate BOMs.

### 3.5 Material-to-product relationships

A finished product may consume multiple different fabrics/materials.

A single fabric/material may be used by many different products/styles.

Therefore BOM must model a many-to-many relationship through BOM lines, including:

- material
- quantity per unit
- unit of measure
- size multiplier
- planned waste
- effective date/version

---

## 4. Material and Procurement Model

### 4.1 Material units

Fabric is normally measured in metres. Trims are normally measured in pieces. Unit of measure must remain configurable per material.

### 4.2 Landed material cost

```text
material_effective_cost = purchase_price + freight + customs/clearing
```

Freight and customs/clearing capitalized into material cost; they are not factory overhead.

### 4.3 Material master

Material supports:

- code
- name
- category
- unit
- supplier(s)
- purchase price history
- freight rate
- customs/clearing components
- MOQ
- pack size
- active status
- reorder parameters

### 4.4 Procurement flow

```text
Supplier
  → RFQ (optional)
  → Purchase Order
  → Goods Receipt
  → Inventory Lot
  → Supplier Invoice / AP
  → Payment
```

Purchase price variance must be captured at goods receipt/invoice level so changes such as 95 → 112 EGP/m can be traced to their effect on product cost.

Supplier scorecard must cover price, quality and delivery.

---

## 5. Cost Engine

### 5.1 Capacity formulas

Two different operational diseases must remain separate:

- **Utilisation:** lack of booked work / machine idle time; primarily a sales/capacity planning problem.
- **Efficiency:** operators taking more clock time than the earned standard time; primarily a shop-floor productivity problem.

```text
gross_available_minutes = operators × working_days × hours_per_day × 60
productive_minutes = gross_available_minutes × utilisation × efficiency
actual_minute_rate = net_cost_pool / productive_minutes
full_capacity_minute_rate = net_cost_pool / gross_available_minutes
idle_penalty_per_minute = actual_minute_rate − full_capacity_minute_rate
idle_penalty_per_unit = idle_penalty_per_minute × style_smv
```

The system must retain the historical `MinuteRatePeriod` for each entity/month, including capacity inputs, cost pool, rates and `locked_at`.

A production order costed in March permanently references March's frozen rate. Recomputing August must never alter March.

### 5.2 CMT revenue credit

External CMT revenue is credited against the Factory conversion cost pool before calculating the Brand-facing minute rate, because selling otherwise-idle capacity genuinely lowers the economic burden carried by the Brand.

The system must show both gross factory cost pool and net cost pool after CMT revenue credit.

CMT pricing may never fall below `full_capacity_minute_rate` unless an explicit owner-authorized exception exists.

### 5.3 Style costing

```text
effective_consumption = standard_consumption × (1 + waste_rate)
fabric_cost = effective_consumption × material_effective_cost
material_cost = fabric_cost + Σ(trim_qty × trim_cost)
cmt_cost = smv_minutes × minute_rate
factory_total_cost = material_cost + cmt_cost
transfer_price = factory_total_cost × (1 + factory_margin)
```

SMV is the sum of `StyleOperation` rows and is drillable operation-by-operation.

### 5.4 Waste

Every cutting ticket/material issue records actual metres issued against standard metres required for the quantity cut.

```text
actual_waste_rate = (actual_issued / standard_required) − 1
```

Style keeps:

- `planned_waste_rate`
- `actual_waste_rate_trailing`

Costing uses planned waste at snapshot time. Actual waste is used for variance analysis and alerts. Historical snapshots are never rewritten.

### 5.5 Immutable cost snapshot

At production-order confirmation, freeze:

- every BOM line quantity
- every material price
- landed-cost components
- planned waste
- SMV
- minute rate
- minute-rate period
- conversion subtotal
- material subtotal
- factory total cost
- factory margin
- transfer price

`CostSnapshot` is append-only. Corrections are adjustment records referencing the original snapshot.

---

## 6. Brand Unit Economics and Pricing

### 6.1 Brand unit economics

```text
net_price = retail_price × (1 − discount_rate)
effective_revenue = net_price × (1 − return_rate)
variable_cost = transfer_price + packaging + shipping + payment_fee
                + marketing_per_unit + return_handling_cost
contribution_margin = effective_revenue − variable_cost
break_even_units = allocated_fixed_costs / contribution_margin
break_even_pct = break_even_units / production_run_qty
```

Allocated fixed costs are **Brand-only** fixed costs: showrooms, Brand salaries, Brand rent, software and other explicitly included costs. Factory overhead is already absorbed into transfer price and must not be counted again in this pool.

The UI must expose every member of the fixed-cost pool and the reason it is included.

Break-even must be shown as units and as a percentage of the production run, e.g. `340 units = 62% of run`. Anything above 60% is flagged red.

If contribution margin is zero or negative, break-even is reported as unavailable/never achieved rather than producing a misleading number.

This contribution measure is intentionally distinguished from textbook CVP because transfer price contains absorbed factory fixed overhead. Group P&L remains the authoritative view of true fixed/variable behavior.

### 6.2 Brand pricing calculator

The Brand must have a pricing workspace/calculator where the owner can enter or select:

- transfer-price COGS
- packaging
- shipping
- payment fee by sales channel
- marketing per unit or allocated marketing
- return handling
- Brand overhead allocation
- desired profit margin

The calculator returns:

- minimum price
- target price
- gross margin
- contribution margin
- profit per unit
- break-even units
- break-even percentage
- price sensitivity/scenario comparison

Retail prices are stored ex-VAT until the unresolved VAT-inclusion decision is formally locked.

### 6.3 Factory pricing

Factory pricing must separately show:

- material cost
- conversion cost
- minute rate
- SMV
- margin
- transfer price
- full-capacity floor
- idle-capacity penalty

---

## 7. Inventory and Capital Tracking

### 7.1 Warehouse/location model

The Brand has multiple physical stock locations/channels:

1. **Alexandria Brand Warehouse / Showroom** — the Alexandria showroom is also the Brand's warehouse and stock is sold directly from it.
2. **Cairo Store** — separate physical Brand location.
3. **Bazaars / Exhibitions** — temporary locations used for 2–3 day selling events; stock is transferred to the event location and reconciled back afterward.
4. Future warehouses/locations must be configurable.

### 7.2 Online order fulfillment

Orders generated by the website/Shopify and orders entered by the social-media moderator must be fulfillable from the appropriate Brand warehouse, normally the Alexandria showroom/warehouse unless configured otherwise.

The source of the order must remain visible.

### 7.3 Inventory states

```text
Raw Materials → WIP → Finished Goods
```

Every movement is an `InventoryMovement` against an `InventoryLot`. Balances are reconstructible from the ledger.

### 7.4 FIFO

Inventory valuation uses FIFO by lot.

Lot contains:

- receipt date
- source transaction
- quantity received
- quantity remaining
- unit cost
- total cost
- entity
- warehouse/location

### 7.5 Finished-goods aging

Per SKU:

- 0–30
- 31–60
- 61–90
- 90+

Each bucket displays quantity, cost and capital locked. Dead-stock threshold is configurable.

### 7.6 Capital tracker

The system must explicitly track where cash is tied up:

- raw material purchased but not yet consumed
- WIP
- finished goods unsold
- stock at showroom
- stock at Cairo store
- stock at temporary bazaar/exhibition
- stock reserved for orders
- receivables
- supplier-credit coverage

Example question the system must answer:

> Fabric bought for 10 pieces → 4 produced → 2 sold. Where is the remaining capital?

The system must distinguish:

- remaining raw material value
- WIP value
- finished-goods value
- sold units' realized COGS
- realized profit
- unsold inventory capital

Profit from sold units must not be presented as if the entire purchased fabric cost has been consumed.

### 7.7 Returns

Default returned goods are re-sellable and return to finished goods at original cost. Return handling cost is recorded separately. Damaged returns follow a write-off path.

---

## 8. Manufacturing / MRP / MES

### 8.1 Manufacturing flow

```text
Collection / Style
  → BOM + Operations
  → Demand / Run Plan
  → MRP
  → Material Reservation
  → Production Order
  → Cutting
  → Sewing / Lines
  → QC
  → Rework or Scrap if required
  → Finished Goods Receipt
```

### 8.2 Production order

Production order must carry:

- style/variant
- planned quantity
- planned material consumption
- planned SMV/minutes
- frozen cost snapshot
- actual material consumption
- actual minutes
- actual output
- scrap
- rework
- QC result
- stage history
- warehouse receipt

### 8.3 Planned vs actual

The system compares planned vs actual for:

- fabric/metres
- trims
- minutes
- output
- scrap
- rework
- cost

### 8.4 Capacity planning

Capacity bookings must exist before production execution. Capacity is tracked by line and month.

### 8.5 Production stages

Production stage logs must support at minimum:

- cutting
- sewing
- finishing/pressing
- QC
- packing

Line efficiency and operator productivity are separately measurable.

### 8.6 Scrap

Scrap record must capture:

- quantity
- reason
- stage
- disposition: discarded, sold, reused, sampled or other configured disposition
- value
- authorization

### 8.7 Rework

Rework record must capture:

- reason
- quantity
- minutes
- cost
- stage
- responsible line/operator where appropriate

---

## 9. MRP

MRP is tailored to fashion production and must calculate demand from planned production, existing inventory, reservations, open purchase orders and supplier constraints.

It must account for:

- BOM quantity
- size multiplier
- planned waste
- current stock
- open PO quantities
- MOQ
- pack size
- lead time
- safety stock if configured

MRP output must distinguish:

- already available
- reserved
- on order
- shortage
- recommended purchase quantity
- recommended production timing

---

## 10. Sales and Order Management

### 10.1 Unified Order Engine

All Brand sales must enter one order engine, regardless of source:

- Shopify website
- Social-media/DM moderator orders
- POS showroom sales
- Bazaar/exhibition sales
- Wholesale/future channels

Every order must retain its `SalesChannel`, source, operator/moderator, location, fulfillment location and payment information.

### 10.2 Shopify

Shopify is the Brand's website storefront. It is **not** the source of truth for all orders because social-media orders are manually entered by the moderator.

Integration requirements:

- import website orders
- sync products/variants/SKUs
- sync inventory quantities
- import cancellations
- import refunds/returns where supported
- preserve Shopify order ID as external reference
- prevent duplicate imports through idempotency keys
- record sync status and errors

Shopify is an external channel, not the master accounting ledger.

### 10.3 Moderator orders

A moderator handles customers arriving from Instagram/Facebook/other social DMs and manually creates the order in Cashmere OS.

The order must record:

- moderator/user who created it
- source channel
- customer
- timestamp
- products/variants
- discount
- payment method
- shipping
- fulfillment status
- cancellation/return status

Moderator performance metrics:

- chats handled if entered/available
- orders created
- conversion rate where denominator data exists
- sales value
- average order value
- return rate
- cancellation rate

### 10.4 POS

POS is required for:

- Alexandria showroom/warehouse
- Cairo store
- temporary bazaar/exhibition locations

POS must use the same product, SKU, inventory and order engine as online sales.

POS supports:

- barcode/SKU scan
- customer selection
- discounts
- payment methods
- receipt printing
- returns/exchanges
- stock deduction
- cash drawer/session controls
- cashier/user attribution
- end-of-day reconciliation

### 10.5 Bazaar workflow

```text
Warehouse
 → event transfer
 → temporary POS location
 → sales
 → end-of-event count
 → reconcile
 → transfer remaining stock back
```

The system must report event-level sales, margin, stock movement, unsold returns and variance.

---

## 11. CRM — Brand Only

CRM is primarily for Brand customers, not the Factory's manufacturing customers.

Customer profile:

- contact data
- consent/preferences where applicable
- source
- purchase history
- returns
- spend
- frequency
- AOV
- last purchase
- product/style affinity
- channel preference
- moderator history where relevant
- notes
- segments

Customer timeline must unify orders, returns, campaigns, coupons and interactions.

Wholesale customers may be modeled separately or as a customer type with different commercial rules.

---

## 12. Marketing and Growth Engine

Marketing is a first-class Brand module because marketing spend materially affects profitability.

### 12.1 Campaigns

Campaign contains:

- objective
- collection/style/product scope
- channel
- budget
- spend
- dates
- creative assets
- audience
- tracking parameters
- revenue
- COGS
- shipping
- returns
- payment fees
- packaging
- marketing spend
- contribution/net profit

### 12.2 Advertising

Initial channels should support Meta and Google conceptually, with integration implemented through connectors/APIs in later phases.

Track:

- campaign
- ad set/ad group
- ad/creative
- spend
- impressions
- clicks
- CTR
- CPC
- CPM
- add-to-cart
- checkout
- purchases
- revenue
- ROAS
- profit after marketing

ROAS is not the final profitability KPI.

### 12.3 Marketing allocation

Default marketing allocation basis: **units sold**.

Per-style override is allowed for campaigns clearly attributable to a specific style.

### 12.4 Influencers / affiliates

Track:

- creator
- fee
- products gifted
- coupon/link
- attributed orders
- revenue
- COGS
- profit
- ROI

### 12.5 Content library

Assets include:

- photo
- video
- reel
- static
- carousel
- UGC
- design/artwork

Each asset can link to style, collection, campaign and creator/production cost.

### 12.6 Growth dashboard

Core KPIs:

- Revenue
- Gross profit
- Marketing spend
- Profit after marketing
- CAC
- LTV
- MER
- ROAS
- contribution margin
- conversion rate
- repeat purchase rate

The executive dashboard should prioritize profit after marketing over vanity metrics.

---

## 13. Pricing and Commercial Analytics

The system must provide pricing simulations at Brand and Factory levels.

Scenarios can change:

- material price
- waste
- SMV
- minute rate
- utilisation
- efficiency
- factory margin
- retail price
- discount
- return rate
- marketing cost
- shipping
- payment fees

Scenario results must never modify live accounting data.

---

## 14. Accounting Architecture

### 14.1 Accrual principle

All costs and revenue are recognized when incurred/earned according to the configured accounting event, not when cash moves.

### 14.2 Expenses

Expense supports:

- entity
- cost center
- category/account
- amount ex-VAT
- VAT
- incurred date
- due date
- supplier/vendor
- invoice/reference
- paid amount
- outstanding amount
- payment status
- attachments
- recurring template

Recurring monthly costs such as rent and salaries are accrued at period open even when the supplier invoice has not yet arrived.

### 14.3 AP aging

AP aging is based on `due_date`, not incurred date.

Partial payments are supported.

Buckets must be configurable but default to common aging ranges such as:

- current
- 1–30
- 31–60
- 61–90
- 90+

### 14.4 Chart of accounts

The system requires a real double-entry ledger, not only an expense table.

Minimum account classes:

- Assets
- Liabilities
- Equity
- Revenue
- Cost of Goods Sold
- Operating Expenses
- Other Income/Expense

### 14.5 Cost centers

At minimum:

- Factory
- Brand
- Showroom Alexandria
- Cairo store
- Marketing
- Corporate/Group where needed

A transaction must be traceable to entity and cost center where economically meaningful.

### 14.6 VAT

VAT is currently modeled at 14% and displayed/calculated separately from ex-VAT stored amounts.

**Open decision:** confirm whether Shopify retail prices are VAT-inclusive or VAT-exclusive. Do not finalize the revenue engine until this is locked.

### 14.7 Payments and bank

Payments are separate from incurred expenses and must reconcile against bank/cash accounts.

Payment methods include, as configured:

- cash
- card
- COD
- bank transfer
- other

Payment fees are channel-specific. COD may use a per-order collection fee; card may use a percentage. The system converts channel fee rules into per-unit economics where required.

### 14.8 Assets and depreciation

Depreciation is a real accrued cost in the Factory conversion pool when the asset belongs to the Factory.

Assets require:

- acquisition cost
- acquisition date
- useful life
- depreciation method
- residual value where applicable
- monthly depreciation
- accumulated depreciation
- entity
- cost center

Default method: straight-line.

### 14.9 Financial statements

Required reports:

- Trial Balance
- General Ledger
- P&L by entity
- Group consolidated P&L
- Balance Sheet
- Cash Flow
- AP Aging
- AR Aging
- VAT report
- Inventory valuation
- Cost center P&L

---

## 15. Cash Conversion Cycle

```text
CCC = raw_material_days + production_lead_days + finished_goods_days
      + collection_days − supplier_credit_days

working_capital_locked = CCC × (monthly_COGS / 30)
```

Raw material holding period is explicitly included.

Permanent dashboard tile:

**دورة الكاش — Cash Conversion Cycle**

Show both days and locked capital.

---

## 16. HR

HR is required from the initial platform design.

Employee master:

- identity
- role
- department
- entity
- employment dates
- salary
- contract
- attendance
- leave
- productivity where applicable

Factory-specific HR:

- operator assignment
- line assignment
- earned SMV
- clocked minutes
- efficiency
- attendance

Payroll must post to accounting with entity/cost center allocation.

Owner salary, if paid for actual work, is an expense. Owner drawings are equity/distribution transactions.

### Biometric integration

Biometric/attendance integration should be designed as an adapter layer so supported devices can feed attendance into HR without coupling the core domain to a single vendor. Exact device/API depends on the chosen hardware.

---

## 17. Workflow Engine

Every major document must support lifecycle states and configurable approvals.

Examples:

```text
Draft → Submitted → Approved → Released → Completed → Closed
```

Applicable to:

- Purchase Orders
- Production Orders
- Expenses
- Payments
- Transfers
- Discounts/markdowns
- Returns
- Stock adjustments
- CMT quotes

Workflow actions must be auditable.

---

## 18. Printing and Documents

A printing engine is required.

Documents include:

- POS receipts
- barcode labels
- SKU labels
- inventory transfer documents
- goods receipt
- purchase order
- supplier documents
- production order
- cutting ticket
- QC sheet
- packing list
- invoices
- credit notes
- internal transfer invoices

Templates must be bilingual and configurable.

---

## 19. Integrations

### 19.1 Shopify

Required integration areas:

- orders
- products
- variants/SKUs
- inventory
- refunds/returns
- fulfillment status
- idempotency
- error queue
- sync logs

### 19.2 Social moderator

No AI model is required or planned for the moderator workflow. Human moderator creates orders manually. The system measures moderator attribution and performance.

### 19.3 Payment/shipping

Adapters should support configurable providers. Provider-specific code must not contaminate the core order/accounting domain.

### 19.4 Biometric

Adapter-based attendance import.

---

## 20. Traceability and Auditability

Every displayed financial or operational number should be drillable to its parents.

Examples:

```text
Minute rate
 → cost pool
   → expense categories
     → expense lines
       → supplier/invoice/payment
```

```text
Style cost
 → BOM
   → material
     → price history
       → purchase order
         → goods receipt
```

```text
Break-even
 → contribution margin
   → variable costs
   → fixed cost pool
     → individual cost members
```

Calculation functions should return or expose both the calculated result and the input lineage/trace object.

Audit log must capture:

- who
- what
- when
- before
- after
- source
- reason where required

Historical financial records, locked rates, snapshots and posted journal entries must not be silently edited.

---

## 21. Alerts and Decision Support

Alert rules are configurable. Initial high-value rules include:

1. actual waste above planned threshold
2. break-even above 60% of run
3. dead stock beyond threshold
4. low stock/reorder point
5. supplier price increase above threshold
6. supplier delivery delay
7. line efficiency below target
8. utilisation below target
9. high rework
10. high scrap
11. negative/low contribution margin
12. AP overdue
13. CCC above target
14. cash forecast shortfall
15. transfer price below factory floor

Alerts should link directly to the affected records and provide the reason, not merely a red badge.

---

## 22. Permissions

Initial roles:

- **OWNER** — full visibility and configuration
- **ACCOUNTANT** — accounting, payments, reports, financial controls
- **PRODUCTION** — production, materials, WIP, QC, line data
- **VIEWER** — read-only permitted dashboards/data

Future roles can be added without changing the core permission model.

Sensitive actions require elevated permissions and audit logging.

---

## 23. Technical Architecture

Current foundation:

- Next.js App Router
- TypeScript
- PostgreSQL 16
- Prisma 7
- Server Actions, not tRPC
- Zod at every input boundary
- Decimal arithmetic; no floats for money/quantities/rates
- JWT session cookie + bcrypt credentials auth
- Tailwind with logical RTL properties
- Arabic RTL primary; English LTR secondary

Numeric precision:

- Money: `Decimal(18,4)`
- Quantities: `Decimal(18,4)`
- Rates: `Decimal(18,8)`
- Display rounding only; EGP displayed to 2 decimals

All business calculations must be pure/domain-testable where possible.

No magic numbers. Configurable rates belong in settings or effective-dated master data.

---

## 24. Data Integrity Rules

1. Never use floating point for financial calculations.
2. Never mutate a locked accounting period.
3. Never mutate a cost snapshot.
4. Never retroactively change historical material price in a snapshot.
5. Every stock movement must have a source transaction.
6. Inventory balance must be reconstructible from movements.
7. Every posted journal must balance debits and credits.
8. Every intercompany transaction must identify both entities.
9. Intercompany profit in unsold inventory must be eliminable at Group level.
10. Every external integration must be idempotent.
11. Every order must have a source channel.
12. Every manual moderator order must identify the moderator.
13. Every POS transaction must identify the location and cashier/session.
14. Every temporary bazaar stock movement must be reconciled.
15. Every configurable business rule must be visible to authorized users.
16. Corrections are adjustments/reversals, not silent edits.

---

## 25. Reporting Architecture

### Executive dashboard

Permanent tiles:

- Factory profitability
- Brand profitability
- Group profitability
- الطاقة العاطلة — idle capacity cost
- دورة الكاش — CCC and locked capital
- المخزون الراكد — dead stock
- break-even risk
- cash position/forecast
- marketing spend
- profit after marketing

### Factory dashboard

- utilisation
- efficiency
- productive minutes
- actual minute rate
- full-capacity rate
- idle penalty
- CMT capacity/revenue
- production plan vs actual
- waste
- rework
- scrap
- line productivity

### Brand dashboard

- revenue
- units
- AOV
- contribution margin
- break-even
- sell-through
- markdowns
- returns
- inventory capital
- channel performance
- marketing profitability
- moderator performance
- store performance

### Group dashboard

- consolidated P&L
- elimination entries
- inventory unrealised profit elimination
- group cash
- capital locked
- group margins

---

## 26. Future Platform Extensions

The core should remain configurable enough to support future fashion businesses without rewriting core logic.

Potential future engines:

- PLM / Product Lifecycle Management
- PDM / Product Data Management
- WMS / Warehouse Management
- MES / Manufacturing Execution
- Growth/Marketing Engine
- Rules Engine
- Dashboard Builder
- Form Builder
- Document Management
- Multi-brand / multi-tenant support

These are architectural extension points, not permission to overbuild Phase 1.

---

## 27. Non-Goals

The system will **not** embed an expensive general-purpose AI model/API as a required business dependency. No AI is required for order entry, accounting, costing, inventory or production. AI may be integrated later as an optional external assistant if economics and security justify it.

The system is not intended to replace the owner’s judgment; it is intended to make the economic consequences of decisions visible and traceable.

---

## 28. Open Decisions Before Final Financial Lock

These must be explicitly confirmed before the affected calculation is considered final:

### O-001 — Shopify retail prices VAT treatment

Are Shopify prices VAT-inclusive or VAT-exclusive? This changes every revenue and margin number.

### O-002 — Factory margin basis

Current specification assumes factory margin is applied to **full factory cost including materials**. If the desired commercial policy is instead manufacturing conversion cost plus a material pass-through/handling margin, this must be changed before final transfer-price implementation.

### O-003 — Exact ten colour codes

The current product model requires exactly ten configured colour codes, but the canonical code list must be confirmed and locked in seed/config.

### O-004 — Egyptian biometric device/provider

Exact integration depends on the selected device/API. The adapter architecture is fixed; the vendor is not.

---

## 29. Phase Delivery Rule

Each implementation phase must be delivered as a testable increment.

Required gate before moving to the next phase:

1. schema/migration passes
2. unit tests pass
3. typecheck passes
4. production build passes
5. browser smoke test passes
6. seeded data is coherent
7. accounting/inventory invariants pass
8. user tests the phase with real business examples

No phase is considered complete merely because the code compiles.

---

## 30. Current Foundation Status

Phase 1 foundation exists in the repository and includes schema, migrations, realistic Egyptian seed data, authentication, bilingual RTL/LTR shell, entity switcher and initial tests.

The next implementation milestone is the **Cost Engine**, because minute-rate versioning, style costing, transfer pricing and immutable snapshots are load-bearing for later production, commercial and profitability modules.

**End of Master Specification v1.0**
