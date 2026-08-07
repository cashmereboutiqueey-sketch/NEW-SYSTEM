# Accounting & Cost Engine — Test Matrix

This document defines the minimum acceptance matrix before the accounting/costing engine can be considered production-safe.

| ID | Scenario | Expected result |
|---|---|---|
| ACC-001 | Expense incurred but unpaid | P&L recognizes cost; AP remains outstanding |
| ACC-002 | Expense partially paid | AP equals original amount minus allocated payments |
| ACC-003 | Payment after month close | Payment clears liability; prior expense remains unchanged |
| ACC-004 | Recurring rent at period open | Accrual exists even without supplier invoice |
| ACC-005 | Journal imbalance | Posting blocked |
| ACC-006 | Posted journal edit | Blocked; adjustment/reversal required |
| ACC-007 | Locked-period edit | Blocked |
| ACC-008 | Owner drawing | Does not affect operating expense or profit |
| ACC-009 | Owner salary | Expense only when valid compensation transaction exists |
| ACC-010 | VAT separation | Ex-VAT economics remain separate from VAT balance |
| ACC-011 | Factory material accidentally assigned to conversion pool | Blocked or flagged before minute-rate calculation |
| ACC-012 | Brand fixed cost assigned to Factory pool | Blocked or flagged |
| ACC-013 | Intercompany invoice | Factory revenue and Brand payable created |
| ACC-014 | Intercompany settlement | Receivable/payable reduced without creating new revenue/expense |
| ACC-015 | Unsold Factory margin | Eliminated from Group profit and inventory margin |
| ACC-016 | Partially sold lot | Only sold quantity's embedded margin is realized |
| COST-001 | Supplier price changes after snapshot | Historical snapshot unchanged |
| COST-002 | Freight changes after receipt | Historical landed cost unchanged |
| COST-003 | Planned waste 8%, actual 12% | Snapshot uses 8%; variance reports 12% |
| COST-004 | Utilisation falls | Actual minute rate rises |
| COST-005 | Efficiency falls | Productive minutes fall and rate rises |
| COST-006 | CMT credit increases | Net pool and minute rate fall |
| COST-007 | Transfer margin below floor | Confirmation blocked |
| COST-008 | Style margin override above floor | Allowed and audited |
| COST-009 | Missing SMV | Cost confirmation blocked |
| COST-010 | Missing material cost | Cost confirmation blocked |
| COST-011 | Multiple fabrics on style | All BOM lines included |
| COST-012 | One fabric on many styles | Each style costs independently |
| COST-013 | Size multiplier 1.10 | Affected variant material cost increases 10% |
| COST-014 | Contribution margin <= 0 | Break-even shown as never |
| COST-015 | Break-even share > 60% | High-risk flag shown |
| COST-016 | Marketing by units | Allocation matches units sold |
| COST-017 | Campaign override | Override replaces default and displays reason |
| COST-018 | Historical minute-rate recalculation | Locked order costs remain unchanged |

## Reconciliation tests

- Factory subledger = Factory GL.
- Brand subledger = Brand GL.
- Intercompany receivable = intercompany payable before consolidation elimination.
- Group revenue excludes internal Factory→Brand sales.
- Group inventory contains no unrealized internal margin.
- Inventory ledger value reconciles to inventory control accounts.
- AP detail reconciles to AP control account.
- AR detail reconciles to AR control account.
- Trial balance balances to zero.

## Regression requirement

Every defect found in production or UAT must add a permanent automated regression test before the defect is marked closed.
