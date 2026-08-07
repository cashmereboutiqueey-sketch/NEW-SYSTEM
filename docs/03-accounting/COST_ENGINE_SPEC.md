# Cashmere OS — Cost Engine Specification

**Status:** Draft for implementation
**Owner:** Finance + Factory Operations
**Source:** Master Specification v1

## 1. Objective

Produce an immutable, auditable economic cost for every Factory production order and an operating unit-economic view for every Brand style/variant.

The engine must distinguish:

- material cost
- conversion cost
- capacity loss
- transfer margin
- Brand variable costs
- Brand-only fixed costs
- Group economic cost

No historical cost may change because a supplier changes a price later.

## 2. Decimal policy

- Money: `Decimal(18,4)`
- Quantity: `Decimal(18,4)`
- Rates: `Decimal(18,8)`
- Percentages/rates are stored as fractions: `0.14 = 14%`
- No floating-point arithmetic in domain calculations.
- Rounding occurs only at presentation/reporting boundaries.
- Display EGP to 2 decimal places.

## 3. Factory minute-rate engine

### Inputs

- operators
- working days
- hours per day
- utilisation
- efficiency
- factory conversion cost pool
- external CMT revenue credit

### Formulas

```text
gross_available_minutes = operators × working_days × hours_per_day × 60
productive_minutes = gross_available_minutes × utilisation × efficiency
net_cost_pool = total_factory_conversion_cost − cmt_revenue_credit
actual_minute_rate = net_cost_pool / productive_minutes
full_capacity_minute_rate = net_cost_pool / gross_available_minutes
idle_penalty_per_minute = actual_minute_rate − full_capacity_minute_rate
idle_penalty_per_unit = idle_penalty_per_minute × style_smv
```

Utilisation and efficiency must remain separate in storage and reporting.

- Utilisation answers: how much capacity had orders?
- Efficiency answers: how well did the operators convert clock time into earned standard minutes?

If external CMT revenue is credited to the cost pool, the system must show the gross pool, credit, net pool, and both minute rates in the drill-down.

## 4. Minute rate versioning

Exactly one period record per entity/month.

The record stores:

- period
- capacity inputs
- gross minutes
- utilisation
- efficiency
- productive minutes
- gross conversion cost pool
- CMT revenue credit
- net cost pool
- actual minute rate
- full-capacity minute rate
- idle penalty
- status
- locked_at

A production order stores the minute-rate-period reference and frozen rate in its CostSnapshot.

## 5. Material effective cost

```text
material_effective_cost = purchase_price + allocated_freight + allocated_customs_clearing
```

The engine uses landed cost, not supplier invoice price alone.

Freight and clearing are capitalized into material cost according to the approved allocation rule.

## 6. Style material costing

```text
effective_consumption = standard_consumption × (1 + planned_waste_rate)
fabric_cost = effective_consumption × material_effective_cost
trim_cost = Σ(trim_qty × trim_effective_cost)
material_cost = fabric_cost + trim_cost
```

Each BOM line supports a per-size consumption multiplier, default `1.0`.

A product may consume multiple fabrics/materials, and one fabric/material may be used by many products. The data model must therefore be many-to-many through BOM/material lines rather than a single material foreign key on a style.

## 7. SMV costing

```text
smv_minutes = Σ StyleOperation.smv_minutes
cmt_cost = smv_minutes × frozen_minute_rate
factory_total_cost = material_cost + cmt_cost
```

Operations are individually traceable.

Example:

`Style → Operations → sleeve attach → 4.2 SMV → minute rate → cost`

## 8. Transfer price

```text
transfer_price = factory_total_cost × (1 + factory_margin)
```

`factory_margin` is configurable globally with an optional per-style override.

The system must enforce a configured arm's-length minimum.

A style override below the minimum is blocked. An override above the minimum is permitted but flagged for audit visibility.

## 9. Immutable CostSnapshot

Confirmation of a production order creates an append-only CostSnapshot.

Snapshot must include:

- style
- production order
- quantity
- every BOM line
- material quantity
- material price
- landed-cost components
- waste rate
- size multiplier
- operation list
- SMV
- minute-rate period
- minute rate
- material subtotal
- conversion subtotal
- factory total cost
- margin
- transfer price
- snapshot timestamp

No update operation may mutate a confirmed snapshot.

Corrections create a new adjusting snapshot/record linked to the original.

## 10. Waste variance

Cutting tickets record actual issue quantity.

```text
actual_waste_rate = (actual_issued / standard_required) − 1
```

Costing continues to use planned waste at snapshot time.

Actual trailing waste is used for variance reporting.

If:

`actual_waste_rate > planned_waste_rate + configured_threshold`

then the style receives a waste alert.

Historical costs are never recalculated because actual waste later changed.

## 11. Production planned-vs-actual

For each production order show:

- planned material quantity vs actual issue
- planned waste vs actual waste
- planned SMV vs actual earned/clocked minutes
- planned conversion cost vs actual conversion cost
- planned total cost vs actual total cost
- variance in EGP
- variance percentage
- root-cause category

The variance engine must distinguish material variance from labor/time/efficiency variance.

## 12. Brand pricing calculator

The Brand pricing tool accepts:

- frozen transfer price
- packaging
- shipping
- payment fee by channel
- marketing per unit
- return handling
- discount rate
- return rate
- Brand fixed-cost pool
- target profit margin

Core formulas:

```text
net_price = retail_price × (1 − discount_rate)
effective_revenue = net_price × (1 − return_rate)
variable_cost = transfer_price + packaging + shipping + payment_fee + marketing_per_unit + return_handling_cost
contribution_margin = effective_revenue − variable_cost
break_even_units = allocated_brand_fixed_costs / contribution_margin
break_even_share = break_even_units / production_run_quantity
```

If contribution margin ≤ 0, break-even is reported as `never`.

Break-even share > 60% is high risk.

## 13. Important accounting distinction

This contribution margin is an **operating decision metric**, not textbook variable-cost CVP, because the transfer price contains absorbed Factory fixed conversion overhead.

The Group P&L remains the authoritative view for true fixed/variable economic behavior.

The UI must label these two concepts distinctly.

## 14. Marketing allocation

Default allocation basis: **units sold in the reporting period**.

A style may have a campaign-specific allocation override.

The engine must show:

- total marketing expense
- allocation basis
- style share
- allocated EGP
- override reason

The same expense must remain traceable to the accounting transaction.

## 15. Capital and inventory economics

The cost engine feeds capital-lock reporting.

For a purchased fabric lot:

```text
purchase cash/credit
        ↓
raw material inventory
        ↓
material issued to production
        ↓
WIP
        ↓
finished goods
        ↓
customer sale
        ↓
realized COGS + cash/receivable
```

The engine must not call unsold inventory profit.

For Group reporting, unsold Brand inventory includes no unrealized Factory margin.

## 16. Cost traceability contract

Every domain calculation function should return:

- value
- unit
- formula identifier/version
- input references
- input values
- source records
- warnings
- assumptions

This is required so UI drill-down can explain every number.

## 17. Failure rules

The engine must block calculation when required economic inputs are missing, including:

- missing material price
- missing applicable landed-cost rule
- missing BOM quantity
- missing SMV
- missing minute rate
- missing arm's-length margin floor

It must never silently substitute zero.

Explicit approved defaults are allowed only where the schema defines them, e.g. size consumption multiplier `1.0`.

## 18. Required test cases

1. Decimal precision across a full cost chain.
2. Supplier price change does not alter a locked snapshot.
3. Planned waste differs from actual waste without rewriting cost.
4. Utilisation change alters actual minute rate.
5. Efficiency change alters productive minutes and rate.
6. CMT revenue credit lowers the net pool and minute rate.
7. Transfer price below minimum margin is blocked.
8. Style margin override is visible and traceable.
9. Multiple materials on one style cost correctly.
10. One material used by multiple styles costs independently.
11. Size multiplier changes material cost only for affected size.
12. Negative/zero contribution margin returns `never` break-even.
13. Marketing allocation follows units sold unless overridden.
14. Group elimination removes unrealized Factory margin from unsold units.
15. Historical period recalculation cannot modify locked production costs.
