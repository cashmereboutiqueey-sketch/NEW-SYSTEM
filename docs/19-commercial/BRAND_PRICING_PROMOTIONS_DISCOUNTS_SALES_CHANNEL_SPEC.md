# Cashmere OS — Brand Pricing, Promotions, Discounts & Sales Channels Specification

## Purpose
Create one controlled commercial pricing engine for Shopify, POS, moderator/social orders, showrooms and exhibitions while preserving the original list price, discount, net price, customer/channel and approval history.

## 1. Sales channels
Brand channels include:
- Shopify website
- POS — Alexandria showroom
- POS — Cairo showroom
- Moderator/social orders
- Exhibitions/bazaars

Each SalesChannel has its own payment-fee rules, return behaviour, default discount policy and operational owner.

## 2. Locations
Brand inventory locations include:
- Alexandria showroom / Brand warehouse
- Cairo showroom
- exhibition/event locations
- online allocation/fulfilment pool where configured

The Alexandria showroom is the primary Brand warehouse and showroom unless configuration changes.

## 3. Product structure
`Collection → Style → Variant/SKU`

Variant = colour × size.
SKU follows the configured uppercase format and remains immutable once used in transactions.

## 4. Price lists
Support effective-dated price lists with:
- style/variant
- list price ex-VAT
- VAT rate
- channel
- effective from/to
- approval status

Historical sales retain the exact price applied.

## 5. Pricing calculator
For each style, the Brand pricing calculator shows:
- transfer-price COGS
- packaging
- expected shipping
- payment fee
- marketing per unit
- return handling
- allocated Brand fixed-cost target where configured
- target contribution/profit margin
- suggested retail price

It must show the formula and inputs rather than only a final number.

## 6. Price floors
Optional minimum price can protect contribution margin. A user cannot publish a price below a configured floor without approval and reason.

## 7. Discounts
Discounts can be:
- order-level
- line-level
- campaign-based
- customer-segment based
- channel-based
- clearance/stock-age based

Store original price, discount amount/percentage, code/campaign and approver where required.

## 8. Promotion stacking
Promotion rules explicitly define whether discounts stack. The engine must prevent unintended stacking and show the exact price waterfall before checkout/POS confirmation.

## 9. Sale and clearance
Dead/slow stock can trigger eligible clearance recommendations based on age and locked capital. Clearance is still an approved commercial decision and does not rewrite original cost.

## 10. Moderator orders
Moderator creates the order directly in Cashmere OS when a customer buys through DMs.

Required attribution:
- moderator
- channel = social/moderator
- customer
- products/variants
- discount
- payment method/status
- fulfilment location
- shipping
- notes

Moderator must not be required to create a duplicate Shopify order for a social sale.

## 11. Shopify orders
Shopify website orders enter through the Shopify connector and are mapped to internal customer/order/SKU records. Shopify remains the website checkout source; Cashmere OS remains the internal operational/accounting record.

## 12. POS orders
POS sales are created directly in the internal system. Cashier, location, payment method and shift are mandatory context.

## 13. Exhibition orders
Exhibition sales can use a POS-like offline workflow with event/location attribution, then reconcile when connectivity returns.

## 14. Customer attribution
Every Brand sale identifies source channel and, where applicable:
- moderator
- cashier
- exhibition
- campaign
- referral/source

This allows sales and incentive analysis by source without changing financial revenue.

## 15. Payment fees
Payment fee rules vary by channel and payment method. COD may use per-order fee; cards may use percentage; configured gateways can use mixed fixed + percentage fees.

Convert order-level fees into per-unit economics according to a defined allocation basis, defaulting to units when appropriate.

## 16. Returns
Returns link to original sale/order line and preserve original selling price, discount and channel.

Return rate used in style economics is trailing actual where history exists, otherwise channel/Brand default.

Resellable returns re-enter the appropriate Brand inventory location at original inventory cost. Damaged returns follow write-off/quarantine workflow.

## 17. Omnichannel stock
Inventory is location-aware. A sale reduces stock from the actual fulfilment/selling location. Transfers between Alexandria, Cairo and exhibitions are explicit InventoryMovement events.

## 18. Reservation
Online orders may reserve inventory before fulfilment. POS and moderator orders follow configured reservation/commit rules.

Reservations are not consumption and must not double-count available stock.

## 19. Customer segments
CRM segments can drive eligible promotions, but financial discounts remain explicit transaction values.

Examples:
- VIP
- repeat customer
- first purchase
- inactive customer
- high-return customer

## 20. Campaign linkage
Every promotional price can link to a Campaign/Promotion record so marketing can compare spend, sales, discount cost and contribution.

## 21. Contribution view
For every channel/style, show:
`Effective Revenue − (Transfer Price + Packaging + Shipping + Payment Fee + Marketing/Unit + Return Handling)`

Break-even uses Brand-only allocated fixed costs and clearly lists the pool.

## 22. Price waterfall
Display:
`List Price → Promotion/Discount → Net Price → VAT treatment → Return-adjusted Revenue → Variable Costs → Contribution`

This makes pricing decisions auditable.

## 23. Approval thresholds
Approval may be required for:
- below-floor price
- discount above threshold
- manual price override
- refund above threshold
- free item
- staff discount

## 24. Customer credit/store credit
If enabled, store credit is tracked as a liability/credit balance, not negative revenue. Redemption links to original issuance.

## 25. Gift cards
If enabled, gift-card sale creates liability until redemption according to accounting policy. Expiry/breakage follows configured policy and applicable law.

## 26. Price history
Price changes are effective-dated and immutable historically. Every change records requester, approver, timestamp and reason where approval applies.

## 27. Channel performance
Dashboard compares channels on:
- units
- gross sales
- discounts
- net sales
- returns
- contribution
- payment fees
- shipping cost
- marketing cost
- average order value
- conversion where data exists

## 28. Acceptance criteria
The commercial engine is complete when Shopify, POS, moderator/social and exhibitions share the same SKU/customer/order/pricing logic; each transaction preserves price/discount/channel attribution; location-aware inventory is respected; returns reverse correctly; payment fees and marketing allocation feed unit economics; and pricing decisions can be audited from retail price to contribution and break-even.
