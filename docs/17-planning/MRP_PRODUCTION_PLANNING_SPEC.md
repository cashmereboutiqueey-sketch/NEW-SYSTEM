# Cashmere OS — MRP, Demand Planning & Production Planning Specification

## Purpose
Turn sales demand, inventory, BOMs, capacity and supplier lead times into controlled purchasing and production recommendations without allowing automation to bypass management approval.

## 1. Planning hierarchy
`Demand → Net Available Inventory → MRP → Purchase Suggestions + Production Suggestions → Capacity Check → Approval → Execution`

## 2. Demand sources
Demand planning can use:
- confirmed Brand sales orders
- Shopify orders
- POS sales/orders
- moderator social orders
- exhibition/bazaar demand
- open customer reservations
- approved forecasts
- collection/style plans

Historical demand remains traceable to source channel.

## 3. Inventory netting
For each SKU/material, planning considers:
- on-hand
- reserved
- available
- open purchase orders
- open production orders
- safety stock
- confirmed demand
- expected returns where configured

Never count reserved stock twice.

## 4. Style and variant planning
Planning occurs at style and SKU/variant levels. Variant = colour × size.

A style may have multiple fabrics/materials and one material may be used by multiple styles. MRP explodes the BOM graph accordingly.

## 5. BOM explosion
For a planned production quantity:
`Required Material = Qty × BOM Consumption × Size Multiplier × (1 + Planned Waste Rate)`

The system shows gross requirement, available stock, allocated stock, incoming POs, net requirement and suggested purchase quantity.

## 6. Material relationships
One finished product can consume many materials. One material can feed many products. The planning engine must support many-to-many material/product relationships through BOM lines.

## 7. Lead times
Material planning stores supplier lead time, MOQ, pack size and expected delivery. Production planning stores operation lead times and planned production duration.

Recommendations include required-by date and latest order date.

## 8. MOQ and pack size
Purchase suggestions round to supplier MOQ/pack rules and clearly show the resulting excess quantity/value.

Do not hide MOQ-induced overbuying; expose it as potential locked working capital.

## 9. Supplier selection
Where multiple suppliers can provide a material, compare price, lead time, MOQ, quality score and approved status. The planner can select a preferred supplier or require approval.

## 10. Capacity planning
Capacity uses separate utilisation and efficiency:
`Gross Minutes = Operators × Working Days × Hours × 60`
`Available Productive Minutes = Gross × Utilisation × Efficiency`

Production plans are checked against line/work-centre capacity and planned downtime.

## 11. Bottleneck detection
Show the first constrained operation/line and its impact on promised completion dates.

Capacity shortages can be addressed through overtime, line reassignment, external CMT or date changes, each requiring configured approval.

## 12. External CMT
CMT is a capacity-release option when internal capacity is constrained. External CMT work is separately costed and priced under Factory rules.

CMT revenue credits the Factory cost pool according to the approved minute-rate methodology, lowering the Brand's absorbed minute rate without pretending CMT is free capacity.

## 13. Production order proposal
MRP can propose production orders containing:
- style
- variant quantities
- target location
- required-by date
- BOM version
- planned material consumption
- planned SMV/minutes
- capacity load
- expected cost
- linked demand

Management approval converts proposal to production order.

## 14. Material reservation
Approved production orders reserve required material lots according to FIFO and configured issue rules. Reservations reduce available stock but do not create consumption until actual MaterialIssue.

## 15. Purchase suggestions
Purchase recommendations include material, supplier, quantity, MOQ/pack rounding, expected landed cost, required date, projected shortage and linked demand.

Converting a suggestion to PO requires approval where configured.

## 16. Sales and production relationship
The system must distinguish:
- made-to-stock
- made-to-order
- replenishment
- event/bazaar allocation

A production order can be linked to one or multiple demand sources.

## 17. Collection planning
Collections can have launch date, target quantity, styles, variants, expected demand and production window. Collection plans feed MRP but do not alter accounting until actual transactions occur.

## 18. Scenario planning
Use Scenario + ScenarioResult for What-If:
- +20% sales
- -10% returns
- new collection
- supplier delay
- material price change
- additional operators
- higher utilisation
- external CMT minutes

Scenario results never mutate live inventory or accounting.

## 19. Inventory ageing feedback
Dead stock and slow-moving inventory reduce the recommendation to produce replenishment unless a manager explicitly overrides it.

Planning should surface locked capital before recommending more purchases.

## 20. Demand confidence
Forecasts have source, period, owner and confidence level. Forecast and confirmed demand are shown separately.

## 21. Seasonality
Support monthly/collection seasonal patterns without overwriting historical sales. Planning can compare current run-rate with prior periods.

## 22. Material availability warning
If a planned production order lacks sufficient material by required date, show the specific material, shortage quantity, supplier lead time and expected delay.

## 23. Production scheduling
Schedule by work centre/line and operation. Show planned start/end, operator capacity, downtime, dependencies and priority.

Scheduling must not assume every operator can perform every operation; skill/operation eligibility can be configured.

## 24. Production actuals
Compare planned vs actual:
- quantity
- material consumption
- waste
- minutes
- completion time
- scrap
- rework
- cost

Variance feeds operational reporting but does not rewrite locked standard cost snapshots.

## 25. MRP outputs
Dashboard should show:
- material shortages
- purchase suggestions
- production suggestions
- capacity bottlenecks
- excess/MOQ overbuy
- dead-stock warnings
- required-by risks
- projected working capital

## 26. Approval workflow
`Draft → Reviewed → Approved → Released → Executing → Completed/Cancelled`

Purchase and production recommendations are not commitments until approved.

## 27. Auditability
Every MRP recommendation stores the demand, inventory, BOM, lead time, capacity and settings used to generate it. Re-running MRP later must not rewrite the historical recommendation.

## 28. Acceptance criteria
MRP is complete when it can explode multi-material BOMs, account for materials shared by many products, net location-aware inventory, apply waste/size multipliers, respect MOQ/pack/lead time, plan capacity with utilisation × efficiency, expose bottlenecks and locked working capital, incorporate CMT as a capacity option, and generate auditable purchase/production recommendations without automatically changing the books.
