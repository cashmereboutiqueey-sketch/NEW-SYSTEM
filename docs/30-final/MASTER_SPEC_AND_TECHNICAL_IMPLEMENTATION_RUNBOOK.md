# Cashmere OS — Final Master Specification & Technical Implementation Runbook

## 0. Purpose
This document is the single source of truth for implementation of Cashmere OS. It consolidates the business architecture, accounting rules, inventory/production model, integrations, security, UI, testing and deployment requirements.

## 1. System scope
Cashmere OS operates three reporting scopes:
- Factory
- Brand
- Group

Operational locations include Alexandria showroom/warehouse, Cairo showroom, exhibitions and any future configured location.

The Alexandria Brand warehouse/showroom is both a physical showroom and inventory location. Shopify is the website sales channel. Social-media DM orders are entered by Moderators directly into Cashmere OS. POS covers showroom/exhibition sales.

## 2. Core architecture
Recommended application architecture:
- TypeScript full-stack web application
- Next.js App Router for web/application layer
- PostgreSQL as primary relational database
- Prisma ORM or an equivalent typed data-access layer
- Zod for boundary validation
- Background worker/queue for integrations, imports, scheduled jobs and heavy reports
- Object storage for controlled documents/attachments
- GitHub for source control and CI/CD

The exact framework may change only through an approved architecture decision; business rules and database invariants must remain intact.

## 3. Deployment target
The initial production environment is the user's Hostinger VPS, where the application, PostgreSQL database and domain/HTTPS are hosted/configured. The implementation must be VPS-friendly and must not assume managed cloud-only services.

Recommended deployment:
- Linux VPS
- reverse proxy (Nginx or equivalent)
- Node.js runtime
- PostgreSQL
- process manager/container strategy
- HTTPS
- automated backups to a separate backup destination
- environment secrets outside source control

The architecture should remain portable so a future migration to another VPS/cloud provider does not require rewriting business logic.

## 4. AI policy
AI is NOT a core runtime dependency. No paid AI-model API is required for core operations. The system must work fully without an LLM.

Optional future AI features, if ever added, must be isolated behind a separate adapter/service and must not be required for accounting, inventory, production, CRM, POS, HR, MRP or reporting.

## 5. Source-of-truth hierarchy
- Internal operational/accounting ledgers are authoritative for internal state.
- Shopify is authoritative for the website's external checkout event history.
- POS and Moderator are first-party Cashmere OS order-entry interfaces.
- Payment providers and banks provide payment evidence; reconciliation determines accounting linkage.
- Biometric devices provide raw attendance evidence.

No integration may silently overwrite historical ledger records.

## 6. Product model
Support:
- Collections
- Styles/products
- Variants
- Sizes
- Colors
- SKU
- BOM
- Materials
- Fabric/material lots

A product/style may consume multiple different materials. A material may be used by multiple products. BOM versions are effective-dated.

## 7. Inventory model
Inventory types:
- Raw Material
- WIP
- Finished Goods

Track by:
- SKU/material
- lot
- location
- quantity
- reserved quantity
- available quantity
- unit cost
- FIFO age

Every quantity change is an InventoryMovement. No direct quantity overwrite is permitted for posted stock.

## 8. Production model
Production orders support planning, material reservation/issue, stages, operator/workstation activity, QC, rework, scrap and finished-goods receipt.

Track planned vs actual:
- units
- materials
- minutes
- labor
- overhead
- total cost

Capacity separates utilisation from efficiency. Absence reduces available capacity; it is not automatically an efficiency loss.

## 9. Factory economics
Support minute-rate costing using configured cost pools, available minutes, productive minutes, utilisation and efficiency.

Expose:
- actual minute rate
- full-capacity minute rate
- idle penalty per unit
- CMT revenue credit

External CMT work is separate from internal production and must not double count supplier cost.

## 10. Costing and CostSnapshots
Product costing includes configurable:
- material cost
- conversion/labor
- factory overhead
- packaging/other direct costs where applicable
- Brand operating allocations where the business policy requires them
- transfer price
- margin

Every approved production/transfer costing creates an immutable CostSnapshot. Later rate changes do not rewrite historical COGS.

## 11. Pricing engine
Provide a pricing calculator that can use:
`COGS + configured overhead/allocation + target profit margin`

The system must display assumptions and formula components. Retail pricing and transfer pricing are separate price concepts.

## 12. MRP
MRP supports demand, BOM explosion, on-hand inventory, reservations, safety stock, lead times, purchase suggestions, production suggestions and capacity constraints.

MRP recommendations are not commitments until approved.

## 13. Brand sales channels
Support:
- Shopify website
- Moderator/social DM orders
- POS showroom
- exhibition POS

Every order stores source/channel and responsible user where applicable.

## 14. Shopify
Sync orders, customers, products/variants, refunds, cancellations, fulfilment status and controlled inventory publication.

External IDs are unique and idempotent. Unknown SKU mappings become exceptions.

## 15. Moderator
Moderators create social orders directly in Cashmere OS. Required attribution includes moderator, source, customer, SKU/variant, payment, fulfilment and notes.

Moderators cannot post journals, change historical costs/transfer prices or perform unrestricted inventory adjustments.

## 16. POS
POS supports cashier, shift, customer where known, variant selection, barcode/SKU search, discounts by permission, split payments, receipts, offline queueing and shift close.

Locations include Alexandria, Cairo and exhibitions.

## 17. CRM
Brand CRM is customer-centric, not a generic B2B client CRM. Track customer identity, source/channel, purchase history, returns, RFM, repeat behaviour, attribution, moderator relationship and consent/suppression.

Shopify, Moderator and POS customer records must deduplicate safely with review for conflicts.

## 18. Marketing & Ads
Marketing is a first-class Brand module. Support campaigns, ad platforms/imports, spend, creatives, audience/segment metadata, attribution, revenue, returns and contribution.

Show both ROAS and contribution ROAS and state attribution model/period.

AI is not required for marketing operations.

## 19. HR
Support employees, roles, attendance, biometric punches, schedules, overtime, payroll, salary history and permissions.

Payroll flows into accounting and configured Factory labor cost pools.

## 20. Workflow engine
Business workflows use:
`Draft → Submitted → Approved → Posted/Executed → Closed`

Exceptions have dedicated queues. Tasks, due dates, escalations, approvals and audit evidence are first-class records.

## 21. Accounting
Use accrual-based double-entry accounting.

Every posted journal must balance. Posted journals are immutable. Corrections use reversing/adjusting entries.

Subledgers reconcile to GL.

## 22. Expense classification
Every expense records Factory/Brand entity, cost centre/department, account/category, supplier/payee, incurred period, due date, payment status, tax treatment and optional campaign/project/style/event reference.

Shared expenses require an explicit allocation driver and auditable allocation record.

## 23. Factory accounting
Factory has separate books for external CMT revenue and intercompany Brand activity. Materials, conversion, overhead, depreciation and operating expenses are visible.

## 24. Brand accounting
Brand reports retail sales net of approved discounts/returns, transfer-price COGS, packaging, shipping, payment fees, marketing and Brand operating expenses.

## 25. Group consolidation
Eliminate Factory↔Brand intercompany revenue/COGS and receivable/payable. Eliminate unrealised intercompany profit in unsold finished goods. Release it when inventory is sold externally according to consolidation policy.

## 26. Tax
Tax rates are versioned and historical transactions retain their applied rate. Egyptian VAT configuration is supported; current configuration may be 14% but must never be hard-coded into historical logic.

## 27. Cash/bank/reconciliation
Bank statement/API evidence is reconciled to accounting. Unmatched transactions remain in exception queues. Payment records are separate from orders and may include attempts, fees, refunds and reconciliation state.

## 28. Dashboards
Owner cockpit includes cash, working capital locked, CCC, factory minute rate, full-capacity rate, idle penalty, contribution, break-even, finished-goods aging, dead stock, production, sales and marketing contribution.

Factory, Brand and Group dashboards provide drill-down from KPI → calculation → contributing records → source document → external evidence.

## 29. Security
Action/entity/location-aware permissions, segregation of duties, immutable audit log, scoped integration accounts, protected secrets, rate limits, session management, backup/restore and sensitive-data controls are mandatory.

## 30. UI/UX
Cashmere branding is used consistently without compromising operational clarity. Arabic RTL is default; English LTR mirrors correctly. Owner/Brand screens may be more premium/feminine; Factory/Accounting remain restrained and dense.

## 31. Printing
Support A4 reports, invoices, receipts, SKU/barcode labels, production documents and warehouse/material documents. Arabic printing must be tested.

## 32. Testing
Business-critical invariants include:
- debit = credit
- inventory movement equation reconciles
- FIFO consumption is correct
- CostSnapshots are immutable
- intercompany elimination reconciles
- Shopify/POS/Moderator totals reconcile
- payroll flows once into cost/accounting
- locked periods cannot mutate

End-to-end scenarios must pass before production.

## 33. Data migration
Migrate master data and opening balances with preserved source identifiers and reconciliation evidence. Historical inventory must not be invented through unexplained adjustments.

## 34. Deployment/runbook
Required environments:
- local development
- staging/sandbox
- production

Production deploy flow:
1. CI checks
2. build
3. database migration review
4. backup
5. deploy
6. health check
7. smoke tests
8. integration verification
9. monitoring

Never run destructive schema changes directly against production without backup and migration review.

## 35. Hostinger VPS requirements
The VPS deployment specification must document:
- OS/runtime versions
- domain DNS
- HTTPS certificate/renewal
- reverse proxy
- application process/container
- PostgreSQL connection/security
- firewall/network exposure
- backup destination and retention
- environment variables/secrets
- log rotation
- monitoring/health endpoint
- restart/recovery behavior
- deployment rollback

Database should not be publicly exposed; application access uses a private/local connection where possible.

## 36. Repository requirements
Repository should contain:
- application source
- database schema/migrations
- seed/reference data
- tests
- integration adapters
- deployment configuration
- environment example without secrets
- documentation
- CI workflow

Secrets must never be committed.

## 37. Suggested implementation order
1. Repository/app skeleton
2. Auth/RBAC/audit
3. Database schema and migrations
4. Master data/product/SKU/variant
5. Inventory ledger
6. Accounting ledger
7. Factory/production/costing
8. Brand orders/POS/Moderator
9. Shopify integration
10. CRM
11. HR/payroll/biometric
12. MRP
13. Marketing
14. Dashboards/reporting
15. Printing
16. Reconciliation
17. staging/parallel run
18. production cutover

## 38. Definition of done
A module is not done because its screens exist. It is done only when:
- schema exists
- permissions exist
- workflows exist
- accounting/inventory effects are defined
- audit exists
- tests exist
- reconciliation exists where applicable
- UI states exist
- documentation exists

## 39. Final architecture rule
Business logic belongs in the server/domain layer and database constraints, not only in the browser UI. Financial and inventory invariants must be enforced server-side.

## 40. Final principle
Cashmere OS must remain a deterministic business operating system first. Integrations extend it; AI is optional; dashboards explain it; accounting proves it; inventory and production record reality; and the audit trail explains who changed what and why.
