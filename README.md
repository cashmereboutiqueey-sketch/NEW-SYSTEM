# Cashmere OS

النظام الداخلي لتشغيل مصنع وبراند كاشمير بوتيك
Internal operating system for the Cashmere Boutique factory and brand.

Currency: **EGP** throughout. UI: **Arabic (RTL) and English**. Code, schema and identifiers: English.

---

## 1. Why this system exists

Two businesses currently share one bank account, one pocket and one set of records:

- **المصنع (the Factory)** — produces garments, runs at roughly 60% of its capacity, and currently sells to exactly one customer.
- **البراند (the Brand)** — Cashmere Boutique, modest casual daily wear.

Because they are blurred together, two things are invisible:

1. **The factory's real cost per garment**, including the cost of the 40% of capacity that produces nothing.
2. **Unpaid liabilities**, because the existing accounting software is cash-based — a cost that has not been paid yet does not appear, so every reported figure is better than reality.

This system separates the two entities, records costs when they are *incurred* rather than when they are *paid*, and makes the cost of idle capacity a visible number rather than a silent tax on every garment.

---

## 2. The domain model, for an accountant

### 2.1 Two entities, one transfer price

The Factory **sells** its output to the Brand and issues an internal invoice for every production order. The price it charges is the **سعر التحويل (transfer price)**.

That price must be **arm's length** — the same margin the factory would charge an outside client. This is the load-bearing rule of the whole system. If the transfer price is ever discounted "because it's our own brand", the factory's loss simply migrates into the brand's accounts and the system stops being able to tell you anything useful. The system flags any transfer price generated below the configured minimum margin.

**Group P&L** = Factory P&L + Brand P&L, minus intercompany transactions. The elimination has two parts:

1. Factory revenue from the Brand cancels against the Brand's cost of goods.
2. **Unrealised profit inside unsold finished goods is also eliminated.** If the factory books margin on 1,000 units and the brand has sold 400, the margin on the remaining 600 is not group profit — it is inventory. Without this second step, the group appears more profitable simply for producing into stock.

### 2.2 Accrual accounting, always

Every expense is recorded when **incurred**, never when paid.

| Field | Meaning |
|---|---|
| `amount` | The cost, ex-VAT |
| `incurredDate` | When the obligation arose |
| `dueDate` | When it must be paid |
| `paidAmount` | Sum of payments received against it so far |

An expense can be partially paid. Unpaid balances roll into an **accounts payable aging** report. There is deliberately no way to record a cost only when cash leaves the account.

### 2.3 The minute rate — the spine of all costing

Everything the factory makes is costed in minutes.

```
gross_available_minutes   = operators × working_days × hours_per_day × 60
productive_minutes        = gross_available_minutes × utilisation × efficiency
actual_minute_rate        = net_cost_pool / productive_minutes
full_capacity_minute_rate = net_cost_pool / gross_available_minutes
```

**Utilisation and efficiency are tracked separately**, because they are different diseases with different cures:

- **Utilisation** — the share of available minutes actually booked with orders. Low utilisation is a *sales* problem.
- **Efficiency** — earned standard minutes divided by clocked minutes while working. Low efficiency is a *shop floor* problem.

Two rates come out of this:

| Rate | Meaning |
|---|---|
| `actual_minute_rate` | What the brand pays today |
| `full_capacity_minute_rate` | The absolute floor for quoting external CMT work — never quote below it |

The gap between them is **الطاقة العاطلة (idle capacity cost)**:

```
idle_penalty_per_minute = actual_minute_rate − full_capacity_minute_rate
idle_penalty_per_unit   = idle_penalty_per_minute × style_SMV
```

Worked example, at the seeded figures:

| | |
|---|---|
| Factory conversion cost | EGP 568,000 / month |
| 40 operators × 26 days × 8 hours | 499,200 gross minutes |
| Utilisation 60% × efficiency 80% | 239,616 productive minutes |
| **Actual minute rate** | **2.3705 EGP/min** |
| **Full-capacity minute rate** | **1.1378 EGP/min** |
| **Idle penalty** | **1.2326 EGP/min** |
| On a 33-minute style | **EGP 40.68 of pure idleness per garment** |

That last figure is the single most important diagnostic in the system.

**The corollary that makes external CMT strategic:** because external CMT revenue is credited against the factory cost pool, every idle minute sold above the full-capacity floor *directly lowers the minute rate the brand pays*. External CMT is not a side business — it is the main lever on the brand's own margin.

### 2.4 Minute rates are versioned, never rewritten

One `MinuteRatePeriod` row exists per entity per month, holding its own capacity inputs, cost pool and resulting rates.

- A month still open carries a **provisional** rate, labelled as such.
- A closed month is **locked**.
- A production order costed in March keeps March's rate permanently.

Recalculating this month can never retroactively change last quarter's margins.

### 2.5 Style costing

```
effective_consumption = standard_consumption × (1 + waste_rate)
fabric_cost           = effective_consumption × material_effective_cost
material_cost         = fabric_cost + Σ(trim quantity × trim cost)
cmt_cost              = SMV_minutes × minute_rate
factory_total_cost    = material_cost + cmt_cost
transfer_price        = factory_total_cost × (1 + factory_margin)
```

`material_effective_cost` is the **landed** cost: purchase price plus freight and any customs duty, not the invoice price.

SMV is built bottom-up from `StyleOperation` rows (cutting, shoulder join, sleeve attach, pressing…), so the minute count can be inspected operation by operation rather than simply asserted.

### 2.6 Waste is measured, not assumed

```
actual_waste_rate = (actual_metres_issued / standard_metres_required) − 1
```

computed from real cutting tickets (`MaterialIssue`). Each style stores both:

- `plannedWasteRate` — used for costing
- `actualWasteRateTrailing` — computed from a rolling window of real issues

When actual exceeds planned by more than the configured threshold, the style is flagged. Costing continues to use the planned rate; the actual rate drives the variance report. Historical costs are never rewritten.

### 2.7 Cost snapshots are immutable

When a production order is confirmed, the entire cost basis is frozen into a `CostSnapshot`: every material price, the minute rate and its period, the SMV, the waste rate, the margin, and the resulting transfer price — plus a line per BOM item.

Changing a fabric price tomorrow creates a **new** snapshot. It does not touch yesterday's. This is the most common way a system like this silently starts lying, and it is closed off at the schema level.

### 2.8 Brand unit economics

```
net_price           = retail_price × (1 − discount_rate)
effective_revenue   = net_price × (1 − return_rate)
variable_cost       = transfer_price + packaging + shipping + payment_fee
                      + marketing_per_unit + return_handling_cost
contribution_margin = effective_revenue − variable_cost
break_even_units    = allocated_fixed_costs / contribution_margin
break_even_share    = break_even_units / production_run_quantity
```

`allocated_fixed_costs` means **brand-only** fixed costs — showroom rent, brand salaries, software. Factory overhead is already inside the transfer price via the minute rate; counting it again here would charge it twice. Cost categories carry an explicit `includeInBrandFixedPool` flag so the contents of that pool are always inspectable.

Break-even is always reported as a share of the production run — *"break-even at 340 units = 62% of the run"* — and flagged as high risk above 60%.

If contribution margin is zero or negative, the system reports that the style **never** breaks even, rather than printing a very large number.

### 2.9 Cash conversion cycle

```
CCC = raw_material_days + production_lead_days + finished_goods_days
      + collection_days − supplier_credit_days

working_capital_locked = CCC × (monthly_COGS / 30)
```

Raw material days are included because fabric sitting in the store before cutting is locked capital — and it is precisely the period supplier credit is meant to cover.

A positive CCC means every unit of growth consumes cash. This sits permanently on the dashboard, because *"profitable on paper, no cash in hand"* is the daily reality this system was built to explain.

### 2.10 Inventory in three states

**Raw materials → WIP → Finished goods**, valued **FIFO by lot**.

Every movement is an `InventoryMovement` row against an `InventoryLot`, so quantity and value are always reconstructible from the ledger rather than trusted as a stored balance. Finished goods age per SKU into 0–30 / 31–60 / 61–90 / 90+ day buckets, each carrying the capital locked in it, with a dead-stock flag past the configured threshold — **المخزون الراكد**.

---

## 3. Beyond the core: operations and decision intelligence

The schema carries these from day one, so no later phase requires a migration that rewrites history:

| Area | What it answers |
|---|---|
| **Capacity planning** | How full is next month, and how many minutes are still sellable? |
| **Planned vs actual** | Not just what an order cost, but *why* it cost more than planned — fabric and minutes, side by side |
| **Scrap** | Where offcuts went: sold, discarded, used for sampling — and what that was worth |
| **Rework** | Re-sewing, re-pressing, re-packing — costed in minutes at the frozen rate |
| **Line efficiency** | Which line is the problem, not just the factory average |
| **Operator productivity** | Earned SMV vs clocked minutes per operator |
| **Fabric utilisation** | Purchased vs consumed vs wasted vs remaining balance |
| **MOQ** | Warns when a run needs 42 m but the roll is 100 m |
| **Purchase price variance** | Fabric moved 95 → 112: the impact per garment, in EGP |
| **Supplier scorecard** | Price, quality and delivery over time — not just a name |
| **Cash flow forecast** | Known outflows and expected receivables over the next 30 days |
| **Sell-through & markdown** | Did the design succeed, or did discounts move it? |
| **GMROI** | Gross margin return on inventory investment |
| **Customer profitability** | Which wholesale customer actually earns money |
| **Alerts** | The system tells you; you don't go hunting |
| **Scenario simulator** | "What if fabric rises 10% and the factory runs at 85%?" — before spending the money |

---

## 4. Build status

Working end to end, with tests and verified in the browser:

| Area | What works | Screen |
|---|---|---|
| **Accounting core** | Chart of accounts, double-entry journals, trial balance. Three invariants enforced by database triggers: posted journals must balance, posted entries are immutable, closed periods are unwritable. | — |
| **Permissions** | 12 capability-based roles with segregation of duties: no non-owner role holds both halves of a segregated pair, and nobody approves their own document. | — |
| **Expenses** | Accrual entry posting straight to the ledger; payment is a separate event that settles the liability. | `/expenses` |
| **Minute rate** | Cost pool read from posted conversion accounts, utilisation and efficiency kept separate, versioned and lockable per month. | `/minute-rate` |
| **Style costing** | BOM at landed cost, SMV at the frozen rate, margin, transfer price, immutable cost snapshots. | `/costing` |
| **Inventory** | FIFO by lot across raw / WIP / finished goods, locations, ageing, dead stock, capital tracker. | `/inventory` |
| **Production** | Raise, confirm, issue against and close a run. Confirming freezes the cost basis; output is booked as a size curve, one lot per SKU. Planned vs actual fabric, minutes and waste. | `/production` |
| **Sales** | One engine for Shopify, moderator and POS, with till sessions, split payments and COD clearing. Orders taken by message are entered on the sales screen; the website arrives by webhook. | `/sales`, `/pos` |
| **Group** | Factory despatches, the shop counts the delivery in and tags it, and only then is the internal invoice raised — for what actually arrived. Anything short is the factory's abnormal loss. Intercompany elimination and unrealised profit in unsold stock follow from it. | `/transfers`, `/goods-in`, `/reports/group-pnl` |
| **Statements** | Factory and Brand P&L with the trial balance beside them, AP aging by due date. | `/reports/entity-pnl` |
| **CRM** | RFM, lifetime value from real orders, duplicate detection with human confirmation, consent. | `/customers` |
| **HR** | Biometric import, derived attendance, payroll accrual reaching the cost pool exactly once. | `/hr` |
| **Garment tags** | A unique code per physical garment, minted as a run is closed, followed through despatch, intake and sale. Roll labels sized from settings; the till scans a tag to sell that exact piece. | `/print/labels/despatch/…`, `/pos` |
| **Dashboard** | Cash, capital locked, idle-capacity penalty, cash conversion cycle, dead stock, group result. | `/` |

| **Working capital** | AP aging, cash conversion cycle with every leg measured, break-even per style, GMROI by collection, dead stock by age. | `/expenses/aging`, `/reports/cash-cycle`, `/reports/break-even`, `/reports/gmroi`, `/inventory/dead-stock` |
| **Commercial analysis** | Sell-through against what was made, markdown analysis reading what discounting actually ate, supplier scorecard putting price, lateness and quality side by side. | `/sales/sell-through`, `/sales/markdown`, `/suppliers/scorecard` |
| **Factory floor** | Capacity and its booking, line and stage efficiency, scrap with its recovery rate. | `/capacity`, `/capacity/planning`, `/production/lines`, `/production/scrap` |
| **Cash forecast** | Thirteen weeks of obligations already on the books — no sales projection. Rent, payroll and instalments are entered here as scheduled items. | `/cash-flow` |
| **Stocktake** | Count a shelf and post the difference. A shortfall above a configured limit needs a second person, and whoever counted cannot approve it. Tagged garments that are missing are marked lost, so the till refuses them. | `/inventory` |
| **Capacity** | Operators, days, hours, utilisation and efficiency — the five numbers the whole minute rate rests on. A period whose rate is locked cannot be re-configured. | `/capacity` |
| **Alerts** | Eleven rules that evaluate against real data and deduplicate by condition, so a problem seen three mornings running is one alert. | `/alerts` |
| **What-if** | A measured month with one thing changed: cloth, wages, utilisation, discount, returns. | `/scenarios` |
| **External CMT** | Clients and quoting, with the full-capacity rate enforced as a hard floor. | `/cmt/clients`, `/cmt/quotes` |

| **Reconciliation** | Courier and gateway remittances cleared order by order against the clearing accounts, and bank statements matched line by line against the ledger. | `/reconciliation` |

Not built yet: deployment to the VPS.

Every screen in the navigation now has a page, and every screen that should
accept input does. The audit that proves it runs as part of `npm run
walkthrough`.

### The walkthrough

`npm run walkthrough` drives the whole cycle against a freshly seeded database
— add a supplier, buy fabric, create a product, make it, get it to the till,
sell it — and reports anything that does not add up. It also checks that every
step of that cycle has a screen with buttons on it, because the first version
of this script passed while the production screen was read-only: it was calling
the services directly, which no user can do.

### Money somebody else is holding

Cash taken on a customer's doorstep is the courier's until they pay it over,
so it is posted to a clearing account rather than to cash. The balance of that
account is exactly what they owe, which is what makes it reconcilable at all.

Remittances are cleared order by order, never by total. A batch that is 4,000
light against a total looks like a fee; against a list it is a specific parcel
nobody was paid for, and the answer is to leave that order unticked so it stays
outstanding rather than explaining the gap away.

Building this surfaced a real defect in the sales code: the account a payment
went to was chosen by method alone, ignoring whether it had been collected. A
card sale rung up at the till went to the gateway clearing account and stayed
there, showing as a debt the gateway had already settled. It now goes to the
bank, and a test pins it.

### Two rates, and why external work is strategic

The factory has two minute rates and they do different jobs. The **actual**
rate is what the Brand pays. The **full-capacity** rate is what the same
minutes would cost if the factory were full, and it is the hard floor for
quoting outside work — the quoting screen refuses to go under it rather than
warning, because below it the Brand is paying part of a stranger's bill.

Between the two sits the idle penalty, which is what unsold capacity costs
whether or not anybody buys it. Because external CMT revenue is credited
against the factory cost pool, every minute sold above the floor lowers the
rate the Brand itself pays. That is why external work is a lever on the
Brand's own margin rather than a sideline.

### Stock crossing between the two companies

The Factory and the Brand are separate companies, so stock crosses between
them by invoice. It happens in two steps, for the same reason a courier makes
you sign for a parcel:

- **Despatch** (`/transfers`) — the goods leave the factory warehouse and sit
  in transit. They are still the factory's, and nothing is invoiced. Sending
  is not selling.
- **Goods in** (`/goods-in`) — the shop counts what arrived and tags it. The
  internal invoice is raised then, for the counted quantity, and the garments
  become sellable.

Two consequences, both deliberate. A delivery that arrives short is invoiced
short: the missing garments are charged to the factory as abnormal loss
(account 5400), because the goods were in its hands until they arrived. And
nothing reaches a shelf untagged — a garment with no barcode is one the till
cannot ring up and a stocktake cannot count.

### Every garment carries its own code

A tag holds an eight-character code unique to that physical garment, not to its
SKU — two black mediums off the same run are told apart. That is what makes
"which one was sold", "which one came back" and "which three never arrived"
answerable at all.

The code is deliberately short. A Code 128 barcode of eight characters is
35.75mm wide including its quiet zones, which fits a 40mm label; the readable
`DALIA-BLK-M-00427` shape comes to 55mm and runs off the edge, where no scanner
will read it. A test holds that line so nobody makes the code legible and finds
out on the roll.

The alphabet drops `0/O` and `1/I/L`, leaving exactly 31 characters. 31 being
prime is what makes the check character catch every single wrong character and
every transposition — at a composite length, weights sharing a factor with the
base wave some misreadings through.

Codes are minted as a run is closed, so a short delivery names the missing
pieces rather than only counting them. Labels print one per garment on a roll
sized from settings, and the till resolves a scan to the exact piece: one
already sold, still at the factory, or in the other branch each says so.

Units sit alongside lots rather than replacing them. Lots carry cost and drive
FIFO; units carry identity. No figure in the ledger depends on any of this.

### Business decisions

Two decisions that change financial meaning were escalated rather than
assumed, and are recorded with their consequences in
[`docs/DECISIONS.md`](docs/DECISIONS.md): VAT treatment (not registered) and
the factory margin basis (full cost including materials).

---

## 5. Running it

### Requirements
- Node.js 22+
- PostgreSQL 16+ — either your own instance, or the bundled Docker one below

### Setup

```bash
npm install                 # also runs `prisma generate`
cp .env.example .env        # then fill in the three secrets it asks for
docker compose up -d db     # local Postgres 18 on 127.0.0.1:5435
npm run db:migrate          # create the schema
npm run db:seed             # load realistic Egyptian sample data
npm run dev                 # http://localhost:3000
```

`docker-compose.yml` binds Postgres to loopback only, so the database is never
publicly exposed. Point `DATABASE_URL` at your own instance instead if you
prefer — nothing in the application depends on Docker.

Generate the two secrets `.env` needs:

```bash
openssl rand -base64 32                                                  # AUTH_SECRET
node -e "console.log(require('crypto').randomBytes(18).toString('base64url'))"  # POSTGRES_PASSWORD
```

### Seeded sign-in

| Email | Password | Role |
|---|---|---|
| `owner@cashmere.eg` | `cashmere2026` | OWNER |
| `accountant@cashmere.eg` | `cashmere2026` | ACCOUNTANT |
| `production@cashmere.eg` | `cashmere2026` | PRODUCTION |

> Sample credentials for local evaluation only. Replace them before this touches a real network.

### Scripts

| Command | Purpose |
|---|---|
| `npm run dev` | Development server |
| `npm run build` / `npm start` | Production build and serve. Writes to `.next-build`, not `.next`, so it can run while a dev server is up. |
| `npm test` | Unit tests for the domain logic. No database needed. |
| `npm run test:db` | Integration tests against a real PostgreSQL instance |
| `npm run walkthrough` | Drives the whole business cycle end to end and reports gaps |
| `npm run typecheck` | TypeScript, no emit |
| `npm run db:migrate` | Create and apply a migration |
| `npm run db:seed` | Load sample data |
| `npm run db:reset` | Drop, re-migrate and re-seed |
| `npm run db:studio` | Browse the database |

### Seeded sample data

2 entities · 12 fiscal periods · 23 settings · 86 accounts · 3 locations · 6 cost centres · 2 tax rates · 10 colours · 5 sizes · 19 cost categories · 3 production lines · 40 operators · 12 capacity configurations · 6 suppliers · 15 materials · 3 collections · 8 styles · 60 BOM lines · 66 operations · 165 variants · 5 sales channels · 11 alert rules.

Prices are at 2026 Egyptian levels: cotton jersey at 168 EGP/m, linen blend at 318 EGP/m, factory payroll at 268,000 EGP/month, factory rent at 55,000 EGP/month.

No minute rate, cost snapshot or transfer price is seeded. Those are produced by the Phase 2 costing engine — a seeded "answer" would be a fiction, which is exactly what this system exists to eliminate.

---

## 6. Technical decisions

| Decision | Choice | Why |
|---|---|---|
| Framework | Next.js 15 App Router + TypeScript | |
| Database | PostgreSQL 16 + Prisma 7 | |
| Data layer | **Server actions** (not tRPC) | One mechanism, used consistently, validated with Zod at every boundary |
| Numbers | `Decimal` everywhere, never `float` | Money is `Decimal(18,4)`, rates `Decimal(18,8)`, percentages stored as fractions (0.14, not 14) |
| Rounding | Display only | Intermediate arithmetic keeps full precision so long calculation chains don't drift |
| Styling | Tailwind 4, logical properties | RTL comes from `margin-inline`, `border-inline` etc., not mirrored stylesheets |
| Auth | JWT session cookie + bcrypt | Roles: OWNER / ACCOUNTANT / PRODUCTION / VIEWER |
| Charts | Recharts | Phase 5 |

### Design rules held throughout

1. **No hardcoded rates or magic numbers.** Every configurable figure is a row in `settings`, visible and editable in the UI.
2. **Every calculated figure is traceable.** Stored components (`MinuteRateComponent`, `CostSnapshotLine`) exist so any number can be opened up and its inputs shown, rather than recomputed on click.
3. **Never mutate history.** Prices, snapshots and locked periods are append-only. Corrections are adjusting entries that reference the original.
4. **Consistent Arabic terminology.** تكلفة الدقيقة · سعر التحويل · هامش المساهمة · نقطة التعادل · الطاقة العاطلة · دورة الكاش · المخزون الراكد
5. **Latin digits for money in the Arabic UI**, matching Egyptian accounting practice.

---

## 7. Repository layout

```
prisma/
  schema.prisma        the full data model, commented by domain area
  migrations/          versioned SQL, including partial unique indexes
  seed.ts              realistic Egyptian sample data
src/
  app/                 routes, layouts, server actions
  components/          UI: sidebar, entity switcher, tables, tiles
  core/                pure domain logic — no framework, no database, unit tested
  lib/                 db client, money, i18n, auth, session, navigation
  generated/prisma/    Prisma client (generated; not committed)
```

`src/core/` is deliberately free of Next.js and Prisma imports. The costing formulas are pure functions over `Decimal`, so every formula can be tested with fixture data and expected outputs without a database.

---

## 8. Business rules confirmed with the owner

Recorded here so they are not re-litigated later:

1. **Utilisation and efficiency are modelled separately**, not as one combined factor.
2. **FIFO** inventory valuation, for accurate aging and dead-stock capital.
3. **Marketing allocated by units sold**, with a per-style override for targeted campaigns.
4. **External CMT revenue is credited to the factory cost pool**, so filling idle capacity visibly lowers the brand's minute rate.
5. **Raw material days are included in the cash conversion cycle.**

Open items to confirm before Phase 2 completes:

- Are Shopify retail prices VAT-inclusive or exclusive? The system currently stores everything ex-VAT at 14%.
- Should the factory margin apply to the full cost including materials (current behaviour, per specification), or to conversion cost only with materials passed through at cost plus a handling percentage?
