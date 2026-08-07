# Cashmere OS — Management Dashboards & Executive Cockpit Specification

## Purpose
Turn the accounting, factory, brand, inventory, commercial, HR and marketing engines into decision dashboards. Every KPI is drillable to source records.

## 1. Global header
Persistent controls:
- Entity: Factory / Brand / Group
- period
- comparison period
- location where relevant
- language AR/EN
- alerts
- user/profile

## 2. Owner cockpit
Primary tiles:
- Cash available
- Working capital locked
- CCC
- Factory minute rate
- Full-capacity minute rate
- Idle penalty per unit
- Brand contribution
- Break-even units and % of run
- Finished-goods capital by aging bucket
- Dead stock
- Production status
- Sales
- Returns
- Marketing contribution ROAS

## 3. Factory dashboard
Show:
- orders and backlog
- capacity booked
- gross minutes
- utilisation
- efficiency
- productive minutes
- actual minute rate
- full-capacity rate
- idle penalty
- CMT revenue credit
- material usage/waste
- production cost variance
- rework/scrap
- quality/yield
- operator productivity
- supplier/material issues

## 4. Brand dashboard
Show:
- sales by channel/location
- units
- net revenue
- transfer-price COGS
- contribution
- returns
- discounts
- marketing spend
- contribution ROAS
- break-even
- stock coverage
- aged/dead stock
- showroom performance
- moderator performance
- Shopify performance
- exhibition performance

## 5. Group dashboard
Show consolidated P&L after eliminating:
- Factory revenue to Brand
- Brand transfer-price COGS
- unrealised intercompany margin in unsold finished goods

Also show group cash, inventory, working capital, EBITDA/operating result according to configured accounting policy.

## 6. Permanent diagnostic tiles
Two permanent diagnostic concepts:
- `الطاقة العاطلة` — idle penalty per unit
- `دورة الكاش` — CCC + working capital locked

They should remain visible in management views even when not selected as the main KPI.

## 7. Inventory cockpit
Show raw material, WIP and finished goods by location and age:
- 0–30
- 31–60
- 61–90
- 90+

Each bucket shows quantity, cost and capital locked. Drill to InventoryLot and movements.

## 8. Production cockpit
Show planned vs actual:
- quantity
- material consumption
- minutes
- cost
- completion
- defects
- rework
- scrap

Flag material shortages, late orders and capacity bottlenecks.

## 9. Cash cockpit
Show:
- opening/closing cash
- expected collections
- supplier payments
- payroll
- rent
- scheduled cash items
- debt/other liabilities where configured
- forecast cash
- working-capital lock

Separate forecast from actual.

## 10. Commercial cockpit
Compare channel/location/style:
- gross sales
- discounts
- returns
- net sales
- variable costs
- contribution
- AOV
- units
- stock

## 11. Marketing cockpit
Show:
- spend
- revenue
- contribution
- ROAS
- contribution ROAS
- CAC
- new customers
- return rate
- campaign/style/creative performance

Always display attribution model and period.

## 12. CRM cockpit
Show:
- active customers
- new customers
- repeat rate
- RFM segments
- at-risk customers
- customer contribution
- moderator conversion
- return behaviour

## 13. HR cockpit
Show permissioned:
- headcount
- attendance
- absence
- overtime
- payroll
- Factory labour pool
- Brand payroll
- operator productivity
- capacity impact

## 14. Accounting cockpit
Show:
- trial balance summary
- P&L
- balance sheet summary
- cash flow
- AP aging
- AR aging
- inventory valuation
- VAT
- accruals
- unreconciled items

## 15. Alert center
Alerts are prioritized:
- critical
- high
- medium
- informational

Each alert links to a source record and suggested action. Alerts never silently change data.

## 16. Drill-down rule
Every KPI follows:
`KPI → calculation → contributing records → source document → external reference`

For example:
`Idle penalty/unit → minute-rate period → factory cost pool → expense lines → supplier invoice/payment evidence`.

## 17. KPI definitions
KPI cards must show formula, period, scope and source. No ambiguous labels such as “profit” without specifying whether it means contribution, operating result or group net income.

## 18. Comparisons
Support prior period, budget and target comparisons. Variance explanations should identify the main contributing categories.

## 19. Export
Authorized users can export reports with entity, period, filters and generated timestamp. Sensitive reports are permission controlled.

## 20. Acceptance criteria
The dashboard layer is complete when Factory, Brand and Group have coherent management views, permanent idle/cash diagnostics exist, every KPI is drillable, accounting and operational metrics reconcile to source ledgers, and the owner can move from a red KPI to the exact transaction causing it.
