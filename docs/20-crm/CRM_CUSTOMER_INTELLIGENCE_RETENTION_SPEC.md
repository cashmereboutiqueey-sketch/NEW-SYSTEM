# Cashmere OS — CRM, Customer Intelligence & Retention Specification

## Purpose
Create a Brand-only CRM that connects customers, orders, channels, moderators, POS, Shopify and marketing into one customer history without mixing customer intelligence with Factory clients.

## 1. CRM scope
CRM belongs to the Brand. Factory customer management is a separate B2B client model for external CMT clients and the Brand as an intercompany customer.

## 2. Customer identity
A customer can originate from Shopify, POS, moderator/social orders, exhibitions or manual entry. Duplicate detection uses configured identity signals such as normalized phone, email and customer-confirmed information.

Never merge customers silently. Suspected duplicates enter a review workflow.

## 3. Unified customer timeline
Show:
- orders
- returns
- payments where appropriate
- visits/POS interactions
- moderator notes
- campaigns
- messages/consent events
- customer service events
- loyalty/store credit if enabled

Every event keeps its original source.

## 4. Attribution
Order attribution records channel, moderator/cashier, campaign/source and location. Customer acquisition source is distinct from the channel of a later purchase.

## 5. Segmentation
Configurable segments can use:
- total spend
- order count
- recency
- average order value
- return rate
- discount dependency
- favourite categories/styles
- showroom visits
- acquisition source
- inactivity period

Segments are calculated from source data and can be snapshotted for campaigns.

## 6. RFM
Support Recency, Frequency and Monetary scoring with configurable windows. Scores are analytical and never change accounting records.

## 7. Customer profitability
Show revenue, discounts, returns, payment/shipping costs where attributable, marketing acquisition/retention spend where supported and contribution. Avoid calling gross sales “profit.”

## 8. Returns intelligence
Track return frequency, reason, SKU/style, channel and disposition. High-return customers can be flagged for review but must not be automatically discriminated against without an approved business rule.

## 9. Moderator intelligence
Track moderator-created leads/orders and outcomes:
- conversations/leads where captured
- orders
- conversion
- units
- revenue
- discounts
- returns
- contribution

Do not require a separate Shopify order for moderator sales.

## 10. Customer lifecycle
Suggested lifecycle:
`Lead → First Purchase → Active → Repeat → VIP → At Risk → Inactive → Reactivated`

Rules are configurable and historical state changes are auditable.

## 11. Marketing integration
Campaigns can target CRM segments. Store campaign membership, send/delivery events where supported, order attribution and resulting revenue/contribution.

Marketing allocation for Brand unit economics remains based on units sold by default, with style override. CRM attribution is a separate analytical layer and must not silently replace the accounting allocation basis.

## 12. Consent and preferences
Store channel preferences, consent status, source and timestamp. Respect opt-out and suppression rules across connected messaging channels.

## 13. Customer service
Customer issues can be linked to customer/order/SKU/return. Resolution status, owner and notes are auditable.

## 14. Loyalty
Optional loyalty points can be configured, with issuance/redemption events stored separately from revenue and liability treatment defined by accounting policy.

## 15. Recommendations
Customer intelligence can recommend follow-up actions such as:
- reactivation campaign
- new collection notification
- showroom invitation
- cross-sell
- replenishment reminder

Recommendations are rule-based/configurable. No external AI model/API is required.

## 16. Privacy
Customer personal data is restricted to Brand roles. Exports and bulk actions are permission-controlled and audited.

## 17. Data quality
CRM dashboards expose duplicate candidates, missing phone/email, inconsistent names and unlinked channel identities.

## 18. Acceptance criteria
CRM is complete when Shopify, POS and moderator/social orders create a unified Brand customer history; customer identity can be safely deduplicated; lifecycle, RFM, return and profitability intelligence is available; campaigns can use segments; consent is respected; and all intelligence remains traceable to source transactions without changing the accounting ledger.