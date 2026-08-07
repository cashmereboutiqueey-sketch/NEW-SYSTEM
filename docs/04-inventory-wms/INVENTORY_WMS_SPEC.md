# Cashmere OS — Inventory & WMS Specification

**Status:** Draft for implementation
**Scope:** Raw materials, WIP, finished goods, locations, lots, movements, valuation, aging, dead stock, POS/online/bazaar stock ownership.

## 1. Core principle

Inventory is a **ledger**, not a mutable balance.

Every quantity/value change is an `InventoryMovement` against an `InventoryLot`. Current balances are derived from the movement ledger and may be cached only as a rebuildable projection.

No screen may directly edit an inventory balance.

## 2. Inventory states

The Brand and Factory must support these economic states:

```text
Raw Materials → WIP → Finished Goods → Available / Reserved / Sold / Returned / Damaged
```

Factory raw materials and Factory WIP belong to Factory.

Finished goods transferred to Brand belong to Brand.

The Brand's Alexandria warehouse/showroom is the primary Brand stock location and serves both as showroom stock and fulfillment stock for online/social orders unless a separate location is configured.

The Cairo store is a separate Brand inventory location.

Each temporary bazaar/exhibition is a temporary Brand inventory location/event location. Stock sent there remains Brand-owned inventory until sold or returned.

## 3. Locations

Location types:

- Factory Warehouse
- Factory Cutting/WIP
- Factory Finished Goods
- Alexandria Showroom/Warehouse
- Cairo Store
- Bazaar/Event
- In Transit
- Damaged/Hold
- Customer Return Inspection

A location has:

- entity
- name
- type
- address/event reference
- active status
- inventory responsibility owner

Transfers between locations create paired ledger movements and never silently change quantity.

## 4. Units and materials

Material units are configurable.

Default examples:

- Fabric: metres
- Trims: pieces

Finished goods are unit-counted.

Quantities use `Decimal(18,4)`.

Each material may define:

- base unit
- purchase unit
- conversion factor
- MOQ
- pack size
- supplier references
- lot tracking requirement
- expiry/quality fields where relevant

## 5. Inventory lots

Every received raw material lot has:

- material
- supplier
- purchase receipt
- supplier invoice
- received date
- quantity received
- quantity available
- unit landed cost
- total landed value
- warehouse/location
- lot/batch identifier
- quality status

Finished-goods lots have:

- SKU/variant
- style
- production order
- production date
- transfer-price unit cost
- quantity produced
- quantity remaining
- Brand receiving event

Lot records are immutable in economic identity. Movements change the remaining quantity.

## 6. FIFO valuation

Inventory valuation policy: **FIFO by lot**.

Outbound consumption must consume the oldest eligible lot first.

For a sale, reservation, transfer, or production issue, the system allocates quantities against FIFO layers and records each allocation.

Example:

```text
Lot A: 100 units @ 300 EGP
Lot B: 100 units @ 330 EGP
Sale: 120 units

COGS:
100 × 300 + 20 × 330
```

No weighted-average substitution is permitted unless the accounting policy is explicitly changed and a migration is designed.

## 7. Raw material receiving

A purchase order does not automatically increase inventory.

Inventory increases when a Goods Receipt is posted.

Goods Receipt must capture:

- supplier
- PO
- receipt date
- location
- material
- quantity received
- accepted/rejected quantity
- landed cost components
- lot
- quality status

Price variance between PO and receipt/invoice is recorded separately and traceable to accounting treatment.

## 8. Landed cost

Raw material inventory cost includes approved landed components:

`purchase price + freight + customs/clearing`

The system must preserve each component rather than storing only one unexplained total.

If freight/clearing is allocated across multiple lines, the allocation basis and allocation result are stored.

## 9. Material issue / cutting ticket

A `MaterialIssue` is the authoritative cutting/production consumption event.

It records:

- production order
- style
- quantity planned
- standard required quantity
- actual issued quantity
- material lot(s)
- standard waste
- actual waste
- operator/user
- timestamp

Formula:

`actual_waste_rate = (actual_issued / standard_required) − 1`

The system must retain the planned waste used in the CostSnapshot and must not rewrite it with actual waste.

## 10. WIP

WIP is a real inventory state.

Material consumed into an open production order moves from raw-material inventory into WIP.

As production progresses, WIP can be represented by stage quantities and accumulated conversion cost.

Production-stage logs must make WIP quantities reconstructible.

On completion:

`WIP → Factory Finished Goods`

with the production-order frozen economic cost.

## 11. Factory to Brand transfer

A confirmed Factory production order creates finished goods at Factory and an internal transfer/invoice to Brand.

The physical transfer creates inventory movement:

`Factory FG → In Transit → Brand location`

The economic transfer uses the immutable transfer price from the CostSnapshot.

Brand inventory unit cost is the transfer price.

## 12. Brand inventory channels

Brand stock can be sold through:

1. Shopify website
2. Social-media orders entered by moderator
3. Alexandria showroom POS
4. Cairo store POS
5. Temporary bazaars/exhibitions
6. Future sales channels

All channels consume the same Brand inventory ledger.

A sale must reserve/decrease stock from the actual fulfillment location and record channel/source metadata.

## 13. Social-media moderator orders

A moderator can create an order manually when a customer purchases through Instagram/Facebook/WhatsApp DM or another supported social conversation.

Required attribution:

- moderator
- customer
- source channel
- campaign/UTM when known
- order date
- fulfillment location
- payment method
- status

This is a first-class order source, not a Shopify order.

Moderator performance must therefore be reportable independently.

## 14. Shopify integration boundary

Shopify is an external sales channel and inventory source of operational events, not the accounting authority.

The integration should ingest:

- orders
- order lines
- customers where permitted
- products/variants
- fulfillment status
- cancellations
- refunds
- inventory changes where appropriate

The internal ledger remains the authoritative inventory accounting record.

Shopify inventory synchronization must be idempotent and event-aware so the same order/webhook cannot reduce stock twice.

## 15. POS

POS is a Brand sales channel.

Each POS terminal belongs to a location and user/session.

A completed sale:

- creates the sales order
- records payment/tender
- reserves/consumes inventory
- creates COGS through FIFO allocation
- creates accounting entries
- records salesperson/user

Cashier sessions must reconcile opening float, sales, refunds, payouts, and closing cash.

## 16. Bazaar/event inventory

A bazaar is a temporary sales location.

Before the event:

`Alexandria/Cairo stock → Bazaar location`

During event:

`Bazaar stock → Customer sale`

After event:

`Remaining Bazaar stock → Origin location`

The system reports:

- quantity sent
- quantity sold
- quantity returned
- revenue
- COGS
- event expenses
- profit
- stock discrepancy

## 17. Reservations

Stock states must distinguish:

- On hand
- Reserved
- Available
- In transit
- Damaged/hold

An order reservation does not create COGS until the sale is posted/fulfilled according to the configured revenue-recognition policy.

Reservation expiry/cancellation releases stock without creating a sale.

## 18. Returns

Default customer return disposition: **resellable**.

A resellable return:

`Customer → Return inspection → Finished Goods`

at the original inventory cost.

Return handling cost is a Brand variable cost and does not alter the historical product cost.

Damaged return:

`Customer → Damaged/Written-off`

with an inventory write-off and accounting entry.

Return must reference the original sale line whenever possible.

## 19. Inventory aging

Finished goods age by SKU/lot using the relevant production/receipt date.

Buckets:

- 0–30
- 31–60
- 61–90
- 90+

Each bucket displays:

- units
- cost value
- retail value where configured
- percentage of total inventory

A configurable dead-stock threshold creates the `المخزون الراكد` flag.

## 20. Raw-material aging

Raw materials also require age reporting because fabric sitting before cutting is locked working capital.

Reports should show:

- age since receipt
- quantity
- landed value
- days since last issue
- supplier
- style/BOM usage where known

This feeds the CCC and capital-lock dashboard.

## 21. Capital tracking

The system must answer:

> How much of my cash/capital is currently trapped in fabric, WIP, finished goods, and unsold inventory?

Capital-lock views must distinguish:

- raw material capital
- WIP capital
- finished-goods capital
- stock in transit
- reserved stock
- dead stock
- sold-but-uncollected receivables where applicable

Inventory value must reconcile to the accounting control accounts.

## 22. Inventory movement types

Minimum movement types:

- PURCHASE_RECEIPT
- QUALITY_REJECT
- RAW_MATERIAL_ISSUE
- WIP_RECEIPT
- WIP_TRANSFER
- PRODUCTION_COMPLETION
- FACTORY_TO_BRAND_TRANSFER
- LOCATION_TRANSFER_OUT
- LOCATION_TRANSFER_IN
- RESERVATION
- RESERVATION_RELEASE
- SALE
- CUSTOMER_RETURN
- RETURN_RESTOCK
- RETURN_DAMAGE
- WRITE_OFF
- STOCK_ADJUSTMENT
- BAZAAR_DISPATCH
- BAZAAR_RETURN

Every movement references a source document/event.

## 23. Stock counts

Physical stock counts are reconciliation events, not direct balance edits.

A count session records:

- location
- counter
- timestamp
- expected quantity
- counted quantity
- variance
- reason
- approval

Approved variance creates an adjustment movement and corresponding accounting entry.

## 24. Negative stock policy

Negative inventory is blocked by default.

An emergency override, if later enabled, requires elevated permission, reason, and audit trail.

The system should not hide negative stock by silently creating synthetic inventory.

## 25. Traceability

Example raw-material trace:

`Supplier invoice → receipt → lot → FIFO layer → MaterialIssue → ProductionOrder → Finished Goods → transfer → sale`

Example finished-goods trace:

`Sale → SKU → lot → ProductionOrder → CostSnapshot → BOM → material lots → supplier`

Every inventory value must drill to its source movement chain.

## 26. Required inventory reports

1. Stock by location
2. Stock by SKU
3. Stock by lot
4. Raw-material stock
5. WIP stock
6. Finished-goods stock
7. FIFO valuation
8. Inventory aging
9. Dead stock
10. Stock movement ledger
11. Stock transfers
12. Stock count variance
13. Bazaar stock performance
14. POS stock performance
15. Online/social fulfillment stock
16. Capital locked in inventory
17. Raw-material days
18. Slow-moving raw materials
19. Inventory reconciliation to GL
20. Inventory valuation by entity

## 27. Acceptance criteria

The inventory system is correct only when:

- every balance can be reconstructed from movements
- FIFO allocations are deterministic
- Factory and Brand ownership never mix
- Shopify and moderator orders can consume the same Brand stock without double deduction
- POS sales create inventory and accounting effects together
- bazaar stock can leave and return without becoming unexplained shrinkage
- returns preserve original cost when resellable
- dead stock is visible by quantity and capital value
- physical count variances are auditable
- inventory valuation reconciles to accounting
- capital-lock figures reconcile to inventory state totals
