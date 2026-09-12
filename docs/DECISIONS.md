# Cashmere OS — Business Decisions Log

Decisions that change financial meaning, recorded so they are not re-litigated
and so a future reader can see *why* a number is calculated the way it is.

Each entry records who decided, when, and what the alternative was. A decision
is only superseded by a new numbered entry — entries are never edited away.

---

## D-001 — VAT treatment

**Decided:** 2026-08-07 by the owner.
**Status:** Active.

The business is **not VAT-registered and does not charge VAT**. Sales post at
full value with no output VAT recognised, against the seeded `VAT-EXEMPT` rate.

**Alternatives considered:** VAT-inclusive Shopify pricing (gross split into net
and 14% tax before posting revenue) and VAT-exclusive pricing (14% added at
checkout).

**Consequences**

- Revenue postings carry no output VAT line. Account `2300 Output VAT payable`
  exists but stays unused until registration.
- Input VAT on supplier invoices is **not** recoverable while unregistered, so
  supplier VAT is part of the cost, not an asset in `1450`.
- Retail prices entered into the system are the actual amounts customers pay.

**If this changes:** the `TaxRate` table is already effective-dated and
`splitTaxInclusive` / `applyTaxExclusive` already exist in `src/core/ledger.ts`.
Registration means adding a new `VAT-EG` rate row with the registration date as
`effectiveFrom` and switching the default rate — historical transactions keep
the rate they posted with and are not restated.

---

## D-002 — Factory margin basis

**Decided:** 2026-08-07 by the owner.
**Status:** Active.

The factory margin applies to the **full factory cost including materials**:

```text
factory_total_cost = material_cost + cmt_cost
transfer_price     = factory_total_cost × (1 + factory_margin)
```

This is what the schema and the specification already assumed; the decision
confirms it rather than changing it.

**Alternatives considered:** applying the margin to conversion cost only with
materials passed through at landed cost, and a split basis with a smaller
material-handling percentage plus a full conversion margin.

**Consequences**

- The factory earns margin on fabric as well as on manufacturing, which
  compensates it for carrying purchasing, financing and stock-holding risk on
  materials.
- A rise in fabric price raises the brand's transfer price by *more* than the
  fabric rise itself, because the margin applies on top. This is intended, but
  it means material price variance is a brand-margin issue as well as a factory
  one — the purchase price variance report should be read with that in mind.
- `factory.margin.default` in `settings` remains the single configurable rate.
  The arm's-length floor still applies: a generated transfer price below the
  configured minimum margin is flagged.

---

## D-003 — Local development database

**Decided:** 2026-08-07 by the owner.
**Status:** Active.

Local development uses a **Docker PostgreSQL 18 container** (`docker-compose.yml`)
bound to `127.0.0.1:5435`, rather than the developer's pre-existing local
PostgreSQL instance.

**Consequences**

- The database is never exposed beyond loopback, matching the deployment
  requirement that it must not be publicly reachable.
- The pre-existing `cashmere-erp` container and its volume — an unrelated older
  project — are left untouched.
- Nothing in the application depends on Docker; `DATABASE_URL` can point at any
  PostgreSQL 16+ instance.

---

## D-004 — What registering for VAT will actually require

**Decided:** 2026-09-12 by the owner. **Status:** Active. **Relates to:** D-001.

The business expects to register for VAT in the near future. D-001 stands until
it does: no VAT is charged and none is recovered.

Recorded here because the switch on the VAT screen is **not** the whole job. It
records the registration and feeds the VAT report; it does not yet make the
books VAT-correct, because sales, purchases and expenses post their full amounts
without splitting tax out. Turning it on alone would produce a VAT return that
does not agree with the ledger.

**What has to be built before the switch means anything** — none of it is done:

1. Whether a price is tax-inclusive or tax-exclusive, per channel. Shopify
   prices are what the customer pays; a wholesale quote may be net of tax.
2. Splitting the tax out at the point of posting: output VAT to `2300` on sales,
   input VAT to `1450` on purchases and expenses, at the rate in force on the
   document's own date.
3. The rate each document posted at, stored **on the document**, so a later rate
   change never restates a past sale.
4. Returns and credit notes reversing the tax they originally carried.
5. Rounding stated once and applied everywhere, so the return and the ledger
   agree to the piastre.
6. Exemptions and zero-rated lines, if any apply.
7. The VAT report reconciled against `2300` and `1450` before it is filed.

**Until then:** the VAT screen says the figures are not live, and the report is
a preview of a future obligation rather than a return that can be filed.
