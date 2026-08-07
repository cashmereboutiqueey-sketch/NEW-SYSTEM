# Cashmere OS — Brand POS, Omnichannel Commerce & Shopify Specification

**Status:** Draft for implementation
**Entity:** Brand
**Scope:** Alexandria showroom, Cairo store, Shopify, moderator/social orders, temporary exhibitions/bazaars, inventory fulfillment, POS, payments, returns, customer attribution and stock synchronization.

## 1. Purpose

Cashmere Brand sells through multiple channels while using one Brand inventory truth.

Supported channels:

- Alexandria showroom / Brand warehouse
- Cairo store
- Shopify website
- Social-media moderator orders
- Temporary exhibitions / bazaars
- Other future Brand channels

The system must answer at any moment:

- what stock exists
- where it physically exists
- what is reserved
- what is available to sell
- where a sale came from
- who created the order
- who fulfilled it
- how it was paid
- what was returned
- what inventory remains

## 2. Brand locations

The Alexandria location is both:

- Brand showroom
- Brand warehouse / fulfillment stock point

It is not a separate company/entity.

The system must distinguish **location** from **economic entity**.

Cairo is a second permanent Brand location.

Each bazaar/exhibition can be created as a temporary Brand location for the event period.

## 3. Inventory location model

Every Brand inventory quantity is associated with:

- SKU
- InventoryLot
- physical location
- quantity
- cost
- reservation status

Available stock:

`on_hand − reserved − unavailable/hold`

A location transfer changes physical location but does not create revenue or profit.

## 4. Sales channels

SalesChannel supports:

- SHOPIFY
- SOCIAL_MODERATOR
- POS_ALEXANDRIA
- POS_CAIRO
- BAZAAR
- OTHER

The order's sales channel is immutable after confirmation except through controlled correction.

## 5. Order source vs fulfillment location

These are separate fields.

Example:

`Source = SOCIAL_MODERATOR`

`Fulfillment = ALEXANDRIA`

Another example:

`Source = SHOPIFY`

`Fulfillment = ALEXANDRIA`

This prevents online/social orders from being confused with physical-store sales.

## 6. Brand order lifecycle

`Draft → Confirmed → Reserved → Picking → Packed → Fulfilled → Completed`

Alternative states:

- Cancelled
- Partially fulfilled
- On hold
- Returned
- Partially returned

A confirmed order reserves inventory according to configured policy.

## 7. POS sale lifecycle

For showroom/bazaar sales:

`Open Cart → Payment → Completed`

The POS must support:

- SKU scan/search
- variant selection
- quantity
- discount
- customer optional/required by policy
- payment method
- cashier
- location
- receipt
- return reference

## 8. Payment methods

Configurable payment methods include:

- cash
- card
- wallet
- bank transfer
- COD
- online gateway
- other

Payment method is separate from sales channel.

## 9. Payment fees

Payment fees are configured per SalesChannel/payment method.

Examples:

- card percentage
- COD per-order fee
- gateway percentage + fixed fee

For style economics, fees are converted into an appropriate per-unit amount.

Actual transaction fees should be reconciled to accounting.

## 10. Shopify integration

Shopify is an external commerce channel, not the Brand's accounting master.

Integration responsibilities:

### Import from Shopify

- products
- variants/SKUs
- orders
- customers where permitted
- discounts
- refunds
- fulfillment status
- payment status
- inventory-relevant events
- timestamps
- source/UTM information where available

### Send to Shopify

- SKU availability
- inventory quantities according to the configured sellable-location policy
- product/variant status where explicitly enabled
- fulfillment updates where supported

The integration must be idempotent and event-aware.

## 11. Shopify product mapping

Each Shopify variant must map to exactly one Cashmere SKU.

Store:

- Shopify product ID
- Shopify variant ID
- Cashmere SKU
- location mapping
- sync status
- last sync
- external updated timestamp

Never identify a product only by its display name.

## 12. Shopify inventory synchronization

Cashmere OS is the operational inventory source of truth for Brand stock.

Shopify is a sales channel consuming the sellable quantity.

Recommended flow:

`Purchase/Production → Brand Inventory → Available-to-Sell → Shopify`

Shopify orders then create/reconcile inventory reservations and sales.

Avoid two systems independently deciding the final quantity.

## 13. Inventory sync safeguards

Prevent:

- negative stock caused by duplicate webhooks
- duplicate order import
- duplicate refund import
- quantity overwrite from stale Shopify data
- SKU mismatch
- location mismatch

Use:

- external IDs
- webhook event IDs
- idempotency keys
- sync timestamps
- reconciliation jobs

## 14. Shopify webhook events

Support event adapters for relevant events such as:

- order created
- order updated
- order cancelled
- refund created
- fulfillment created/updated
- product/variant changes
- inventory changes where applicable

Raw external events should be retained before normalization.

## 15. Social moderator orders

Social-media orders are **not required to exist in Shopify**.

The moderator creates the order directly in Cashmere OS.

Required fields:

- customer
- products/variants
- quantities
- selling price
- discount
- source platform
- campaign/attribution where known
- moderator
- shipping method
- payment method
- notes

The order becomes part of the same Brand order and inventory system as Shopify/POS orders.

## 16. Moderator accountability

Every moderator-created order stores:

- moderator user
- creation timestamp
- order source
- edits
- confirmation
- cancellation
- fulfillment result

Dashboard metrics:

- leads handled
- orders created
- conversion rate where lead data exists
- revenue
- discount value
- returns
- contribution

## 17. Social conversation to order

CRM owns the conversation/lead record.

Commerce owns the order.

The relationship is:

`Lead/Conversation → Customer → Order`

Marketing owns campaign attribution metadata.

Do not duplicate full CRM conversations inside the commerce order.

## 18. Bazaar / exhibition sales

Each event is a temporary Brand location and sales context.

Event fields:

- name
- dates
- location
- responsible user
- inventory dispatched
- inventory returned
- sales
- expenses
- event-specific marketing spend

Stock moved to the event is a location transfer, not a sale.

## 19. Bazaar inventory flow

`Alexandria/Cairo → Bazaar Location → Sales → Unsold Return → Original Location`

Every dispatch and return is an InventoryMovement.

The event report must reconcile:

`opening stock + transfers in − sales − damages − transfers out = closing stock`

## 20. Store-to-store transfers

Support:

- Alexandria → Cairo
- Cairo → Alexandria
- Store → Bazaar
- Bazaar → Store

Transfer states:

`Requested → Approved → Dispatched → In Transit → Received`

In-transit stock must not appear as sellable at either location until received.

## 21. Reservations

Reservations may originate from:

- confirmed Shopify orders
- confirmed moderator orders
- POS carts according to configurable timeout
- manual approved reservations

Reservation expiry must release stock automatically where policy permits.

## 22. Fulfillment

Fulfillment supports location selection based on:

- stock availability
- configured priority
- shipping geography
- operational rules

A future optimization engine may choose the best location, but every fulfillment decision must remain visible.

## 23. Shipping

Store:

- carrier
- tracking number
- shipping fee charged to customer
- actual shipping cost
- fulfillment location
- dispatch date
- delivery date
- delivery status

Shipping revenue and shipping expense remain separately visible.

## 24. COD

COD orders require:

- collection amount
- expected fee
- carrier
- settlement status
- collected amount
- remitted amount
- variance

COD collection is not recognized as revenue merely because an order exists.

## 25. Returns

Return flow:

`Requested → Approved → Received → Inspected → Resellable / Damaged → Completed`

Return must reference the original order line.

Resellable goods return to Finished Goods at original cost.

Damaged returns follow the write-off path.

## 26. Exchanges

An exchange is not simply a new sale.

The system should link:

- original order
- returned SKU
- replacement SKU
- price difference
- payment/refund difference
- inventory movements

This keeps revenue and customer history accurate.

## 27. Discounts

Discounts are stored at order-line level.

Support:

- percentage
- fixed amount
- campaign
- coupon
- moderator-approved discount
- showroom discount
- clearance

Discount authorization rules should depend on user role and threshold.

## 28. Price lists

Brand can maintain:

- standard retail price
- promotional price
- clearance price
- channel-specific price where necessary

Price history is effective-dated.

Historical orders retain the actual price charged.

## 29. VAT

Retail prices and reporting remain ex-VAT internally unless configured otherwise.

VAT display uses the configured rate, currently assumed 14%.

Shopify VAT-inclusive pricing must be explicitly configured before historical migration/import.

## 30. Inventory valuation integration

Sales reduce inventory using the configured FIFO lot valuation.

The POS/commerce layer does not calculate a new COGS method.

It requests the inventory/accounting engine to consume the correct lot cost.

## 31. Brand unit economics

For each SKU/style/order:

`net_price = retail_price × (1 − discount_rate)`

`effective_revenue = net_price × (1 − return_rate)` for planning models

Actual completed sales use actual returns/refunds.

Variable cost includes:

- transfer price
- packaging
- shipping
- payment fee
- marketing allocation
- return handling

## 32. Order profitability

Every completed order should support drill-down to:

- gross sales
- discounts
- net sales
- VAT
- transfer-price COGS
- packaging
- shipping
- payment fees
- marketing attribution/allocation
- returns
- contribution

The order-level report must clearly distinguish actuals from planning assumptions.

## 33. Customer ownership

Brand CRM owns customer identity and relationship.

Commerce references the customer.

Factory does not own Brand retail customers.

External Factory CMT customers are separate Factory-side customers.

## 34. Customer deduplication

Customers from Shopify, moderator orders and POS may represent the same person.

Use controlled matching based on available identifiers.

Do not automatically merge records when confidence is low.

Merges must preserve an audit trail.

## 35. Omnichannel customer history

A Brand customer profile should show:

- Shopify orders
- moderator orders
- showroom purchases
- Cairo purchases
- bazaar purchases
- returns
- discounts
- total spend
- units
- last purchase
- acquisition source
- campaign attribution where available

## 36. Stock availability views

Show separately:

- on hand
- reserved
- available to sell
- in transit
- on hold
- damaged
- incoming from Factory
- incoming purchase

Never show one unexplained "stock" number.

## 37. Factory → Brand stock receipt

When Factory completes a Brand production order:

1. Factory finished goods are created.
2. Internal transfer/invoice is generated.
3. Brand receives inventory at transfer price.
4. Brand location receives physical stock.
5. Shopify/POS availability updates from Brand inventory.
6. Accounting records intercompany entries.

The physical receipt and financial receipt must remain linked.

## 38. Order cancellation

Cancellation must release reservations and reverse any applicable payment/financial state.

A fulfilled/settled order cannot be treated as an ordinary cancellation; use return/refund workflows.

## 39. POS permissions

Roles can control:

- sale creation
- discount thresholds
- refund
- void
- price override
- cash drawer operations
- end-of-day close
- inventory adjustment

Owner/accountant can access financial reconciliation; sales staff should not be able to alter accounting history.

## 40. End-of-day store close

Each permanent store and bazaar should support:

- opening cash
- cash sales
- card sales
- wallet sales
- refunds
- expenses where permitted
- expected closing cash
- counted cash
- variance
- cashier
- supervisor approval

Closing produces a reconciliation record, not an editable balance.

## 41. Cash drawer controls

Cash movements should include:

- opening float
- sales
- refunds
- approved cash expenses
- cash in/out adjustments
- closing count

Unexplained variance becomes an alert and accounting review item.

## 42. Shopify reconciliation

Daily reconciliation should compare:

`Shopify orders ↔ Cashmere orders ↔ inventory movements ↔ payment clearing ↔ refunds`

Exceptions:

- missing order
- duplicate order
- price mismatch
- quantity mismatch
- refund mismatch
- fulfillment mismatch
- payment mismatch
- SKU mapping mismatch

## 43. Channel reporting

Brand reports should compare:

- Shopify
- Alexandria POS
- Cairo POS
- Moderator/social
- Bazaar

Metrics:

- orders
- units
- gross sales
- discounts
- net sales
- returns
- contribution
- AOV
- conversion where measurable
- payment fees
- shipping cost

## 44. Inventory-aware sales controls

Prevent or warn on:

- selling unavailable stock
- negative inventory
- duplicate reservation
- stale Shopify inventory
- selling a discontinued SKU without approval
- transferring reserved stock
- receiving duplicate webhook orders

## 45. Audit trail

Record every material commerce action:

- who
- what
- before
- after
- timestamp
- source/channel
- reason where required

Posted sales, payments, returns and inventory movements are not silently edited.

## 46. Required dashboards

1. Brand command center
2. Omnichannel sales
3. Alexandria POS
4. Cairo POS
5. Shopify
6. Moderator sales
7. Bazaar/event sales
8. Inventory by location
9. Available-to-sell
10. Transfers/in-transit
11. Returns
12. Discounts
13. Order profitability
14. Payment reconciliation
15. Shopify reconciliation
16. Daily store close

## 47. Acceptance criteria

Brand commerce is production-safe when:

- Alexandria showroom is modeled as a Brand warehouse/showroom
- Cairo is a separate Brand location
- bazaars can operate as temporary locations
- Shopify orders integrate without becoming the accounting master
- social moderator orders can be created directly in Cashmere OS
- moderator attribution is preserved
- POS and online orders share one inventory truth
- stock is tracked by location and lot
- reservations are separate from physical stock
- store transfers are traceable
- Shopify inventory sync is idempotent
- returns restore stock correctly when resellable
- damaged returns are written off correctly
- payment clearing supports delayed settlement
- discounts remain traceable
- every order can be traced to customer, channel, inventory, payment and accounting
- Factory → Brand finished goods receipt is linked to transfer pricing and accounting
