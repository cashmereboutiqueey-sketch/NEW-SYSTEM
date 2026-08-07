# Cashmere OS — Decision Log v1

## Approved

| ID | Decision | Status |
|---|---|---|
| ADR-001 | Factory and Brand are economically separate entities with Group consolidation | Approved |
| ADR-002 | Accrual accounting; costs recognized when incurred | Approved |
| ADR-003 | Utilisation and Efficiency are separate variables | Approved |
| ADR-004 | FIFO inventory valuation by lot | Approved |
| ADR-005 | Marketing allocation by units sold, with style override | Approved |
| ADR-006 | External CMT revenue is credited against Factory conversion cost pool | Approved |
| ADR-007 | Raw-material holding days are included in CCC | Approved |
| ADR-008 | Alexandria showroom is also the Brand warehouse | Approved |
| ADR-009 | Cairo store is a separate Brand stock location | Approved |
| ADR-010 | Temporary bazaars/exhibitions are temporary inventory/POS locations | Approved |
| ADR-011 | Shopify is the website sales channel, not the master order/accounting ledger | Approved |
| ADR-012 | Social-media orders are manually entered by a human moderator | Approved |
| ADR-013 | Moderator attribution is mandatory for moderator-created orders | Approved |
| ADR-014 | POS uses the same order/inventory engine as online sales | Approved |
| ADR-015 | Products support multiple fabrics/materials; materials can serve multiple products | Approved |
| ADR-016 | Variant = Color × Size; SKU = STYLENAME-COLORCODE-SIZE | Approved |
| ADR-017 | Cost snapshots are immutable and effective-dated | Approved |
| ADR-018 | No required AI model/API in the core system | Approved |
| ADR-019 | Server Actions + Zod instead of tRPC | Approved |
| ADR-020 | Decimal arithmetic; never float for financial quantities/rates | Approved |
| ADR-021 | Owner drawings are distributions; owner salary for actual work is an expense | Approved |
| ADR-022 | Depreciation is accrued and included in Factory conversion pool when applicable | Approved |
| ADR-023 | Freight/customs/clearing are capitalized into landed material cost | Approved |

## Open

| ID | Question | Impact |
|---|---|---|
| O-001 | Are Shopify retail prices VAT-inclusive or VAT-exclusive? | Revenue, VAT and every margin calculation |
| O-002 | Is Factory margin applied to full factory cost including materials, or conversion cost plus material pass-through/handling? | Transfer price and Factory/Brand profitability |
| O-003 | Confirm exact ten colour codes | SKU validation and seed/config |
| O-004 | Confirm biometric attendance hardware/provider | Integration implementation |
