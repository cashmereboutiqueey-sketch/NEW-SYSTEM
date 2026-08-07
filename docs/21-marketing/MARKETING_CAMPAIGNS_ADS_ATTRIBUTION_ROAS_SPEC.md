# Cashmere OS — Brand Marketing, Campaigns, Ads, Attribution & ROAS Specification

## Purpose
Connect Brand marketing spend to actual orders, customers, products and contribution without requiring a paid AI model. Marketing is an operational and financial subsystem, not a separate dashboard.

## 1. Marketing scope
Marketing belongs to the Brand. Factory external-CMT acquisition can be tracked separately as Factory commercial activity.

## 2. Campaign structure
`Campaign → Ad Set/Target → Creative → Ad/Placement`

Campaigns can also exist for organic, influencer, showroom, exhibition and offline activity.

Store objective, dates, budget, owner, channel, collection/style and status.

## 3. Spend capture
Record spend by date, platform, campaign, ad set/creative where available, supplier/agency and payment source. Imported spend is reconciled against platform totals and accounting transactions.

Manual spend is allowed with source and approval metadata.

## 4. Marketing allocation for unit economics
Default Brand allocation remains **units sold in the period**, with per-style override.

The accounting/unit-economics allocation basis is separate from campaign attribution. Attribution can answer “which campaign influenced this order?” without silently changing the costing allocation rule.

## 5. Sales attribution
Orders may carry:
- first-touch source
- last-touch source
- campaign
- ad set
- creative
- referral/source
- moderator where applicable
- organic/direct classification

Store the raw source evidence and attribution model used.

## 6. Attribution models
Support configurable analytical models:
- last touch
- first touch
- linear
- position-based

Financial reporting should clearly label the model. Never present attributed revenue as incremental profit unless causality is established.

## 7. Shopify attribution
Shopify order data can be linked to campaign/source identifiers when available. The connector stores external identifiers and preserves Cashmere OS attribution history.

## 8. Moderator attribution
DM-originated sales are attributed to the moderator and campaign/source when captured. Moderator-created orders remain internal Brand orders and do not need to exist in Shopify.

## 9. POS/showroom attribution
Showroom orders can record campaign/referral/source and staff attribution. Walk-in/direct remains a valid source category.

## 10. Exhibition attribution
Exhibition sales are linked to event, location and campaign. Event costs are linked to the same activity for profitability analysis.

## 11. Creative intelligence
Creative records can track:
- hook/message
- format
- product/style
- audience
- spend
- impressions/reach where imported
- clicks
- leads where captured
- orders
- revenue
- discounts
- returns
- contribution

## 12. Funnel metrics
Support:
`Spend → Reach/Impressions → Clicks → Leads → Orders → Units → Revenue → Contribution`

Each metric shows its source and date range.

## 13. ROAS and contribution ROAS
Standard ROAS:
`Attributed Revenue / Ad Spend`

Contribution ROAS should also be available:
`Attributed Contribution / Ad Spend`

Contribution uses the Brand operating formula and must not be confused with accounting net income.

## 14. CAC
`CAC = Marketing Spend / New Customers Attributed`

Model and attribution window are always displayed.

## 15. LTV
Customer LTV is analytical and can use realized contribution over a configurable observation window. It should not rely on speculative future purchases as if they were booked revenue.

## 16. Discount-aware marketing economics
Campaign reports show gross revenue, discount, net revenue, returns, variable costs and contribution. High ROAS with heavy discounting or returns must be visible.

## 17. Product/style marketing economics
For each style show:
- marketing spend allocation
- units sold
- revenue
- discount
- return rate
- contribution before marketing
- allocated marketing
- contribution after marketing

## 18. Campaign budget control
Campaigns have planned budget and actual spend. Alerts can trigger on pacing, overspend, under-spend and poor contribution ROAS.

## 19. Creative fatigue
When platform data exists, flag declining CTR/conversion or rising acquisition cost over configurable windows. This is a rule-based alert, not AI prediction.

## 20. Marketing calendar
Provide calendar view for campaigns, collection launches, showroom events, exhibitions, promotions and content/creative deadlines.

## 21. Influencer/affiliate
Optional partner records support fee, commission, code/link, attributed orders, returns and net contribution. Fixed fees are separated from variable commissions.

## 22. Offline marketing
Track showroom signage, bazaar fees, photography, production shoots, print, packaging collateral and other offline marketing. Each expense can be classified to Brand marketing and linked to campaign/event when relevant.

## 23. Approval controls
Require approval for campaign budgets, unusually large spend, manual attribution overrides and influencer/agency commitments above configured thresholds.

## 24. Reconciliation
Marketing spend must reconcile across:
- ad platform imports
- bank/payment transactions
- accounting expense records

Differences create reconciliation exceptions rather than silent adjustments.

## 25. Data import resilience
Imports are idempotent. External ad IDs prevent duplicate spend or performance records. Failed imports enter retry/error state and never fabricate zero data.

## 26. Reporting
Marketing dashboard:
- spend
- revenue
- contribution
- ROAS
- contribution ROAS
- CAC
- new customers
- repeat customers
- conversion
- returns
- discount rate
- channel/campaign/style/creative performance

## 27. What marketing must not do
Marketing attribution must not:
- rewrite sales values
- rewrite inventory
- rewrite cost snapshots
- alter accounting journals silently
- claim causality from attribution alone

## 28. Acceptance criteria
Marketing is complete when spend is captured/reconciled, campaigns and creatives are traceable to orders where source data permits, moderator/POS/exhibition sales are supported, ROAS/CAC/contribution metrics are discount- and return-aware, style economics receive the approved allocation basis, and no paid AI model is required for the core workflow.
