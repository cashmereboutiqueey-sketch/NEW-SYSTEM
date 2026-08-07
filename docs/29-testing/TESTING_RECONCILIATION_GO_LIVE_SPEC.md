# Cashmere OS — Testing, Reconciliation & Go-Live Specification

## Purpose
Prove that Cashmere OS produces correct operational, inventory and accounting results across complete business cycles before production use.

## 1. Test layers
- unit tests
- calculation tests
- schema/constraint tests
- integration tests
- workflow/permission tests
- UI/RTL/LTR tests
- end-to-end business scenarios
- reconciliation tests
- performance/security tests

## 2. Accounting invariants
Every posted journal must satisfy:
`SUM(debits) = SUM(credits)`

No transaction may post into a locked period. Immutable records cannot be edited. Reversal/adjustment must preserve a reference chain.

## 3. Inventory invariants
For each SKU/location/lot:
`Opening + Receipts + Production + Transfers In − Issues − Sales − Transfers Out − Adjustments = Closing`

Available stock must respect reservations and configured safety rules. FIFO consumption must use eligible lots in chronological order.

## 4. Production scenario
Test:
Purchase fabric → receipt → FIFO lot → issue material → cut/sew → stage logs → QC → rework/scrap → finished goods → inventory.

Verify planned vs actual quantity, material, minutes and cost.

## 5. Multi-material scenario
A finished style may consume multiple materials, and one material may be used by many styles. Verify BOM quantities, actual issues, lot consumption and remaining material correctly allocate value without double counting.

## 6. Yield scenario
Example: fabric purchased for 10 units, 4 units produced, 2 sold, 2 finished units remain, and unused fabric remains. Verify:
- sold-unit COGS uses the correct transfer cost
- finished goods inventory remains for unsold units
- unused fabric remains raw-material inventory
- profit does not treat all purchased fabric as sold COGS
- WIP/finished/raw balances reconcile

## 7. Factory-to-brand scenario
Factory completes production and transfers finished goods to Brand at approved immutable transfer price. Verify Factory revenue, Brand inventory/COGS basis and Group elimination.

## 8. External CMT scenario
External CMT revenue and cost are recorded separately from internal production. CMT revenue credit enters the approved Factory cost-pool calculation without double counting external supplier cost.

## 9. Capacity scenario
Test separate utilisation and efficiency:
- low bookings with normal production speed → utilisation problem
- full bookings with slow production → efficiency problem
- absence → available capacity reduction, not automatic inefficiency

Verify minute rate and idle penalty respond according to configured formulas.

## 10. Brand sales scenario
Test:
- Shopify order
- Moderator social order
- POS showroom order
- exhibition order
- discount
- split payment
- cancellation
- return/refund

Verify all channels reach the same Brand inventory and accounting rules while preserving source attribution.

## 11. Shopify reconciliation
Daily reconciliation:
- external orders count/amount
- imported internal orders
- refunds
- cancellations
- fulfilment status
- published stock

Every mismatch enters an exception queue.

## 12. Moderator reconciliation
Moderator order list must reconcile to Cashmere OS orders by moderator, date, status and amount. Manual order edits are audited.

## 13. POS reconciliation
Each POS shift reconciles:
`Opening float + cash sales + other cash movements − cash payouts = expected closing cash`

Card/payment-provider totals are reconciled separately.

## 14. Bank reconciliation
Test matched, partial, unmatched and duplicate statement transactions. No unmatched bank line should silently become an expense.

## 15. Payroll scenario
Attendance → overtime approval → payroll calculation → payroll accrual → payment → liability clearing.

Factory direct labour feeds the configured cost pool once only.

## 16. Marketing scenario
Campaign spend → attribution → order → return/discount → contribution → ROAS/contribution ROAS. Verify attribution does not rewrite accounting values.

## 17. CRM scenario
Customer from Shopify, moderator and POS must deduplicate safely. Conflicting identity data requires review, not silent merge.

## 18. MRP scenario
Demand → net requirements → BOM explosion → stock/reservations → planned purchase/production → supplier lead time → capacity constraints.

MRP suggestions do not become committed purchases without approval.

## 19. Scenario testing
What-if scenarios must never mutate live inventory, accounting or production records. Scenario results are isolated and versioned.

## 20. Permission tests
Verify every role can perform only approved actions, especially Moderator, POS, Warehouse, Production, HR, Accountant and Owner.

## 21. RTL/LTR tests
Test Arabic RTL and English LTR across dashboards, forms, tables, POS, printing and exports. Accounting numbers remain legible and stable.

## 22. Print tests
Test A4 reports, invoices, receipts, SKU labels, barcode labels, production documents and material/warehouse documents. Verify Arabic fonts, margins, page breaks and barcode readability.

## 23. Data migration
Before production migration:
- map source fields
- preserve historical IDs
- validate opening balances
- validate inventory lots/quantities/costs
- validate customers/SKUs
- reconcile migrated totals

Never import opening inventory as an unexplained manual adjustment when historical evidence exists.

## 24. Performance
Define baseline targets for page load, API response, large table queries, POS transaction completion, import throughput and report generation. Load-test realistic SKU, order and inventory volumes.

## 25. Security tests
Test authentication, authorization boundaries, secret exposure, webhook signature validation, rate limits, session revocation, injection and unsafe exports.

## 26. Backup/restore drill
Restore a production-like backup into an isolated environment and verify database integrity, migrations, audit records and business totals.

## 27. Reconciliation checklist before go-live
- GL balances
- trial balance
- AP
- AR
- bank
- inventory valuation
- inventory quantities
- payroll liability
- VAT/tax schedules
- Factory/Brand intercompany
- Shopify
- POS
- Moderator
- payment providers

All material differences must be resolved or formally accepted before cutover.

## 28. Go-live phases
1. sandbox validation
2. parallel run
3. controlled pilot
4. cutover
5. hypercare
6. post-go-live reconciliation

## 29. Rollback
Define a cutover checkpoint, backup, migration version and operational rollback procedure. External integrations must support safe pause/retry to prevent duplicate transactions.

## 30. Acceptance criteria
Go-live is approved only when critical accounting/inventory invariants pass, end-to-end business scenarios reconcile, permissions pass, external integrations reconcile, print outputs pass, backup restore succeeds and unresolved differences are documented and approved.
