# The scripts, and which of them write

A name is not a promise. Several of these are called `check-…` or `audit-…`
and change data anyway, because the only way to check that a sale posts
correctly is to post one. This table says what each does before you run it.

Most take `npx tsx --conditions=react-server scripts/<name>.ts`; the two shell
scripts are run on the server.

## Read only — safe against the live database

| Script | What it answers |
|---|---|
| `audit-rbac.ts` | Do the roles and permissions separate the duties they claim to? |
| `audit-wiring.ts` | Is every permission, screen and dictionary entry actually wired up? |
| `qa-actions.ts` | Is there a button behind every action, and an action behind every button? |
| `qa-removal.ts` | Is anything left referring to something that was removed? |
| `check-brand-pricing.ts`, `check-brand-pricing-typed.ts` | What the brand price list works out to |
| `check-collections.ts` | Collection performance as the screen computes it |
| `check-dead-stock.ts` | What has not moved |
| `check-fabric-ledger.ts` | The fabric ledger and its totals |
| `check-pricing.ts` | Margins, markups and the discount ladder |
| `rate-card.ts` | The CMT rate card |
| `shopify-sku-audit.ts`, `shopify-sku-plan.ts` | What Shopify's SKUs are, and what they would become |

## Sign in as a temporary QA user

They mint a user and a session to read screens as a real person would, then
retire them. Nothing else changes, but they do write those rows.

`audit-http.ts` · `check-pages.ts` · `qa-pages.ts` · `qa-session.ts`

## They change business data — a demo or test database only

They post sales, journals, stock movements and production. Run against the
shop's database they leave invented transactions in the books.

| Script | What it writes |
|---|---|
| `walkthrough.ts` | The whole cycle, from supplier to sale |
| `qa-workflow.ts` | One garment end to end, checking the ledger at every step |
| `audit-atomicity.ts` | Drives services to failure to prove nothing is left behind |
| `audit-books.ts` | Posts and reverses entries to test the accounting rules |
| `check-cashier.ts` | Creates a user and changes its password |
| `check-mixed-basket.ts` | Sells owned and consigned stock in one basket |
| `check-purchase-visibility.ts` | Raises a purchase order |
| `check-quick-customer.ts` | Creates a customer |
| `check-return.ts` | Records a return |
| `open-till.ts` | Opens a POS session |
| `seed-bazaar.ts`, `seed-consignment.ts`, `seed-credit-demo.ts`, `seed-custom-order.ts`, `seed-factory-floor.ts`, `seed-photos.ts` | Demo data for one area each |
| `add-colours-from-mapping.ts` | Colour codes the SKU mapping needs |
| `shopify-import-catalogue.ts` | Styles and variants imported from Shopify |
| `shopify-map-variants.ts` | Ties Shopify variants to local garments |

## Destructive, or reaching outside

| Script | Why it needs care |
|---|---|
| `reset-demo.ts` | **Deletes every transaction** — sales, stock, journals, payroll. Refuses a non-local `DATABASE_URL` unless `ALLOW_REMOTE_RESET=yes`. |
| `audit-volume.ts` | Writes tens of thousands of invented customers, orders and journals. Refuses a non-local `DATABASE_URL` unless `ALLOW_REMOTE_VOLUME_TEST=yes`. |
| `shopify-sku-apply.ts` | **Writes to the live Shopify catalogue**, not to this database. It re-reads each variant before writing and skips anything that changed. |

## Running the system

| Script | What it does |
|---|---|
| `backup.sh` | Nightly backup, verified by restoring it, sealed and sent offsite. Also the restore. See [deploy/RECOVERY.md](../deploy/RECOVERY.md). |
| `deploy.sh` | Builds and starts the current commit on the server |
| `ensure-app-role.mjs` | Creates `cashmere_app`, the login the application runs as, and keeps its grants in step. Run by the migrate step. |
| `connect-shopify.ts` | Records the shop's credentials, sealed |
| `seal-integration-secrets.ts` | Seals credentials that predate sealing |
| `create-owner-account.ts` | A personal owner account |
| `flag-temp-password.ts` | Forces a password change at next sign-in |
| `next-production.mjs` | The production build and start |
| `with-test-database.ts` | Runs a Prisma command against `TEST_DATABASE_URL` |
| `scratch-database.ts` | The guard the two destructive scripts above use |
