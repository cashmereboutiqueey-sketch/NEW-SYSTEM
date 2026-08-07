# Cashmere OS — MRP, Production & Factory Operations Specification

**Status:** Draft for implementation
**Entity:** Factory primarily; Brand receives finished goods through controlled intercompany transfer.

## 1. Purpose

This module converts demand and product definitions into material requirements, capacity requirements, production orders, shop-floor execution, quality records, inventory movements, and immutable production costing.

Core flow:

`Demand → MRP → Planned Production → Material Reservation → Cutting → Sewing → Finishing → QC → Finished Goods → Factory Invoice → Brand Inventory`

## 2. Product structure

A Style is the manufacturing definition.

A Variant is:

`Style × Color × Size`

SKU format:

`[STYLENAME]-[COLORCODE]-[SIZE]`

All SKU codes are uppercase and use the configured ten colour codes.

Costing remains style-level unless a configured size multiplier changes material consumption.

## 3. BOM model

A Style BOM can contain multiple materials.

One material can be used by multiple styles.

One material may therefore create many finished products.

One finished product may consume many different materials.

BOM lines store:

- material
- standard quantity
- unit of measure
- planned waste rate
- per-size consumption multiplier
- effective dates
- version
- notes

BOM versions are immutable once used by a production order.

## 4. Material master

Materials support:

- code
- name AR/EN
- category
- unit of measure
- supplier
- MOQ
- pack size
- lead time
- reorder point
- safety stock
- preferred supplier
- active status

Fabric is measured in metres by default; trims in pieces, with configurable UOMs.

## 5. Material pricing

Material cost uses landed cost:

`purchase price + freight + customs/clearing + directly attributable landed costs`

Price history is effective-dated.

The price used in a production CostSnapshot is frozen at confirmation.

Future price changes cannot rewrite historical production cost.

## 6. MRP inputs

MRP reads:

- sales demand
- open Brand orders
- Shopify demand where imported
- POS demand
- forecasts
- target stock
- current inventory
- reserved inventory
- open purchase orders
- open production orders
- supplier lead times
- MOQ/pack size
- safety stock
- production capacity

MRP should distinguish actual demand from forecast demand.

## 7. MRP calculation

For each material:

`gross requirement = planned production × BOM requirement`

Then consider:

- available stock
- reservations
- open purchase orders
- open production supply
- safety stock
- MOQ/pack size

Result:

`net requirement = gross requirement + safety stock − available supply`

The exact netting policy is configurable and versioned.

## 8. MRP recommendations

MRP can generate recommendations for:

- purchase order
- production order
- transfer/reservation
- expedite
- defer/cancel

Recommendations require approval before creating committed supply unless an explicit auto-release policy is enabled.

## 9. Capacity planning

Factory capacity is driven by:

`gross_available_minutes = operators × working_days × hours_per_day × 60`

Utilisation and efficiency are separate.

`productive_minutes = gross_available_minutes × utilisation × efficiency`

The system must show:

- demand minutes
- available minutes
- utilised minutes
- productive minutes
- idle minutes
- capacity gap/overload

## 10. Capacity booking

CapacityBooking records planned minutes by:

- period
- production line
- production order
- style
- operation
- planned quantity
- planned SMV minutes

Bookings reserve planning capacity without pretending production has happened.

## 11. Production order

ProductionOrder contains:

- order number
- style
- variants
- quantity planned
- quantity cut
- quantity sewn
- quantity finished
- start date
- target date
- priority
- line
- status
- source demand
- BOM version
- routing version
- CostSnapshot reference

Lifecycle:

`Draft → Planned → Released → Material Reserved → Cutting → Sewing → Finishing → QC → Completed → Closed`

Cancellation requires controlled handling of reservations and costs.

## 12. Production order costing

On confirmation/release, freeze:

- BOM lines
- material quantities
- material prices
- waste assumptions
- SMV
- minute-rate period
- minute rate
- factory margin
- transfer price
- all intermediate subtotals

This creates an immutable CostSnapshot.

Corrections create adjusting records rather than editing the snapshot.

## 13. Cutting

Cutting consumes fabric according to an approved cutting ticket.

MaterialIssue records:

- production order
- material
- lot
- standard required quantity
- actual issued quantity
- returned quantity
- quantity consumed
- operator/user
- timestamp

Actual waste:

`actual_waste_rate = (actual_issued / standard_required) − 1`

Actual waste is reported as variance; it does not retroactively change the frozen cost.

## 14. Waste and scrap

ScrapRecord stores:

- production order
- material/product
- quantity
- estimated cost
- reason
- disposition
- date

Disposition options may include:

- reusable
- recyclable
- saleable scrap
- disposal
- rework

Scrap cost is visible in production variance reporting.

## 15. Sewing operations

Routing consists of StyleOperation rows.

Each operation stores:

- sequence
- operation code
- operation name
- SMV
- work center/line
- skill requirement
- quality checkpoint where applicable

Style SMV is:

`Σ operation SMV`

SMV is drillable down to operation.

## 16. Shop-floor execution

ProductionStageLog records actual movement through stages:

- cutting
- preparation
- sewing
- finishing
- QC
- packing where applicable

Each log includes:

- production order
- stage
- line
- quantity in
- quantity out
- start/end
- responsible user/team
- downtime
- notes

## 17. Production efficiency

The system separates:

### Utilisation
Whether capacity is being used because orders/work are available.

### Efficiency
How effectively available working time converts to earned SMV.

Example:

100 clock minutes producing 80 earned SMV minutes = 80% efficiency.

Idle time caused by no work is not automatically classified as operator inefficiency.

## 18. Operator productivity

OperatorProductivity can record:

- operator
- date
- line
- operation
- earned minutes
- attended minutes
- efficiency
- quality/rework indicators

These records feed operational reporting, not a second costing system.

## 19. Downtime

Downtime should have reason codes such as:

- no order
- material shortage
- machine breakdown
- maintenance
- quality hold
- power interruption
- changeover
- waiting for instruction
- other

This allows management to distinguish sales/capacity problems from production problems.

## 20. Rework

ReworkRecord stores:

- production order
- operation/stage
- quantity
- reason
- additional minutes
- estimated cost
- disposition

Rework must be visible separately from normal production minutes.

## 21. Quality control

QC checkpoints support:

- inspected quantity
- passed quantity
- rejected quantity
- defect type
- severity
- inspector
- timestamp

Rejected output can move to rework or scrap.

## 22. Production variances

Compare planned vs actual:

- material quantity
- material waste
- SMV/minutes
- labour/production minutes
- quantity
- scrap
- rework
- completion time
- factory cost

Variance must identify root cause where possible.

## 23. Finished goods completion

On completion, accepted finished units become Finished Goods inventory through an InventoryMovement linked to the production order.

Only accepted quantity enters sellable finished inventory unless a separate QC-hold state exists.

## 24. Multi-material products

The system must support products made from multiple fabrics/materials.

Example:

One dress may consume:

- jersey
- lace
- lining
- zipper
- label

Each BOM line has independent quantity, cost, waste, lot traceability, and variance.

## 25. Multi-product material usage

A material can be consumed by multiple styles/products.

The inventory ledger therefore tracks material usage by production order and style without changing the material master.

## 26. Material reservations

MRP or production release may reserve required inventory.

Reservation is not consumption.

Inventory movement occurs only when the physical issue happens.

Cancellation releases unused reservations.

## 27. Shortage handling

If released production lacks material:

- flag shortage
- identify affected orders
- show required vs available
- identify incoming PO and ETA
- allow approved substitution where BOM permits

Do not silently consume negative stock.

## 28. Material substitution

Approved alternatives can be configured by BOM version.

Substitution requires:

- approved alternate material
- approval/user
- effective date
- quantity conversion where required
- quality/technical note

Actual substitution is included in production variance and cost reporting.

## 29. Production scheduling

Scheduling considers:

- due dates
- priority
- line capacity
- operation routing
- material availability
- setup/changeover
- workforce availability

A schedule must distinguish planned from released work.

## 30. External CMT

External CMT is a Factory production capacity stream.

External CMT orders must have:

- customer
- order
- agreed minute/price basis
- planned minutes
- actual minutes where measured
- material responsibility
- delivery
- revenue
- margin

CMT revenue credits the Factory cost pool according to the locked rule.

## 31. Factory margin and transfer price

For Brand production:

`factory_total_cost = material_cost + CMT/conversion_cost`

`transfer_price = factory_total_cost × (1 + factory_margin)`

The system refuses a transfer price below the configured arm's-length floor.

Per-style overrides are allowed but flagged.

## 32. Minute-rate periods

One MinuteRatePeriod per Factory entity/month stores:

- capacity inputs
- operators
- working days
- hours/day
- utilisation
- efficiency
- gross minutes
- productive minutes
- total conversion cost pool
- CMT revenue credit
- net cost pool
- actual minute rate
- full-capacity minute rate
- idle penalty
- locked_at

A production order uses the rate of its costing period forever.

## 33. Idle capacity

Dashboard permanently exposes:

**الطاقة العاطلة**

`idle_penalty_per_minute = actual_minute_rate − full_capacity_minute_rate`

`idle_penalty_per_unit = idle_penalty_per_minute × style_smv`

The system should model external CMT as a lever that can reduce the Brand's absorbed minute rate when configured.

## 34. Inventory integration

Every physical material/product movement is posted through InventoryMovement.

Production does not maintain a second inventory balance.

Flow:

`Reservation → Issue → WIP → Completion → Finished Goods`

## 35. Procurement integration

MRP recommendations can create approved Purchase Orders.

PO lifecycle:

`Draft → Approved → Sent → Partially Received → Received → Closed`

Goods receipt creates inventory and price-variance data.

Supplier invoice is handled by AP/accounting.

## 36. Production-to-accounting bridge

Production provides accounting with:

- actual material consumption
- WIP movement
- finished goods valuation
- scrap
- rework
- conversion cost
- production variances

Accounting remains responsible for journal posting.

## 37. Traceability

Every finished unit should be drillable to:

`SKU → ProductionOrder → BOM version → MaterialIssue → InventoryLot → Supplier/Purchase → Material price history`

And:

`SKU → Routing → StyleOperation → SMV → MinuteRatePeriod → Factory expense pool`

## 38. Alerts

Recommended production alerts:

1. Material shortage
2. Production overdue
3. Capacity overload
4. Excess idle minutes
5. Waste above threshold
6. Rework above threshold
7. Scrap above threshold
8. Efficiency below threshold
9. Utilisation below target
10. Material price spike
11. Production cost variance
12. QC rejection spike
13. Missing stage completion
14. Stockout risk
15. CMT capacity opportunity

## 39. Production dashboards

1. Factory command center
2. MRP recommendations
3. Material shortage dashboard
4. Capacity/load dashboard
5. Production schedule
6. Shop-floor progress
7. Utilisation vs efficiency
8. Idle-capacity cost
9. Material waste variance
10. Scrap/rework
11. QC performance
12. Production cost variance
13. External CMT performance
14. Production order drill-down

## 40. Controls

Prevent/flag:

- production without valid BOM
- production without approved routing
- issue without inventory lot
- negative inventory
- duplicate material issue
- completion above released quantity without approval
- QC-passed quantity above produced quantity
- transfer price below floor
- editing locked CostSnapshot
- posting a historical production rate into a new period
- consuming material outside an approved substitution

## 41. Acceptance criteria

MRP/Production is production-safe when:

- one material can serve many products
- one product can consume many materials
- variants are fully supported by colour × size
- MRP nets actual stock, reservations and open supply
- MOQ and pack size are respected
- utilisation and efficiency remain separate
- production is traceable from raw material to finished SKU
- actual waste is measured without rewriting historical cost
- scrap and rework are separately visible
- capacity is linked to real workforce availability
- finished goods enter the shared Brand inventory ledger correctly
- Factory transfer pricing uses immutable cost snapshots
- external CMT can credit the Factory cost pool
- production accounting has a clean bridge to Finance
- every major operational number can be drilled to source events
