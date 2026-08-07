# Cashmere OS — Brand Commerce, POS & Sales Specification

**Status:** Draft for implementation
**Entity:** Brand
**Scope:** Shopify, social-media moderator orders, POS, showrooms, bazaars, sales, payments, reservations, returns, customers, fulfillment, channel attribution, reconciliation.

## 1. Purpose

Create one Brand commerce layer for every sales channel while keeping a single inventory and accounting truth.

Channels:

1. Shopify website
2. Social-media/DM orders entered by moderators
3. Alexandria showroom POS
4. Cairo store POS
5. Temporary bazaars/exhibitions
6. Future channels

All channels sell the same internal Product/Variant records and consume the same Brand inventory ledger.

## 2. Brand locations

### Alexandria showroom/warehouse

This is the primary Brand physical location and fulfillment location unless another location is selected.

It serves:

- showroom sales
- online fulfillment
- social-order fulfillment
- stock holding

### Cairo store

Separate inventory location and POS location.

### Bazaar/event

Temporary Brand location created for each event.

Stock sent to a bazaar remains Brand-owned until sold or returned.

## 3. Unified order model

Every Brand order uses one internal order model regardless of source.

Required fields:

- order number
- source channel
- customer
- order date/time
- sales location/fulfillment location
- sales representative/moderator/cashier where applicable
- currency
- prices ex-VAT internally
- discount
- shipping
- payment method
- order status
- fulfillment status
- refund/return status
- external source ID
- campaign/UTM attribution where known

Source values include:

`SHOPIFY | SOCIAL_DM | POS_ALEXANDRIA | POS_CAIRO | BAZAAR | OTHER`

## 4. Shopify

Shopify is the website sales channel.

The integration should ingest, idempotently:

- orders
- order lines
- customers
- variants
- fulfillment events
- cancellations
- refunds
- payment status
- discounts
- shipping

Shopify IDs are stored as external references.

Internal Cashmere OS IDs remain authoritative.

### Shopify inventory synchronization

The system may push available Brand inventory to Shopify by mapped variant/location policy.

Webhook/event processing must be idempotent.

The same Shopify event must never create duplicate sales or duplicate stock deduction.

## 5. Social-media moderator orders

Social orders are not Shopify orders.

A moderator receives a customer through DM/WhatsApp/Facebook/Instagram or another supported social channel and creates the order directly in Cashmere OS.

Required attribution:

- moderator user
- source platform
- customer
- campaign if known
- order timestamp
- selected SKU/variant
- quantity
- price/discount
- delivery address
- fulfillment location
- payment method
- order status

The moderator must not need Shopify to create the order.

## 6. Moderator accountability

Each social order records the moderator who created/handled it.

Reports:

- orders per moderator
- units per moderator
- revenue per moderator
- discounts per moderator
- cancellation rate
- return rate
- conversion rate when lead data exists
- average order value
- collection/payment performance

Moderator attribution remains attached to the order after fulfillment.

## 7. POS

POS is a first-class Brand sales channel.

Each POS terminal belongs to a location.

Each cashier operates a POS session.

### POS session lifecycle

`Open → Active → Closing → Reconciled → Closed`

Session captures:

- opening float
- sales by tender
- refunds
- cash payouts
- cash expected
- cash counted
- variance
- cashier
- terminal
- location
- opening/closing timestamps

## 8. Payment methods

Payment methods are configurable by channel.

Examples:

- cash
- card
- COD
- bank transfer
- wallet
- other approved method

Each method stores its fee rule.

Payment fees may be:

- fixed per order
- percentage
- hybrid

For product economics, order-level fees are allocated to units using the configured allocation rule.

## 9. COD

COD requires additional operational states:

`Pending Collection → Collected → Failed/Returned`

The system tracks:

- courier/collection provider
- expected collection amount
- actual collection
- collection fee
- failure reason
- remittance date

COD fees feed Brand variable-cost calculations.

## 10. Card payments

Card payment fees are recorded by provider/channel configuration.

The system must distinguish:

- gross customer payment
- provider fee
- net settlement

Reconciliation should match settlement records rather than assuming gross sales equal bank deposits.

## 11. Order lifecycle

Recommended:

`Draft → Confirmed → Reserved → Fulfillment → Delivered/Completed`

Alternative paths:

- Cancelled
- Failed delivery
- Partially fulfilled
- Returned
- Refunded

Status transitions are audited.

## 12. Inventory reservation

Confirmed orders may reserve stock.

Reservation is separate from sale COGS.

When the configured fulfillment/sale event occurs, FIFO inventory consumption is posted.

Cancellation releases reservation.

The system must prevent overselling across channels.

## 13. Fulfillment

Fulfillment task includes:

- order
- source channel
- fulfillment location
- picker/packer
- items
- packed quantity
- shipped quantity
- courier
- tracking number
- shipment cost
- delivery status

A social-media order and Shopify order can both be fulfilled from Alexandria stock without creating duplicate inventory records.

## 14. Split fulfillment

An order may be fulfilled from multiple locations if enabled.

Each fulfillment line records:

- location
- quantity
- shipment
- fulfillment status

Inventory is consumed from the actual fulfillment location.

## 15. Discounts

Discounts are stored at order and/or line level.

Every order line retains:

- original unit price
- discount percentage/amount
- final selling price
- discount reason/code

Historical sales never recalculate because a discount rule changes later.

Discount analysis supports:

- by style
- collection
- channel
- moderator
- cashier
- campaign
- location

## 16. VAT

Internal commercial economics use ex-VAT prices.

VAT rate is configurable and currently assumed to be 14%.

If Shopify prices are VAT-inclusive, the integration must normalize them into ex-VAT internal values before revenue analytics.

This must be a deliberate configuration decision, not an assumption buried in code.

## 17. Returns

Return starts from an original order/line whenever possible.

Return workflow:

`Requested → Approved → Received → Inspected → Restocked / Damaged / Rejected`

### Resellable return

Returned item re-enters Brand finished goods at original inventory cost.

### Damaged return

Item moves to damaged/write-off inventory and creates the appropriate accounting entry.

Return handling cost remains a Brand variable cost.

## 18. Refunds

Refund records reference:

- original payment
- order
- return
- amount
- payment method
- refund date
- reason

Refunds must not silently alter the historical sales price.

## 19. Customer master

Customer records are shared across Brand channels where identity can be reliably matched.

Fields include:

- name
- phone
- email
- addresses
- preferred language
- source
- consent/marketing status where applicable
- first order date
- last order date
- lifetime revenue
- lifetime units
- return history

Duplicate matching should use configurable identity rules and never merge customers destructively without auditability.

## 20. CRM handoff

The commerce module records transactional facts.

CRM later consumes these facts for:

- customer segmentation
- repeat purchase
- retention
- lead/follow-up
- campaign attribution

Commerce remains the source of truth for orders and payments.

## 21. Sales channel economics

For every style/order line the system should calculate:

- gross retail price
- discount
- net selling price
- VAT component
- effective revenue after return-rate modeling where used in planning
- transfer-price cost
- packaging
- shipping
- payment fee
- marketing allocation
- return handling
- contribution margin

Actual accounting uses actual transactions; planning models may use trailing return/discount rates.

## 22. Shipping

Shipping may be:

- customer-paid
- Brand-paid
- partially subsidized

The order records:

- shipping charged to customer
- actual shipping expense
- courier
- shipment count

Shipping expense enters Brand variable-cost reporting according to the configured policy.

## 23. Bazaars

A bazaar has:

- event name
- location
- start/end date
- organizer
- event costs
- assigned staff
- inventory dispatch
- POS/sales activity
- stock return

Event P&L:

`Revenue − COGS − event expenses − applicable fees`

This makes each 2–3 day exhibition measurable independently.

## 24. Showroom performance

Alexandria and Cairo each have location-level reporting:

- sales
- units
- average order value
- discounts
- returns
- payment mix
- gross margin
- contribution margin
- stock turnover
- sell-through
- cashier performance

## 25. Sales reconciliation

Daily reconciliation should cover:

- order count
- gross sales
- discounts
- refunds
- net sales
- VAT
- payment-method totals
- POS cash expected vs actual
- card settlement expected
- COD expected/collected
- inventory units sold
- COGS

The system must expose discrepancies rather than silently force balances.

## 26. Shopify reconciliation

For each Shopify reconciliation period:

`Shopify order totals ↔ Cashmere sales orders ↔ payment/settlement ↔ inventory movements ↔ accounting entries`

Mismatch report must identify:

- missing order
- duplicate order
- wrong amount
- wrong variant
- wrong fulfillment location
- inventory mismatch
- refund mismatch
- payment mismatch

## 27. POS reconciliation

For each POS session:

`POS sales ↔ payment tenders ↔ inventory movements ↔ accounting`

A session cannot be closed without recording unresolved variance or authorized override.

## 28. Permissions

### Owner

Full access and approval authority.

### Accountant

Accounting, reconciliation, financial reports; no unrestricted operational deletion.

### Sales/Moderator

Create/manage assigned customer orders; no accounting posting control.

### Cashier

POS sales/session access only according to location.

### Production

Factory operations, no Brand financial edits.

### Viewer

Read-only.

## 29. Audit controls

Never hard-delete a posted order, payment, refund, inventory movement, or accounting transaction.

Corrections use reversal/adjustment records.

Every privileged action records:

- user
- timestamp
- action
- object
- before/after where relevant
- reason where required

## 30. Required Brand commerce reports

1. Sales by channel
2. Sales by location
3. Sales by moderator
4. Sales by cashier
5. Sales by style
6. Sales by variant
7. Sales by collection
8. Discount report
9. Returns report
10. Refund report
11. Payment-method report
12. Shopify reconciliation
13. POS reconciliation
14. COD collection report
15. Bazaar P&L
16. Showroom P&L
17. Contribution margin by channel
18. AOV
19. Units/order
20. Sell-through
21. Stock reservation
22. Fulfillment performance
23. Customer sales summary
24. Failed-delivery report

## 31. Acceptance criteria

Commerce is production-safe when:

- every sale has one internal order identity
- Shopify and social orders are distinct sources under one order model
- moderator attribution is preserved
- POS sessions reconcile to payment and inventory
- Cairo/Alexandria/bazaar stock are distinct locations under one Brand inventory ledger
- overselling is prevented across channels
- returns preserve original cost when resellable
- refunds trace to original payments
- payment fees are captured by channel
- VAT treatment is explicit
- Shopify synchronization is idempotent
- accounting and inventory effects reconcile to sales
- every posted transaction is auditable
