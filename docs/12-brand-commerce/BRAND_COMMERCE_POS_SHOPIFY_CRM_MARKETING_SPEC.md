# Cashmere OS — Brand Commerce, POS, Shopify, CRM & Marketing Specification

## 1. Purpose
Create one Brand commercial layer covering Shopify, Alexandria showroom POS, Cairo showroom POS, social-media moderator orders, temporary exhibitions/bazaars, inventory locations, customers, CRM, promotions, marketing and attribution.

The Brand is the commercial entity. Factory production and accounting remain linked through controlled transfer-price transactions.

## 2. Brand locations
- Alexandria showroom + Brand warehouse
- Cairo showroom
- Temporary exhibition/bazaar locations
- Online fulfilment/channel

A location can hold stock and/or process sales. Availability is location-aware.

## 3. Channels
- Shopify website
- Alexandria POS
- Cairo POS
- Exhibition/bazaar POS
- Social media / moderator orders
- Future wholesale

Channel and location are separate dimensions. A moderator order may fulfil from Alexandria stock.

## 4. Shopify integration
Shopify is the website commerce source, not the master accounting system.

Import/sync products, variants, SKU, inventory, orders, customers, discounts, refunds/returns, payment status and fulfilment status. Internal SKU is canonical; Shopify IDs are external mappings.

Idempotency is mandatory: duplicate webhooks/imports cannot duplicate sales, payments, customers or inventory movements.

## 5. Inventory sync
Cashmere OS is the operational inventory source of truth for multi-location Brand stock; Shopify is the website-facing channel.

Available-to-sell quantities are calculated internally and published to Shopify. Reserve stock when an order is confirmed; release on cancellation/expiry; deduct on configured fulfilment event. Conflicts become alerts rather than silent overwrites.

## 6. POS
Support product/SKU search, barcode scanning, customer lookup, discounts, payments, returns/exchanges, refunds, stock location, cashier, shifts, receipts, cash drawer and end-of-shift reconciliation.

Every POS sale creates commerce, inventory and accounting source events.

## 7. Moderator social orders
Social orders are entered by moderators after customers contact the Brand through social DMs.

Workflow: `Lead/Conversation → Order Draft → Customer Confirmation → Reserved → Fulfilled → Completed`

Every order records moderator, source platform, customer, SKUs, quantity, price, discount, address, delivery method, payment status and timestamps.

A social order does not need to exist in Shopify.

## 8. Moderator attribution
Track per moderator: leads/orders handled, orders created, conversion where lead data exists, gross/net sales, discounts, cancellations, returns, collected orders and AOV. Optional approved incentives feed payroll.

## 9. Exhibitions / bazaars
Temporary locations have dates and inventory transfers/reservations.

`Origin Location → Event Location → Sale`

Remaining stock returns to origin after the event. Event P&L includes sales, discounts, payment fees, transport, booth cost and event marketing.

## 10. Customers
One Brand customer record is shared by Shopify, POS and moderator orders. Store identity, contact details, addresses, acquisition source, first/last order, LTV, order count, return rate, discount dependence, preferred channel and style/category affinity.

Duplicate detection uses configurable signals; no blind merges.

## 11. CRM lifecycle
`New → First Purchase → Active → Repeat → At Risk → Lapsed → VIP`

CRM activities include calls, connected outreach, notes, tasks, follow-ups and campaign membership. Stage changes are rule-driven and auditable.

## 12. Customer intelligence
Deterministically calculate RFM, lifetime/net lifetime revenue, AOV, frequency, recency, return rate, discount rate, acquisition source, channel preference and collection/style affinity. AI is not required for these calculations.

## 13. Marketing
Campaigns belong to Brand and contain objective, dates, channel, collection/style, spend, creative, audience and attributed orders/revenue.

Channels include Meta Ads, Instagram, Facebook, TikTok, Google, influencer, events/bazaars and offline.

## 14. Marketing allocation
Default allocation is by units sold. Style-level override is allowed for dedicated campaigns. Allocation is reporting logic only and never mutates original spend.

## 15. Ads integration
Use connector architecture for ad platforms; support Meta Ads first. Import spend and campaign metadata where available. No AI model/API is required for campaign import, attribution or financial calculations.

## 16. Attribution
Priority: explicit order source → campaign code/UTM → platform click/session where available → customer acquisition source → configured fallback. Unknown stays unknown; never invent attribution.

## 17. Promotions
Support percentage, fixed amount, item/order-level, campaign code, moderator and POS discounts. Discount authority is role-based and discounts remain separately reportable as a margin-leak metric.

## 18. Returns and exchanges
`Requested → Approved → Received → Inspected → Resellable/Damaged → Completed`

Resellable returns re-enter finished goods at original cost. Damaged returns are written off. Exchanges preserve the customer journey and are represented by linked return/new fulfilment events.

## 19. Fulfilment
Orders may fulfil from eligible Brand locations. Allocation may consider stock, shipping cost, promised date and location rules. Final fulfilment source is retained for profitability analysis.

## 20. Shipping
Capture customer-paid shipping, Brand-paid shipping, courier cost, COD fees, failed delivery and redelivery. Shipping economics feed unit and channel profitability.

## 21. Payments
Support cash, card, COD, bank transfer and online gateway with configurable settlement and payment-fee rules.

## 22. Catalogue
`Collection → Style → Variant → SKU`

Variant = Colour × Size. Product data includes retail price, VAT policy, active status, content references, collection and Shopify mappings.

## 23. Brand price calculator
Inputs: transfer-price COGS, packaging, shipping, payment fee, marketing allocation, return handling, optional Brand fixed-cost allocation and target profit margin.

Outputs: recommended selling price, contribution margin, break-even units and break-even %. Clearly label operating contribution versus Group accounting profit.

## 24. Break-even
`Contribution Margin = Effective Revenue − Variable Cost`

`Break-even Units = Brand-only Fixed Costs / Contribution Margin`

`Break-even % = Break-even Units / Production Run Quantity`

Show the result as a share of the run, e.g. `340 units = 62% of run`; above 60% is red by default. Fixed-cost drilldown explicitly lists Brand-only costs and excludes Factory overhead already absorbed by transfer price.

## 25. Showroom operations
Dashboard: sales today, sales by cashier/SKU/style, stock on hand/reserved, returns, discount rate, AOV, payment reconciliation and target. Showroom inventory reconciles to the Brand inventory ledger.

## 26. Incentives
Optional salesperson/cashier/moderator incentives based on net/collected sales, returns and discount rules. Approved incentives feed HR/payroll/accounting.

## 27. CRM + inventory
Demand signals available to MRP: open customer orders, Shopify demand, POS demand, moderator demand, repeat purchase trends and collection velocity. CRM does not create production automatically; it feeds the approved planning workflow.

## 28. Marketing + production
Link campaigns to collections/styles and compare `Spend → Orders → Net Revenue → Returns → Contribution → Inventory velocity`.

## 29. Customer profitability
Where supported: `Net Revenue − product COGS − shipping − payment fees − discounts − returns/handling − allocated marketing`. Do not arbitrarily allocate Factory fixed costs to customer profitability.

## 30. Brand dashboard
Permanent metrics: Net Sales, Contribution Margin, Break-even %, Brand inventory value, dead stock value, CCC, locked working capital, Shopify sales, POS sales, moderator sales, bazaar sales, return rate, discount rate, marketing spend and ROAS/contribution after marketing where attribution supports it.

## 31. Accounting integration
Commercial events emit accounting-ready records for sale, discount, VAT, payment, settlement, return/refund, shipping, payment fee, inventory COGS, marketing spend and event costs. No channel maintains a hidden P&L.

## 32. Reconciliation
Daily views compare Shopify orders/imports, POS sales/shift totals, moderator orders/fulfilments, inventory/channel sales, payment settlements/bank and returns/inventory receipts. Exceptions remain open until resolved.

## 33. Acceptance criteria
Shopify sync is safe and idempotent; POS works in Alexandria, Cairo and events; moderator orders are first-class sales with attribution; inventory is location-aware; event stock can transfer and return; CRM unifies customers; returns preserve original cost; marketing spend/attribution is reportable; pricing uses approved Brand economics; discount/return leakage is visible; accounting receives all commercial events; duplicate external orders cannot duplicate financial/inventory effects; every KPI drills to source transactions.
