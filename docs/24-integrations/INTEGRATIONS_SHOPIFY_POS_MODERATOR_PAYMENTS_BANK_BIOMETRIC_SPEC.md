# Cashmere OS — Integrations Architecture Specification

## Purpose
Define how external systems feed Cashmere OS without creating duplicate truth, duplicate orders, duplicate stock or duplicate accounting entries.

## 1. Integration principle
Cashmere OS is the internal operational and accounting source of truth. External systems remain authoritative for their own source domains:
- Shopify: website checkout/order events
- POS: physical sales captured by Cashmere OS POS
- Moderator: social/DM order entry inside Cashmere OS
- Biometric device: raw attendance punches
- Payment providers: payment status/transaction evidence
- Bank: bank transaction evidence

No connector may silently rewrite historical accounting, inventory movements or CostSnapshots.

## 2. Integration ledger
Every external record stores:
- provider
- external ID
- entity/type
- first-seen timestamp
- last-sync timestamp
- payload/version reference where appropriate
- sync status
- error state

External IDs are unique per provider and object type to guarantee idempotency.

## 3. Shopify
Import:
- orders
- order lines
- customers
- products/variants/SKUs
- discounts
- refunds
- fulfilment status
- cancellations
- payment status where available

Map Shopify variants to internal immutable SKUs. Unknown mappings create exceptions; they do not create guessed products.

Shopify remains the website checkout interface. Cashmere OS owns internal inventory allocation, accounting and operational status after import according to configured policy.

## 4. Shopify inventory synchronization
Support controlled inventory publishing from internal available-to-sell quantities to Shopify. Reservations and stock adjustments are represented explicitly.

Prevent feedback loops by tagging origin and maintaining sync state.

## 5. Moderator/social orders
Moderator enters DMs/orders directly into Cashmere OS. Required attribution:
- moderator
- customer
- channel/source
- SKU/variant
- location/fulfilment
- payment method/status
- shipping
- discount

No duplicate Shopify order is required or created merely to make the order appear in the system.

## 6. POS
POS operates against Cashmere OS inventory and pricing rules. Every transaction records location, cashier, shift, payment method, customer where known and order source.

POS can operate with controlled offline queueing. Offline transactions receive client-generated IDs and synchronize idempotently.

## 7. Showrooms and exhibitions
Alexandria showroom is the primary Brand warehouse/showroom. Cairo showroom and exhibitions are separate locations. Transfers are inventory movements, not sales.

Exhibition POS can work offline and later reconcile with the central ledger.

## 8. Payments
Payment records are separate from orders. One order can have multiple payment attempts or methods subject to policy.

Store provider transaction ID, amount, status, fees, currency, timestamps and reconciliation status.

A payment success does not itself create revenue; order and accounting rules determine recognition.

## 9. COD
COD orders can remain unpaid/collection-pending until collection evidence arrives. Collection fees are represented separately and feed channel economics.

## 10. Refunds
Refund events link to the original payment/order line. A refund must not create a new unrelated expense or overwrite the original sale.

## 11. Bank integration/import
Support statement import/API where available. Bank transactions enter a reconciliation queue and are matched to invoices, expenses, payroll, supplier payments, customer receipts and other accounting records.

No bank transaction should automatically create an expense without a controlled classification rule.

## 12. Accounting integration
External events create operational records first. Posting engines create accounting journals from approved source transactions. Journal entries are immutable after period close.

## 13. Biometric
Import raw punches from configured devices. Device ID maps to employee ID. Duplicate/replayed events are ignored; unknown IDs become exceptions.

## 14. Webhooks and polling
Prefer signed webhooks for near-real-time events where provider supports them. Polling is a fallback and reconciliation mechanism.

Webhook processing is idempotent and retryable.

## 15. Sync states
Standard states:
`Pending → Processing → Succeeded`
with `Failed`, `Retrying`, `Conflict`, `NeedsReview` exceptions.

## 16. Conflict handling
Examples:
- Shopify SKU not mapped
- Shopify order cancelled after fulfilment started
- internal stock differs from Shopify stock
- duplicate customer identity
- payment amount mismatch
- bank transaction unmatched

Conflicts enter a visible queue with suggested resolution and audit trail.

## 17. Inventory safety
Never allow a failed connector to silently increase available inventory. Inventory changes originate from explicit InventoryMovement records.

## 18. Reconciliation jobs
Scheduled reconciliation compares:
- Shopify orders vs internal orders
- Shopify inventory vs published internal quantity
- payment provider totals vs payment records
- bank statement vs accounting cash entries
- biometric device punches vs attendance

## 19. Rate limits and retry
Connectors use exponential backoff, provider rate-limit handling, dead-letter/error queues and bounded retries.

## 20. Secrets
API credentials are stored in encrypted server-side configuration/secrets, never in browser code, database business records or logs.

## 21. Audit
Every sync action records source, external ID, result, actor/system process, timestamp and error details where applicable.

## 22. Customer sync
Shopify customers are matched to Brand CRM identities using controlled matching. Never silently merge conflicting customers.

## 23. Product sync
Shopify products/variants are mapped to internal Collection/Style/Variant/SKU. Internal cost remains authoritative; Shopify retail price may be synchronized according to approved price-list policy.

## 24. Marketing sync
Campaign/ad spend imports are separate from order sync. External campaign IDs map to internal Campaign records and remain idempotent.

## 25. Moderator permissions
Moderators can create/update permitted social orders but cannot alter accounting journals, transfer prices, historical costs or unrestricted inventory adjustments.

## 26. Operational dashboards
Integration dashboard shows:
- connector health
- last successful sync
- pending records
- failed records
- conflicts
- reconciliation gaps
- webhook failures
- rate-limit events

## 27. Data retention
Retain enough source identifiers and evidence to reconstruct how an external event became an internal transaction. Raw payload retention follows configured privacy and storage policy.

## 28. Acceptance criteria
The integration layer is complete when Shopify, POS, Moderator, payment, bank and biometric sources can synchronize through idempotent, auditable pipelines; conflicts are visible; inventory cannot be corrupted by connector failures; accounting is generated from controlled source transactions; and every external event remains traceable to its internal record.
