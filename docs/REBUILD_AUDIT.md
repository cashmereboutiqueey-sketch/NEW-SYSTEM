# Cashmere OS — Rebuild Audit

**Date:** 2026-08-07
**Branch:** `docs/cashmere-os-master-spec-v1`
**Archive:** `archive/pre-clean-rebuild` tags the pre-rebuild state — nothing destroyed.
**Source of truth used:** `docs/30-final/MASTER_SPEC_AND_TECHNICAL_IMPLEMENTATION_RUNBOOK.md` (the consolidated summary, cited below as "Runbook §N") plus the 29 topic-level spec files under `docs/0N-*/` for detail (accounting: `docs/03-accounting/`, `docs/16-finance/`, `docs/26-accounting/`; inventory: `docs/04-inventory-wms/`; factory: `docs/05-factory-mrp/`, `docs/06-mrp-production/`; product: `docs/06-product-plm/`; brand commerce: `docs/07-brand-commerce/`, `docs/12-brand-commerce/`; CRM: `docs/08-crm/`, `docs/20-crm/`; HR: `docs/09-hr/`, `docs/13-people/`, `docs/22-hr/`; security: `docs/15-governance/`, `docs/27-security/`) plus the master execution prompt's phase ordering.

Repository state found: a real Phase-1 foundation (auth, RBAC-lite, RTL shell, entity switcher) plus a genuinely well-designed Prisma schema covering **factory costing, capacity/minute-rate, BOM/SMV, FIFO inventory, and production** — but **zero business server actions** (only login/logout/locale exist) and **no double-entry accounting ledger**. This is not a prototype to throw away; it's an unusually solid schema with almost no application logic built on top of it yet.

---

## KEEP

| Item | Why |
|---|---|
| `prisma/schema.prisma` — Entity/FiscalPeriod/CapacityConfig/MinuteRatePeriod/MinuteRateComponent | Matches Runbook §9 (Factory economics) exactly: utilisation/efficiency kept separate, versioned & locked per period, self-contained frozen inputs. Correct design. |
| `Material` / `MaterialPriceHistory` / `StyleBomLine` (many-to-many via BOM line) | Matches Runbook §6 (Product model) — many-to-many material↔style through BOM lines, append-only price history. Not the "Product→one Material" anti-pattern the spec warns against. |
| `CostSnapshot` / `CostSnapshotLine` | Matches Runbook §10 (Costing and CostSnapshots) exactly — immutable, references frozen minute-rate period, per-BOM-line cost lines. |
| `InventoryLot` / `InventoryMovement` (FIFO) | Matches Runbook §7 (Inventory model) — ledger-reconstructible balances, lot-based FIFO. Correctly models the "10 fabric → 4 made → 2 sold" scenario at the data level (raw lot `remainingQty`, finished lot `remainingQty` after `SALE` movements). |
| Production order → cutting ticket → material issue → waste variance chain | Matches Runbook §8 (Production model). `actualWasteRate` computed from real issues, planned rate never silently rewritten. |
| `CMTQuote` floor-rate rule, `CapacityBooking` | Matches Runbook §9 — CMT revenue credit and idle-capacity-as-lever design. |
| `Decimal` everywhere, percentages as fractions, no floats | Matches the schema's own documented precision conventions (`prisma/schema.prisma:9-15`) and the accrual-accounting principle repeated across every accounting spec doc. Verified — no `Float` fields anywhere in schema. |
| `src/lib/session.ts`, `src/lib/auth.ts` (bcrypt + JWT cookie, timing-safe auth) | Sound, minimal, no vendor lock-in. Extend rather than replace. |
| RTL/LTR shell (`src/lib/i18n.ts`, `globals.css`, `sidebar.tsx`, `entity-switcher.tsx`) | Matches Runbook §1 (entity lens: Factory/Brand/Group) and §30 (Arabic RTL default, English LTR mirror). Working foundation, not decorative. |
| `src/core/money.ts`, `src/core/sku.ts` + their tests | Pure domain functions, correctly isolated from Next.js/Prisma per repo's own stated architecture rule. Keep as the pattern for all future domain logic. |
| Migration discipline (`capacity_config_partial_unique` as a separate follow-up migration with a documented reason) | Correct pattern — keep writing migrations this way. |

## REBUILD

| Item | Problem | Direction |
|---|---|---|
| `UserRole` enum (`OWNER/ACCOUNTANT/PRODUCTION/VIEWER`) + rank-based `hasAtLeast` | Master execution prompt §31 requires capability-based RBAC with 11 roles (BRAND_MANAGER, MODERATOR, POS_CASHIER, WAREHOUSE, HR, MARKETING, FINANCE_APPROVER, ...) and segregation of duties (purchase create ≠ approve, etc). A linear rank can't express "PRODUCTION can see WIP but not payroll" or SoD. Confirmed by `docs/15-governance/` and `docs/27-security/`. | Add a `Permission`/`RolePermission` capability model; keep the 4 existing roles as a subset, add the rest. Session/auth plumbing stays. |
| `Expense` model as the only accounting record | `docs/16-finance/ACCOUNTING_GL_COA_TAX_AP_AR_CASH_CLOSE_SPEC.md` §5 ("Double-entry invariants") and Runbook §21: every posted journal must balance. Currently there is no `Account`, `Journal`, or `JournalLine` — nothing enforces debit=credit, and there's no GL/Trial Balance/Balance Sheet possible. | Build `Account` (chart of accounts) → `JournalEntry` → `JournalLine`. Every `Expense`, `ExpensePayment`, production-order transfer-price posting, and sale becomes a journal-posting side effect, not a replacement of the existing tables — `Expense` stays as the AP-facing document, `JournalEntry` becomes its GL shadow. |
| No `location` field on `InventoryLot` / no location model at all | Runbook §1: operational locations include Alexandria showroom/warehouse, Cairo showroom, exhibitions and future configured locations — inventory must be trackable per location, and exhibition stock must reconcile back. Current schema has a single implicit location. | Add `Location` model, `locationId` on `InventoryLot`, `TRANSFER` movement already exists as an enum value but nothing populates it yet. |
| `Customer.channelId` / `SalesChannel` model | Present but thin — no RFM, no dedup logic, no moderator attribution beyond a bare `Customer` FK. Runbook §17 (CRM) requirements are far beyond this. | Extend incrementally in the CRM phase; the base table is fine as a foundation, don't discard it. |

## MISSING (entire domains with no schema or code yet)

- Chart of accounts / journal / GL / trial balance / balance sheet / cash flow statement (Runbook §21; `docs/16-finance/`, `docs/26-accounting/`)
- AP/AR subledgers reconciling to GL (Runbook §21; `docs/16-finance/`)
- Bank/cash accounts + reconciliation (Runbook §27)
- Fixed assets + depreciation (`docs/03-accounting/ACCOUNTING_SPEC.md`, `docs/11-accounting/`)
- Tax rate versioning (`vatAmount` is a bare field on `Expense`; no `TaxRate` model, no historical rate lock — Runbook §26)
- Group consolidation / intercompany elimination engine (Runbook §25) — `CostSnapshot.transferPrice` exists but nothing posts the intercompany journal or eliminates unrealised profit
- Shopify integration (adapter, sync, idempotency) (Runbook §14; `docs/24-integrations/`)
- Moderator order entry (Runbook §15; `docs/12-brand-commerce/`)
- POS (Runbook §16; `docs/07-brand-commerce/BRAND_POS_OMNICHANNEL_COMMERCE_SPEC.md`) — no `Location`, `Shift`, `POSSession`, `Payment` models
- Bazaar/exhibition transfer-and-reconcile workflow (Runbook §16; `docs/07-brand-commerce/`)
- CRM beyond bare `Customer` (RFM, dedup, timeline) (Runbook §17; `docs/08-crm/`, `docs/20-crm/`)
- Marketing/campaigns/ads/ROAS (Runbook §18; `docs/21-marketing/`)
- HR/payroll/attendance/biometric adapter (Runbook §19; `docs/22-hr/`)
- MRP (demand, BOM explosion, purchase/production suggestions) (Runbook §12; `docs/17-planning/`)
- Generic workflow engine (Draft→Submitted→Approved→Posted/Executed→Closed) (Runbook §20; `docs/23-workflows/`) — today each domain (ProductionOrder, PurchaseOrder) has its own bespoke status enum, which is fine per-domain but there's no shared approval/escalation layer
- Printing/documents engine (Runbook §31)
- Alert rule *evaluation* — `AlertRule`/`Alert` tables exist but nothing computes/fires them yet
- Audit log *writers* — `AuditLog` table exists but no server action writes to it yet (no business actions exist at all)
- Capability-based permissions (see REBUILD above)
- Scenario simulator *execution* — `Scenario`/`ScenarioResult` tables exist, no engine reads live state and computes deltas
- CI/CD, deployment config, Hostinger VPS runbook (Runbook §34, §35)
- **All server actions for business mutations.** `src/app/actions.ts` currently contains only login/logout/locale/scope. Nothing creates an expense, PO, production order, or sale yet.

## CONFLICT

| Conflict | Resolution |
|---|---|
| Master execution prompt's Phase 2 = "Accounting Core"; the repo README's phase table says next milestone = "Phase 2 — Costing engine" (minute-rate/style-costing/snapshots) | Both point at the same gap in practice: the Cost Engine schema (`MinuteRatePeriod`, `CostSnapshot`) already exists and is unused by any server action — a real Accounting Core (GL) is also entirely absent. Resolution: build **Accounting Core (COA/Journal) first** per the execution prompt's explicit phase order, since every other phase (expenses, POs, sales, payroll) needs somewhere to post to. Wire the Cost Engine's *first vertical slice* (expense entry → minute rate calculation) in the same phase so the existing schema stops being dead weight. |
| Execution prompt §20 "Owner drawings are NOT operating expenses" vs. no `Equity`/drawings concept anywhere in schema | Resolved by the new chart of accounts: drawings post to an Equity account, never to a `CostCategory`/P&L account. No open question. |
| **VAT treatment of Shopify retail prices** — the schema stores everything ex-VAT at 14% (README), but whether Shopify's listed prices are VAT-inclusive or exclusive is not settled anywhere in the specs. Changes every revenue and margin number. | Financial-meaning decision per the execution prompt's escalation rule (§53) — **do not silently pick one**. Must be confirmed by the owner before the Shopify/pricing phases. Not blocking Phases 1–2. |
| **Factory margin basis** — README's open items ask whether the factory margin applies to full cost *including materials* (current schema behaviour) or to conversion cost only with materials passed through at cost plus a handling percentage. | Same escalation rule — changes the transfer price on every garment. Confirm with the owner before the transfer-pricing implementation is finalised. Not blocking Phases 1–2. |
| Exact canonical colour-code list | Non-blocking — seed already has 10 `ColorCode` rows; confirm the real list with the owner before locking further seed data, not before starting the accounting phase. |

## RISK

- **No server actions exist for anything business-related.** The "clean rebuild" risk isn't bad old code to unwind — it's that literally every mutation (expense, PO, production order, journal posting) is being written for the first time. Get the transaction-boundary/audit/permission pattern right on the *first* one (Expense → Journal), because every subsequent phase copies it.
- **Double-entry retrofit onto existing `Expense`.** `Expense`/`ExpensePayment` already have a defined shape; wiring them to auto-post journals must not change their public shape in ways that would have broken a UI that doesn't exist yet — low risk today, but the journal-posting side effect must be transactional (same DB transaction) or the ledger can drift from the AP subledger.
- **`InventoryLot` lacks `locationId`.** Adding it now (Phase 4, before POS/exhibitions in Phase 6) is a cheap additive migration. Adding it after POS/transfer logic exists would require backfilling every historical lot with an assumed location — avoid by sequencing location support before any location-aware feature.
- **Seed data currently seeds no minute rate / cost snapshot / transfer price** (intentional, per README: "a seeded answer would be a fiction"). Once the Cost Engine is wired, the seed script needs a deliberate decision on whether to also seed a first `MinuteRatePeriod` — recommend seeding one PROVISIONAL period so the UI isn't empty on first login, clearly labeled provisional.
- **The repo has two divergent branches.** This branch (`docs/cashmere-os-master-spec-v1`, the confirmed source of truth) carries the 30 topic-level spec files. The current GitHub *default* branch (`claude/cashmere-os-build-3ass8a`) carries a single consolidated `MASTER_SPEC.md` instead, with identical application code. Both must not be merged naively — a merge would produce two overlapping spec trees. Recommend making this branch the default once the rebuild lands, or explicitly deciding which doc layout survives.
- **Spec overlap within this branch.** Several domains are specified more than once at different levels of detail (accounting appears in `03-`, `10-`, `11-`, `16-`, `26-`; HR in `09-`, `13-`, `22-`; CRM in `08-`, `20-`; brand commerce in `07-`, `12-`). Where two files disagree, the higher-numbered (later-committed) file is treated as the more current statement, with `docs/30-final/` as the tie-breaker. Any contradiction that changes a financial number gets escalated rather than silently resolved.

---

## Decision: build order for this rebuild

Following the master execution prompt's phase order, adjusted for what already exists:

1. **Phase 1 (Foundation)** — mostly done. Extend RBAC to capability-based permissions + full role list. Wire `AuditLog` writes into a shared server-action helper so every future mutation gets it for free.
2. **Phase 2 (Accounting Core)** — build now. Chart of accounts, `JournalEntry`/`JournalLine` with enforced debit=credit, wire `Expense`/`ExpensePayment` to auto-post, fiscal period close, tax rate versioning.
3. Continue per the master execution prompt's §47 order from there (Master Data → Materials/Inventory → Factory → Brand Commercial → CRM → HR → MRP → Marketing → Dashboards → Printing → Reconciliation → Staging → Production), reusing the substantial existing schema in each phase rather than rebuilding it.

Each phase ships as a vertical slice (schema → server action → validation → audit → permissions → UI → tests) per the execution prompt's Definition of Done, and is committed in logical, reviewable commits.
