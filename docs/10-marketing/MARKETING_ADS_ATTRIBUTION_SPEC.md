# Cashmere OS — Brand Marketing, Ads & Attribution Specification

**Status:** Draft for implementation
**Entity:** Brand only
**Scope:** Marketing planning, campaigns, channels, ad spend, creatives, attribution, leads, orders, revenue, contribution, CAC, ROAS, MER, campaign budgets and reconciliation.

## 1. Purpose

Marketing is a Brand commercial domain. It must connect spend to the customer journey and ultimately to actual orders and contribution, without becoming a second accounting system.

Core flow:

`Campaign → Ad Set/Target → Creative → Spend → Lead/Customer → Order → Revenue → COGS → Contribution`

The system must distinguish platform-reported metrics from Cashmere's internal financial truth.

## 2. Marketing hierarchy

Support:

`Marketing Plan → Campaign → Ad Set/Audience → Creative/Ad`

Campaign fields:

- name
- objective
- start/end
- budget
- status
- owner
- collection/product focus
- channel
- attribution window
- notes

## 3. Marketing channels

Configurable channels include:

- Meta Ads
- Instagram organic
- Facebook organic
- TikTok
- Google Ads
- influencer/creator
- WhatsApp/social moderator
- showroom
- bazaar/event
- email/SMS where supported
- offline/other

Paid and organic activity must remain distinguishable.

## 4. Campaign budget

Budget supports:

- planned amount
- approved amount
- committed amount
- actual spend
- remaining amount
- start/end dates

Budget alerts should trigger before overspend thresholds.

## 5. Ad spend ledger

Store imported or manually entered spend by:

- date
- platform
- account
- campaign
- ad set
- creative
- currency
- gross spend
- taxes/fees where applicable
- normalized EGP amount
- source/reference

Imported platform data is never silently treated as accounting-posted expense.

Accounting actuals remain authoritative for financial statements.

## 6. Platform integrations

Integration architecture must support adapters for ad platforms.

The core model must not depend on one provider's API schema.

For each integration store:

- account ID
- platform
- sync status
- last sync
- external IDs
- error state

Sync must be idempotent.

## 7. Creative registry

Each creative stores:

- creative ID
- campaign
- format
- product/style/collection
- hook/message
- landing destination
- production date
- status
- external ad IDs

This enables performance comparison by creative, not only campaign.

## 8. Attribution

Attribution must preserve multiple levels:

### First touch
How the customer was initially acquired.

### Lead touch
Which channel/campaign generated the lead.

### Order source
Where the actual order was created:

`SHOPIFY / SOCIAL_DM / POS / BAZAAR`

### Campaign attribution
Which campaign/creative is associated with the sale according to the selected attribution model.

These must not be collapsed into one "source" field.

## 9. Attribution models

Support configurable reporting models:

- first touch
- last touch
- lead-source
- linear/multi-touch where sufficient data exists
- campaign-specific override

Default operational model should be explicit and documented.

No model should rewrite the raw journey events.

## 10. Shopify attribution

Where Shopify/UTM/referrer information exists, retain:

- source
- medium
- campaign
- content
- landing page
- click/session references where available

The system should associate these with the customer/order without requiring Shopify to become the master CRM.

## 11. Moderator attribution

Social-media moderator orders are separately attributable.

Track:

- moderator
- lead source
- campaign
- conversation source
- resulting order
- revenue
- contribution

This allows comparison between paid acquisition and human-assisted conversion.

## 12. Marketing allocation for style economics

The previously locked rule applies:

**Marketing allocation basis = units sold in the period**, with a per-style override for styles having their own campaign.

The allocation engine must expose:

- total marketing pool
- eligible units
- allocated amount
- per-unit amount
- style override
- allocation period

Historical allocations are snapshot/versioned.

## 13. Marketing metrics

At campaign/channel/creative level calculate:

- spend
- impressions
- reach
- clicks
- CTR
- CPC
- CPM
- leads
- orders
- units
- revenue
- net revenue
- discounts
- returns
- COGS
- contribution margin
- CAC
- cost per lead
- ROAS
- MER
- conversion rate
- AOV

Platform metrics may be imported as reported values; financial metrics are calculated from Cashmere OS transactions.

## 14. CAC

Customer Acquisition Cost:

`CAC = attributed acquisition spend / acquired customers`

The reporting period and attribution model must be displayed.

Do not mix all marketing spend with acquisition spend without showing the distinction.

## 15. ROAS

`ROAS = attributed revenue / attributed ad spend`

ROAS is a marketing metric, not profit.

The dashboard must clearly distinguish ROAS from contribution margin and Group profit.

## 16. MER

Marketing Efficiency Ratio:

`MER = total Brand revenue / total marketing spend`

This is useful for executive-level health but must not be confused with campaign-level ROAS.

## 17. Contribution after marketing

For operating decisions, show:

`Contribution before marketing − allocated marketing = contribution after marketing`

The underlying Brand contribution formula remains:

`effective revenue − transfer price − packaging − shipping − payment fee − marketing allocation − return handling`

## 18. Campaign profitability

Campaign report should show:

`Attributed net revenue − attributed COGS − attributed variable costs − campaign spend`

If attribution is incomplete, show the uncertainty and do not fabricate a precise profit number.

## 19. Returns and delayed economics

A campaign sale may later return.

Campaign reporting should support:

- gross attributed sales
- returned sales
- net attributed sales
- return rate
- contribution after actual returns

Planning models may use trailing return rates before enough actual data exists.

## 20. Discount interaction

Marketing analysis must expose whether revenue was generated through:

- full-price sale
- discount
- campaign code
- moderator discount
- showroom discount
- clearance

A high ROAS campaign with excessive discounting must not be presented as equally healthy as a full-price campaign.

## 21. Offline marketing

Offline campaigns can be entered manually and linked to:

- bazaar
- showroom event
- influencer
- partnership
- printed campaign
- referral

Offline spend must have a source document/reference for accounting reconciliation.

## 22. Influencer/creator campaigns

Support:

- creator
- agreed fee
- gifted product cost where applicable
- campaign
- code
- link
- attributed orders
- revenue
- returns
- contribution

Gifted product is not automatically treated as zero-cost marketing; its inventory/accounting treatment must flow from the relevant transaction rules.

## 23. Marketing calendar

Marketing calendar should support:

- campaign dates
- collection launches
- content deadlines
- ad launch
- promotions
- bazaars
- showroom events
- creative production

This is planning data, not accounting data.

## 24. Lead and CRM integration

Marketing creates/attributes leads; CRM owns the relationship workflow.

Marketing can read:

- lead source
- campaign
- conversion
- customer segment
- resulting revenue

CRM remains the source for customer relationship activities.

## 25. Sales integration

Marketing references Commerce order IDs.

For each attributed order, report:

- source
- campaign
- creative where known
- order channel
- order value
- discount
- returns
- COGS
- contribution

This makes the distinction visible between "ad generated the customer" and "customer actually bought through Shopify/POS/moderator."

## 26. Accounting integration

Marketing spend should flow to accounting through controlled expense/accrual records.

No duplicate expense should arise from both:

- imported Meta spend
- manually posted supplier/platform invoice

A reconciliation layer must match platform spend to accounting records.

## 27. Spend reconciliation

For each platform/account/period:

`Platform reported spend ↔ internal marketing ledger ↔ accounting expense/accrual ↔ bank/card settlement`

Mismatch states:

- missing
- duplicate
- timing difference
- tax/fee difference
- currency difference
- unresolved

## 28. Campaign approvals

Campaign workflow:

`Draft → Planned → Approved → Live → Paused/Completed → Archived`

Budget changes after approval require authorization.

## 29. Alerts

Recommended marketing alerts:

1. Budget utilization above threshold
2. Spend with zero orders
3. CAC above target
4. ROAS below target
5. High spend with low contribution
6. Creative fatigue/CTR deterioration
7. High discount dependency
8. High return rate from campaign
9. Tracking/attribution failure
10. Platform spend/accounting mismatch
11. Campaign overspend
12. Landing/product stock shortage

## 30. Stock-aware marketing

Marketing should read Brand inventory availability.

If a campaign is actively spending against a SKU/style with insufficient stock, alert the team.

This prevents paying to create demand for unavailable products.

## 31. Dead-stock campaigns

The system may support a specific campaign objective for inventory liquidation.

Such campaigns must show:

- opening stock
- units sold
- remaining stock
- discount
- realized revenue
- COGS
- marketing spend
- contribution
- capital released

A dead-stock campaign can be economically successful even with lower ROAS if it releases significant locked working capital; the dashboard should make both visible.

## 32. Reporting hierarchy

Executive:

`Revenue → Marketing Spend → MER → Contribution → Cash impact`

Marketing:

`Campaign → Spend → Leads → Orders → CAC → ROAS → Contribution`

Creative:

`Creative → Spend → CTR → CPC → Orders → Revenue → Contribution`

Product:

`Style → Units → Revenue → COGS → Marketing allocation → Contribution`

## 33. Required dashboards

1. Marketing overview
2. Campaign performance
3. Channel performance
4. Creative performance
5. CAC dashboard
6. ROAS dashboard
7. MER dashboard
8. Marketing spend reconciliation
9. Campaign contribution
10. Moderator-assisted acquisition
11. Product marketing profitability
12. Stock-aware campaign dashboard
13. Dead-stock campaign dashboard
14. Attribution health

## 34. Controls

Never:

- overwrite raw platform spend
- overwrite raw attribution events
- treat ROAS as profit
- double-count platform spend in accounting
- allocate marketing twice
- allow a style-specific campaign override to silently alter historical allocations
- attribute an order to a campaign without storing the attribution basis

## 35. Acceptance criteria

Marketing is production-safe when:

- spend is traceable from platform to accounting
- campaigns connect to creatives and products
- lead and customer journeys connect to orders
- moderator-assisted sales remain attributable
- first/last/order source are distinguishable
- CAC/ROAS/MER are explicitly defined
- contribution after marketing is visible
- returns and discounts affect realized economics
- marketing allocation follows units sold by default with documented overrides
- campaigns can be warned when inventory is insufficient
- dead-stock campaigns show both profit and cash-release impact
- platform and accounting spend reconcile without duplication
