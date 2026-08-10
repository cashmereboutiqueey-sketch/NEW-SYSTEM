# Cashmere OS — final production audit

Run on 2026-08-10 against the application as it stands, a real PostgreSQL 18
database, and a running server. Every verdict below rests on a test that was
executed, not on reading the code. Where something could not be reached it is
marked **BLOCKED** and the missing dependency is named.

The audit scripts are in `scripts/` and can be re-run at any time:

```
npx tsx scripts/audit-rbac.ts                              # authorisation map, static
npx tsx --conditions=react-server scripts/audit-http.ts    # the running server, attacked
npx tsx --conditions=react-server scripts/audit-books.ts   # ledger against subledgers
npx tsx --conditions=react-server scripts/audit-atomicity.ts # forced failures roll back
npx tsx --conditions=react-server scripts/audit-volume.ts  # 10k orders, query timings
bash scripts/backup.sh                                     # backup, verified by restoring
npm run walkthrough                                        # the whole business cycle
```

**One warning about running them.** The integration suite wipes the database.
An audit script run straight afterwards compares empty tables and passes
everything trivially, because zero equals zero. That happened once during this
audit and was caught. Always `npm run db:fresh` before running the books,
atomicity or volume audits, and disbelieve any reconciliation that reports 0.00
across the board.

Final verification run, in order:

| | |
|---|---|
| `npm run typecheck` | clean |
| `npm run test` | 17 files, 315 tests passed |
| `npm run test:db` | 16 files, 276 tests passed |
| `npm run build` | compiled successfully, 47 pages |
| `audit-rbac` | authorisation map coherent and enforced |
| `audit-books` | books agree with themselves and refuse to be edited |
| `audit-atomicity` | every failed operation rolled back completely |
| `audit-http` | the running application refused every attack |
| `audit-volume` | every screen query inside its budget |
| `backup.sh` | backup verified by restoring it |

---

## System status

**GO LIVE WITH ACCEPTED P2 ISSUES**, once the deployment items below are done.
The application itself is sound. What is not yet proven is the environment it
will run in, because that environment does not exist yet.

| Area | Verdict | How it was established |
|---|---|---|
| Backend | **PASS** | 315 unit + 276 integration tests, all passing; nine forced mid-operation failures all rolled back |
| Database | **PASS** | 84 tables, 141 foreign keys, 246 indexes (151 unique), 13 triggers; integrity queries clean; no `Float` on any money column |
| Frontend | **PASS** | 47 pages plus the Shopify webhook route build clean; typecheck clean; every screen reached over HTTP with real data |
| Authentication | **PASS** | bcrypt at 12 rounds; forged, malformed and expired sessions all refused over HTTP; timing equalised for unknown accounts |
| Authorization | **PASS** | 53 permissions, 104 guards, 63 server actions all guarded, 25 dangerous role/action pairs refused; fifteen page-level holes found and closed |
| Accounting | **PASS** | Every posted journal balances; posted entries immutable against raw SQL; closed periods refuse postings |
| Inventory | **PASS** | FIFO verified across lots; the mandated 10/4/2 fabric scenario passes; ledger equals the lots to the piastre |
| Factory | **PASS** | Minute rate reproduces the documented worked example; WIP now clears to exactly zero per run |
| Brand | **PASS** | Despatch, intake, transfer pricing and consolidation elimination all verified |
| POS | **PASS** | Till sessions, split payments, drawer variance, scan-to-sell by garment tag |
| Moderator | **PASS** | Orders recorded with source and attribution; only stock the brand holds is offered |
| Shopify | **BLOCKED** | No credentials in the environment. Webhook signature handling was verified earlier against a running server; live order sync is unproven |
| CRM | **PASS** | RFM and lifetime value computed from real orders; duplicate detection requires human confirmation |
| HR | **PASS** (biometric **BLOCKED**) | Attendance, payroll accrual and its single hit on the cost pool verified; no biometric device available |
| MRP | **PASS** | Requirements, urgency and MOQ rounding verified; orders are raised only when a person ticks them |
| Marketing | **PASS** | Campaign spend, ROAS and contribution ROAS from posted figures |
| Security | **PASS** | See below |
| Performance | **PASS** | 10,000 customers, 10,000 orders, 20,000 journals: no screen query over 441ms |
| Backups | **PASS** | Backup taken, restored into a scratch database, then the live database destroyed and fully recovered |
| Hostinger deployment | **BLOCKED** | No server provisioned yet |

---

## What the audit found and fixed

### P0 — would have been unsafe to operate

**Twenty screens guarded only on "is signed in".** A POS cashier could open the
expenses ledger and the group P&L. A moderator could read the factory's
capacity, minute rate and cost basis. Anyone with any session could open
Settings and read the transfer-price margin and the arm's-length minimum.

Each screen now requires the view right its data belongs to. Confirmed over
HTTP with a real session per role: fifteen combinations that previously
returned 200 now do not.

Two of those were introduced during this build, when edit forms were added to
Settings and Capacity and their guards were downgraded to reach the session
object. That is worth recording: the regression came from a change that looked
purely additive.

**The dashboard served the owner's view to everyone.** It fetched cash,
payables, capital locked and the group result for every role and gated only the
group band. It cannot use `requirePermission`, because that redirects to the
dashboard and would loop, so each band is now gated on its own capability and
nothing is fetched at all for a role that may see none of it.

Verified by fetching `/` as seven roles and searching the HTML for the actual
cash figure: it appears for the owner and the read-only viewer, and for nobody
else.

### P1 — a major function was wrong

**Work in progress never cleared.** Material was charged to WIP at what the
cloth actually cost and relieved at the frozen standard cost, so every
production run left the difference behind. The demonstration data carried
81,691.93 of it — a permanent credit balance on an asset account.

That difference is a real number about buying and cutting, so it now posts to a
new **material cost variance** account (5150) and WIP lands at exactly zero per
run. A run also can no longer be closed for material that was never issued.

The first version of that guard compared values and would have blocked any run
whose cloth was bought below standard — a normal, good outcome. It checks
quantities instead and names the materials that are missing.

**Collected payments were parked in a clearing account.** The account a payment
went to was chosen by method alone, ignoring whether the money had been
received, so a card sale rung up at the till went to "the gateway owes us" and
stayed there forever. The demo showed 9,191 owed against 4,853 genuinely
outstanding. Collected payments now go to cash or bank, and the two figures
agree to the piastre.

### P2 — accepted, with actions before go-live

| Issue | Why it is accepted | What to do |
|---|---|---|
| **Default seed passwords** | All three seeded accounts share one password, documented in the README | Change every password on first sign-in. Do not deploy with `cashmere2026` |
| **Shopify unverified** | No credentials available | Test order sync, refunds and duplicate webhooks in a Shopify development store before switching the channel on |
| **Alerts need a scheduler** | The engine works and is correct; nothing calls it automatically | Add a cron entry hitting the evaluation on the VPS, or accept that someone presses "check now" |
| **Biometric import unverified** | No device available | Verify against the real device before relying on attendance for payroll |
| **Responsive layout not machine-tested** | RTL/LTR switching is verified at the document level; visual behaviour on a phone is not | Open the POS and warehouse screens on the actual devices they will be used on |

Two of these were closed during the audit rather than accepted:

- **No login rate limiting.** bcrypt at twelve rounds costs an attacker about a
  quarter-second per guess, which is a brake and not a stop. Accounts now lock
  for fifteen minutes after eight consecutive failures, held on the user row so
  a restart does not hand an attacker a clean slate. A locked account gives the
  same silence as a wrong password, so the lockout does not confirm that an
  address exists.

- **No error boundary.** An unhandled error showed a bare page. There is now an
  error page and a not-found page, both of which say what a person actually
  needs to know — that nothing was half-saved — without printing a stack trace.

### P3 — minor

- `sales_orders.customerId` had no index. At ten thousand orders a customer's
  history took 1.8ms; it now takes 0.22ms. Harmless today, unpleasant at half a
  million rows.
- Ten permissions are defined but nothing checks them yet
  (`journal:post`, `journal:reverse`, `expense:approve`, `payment:approve`,
  `account:manage`, `purchase_order:approve`, `sales_order:refund`,
  `payroll:approve`, `user:manage`, `audit:view`). They belong to approval
  flows and screens not yet built. They are not holes — nothing grants access
  on their absence — but they are promises the system does not yet keep.

---

## Evidence

### No fake data behind real functionality

Searched for `TODO`, `FIXME`, `HACK`, mock, fake, stub, dummy, placeholder and
lorem ipsum across `src/` and `prisma/`. **Nothing found outside test files.**

Demonstration data lives in `prisma/demo.ts`, deliberately separate from
`prisma/seed.ts`, which seeds master and reference records only. No screen
falls back to a hardcoded figure.

### The database refuses to be corrupted

Attacked directly in SQL, bypassing the application entirely:

| Attempt | Result |
|---|---|
| Edit a posted journal line | `Journal entry … is POSTED; its lines cannot be modified` |
| Delete a posted journal entry | `… cannot be deleted; post a reversing entry instead` |
| Delete a line out of a posted entry | Refused |
| Flip a posted entry back to draft | Refused |
| Change a posted entry's date | Refused |
| Commit an unbalanced posted entry | `does not balance: debits 100.0000, credits 60.0000` |
| Commit a balanced entry | Accepted |
| Post to a rollup parent account | `is a rollup parent and cannot be posted to` |
| Post into a closed period | Refused, in SQL as well as in the application |
| Duplicate a garment serial | Refused by unique index |

The immutability held so firmly that it blocked the audit's own cleanup of a
test entry, which is the correct outcome.

### Failures leave nothing behind

Nine operations were driven to a point where they had to fail, and the row
counts for journals, lines, lots, movements, orders, order lines, payments,
garment units and settlements were compared before and after:

selling more than exists · a sale whose payments do not add up · issuing more
fabric than the store holds · finished goods whose material cost exceeds their
total · despatching more than the factory holds · counting in more than was
sent · a remittance with an unexplained shortfall · a stock adjustment over the
approval limit with nobody approving · closing a run against a SKU from another
style.

**All nine failed cleanly with nothing written**, and the ledger still balanced
at 1,883,203.35 afterwards — the same figure as before the nine attacks.

### The ledger agrees with what it summarises

Run against a freshly loaded demonstration cycle (`npm run db:fresh`), which
puts real trading through the system rather than comparing empty tables:

| Check | Ledger balance | Result |
|---|---|---|
| Raw materials (1310) against the lots | 184,501.96 | agrees |
| Work in progress (1320) against the lots | **0.00** | clears exactly |
| Factory finished goods (1330) | 20,167.02 | agrees |
| Brand finished goods (1340) | 154,681.02 | agrees |
| Payables against unpaid expenses plus deliveries | 713,100.00 + 333,428.16 | agrees |
| Brand cost of sales against the order lines | 4,759.42 | agrees |
| Courier clearing against outstanding payments | 2,993.44 | agrees |
| Gateway clearing against outstanding payments | **0.00** | agrees |
| Assets = liabilities + equity + profit | 523,645.71 | balances |

Total posted ledger: 1,883,203.35 on each side.

The two zeros are the point. Work in progress at exactly 0.00 is the P1 fix
holding: material charged at actual and relieved at standard now leaves nothing
stranded. Gateway clearing at 0.00 is the collected-payments fix: card money
taken at the till reaches the bank instead of sitting forever in "the gateway
owes us".

An empty database passes every one of these checks trivially, since 0 = 0. The
integration suite wipes the database, so these figures were produced after
reloading data specifically to avoid that.

### Segregation of duties

Six pairs are enforced, and no role except the owner holds both halves of any:
expense create/approve · payment create/approve · purchase order create/approve
· inventory adjust/approve · payroll prepare/approve · journal create/period
close.

Separately, the same *person* cannot approve what they created, which no role
map can prevent on its own.

### Attacked over HTTP

- All 18 protected pages send an anonymous visitor to the login page.
- A token signed with the wrong secret, a malformed token and an expired
  session are all refused.
- Seven roles were checked against the pages they may and may not open.
- Five injection and traversal attempts — SQL in a query parameter, `../..` in
  a path, a script tag in an entity name — were handled without a 500, without
  reflecting the script tag, and with the users table intact.
- No secret and no database URL appears in any rendered page.
- No secret appears in any of the 11 client-side bundles.

One caveat worth stating plainly. The test for whether salaries are *withheld*
rather than merely hidden could not be completed as designed: the production
role cannot open `/hr` at all, so there is no response to inspect for a leaked
figure. What is proven is that the page is unreachable to it and that a role
holding `salary:view` does receive the figures. If a screen is ever added that
shows staff to a role without `salary:view`, that test becomes meaningful and
should be run.

### Under weight

10,000 customers, 10,000 sales orders, 20,000 journal entries, 40,018 journal
lines — loaded in 64 seconds.

| Query | Time |
|---|---|
| Customer list, first page | 17ms |
| Sales list with joins, first page | 73ms |
| Trial balance over every posted line | 55ms |
| Ledger balance check | 27ms |
| Stock on hand by lot | 13ms |
| Outstanding courier money | 23ms |
| Audit log, most recent page | 8ms |
| Owner dashboard | 441ms |
| Payables aging | 12ms |
| Thirteen-week cash forecast | 95ms |
| One customer's history (indexed) | 0.137ms |
| A scanned garment tag | 0.036ms |
| An order looked up by number | 0.179ms |

Nothing came close to the one-second budget. The owner dashboard is the
heaviest thing in the system at 441ms, which is expected — it is the one screen
that reads across every part of the business.

Index use is judged by selectivity, not by plan shape. Nearly every order
belongs to one entity, so reading the orders table and sorting is the *correct*
plan for an unfiltered list and an index would rightly be ignored there. What
must not read everything is a needle: one customer out of ten thousand, one
scanned tag, one order number. All three use an index.

### Backups are restorable

`scripts/backup.sh` dumps the database and then restores that dump into a
scratch database, checking that the ledger still balances inside it and that
the thirteen triggers survived. **If the restore fails, the dump is deleted**
rather than left to be trusted.

Latest run: a 1,171KB dump, restored into a scratch database holding 20,000
journals, 40,018 lines and 23 lots, ledger balancing at 2,082,643.35, with all
13 triggers surviving the round trip.

Proven end to end earlier in this audit: the live database was destroyed
(`DROP SCHEMA public CASCADE`) and fully recovered from the backup —
20,000 journal entries before, 20,000 after, books balancing.

`backups/` is git-ignored. A database dump is the whole business in one file
and must not go near the repository.

---

## Before switching it on

1. **Change every password.** The seeded accounts share one.
2. **Generate a fresh `AUTH_SECRET` and database password** for the server.
   Do not reuse the development values.
3. **Keep PostgreSQL bound to `127.0.0.1`.** It must not be reachable from the
   internet. It is currently on `127.0.0.1:5435` and should stay that way.
4. **Schedule two things**: the nightly backup, and the alert evaluation.
5. **Restore a backup on the server once**, before there is anything to lose.
6. **Open the POS on the actual till device** and the warehouse screens on
   whatever the storeroom uses.
7. **Test Shopify in a development store** before pointing the channel at real
   orders.

---

## Final recommendation

**GO LIVE WITH ACCEPTED P2 ISSUES.**

No P0 or P1 issue remains open. The three that were found — the authorisation
holes, the unclearing work in progress, and the stranded clearing balances —
are fixed, and each is now covered by a test or an audit script that will catch
it coming back.

The two BLOCKED areas are honest blocks, not failures: Shopify has no
credentials in this environment, and the Hostinger server does not exist yet.
Neither can be called verified, and neither is claimed to be.
