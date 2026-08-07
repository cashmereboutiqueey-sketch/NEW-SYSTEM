# Cashmere OS — Brand CRM Specification

**Status:** Draft for implementation
**Entity:** Brand only
**Purpose:** Turn customer and lead interactions into a controlled commercial process without duplicating the commerce/accounting truth.

## 1. Scope

CRM manages Brand relationships with:

- existing customers
- prospects/leads
- social-media inquiries
- website leads
- showroom prospects
- bazaar/event prospects
- repeat customers
- VIP customers

CRM does **not** own sales orders, payments, inventory, accounting, or product master data. It references those domains.

## 2. Customer identity

Customer is the canonical Brand commercial identity.

Possible identifiers:

- phone
- email
- customer code
- social platform identifier
- Shopify customer ID

Duplicate detection should suggest matches rather than silently merge records.

## 3. Lead

A Lead represents a commercial opportunity before a confirmed customer/order relationship.

Lead fields:

- name
- phone
- platform
- source
- campaign
- assigned moderator/owner
- interested collection/style/variant
- status
- created date
- last contact
- next follow-up
- notes

Lead lifecycle:

`New → Contacted → Qualified → Interested → Won → Lost`

A Lost lead requires an optional/required reason based on configuration.

## 4. Social/DM workflow

The CRM should support a lightweight workflow for social inquiries.

Example:

`New DM → Customer identified → Product inquiry → Availability check → Price/offer → Order created → Follow-up → Completed`

The CRM must link the inquiry to the resulting Brand order when one exists.

The moderator remains attributed to the interaction and order.

## 5. Conversations

Conversation records can reference:

- customer/lead
- platform
- moderator
- start/end
- status
- related product/style
- related order
- next action

Actual message storage/integration is optional by channel and must respect platform/API capabilities and privacy policy.

## 6. Tasks and follow-ups

CRM tasks include:

- call customer
- follow up on inquiry
- notify restock
- confirm order
- follow up after delivery
- request review
- invite to collection launch

Each task has:

- assignee
- due date/time
- priority
- related customer/lead
- related order/product
- status
- completion timestamp

Overdue tasks are visible on dashboards.

## 7. Customer timeline

Every customer should have one chronological commercial timeline combining references to:

- leads
- conversations
- orders
- returns
- refunds
- campaigns
- tasks
- showroom interactions where recorded
- bazaar interactions where recorded

Transactional records remain owned by their source domains.

## 8. Segmentation

Segments may be rule-based or manually assigned.

Useful Brand segments:

- new customer
- repeat customer
- VIP
- high AOV
- high lifetime value
- dormant
- recent purchaser
- frequent returner
- discount-sensitive
- collection-specific buyer
- channel-specific buyer
- Alexandria customer
- Cairo customer
- bazaar-acquired customer

Segments should be computed from current data where possible rather than copied as stale attributes.

## 9. RFM

Support configurable RFM analysis:

- Recency
- Frequency
- Monetary value

RFM should be calculated from completed/refunded-adjusted sales according to a documented rule.

## 10. Customer value

CRM may display:

- lifetime revenue
- net revenue
- order count
- units purchased
- average order value
- contribution proxy
- returns
- discounts
- acquisition source
- first purchase
- latest purchase

Financial truth comes from Commerce/Accounting.

## 11. Acquisition attribution

Lead/customer acquisition can record:

- source channel
- campaign
- ad/source identifier where available
- UTM source
- UTM medium
- UTM campaign
- content/creative identifier
- moderator
- bazaar/event

Attribution must distinguish **lead source** from **order channel**.

Example: a customer may discover Cashmere through Instagram, talk to a moderator, then buy through the Alexandria showroom.

## 12. Campaign linkage

CRM references Brand marketing campaigns.

A campaign may target a segment and generate:

- leads
- orders
- revenue
- repeat purchases

Campaign economics are handled by Marketing/Reporting; CRM supplies relationship and attribution data.

## 13. Restock / product interest

A customer may express interest in:

- style
- variant
- size
- color
- collection

Interest records can trigger a restock alert or follow-up task.

This is especially useful for out-of-stock sizes/colors.

## 14. Post-purchase workflow

Configurable customer journeys can include:

- order confirmation
- delivery check
- return-window follow-up
- review request
- complementary-product recommendation
- new collection announcement
- VIP invitation

Automation must respect customer consent and channel rules.

## 15. Returns and CRM

Returns should enrich customer analytics without changing the original customer order.

Useful indicators:

- return rate
- return reasons
- repeat return behavior
- style-specific return behavior

CRM can flag customers for manual review, but must not automatically penalize customers without an approved business rule.

## 16. Customer notes

Notes support:

- fit preferences
- preferred sizes
- preferred colors
- shopping preferences
- service notes

Sensitive/private information should not be stored in free-text notes unless explicitly permitted by policy.

## 17. Permissions

### Owner
Full CRM access.

### Marketing
Segments, campaigns, customer insights; limited sensitive data.

### Moderator/Sales
Assigned leads/customers, conversations, tasks, order handoff.

### Accountant
Read-only commercial customer references as required for reconciliation.

### Viewer
Read-only.

## 18. Privacy and retention

Customer data must have:

- consent status where relevant
- communication preference
- source
- creation timestamp
- audit history

Deletion/anonymisation must preserve required accounting/legal transaction records while removing unnecessary personal data where policy requires.

## 19. CRM dashboards

1. New leads today
2. Uncontacted leads
3. Follow-ups due
4. Overdue follow-ups
5. Conversion rate
6. Revenue by lead source
7. Revenue by moderator
8. New customers
9. Repeat customer rate
10. VIP customers
11. Dormant customers
12. RFM segments
13. Customer lifetime value
14. Average order value
15. Return-rate segments
16. Product interest/restock requests
17. Campaign-attributed customers
18. Bazaar-acquired customers

## 20. Integration boundaries

CRM integrates with:

- Commerce: orders, returns, customers
- Shopify: customer identity and source references
- Moderator workflow: leads and interactions
- POS: customer lookup where available
- Marketing: campaigns and audiences
- Notifications: approved communication channels

CRM does not duplicate:

- inventory quantities
- product definitions
- order totals
- payment records
- accounting balances

## 21. Acceptance criteria

CRM is correct when:

- every lead can become or link to a Customer without duplicate identity chaos
- moderator ownership is traceable
- every customer has a usable commercial timeline
- social inquiries can be linked to resulting orders
- follow-ups are actionable and measurable
- segments are reproducible from data
- acquisition source and order channel are not confused
- product interest can be captured and converted into follow-up
- CRM metrics reconcile to Commerce/Accounting
- permissions prevent unauthorized access to customer data
