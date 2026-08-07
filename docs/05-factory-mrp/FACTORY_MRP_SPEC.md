# Cashmere OS — Factory + MRP + Production Specification

**Status:** Draft for implementation
**Entity:** Factory
**Purpose:** Convert demand into controlled production while preserving material, capacity, labor, quality, cost, and traceability.

## 1. Operating model

The Factory is a contract manufacturer.

Current internal customer: Cashmere Brand.
Future customers may include external CMT clients.

The production system must support both without changing the core manufacturing model.

Flow:

`Demand → MRP → Material Availability → Capacity Check → Production Order → Cutting → Sewing → Finishing → QC → Completion → Factory FG → Transfer/Customer`

## 2. Master data hierarchy

### Product/style

A Style is the manufacturing design/product definition.

A Variant is `colour × size`.

SKU format:

`[STYLENAME]-[COLORCODE]-[SIZE]`

Uppercase.

### Materials

Materials include fabric and trims.

A material may be used by many styles.
A style may consume many materials.

### Operations

Operations build SMV bottom-up.

A Style has ordered StyleOperations.

Each operation stores:

- operation name/code
- SMV
- machine/work-center requirement
- line/department
- skill requirement where configured
- quality checkpoints

`style_smv = Σ operation_smv`

## 3. BOM

BOM is versioned.

Each BOM line supports:

- material
- standard consumption
- planned waste rate
- size multiplier
- color/material option where applicable
- unit
- effective dates

Default size multiplier: `1.0`.

BOM version used by a production order is frozen in the CostSnapshot.

## 4. Collection and production planning

Collections group styles commercially and may contain multiple production runs.

Production planning must not assume one collection equals one production batch.

A style may be produced in multiple runs, colors, and sizes.

## 5. Demand sources

MRP demand can originate from:

- confirmed Brand sales orders
- approved production replenishment plan
- minimum stock/reorder policy
- forecast
- manual production plan
- external CMT customer order

Demand source must remain traceable.

## 6. Capacity model

Capacity is modeled at least at:

- factory
- production line
- work center where configured

Required fields include:

- operators
- working days
- hours/day
- gross minutes
- utilisation
- efficiency
- productive minutes
- planned bookings
- actual production

Utilisation and efficiency are separate.

`productive_minutes = gross_available_minutes × utilisation × efficiency`

## 7. Capacity booking

`CapacityBooking` represents planned demand against a line/time period.

It includes:

- date/period
- line
- style/order
- planned quantity
- planned SMV minutes
- planned start/end
- required operators
- status

The system must warn when planned bookings exceed available productive capacity.

## 8. MRP net requirements

MRP should calculate:

`gross_requirement − on_hand − eligible_open_supply + safety_stock`

Open supply includes relevant purchase orders, transfers, and production orders according to their expected availability dates.

MRP must be date-aware.

A material needed tomorrow cannot be considered covered by a purchase order due next month.

## 9. Material planning

For every production proposal, MRP shows:

- required material
- gross required quantity
- current eligible stock
- reserved stock
- open purchase supply
- open production supply where relevant
- net requirement
- supplier
- MOQ
- pack size
- planned order quantity
- expected receipt date

MRP must respect MOQ and pack-size rules without silently overstating available material.

## 10. Production order lifecycle

Default lifecycle:

`Draft → Planned → Material Reserved → Released → Cutting → Sewing → Finishing → QC → Completed → Closed`

Cancellation/hold states are explicit.

A completed order cannot be silently reopened; reopening requires authorized action and audit trail.

## 11. Production-order confirmation

On confirmation, freeze:

- style/BOM version
- BOM quantities
- material prices
- landed-cost components
- planned waste
- size multipliers
- SMV
- minute-rate period/rate
- Factory margin
- Factory total cost
- transfer price

This creates the immutable CostSnapshot.

## 12. Cutting

Cutting requires a MaterialIssue.

The system records planned vs actual fabric consumption.

Cutting ticket includes:

- production order
- style/variant quantities
- marker/cut information where available
- standard required fabric
- actual fabric issued
- lots consumed
- waste
- operator
- timestamp

The system calculates actual waste and flags variance beyond threshold.

## 13. Sewing / production stages

ProductionStageLog records each stage/line event.

Minimum stages:

- cutting
- sewing
- finishing
- quality control

Each log can record:

- start/end
- operator/team/line
- quantity received
- quantity completed
- rejected quantity
- rework quantity
- earned SMV
- actual minutes
- downtime reason

## 14. Operator productivity

`OperatorProductivity` should support daily/period analysis.

Metrics include:

- attendance/available time where HR integration exists
- earned minutes
- actual minutes
- efficiency
- output quantity
- quality/rejection
- rework

The factory dashboard must distinguish low demand/utilisation from low shop-floor efficiency.

## 15. Rework

Rework is a separate event, not hidden inside normal output.

`ReworkRecord` stores:

- production order
- stage
- quantity
- reason
- minutes
- cost
- responsible area
- disposition

Rework cost is visible in planned-vs-actual reporting.

## 16. Scrap

`ScrapRecord` stores:

- production order
- material/product
- quantity
- value
- reason
- disposition
- approval

Dispositions may include:

- recoverable
- non-recoverable
- resale
- recycle
- write-off

Scrap must affect inventory/accounting according to disposition; it cannot disappear from the ledger.

## 17. Quality control

QC checkpoints may exist after:

- cutting
- sewing
- finishing
- final inspection

QC records:

- inspected quantity
- accepted
- rejected
- defect type
- severity
- corrective action
- inspector

Rejected units may enter rework or scrap depending on disposition.

## 18. Production completion

A production order can be completed only when required material, quantity, stage, and QC conditions are satisfied or an authorized exception is recorded.

Completion creates Factory finished-goods inventory.

The completed units retain their frozen economic cost.

## 19. Production variance

Every production order must show planned vs actual:

### Materials
- planned metres/pieces
- actual issued
- waste rate
- value variance

### Time
- planned SMV minutes
- actual minutes
- efficiency variance

### Output
- planned quantity
- completed quantity
- scrap
- rework

### Cost
- planned conversion cost
- actual conversion cost
- material cost variance
- total cost variance

## 20. External CMT

The Factory may receive external manufacturing orders.

External CMT orders use the same production engine but have a customer entity other than Cashmere Brand.

CMT revenue is credited to the Factory cost pool according to the accounting/cost-engine rule.

The system must show:

- CMT customer
- quoted rate
- minutes booked
- minutes consumed
- revenue
- cost attribution
- contribution to pool
- effect on Factory minute rate
- effect on Brand minute rate

External CMT must never contaminate Brand sales reporting.

## 21. Production costing

Production uses the Cost Engine specification.

`factory_total_cost = material_cost + cmt_cost`

`transfer_price = factory_total_cost × (1 + factory_margin)`

The Factory invoice to Brand uses the frozen transfer price.

## 22. Maintenance and downtime

Downtime should be captured separately from productive time.

Minimum reasons:

- no orders
- material shortage
- machine breakdown
- setup/changeover
- quality hold
- manpower shortage
- utilities
- other

This allows management to distinguish commercial idle capacity from operational inefficiency.

## 23. Planning horizons

MRP should support:

- daily operational horizon
- weekly production plan
- monthly capacity plan
- longer-term demand planning

Planning changes must not mutate historical production orders or cost snapshots.

## 24. Purchase recommendations

MRP may generate purchase recommendations but should not automatically place supplier orders without configured approval.

Recommendation contains:

- material
- quantity
- supplier
- MOQ/pack constraint
- required date
- expected shortage date
- linked demand

## 25. Production recommendations

MRP may generate production proposals.

A proposal becomes a production order only after approval.

The system should avoid duplicate production against the same demand.

## 26. Shortage handling

When material is short, the production order displays:

- shortage quantity
- shortage value
- expected availability
- affected units
- affected date
- supplier/open PO

The planner can prioritize orders by customer promise date, margin, or configured priority.

## 27. Traceability

Production trace must support both directions.

Forward:

`Material Lot → Material Issue → Production Order → Finished Goods Lot → Brand Transfer → Sale`

Backward:

`Customer Sale → SKU/Lot → Production Order → Material Issue → Material Lot → Supplier`

## 28. Required factory dashboards

1. Today's production
2. Planned vs actual output
3. Capacity utilisation
4. Factory efficiency
5. Idle minutes
6. Idle penalty EGP
7. Line performance
8. Operator productivity
9. Material shortages
10. Production WIP
11. Rework
12. Scrap
13. Quality rejection
14. Production cost variance
15. CMT capacity/revenue
16. Factory transfer revenue
17. Factory margin
18. Orders at risk
19. Material availability
20. Capacity overload

## 29. Alerts

At minimum:

- material shortage
- production order at risk
- capacity overload
- idle capacity above threshold
- efficiency below threshold
- waste above threshold
- scrap above threshold
- rework above threshold
- quality rejection above threshold
- delayed purchase supply
- overdue production stage

## 30. Acceptance criteria

Factory/MRP is production-safe only when:

- MRP is date-aware
- open supply cannot cover earlier demand incorrectly
- MOQ/pack-size constraints are respected
- production orders freeze costing at confirmation
- material issues are lot-aware
- planned vs actual consumption is measurable
- utilisation and efficiency are separately measurable
- WIP is reconstructible
- scrap and rework are explicit
- QC outcomes affect workflow correctly
- completed output creates inventory
- external CMT remains separate from Brand economics
- every production number traces back to its source event
