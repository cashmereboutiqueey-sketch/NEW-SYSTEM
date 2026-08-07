# Cashmere OS — MRP, Manufacturing & Production Workflow Specification

## Purpose
Turn demand into controlled production while preserving material, capacity, quality, costing and accounting traceability.

Core flow:
`Demand → MRP → Production Plan → Material Availability → Cutting → Sewing → Finishing → QC → Finished Goods → Factory/Brand Inventory`

## 1. Manufacturing master data

Style, Collection, Variant/SKU, BOM, Material, Supplier, Operation, Routing, SMV, Work Center/Line, Capacity Calendar, Waste Rules, Size Consumption Multiplier and QC Rules.

Variant = Style × Colour × Size. SKU remains `STYLENAME-COLORCODE-SIZE` using the approved colour-code list.

## 2. BOM architecture

A style can consume many materials and a material can be used by many styles. BOM lines therefore form the many-to-many bridge.

Each BOM line stores material, base quantity, unit, planned waste %, size multiplier, effective dates and notes. Historical BOM versions are immutable.

Size-based consumption uses a multiplier, default 1.0, instead of duplicate BOMs.

## 3. MRP demand sources

MRP may consume demand from Shopify, POS, moderator/social orders, confirmed wholesale/CMT orders, minimum-stock policies, collection plans and management production plans.

Every demand record carries its source so production decisions are explainable.

## 4. Net requirements

For each SKU/material:

`Net Requirement = Gross Requirement − Available Inventory − Confirmed Incoming + Safety Stock Requirement`

Reservations are respected. Stock committed to one demand cannot silently satisfy another.

MRP displays current stock, reserved stock, incoming PO quantity, supplier lead time, MOQ, pack size, shortage and recommended purchase quantity.

Purchase recommendation flow:
`MRP Recommendation → Review → Approval → Purchase Order`

MRP does not place supplier orders automatically by default.

## 5. Production orders

Production Order stores order number, style, variants, quantity, priority, requested date, planned start/end, line, routing, BOM version, SMV version, CostSnapshot and status.

Lifecycle:
`Draft → Planned → Material Reserved → Ready → Cutting → Sewing → Finishing → QC → Completed → Closed`

Exceptions: On Hold, Cancelled, Partially Completed, Rework.

Partial production is supported; remaining quantity stays open.

## 6. Material availability gate

Before cutting, the order must be:
- Available
- Partially available with authorized exception
- Ordered and approved for controlled release
- Blocked

Shortage overrides require authorization and are audited.

## 7. Cost snapshot

Production confirmation freezes BOM quantities, material landed prices, planned waste, SMV, minute-rate period, factory margin, factory cost and transfer price.

Later material-price or minute-rate changes never rewrite the historical snapshot.

## 8. Cutting and material issues

Every cutting ticket records planned quantity, actual cut quantity, standard requirement, actual issued quantity, material lot/roll, operator, timestamp, marker data where used, scrap and rejects.

Actual fabric waste:
`Actual Waste Rate = (Actual Issued / Standard Required) − 1`

Costing uses planned waste at snapshot time. Actual waste drives variance and alerts; it never retroactively rewrites the standard.

Material traceability:
`Supplier Receipt → Inventory Lot → Material Issue → Production Order → Finished Goods`

## 9. Routing and SMV

A style routing is an ordered list of operations, for example cutting, preparation, sewing, overlock, pressing, finishing, QC and packing.

Each operation stores standard time, work center, skill requirement, QC checkpoints and effective dates.

`SMV = Σ active operation standard minutes`

Every style cost must drill into its individual operations.

## 10. Capacity and lines

Production lines store operator count, shifts, calendar, available minutes, planned load, actual load, utilisation and efficiency.

CapacityBooking may reserve time for Brand production, external CMT, maintenance, training or planned downtime.

Scheduling conflicts and overloads are visible before release.

## 11. Utilisation vs efficiency

They remain separate diseases.

Utilisation answers whether available capacity was used because enough work existed.

Efficiency answers how much standard work was produced per actual production minute.

Attendance minutes, available minutes, productive minutes, downtime, setup/changeover and production minutes remain separate measures.

The capacity engine must remain compatible with the locked MinuteRatePeriod model and its utilisation × efficiency logic.

## 12. Production execution

Each stage records planned quantity, completed quantity, rejects, rework, actual minutes, downtime, operator/team and timestamp.

Sewing execution records line, operator/team, operation, start/end, units started/completed, rejects, rework and downtime.

WIP is reconstructible from stage and inventory movements, not a mutable dashboard number.

## 13. Rework and scrap

ReworkRecord stores production order, SKU, reason, operation, units, minutes, materials, stage/team, cost and disposition.

ScrapRecord stores item/material, quantity, reason, stage, cost, disposition and authorization.

Both remain visible as manufacturing variances and can feed accounting.

## 14. Quality

QC can occur at cutting, sewing, finishing and final inspection.

Record inspected, passed, failed, defect type, severity and rework/write-off decision.

Defects are reportable by style, SKU, operation, line, operator/team, material lot and defect type.

## 15. Finished goods and intercompany transfer

Approved production moves:
`WIP → Finished Goods`

Factory completion is not a Brand sale. Finished goods are transferred/invoiced to Brand at the frozen transfer price and received into the Brand logistics location.

The transfer is linked to the CostSnapshot and Accounting Engine.

## 16. Production variance

Report planned vs actual for:
- quantity
- material consumption
- waste
- minutes
- completion date
- quality
- cost

Separate variance buckets:
- material variance
- conversion/labour variance
- waste variance
- rework variance
- scrap variance
- total production variance

Actual production cost never overwrites the frozen transfer-price snapshot.

## 17. External CMT

External customer production uses the same manufacturing machinery but is tagged `External CMT`.

CMT can consume otherwise idle capacity. CMT pricing is compared against full-capacity minute rate, incremental economics, available capacity and minimum acceptable price.

CMT revenue credits the Factory cost pool according to the MinuteRatePeriod rule so the benefit of selling idle minutes reaches Brand economics.

Below-floor CMT pricing requires approval.

## 18. Dead-stock control

Before releasing production, show existing finished goods, ageing buckets, sales velocity, open demand, safety stock and projected ending stock.

The system must prevent production decisions that ignore existing dead stock unless explicitly overridden.

## 19. Collection planning

Collection planning includes launch date, styles, target quantities, required materials, capacity load, investment, expected sales and production deadline.

A collection cannot be treated as only a marketing object; it links to production, inventory and financial planning.

## 20. Change control

Post-confirmation changes create revisions, never silent edits. Controlled changes include BOM, material substitution, quantity, routing, SMV and production line.

Material substitution requires approved substitute status, compatibility confirmation, cost impact and production/QC impact.

## 21. Alerts

Minimum production alerts:
1. Material shortage
2. Late production order
3. Line overload
4. Excess downtime
5. Low efficiency
6. High waste
7. High rework
8. High scrap
9. QC failure spike
10. Material substitution
11. Dead-stock risk
12. Capacity gap

## 22. Dashboard

Permanent manufacturing KPIs:
- planned vs actual production
- available capacity
- utilisation
- efficiency
- downtime
- waste
- rework
- scrap
- shortages
- orders at risk
- idle minutes
- idle penalty/minute
- idle penalty/unit

Headline diagnostic: **الطاقة العاطلة**.

## 23. Traceability

Forward:
`SKU → Production Order → Routing → Operation → Operator/Line → Material Issue → Material Lot → Supplier`

Backward:
`Supplier Lot → Material → Production Orders → Finished Goods → Brand Sale`

## 24. Accounting events

Manufacturing must emit source events for raw-material consumption, WIP, finished goods, scrap/write-off, rework, Factory conversion cost, external CMT revenue and Brand transfer purchase.

No production report should need manual re-entry into accounting.

## 25. Acceptance criteria

The module is complete when:
- many-to-many Style/BOM/Material relationships work
- size multipliers work
- MRP respects reservations, MOQ and pack size
- shortages are visible before cutting
- production stages are traceable
- planned vs actual material/minutes/cost are reportable
- waste is measured from actual issue
- SMV drills to operations
- utilisation and efficiency remain separate
- WIP is reconstructible
- rework/scrap/QC are valued and traceable
- finished goods enter inventory through controlled movements
- Factory/Brand transfer uses frozen cost snapshots
- external CMT uses the capacity engine
- dead-stock risk is visible before production release
- manufacturing events feed accounting automatically.
