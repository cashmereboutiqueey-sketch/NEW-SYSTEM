# Cashmere OS — Brand CRM & Customer Intelligence Specification

**Status:** Draft for implementation
**Entity:** Brand only
**Scope:** Unified customer identity, leads, social conversations, moderator activity, Shopify, POS, bazaars, segmentation, retention, customer profitability, consent, attribution and actionable customer intelligence.

## 1. Purpose

CRM is the single relationship layer for the Brand.

It must unify customer activity regardless of where the customer interacted or purchased:

`Instagram/Facebook/WhatsApp lead → Moderator → Customer → Order`

`Shopify → Customer → Order`

`Alexandria POS → Customer → Order`

`Cairo POS → Customer → Order`

`Bazaar → Customer → Order`

CRM does not own accounting, inventory, production or Factory customers. It references those systems.

## 2. Customer master

A Brand Customer represents one real customer whenever identity can be established with sufficient confidence.

Fields include:

- customer ID
- full name
- mobile
- alternate mobile
- email
- preferred language
- city/area
- gender where commercially appropriate
- birthday if voluntarily provided
- acquisition source
- acquisition campaign
- assigned owner/team
- lifecycle status
- consent status
- created date
- last activity

Customer identity is separate from channel identity.

## 3. Channel identities

One customer may have multiple channel identifiers:

- Shopify customer ID
- Shopify email
- social platform identity
- WhatsApp number
- POS customer ID
- phone number

Store these separately and link them to one Customer when identity is confirmed.

Never use display name as the primary identity key.

## 4. Identity resolution

Customer matching uses deterministic identifiers first:

1. verified phone
2. verified email
3. known external customer ID
4. controlled secondary matching

Possible matches should be presented for review when confidence is insufficient.

Automatic merge is prohibited for low-confidence matches.

Every merge/split creates an audit record.

## 5. Lead model

A Lead represents a potential customer before a confirmed customer relationship exists.

Lead fields:

- source platform
- source account
- conversation ID
- campaign/ad/source
- moderator owner
- contact information
- product interest
- first response
- last response
- status
- created date
- converted customer/order reference

Lead statuses:

`New → Contacted → Qualified → Interested → Order Created → Won`

Alternative terminal states:

`Lost / Not Interested / Invalid / Duplicate`

## 6. Conversation model

CRM stores conversation metadata and references external conversation systems where applicable.

Do not duplicate an entire social conversation unnecessarily.

Store:

- channel
- external conversation ID
- participant/customer
- moderator
- timestamps
- status
- last message direction
- last message time
- tags
- linked lead
- linked orders

## 7. Moderator workflow

Moderator receives/owns social leads and can create Brand orders directly.

Flow:

`Incoming DM → Lead → Customer match/create → Product interest → Order → Reservation → Fulfillment`

Every order created by a moderator stores the moderator user.

Moderator performance must be measurable without turning CRM into a generic HR system.

## 8. Moderator KPIs

Track:

- leads received
- leads contacted
- response time
- qualified leads
- orders created
- conversion rate
- revenue
- average order value
- discount granted
- return rate
- lost leads
- reason for loss

Where source data supports it, measure conversion from conversation to completed order, not merely order creation.

## 9. Customer timeline

Customer profile must show a unified timeline:

- lead created
- conversation
- moderator actions
- order created
- payment
- fulfillment
- delivery
- return/refund
- POS purchase
- Shopify purchase
- bazaar purchase
- campaign touch
- consent changes
- notes/tasks

The timeline is chronological and drillable to the source record.

## 10. Commerce integration

CRM references Brand commerce records.

For every customer show:

- total orders
- completed orders
- cancelled orders
- returned orders
- units purchased
- gross sales
- discounts
- net sales
- actual returns/refunds
- contribution where available
- AOV
- first purchase
- last purchase
- purchase frequency

These are derived values, not duplicated accounting balances.

## 11. Shopify integration

Shopify customer/order data is imported through the commerce integration.

CRM should retain:

- external Shopify customer ID
- source order IDs
- acquisition/UTM metadata when available
- customer tags where mapped
- last sync timestamp

Shopify remains the external commerce channel; CRM remains the Brand relationship layer.

## 12. POS integration

POS can identify customers by:

- mobile
- email
- customer code
- optional QR/customer lookup

Customer purchase history must combine Alexandria and Cairo purchases with online purchases.

Do not create duplicate customers merely because a purchase occurred at a different store.

## 13. Bazaar integration

Bazaar orders may optionally capture customer identity.

If identified, the sale enters the customer's unified lifetime history.

Event-specific acquisition source and campaign can be attached.

## 14. Marketing integration

Marketing owns campaigns, ads, spend and attribution.

CRM references:

- campaign
- ad set/ad where available
- source
- medium
- first-touch source
- last-touch source
- conversion source

Do not make CRM responsible for calculating ad spend.

## 15. Attribution model

Store raw attribution facts before applying a reporting model.

Recommended fields:

- first_touch
- last_touch
- converting_touch
- UTM source
- UTM medium
- UTM campaign
- platform
- ad/ad set identifiers where available

Reports may support multiple attribution models without rewriting the original facts.

## 16. Customer acquisition cost

Marketing CAC is calculated from Marketing spend and acquired customers, not manually entered into CRM.

CRM can display:

`CAC by source / campaign / cohort`

provided acquisition attribution exists.

## 17. Segmentation

Segments can be dynamic or static.

Dynamic examples:

- purchased in last 30 days
- no purchase for 90 days
- VIP by lifetime contribution
- high-return customer
- frequent buyer
- discount-sensitive
- showroom-only
- Shopify-only
- moderator-acquired
- bazaar-acquired
- category/style affinity
- high AOV
- low frequency/high value

Segment rules must be stored as definitions and evaluated consistently.

## 18. RFM

Customer Intelligence should calculate RFM:

- Recency
- Frequency
- Monetary value

Use actual completed transactions, with returns/refunds handled according to the reporting policy.

RFM scores can drive segments and campaigns.

## 19. Customer profitability

Customer profitability should not be confused with gross sales.

Where data exists, calculate contribution using:

`net revenue − transfer-price COGS − packaging − shipping − payment fees − marketing allocation − return handling`

Show the underlying components.

Factory cost is not added again at Brand level because transfer price already contains the Factory economics.

## 20. Customer lifetime value

Support configurable LTV models.

At minimum show:

- historical contribution
- historical net revenue
- order count
- average order value
- purchase frequency
- days since last purchase

Predictive LTV is optional and must be clearly labeled as an estimate, not an accounting number.

## 21. Cohort analysis

Create cohorts by:

- first purchase month
- first purchase channel
- first purchase campaign where available

Track by cohort:

- customers acquired
- repeat purchase rate
- orders
- net revenue
- contribution
- retention

## 22. Product affinity

Track customer-level product/style/category history.

Examples:

- styles purchased
- colors purchased
- sizes purchased
- categories purchased
- repeat style
- cross-category behavior

This data supports merchandising and marketing segmentation.

## 23. Size and variant intelligence

Variant purchases should be available for customer analysis.

Use carefully for personalization and stock planning, not as an immutable customer attribute.

A customer may purchase multiple sizes over time.

## 24. Return behavior

Track:

- return count
- returned units
- return value
- return rate
- damage rate where relevant
- common return reasons
- style-level return patterns

High-return customers should be visible without automatically penalizing them.

## 25. Discount behavior

Track:

- discount frequency
- average discount
- coupon usage
- clearance purchases
- full-price purchases

This supports identifying discount sensitivity.

## 26. Customer service tasks

CRM supports tasks such as:

- follow-up
- abandoned inquiry follow-up
- post-purchase check
- exchange follow-up
- complaint follow-up
- VIP outreach

Tasks include owner, due date, status, priority and linked customer/order.

## 27. Customer notes

Notes may be added by authorized staff.

Notes must include:

- author
- timestamp
- visibility
- content

Sensitive personal information should not be stored unless necessary and authorized.

## 28. Consent and communication preferences

Store explicit communication preferences separately by channel where applicable:

- WhatsApp
- SMS
- email
- social messaging

Track:

- consent state
- source
- timestamp
- policy/version
- withdrawal timestamp

Marketing sends should respect current consent and suppression rules.

## 29. Customer lifecycle

Recommended lifecycle:

`Lead → New Customer → Active → Repeat → VIP → At Risk → Lapsed`

Lifecycle state is derived from configurable rules and can be manually overridden only with reason/audit.

## 30. Churn / at-risk logic

At-risk status can use customer-specific or segment-level purchase intervals.

Do not use one arbitrary 90-day threshold for every customer.

Recommended comparison:

`days since last purchase ÷ customer's historical purchase interval`

This allows a frequent buyer and an occasional buyer to be treated differently.

## 31. Customer service / complaints

Support cases may link:

- customer
- order
- order line
- product/SKU
- issue category
- priority
- owner
- status
- resolution
- refund/exchange where applicable

Service resolution must connect back to commerce and accounting without duplicating financial transactions.

## 32. Fraud/risk indicators

The system may flag operational anomalies such as:

- repeated failed deliveries
- unusually high return frequency
- repeated COD refusal
- duplicate customer identities
- suspicious discount usage

These are operational flags, not automatic accusations or financial write-offs.

## 33. Customer intelligence dashboard

Brand dashboard should expose:

- total customers
- new customers
- repeat customers
- active customers
- at-risk customers
- lapsed customers
- VIP customers
- repeat rate
- retention
- AOV
- contribution per customer
- CAC
- LTV
- channel mix
- cohort retention
- top customer segments

## 34. Moderator dashboard

Show:

- live leads
- unassigned leads
- response SLA
- conversion funnel
- orders by moderator
- revenue by moderator
- pending follow-ups
- lost lead reasons

The moderator should not need to open a separate system to turn a social conversation into an order.

## 35. Customer 360

The Customer 360 page should combine:

### Identity
Customer master + channel identities.

### Communication
Leads + conversations + tasks.

### Commerce
Orders + products + returns.

### Financial view
Net revenue + contribution + payment history where appropriate.

### Marketing
Acquisition + attribution + campaign touches.

### Behavior
RFM + frequency + style/category affinity.

### Service
Cases + complaints + resolutions.

### Timeline
All events chronologically.

## 36. Search

Search customers by:

- name
- mobile
- email
- customer code
- Shopify ID
- order number
- social identifier where supported

Search results must protect against accidental duplicate customer creation.

## 37. Bulk actions

Authorized users may:

- tag customers
- assign owner
- add/remove segment membership where static
- create tasks
- export permitted data
- suppress communication

Bulk operations require confirmation and audit logging.

## 38. Data ownership

Source-of-truth responsibilities:

- CRM: customer relationship, leads, tasks, segmentation, consent
- Commerce: orders, prices, payments, fulfillment
- Inventory: stock quantities and valuation
- Marketing: campaigns, spend, ad data, attribution facts
- Accounting: posted financial truth

CRM should reference rather than duplicate these records.

## 39. Auditability

Audit all important CRM actions:

- customer merge/split
- identity change
- consent change
- assignment change
- lead status change
- manual lifecycle override
- customer deletion/anonymization request
- segment definition change

## 40. Privacy and retention

Provide configurable retention policies.

Support customer data export and authorized deletion/anonymization workflows where legally required.

Financial transaction records must not be deleted merely because a CRM profile is anonymized; accounting retention rules prevail.

## 41. Alerts

Recommended CRM alerts:

1. Unassigned social lead
2. Lead response SLA breached
3. High-value customer inactive
4. VIP return/complaint
5. Customer at risk
6. Customer lapsed
7. Abandoned inquiry requiring follow-up
8. Repeated failed COD delivery
9. Duplicate customer candidate
10. Consent conflict
11. Unresolved service case
12. Moderator conversion anomaly

## 42. Recommended automations

Non-AI deterministic workflows can trigger:

- follow-up task after inquiry
- post-purchase service task
- at-risk customer segment update
- VIP notification
- return follow-up
- abandoned inquiry reminder
- consent suppression

No generative AI is required for these workflows.

## 43. Reporting drill-down

Every Customer Intelligence metric must trace to underlying records.

Example:

`VIP contribution → customer orders → order lines → actual discounts → FIFO COGS → shipping → payment fee → marketing allocation → return handling`

## 44. Acceptance criteria

CRM is complete when:

- one Brand customer can be recognized across Shopify, moderator orders, Alexandria POS, Cairo POS and bazaars
- social leads can become customers and orders without Shopify
- moderator ownership is fully auditable
- Customer 360 shows the full commercial relationship
- marketing attribution is preserved without making CRM the marketing accounting system
- customer profitability uses actual commerce/accounting data
- segmentation is rule-based and drillable
- RFM and cohort analysis are available
- consent is channel-specific and auditable
- returns and service cases affect the customer timeline
- duplicate identities can be reviewed safely
- customer data can be exported/anonymized without corrupting accounting history
- every intelligence metric can be traced back to source records
