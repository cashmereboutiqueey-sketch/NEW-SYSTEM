# Cashmere OS — Workflow, Approvals, Tasks & Escalations Specification

## Purpose
Give every important operational action a controlled lifecycle, owner, approval path, deadline and audit trail. Workflow connects Factory, Brand, Group, Accounting, HR, Inventory, MRP, CRM and Marketing without creating hidden state outside the system.

## 1. Workflow principles
Every controlled transaction has:
`Draft → Submitted → Reviewed → Approved/Rejected → Executing → Completed/Cancelled`

Not every record requires every state; the applicable workflow is configuration-driven.

## 2. Approval matrix
Configurable approval thresholds by:
- entity
- transaction type
- amount
- quantity
- discount percentage
- write-off value
- purchase value
- payroll change
- price override
- transfer price override

## 3. Segregation of duties
The system can prevent the same user from preparing and approving selected high-risk transactions.

Examples:
- purchase request vs PO approval
- expense entry vs payment approval
- payroll preparation vs finalization
- stock write-off vs write-off approval
- price override vs price approval

Owner can configure exceptions with audit reason where necessary.

## 4. Task engine
Tasks have:
- title/type
- linked record
- owner
- due date
- priority
- status
- comments
- attachments
- escalation rule

## 5. Escalation
Overdue tasks can escalate to supervisor/owner according to configured timing. Escalations do not modify transactions automatically.

## 6. Production workflow
Suggested flow:
`Demand → MRP Proposal → Production Approval → Material Reservation → Cutting → Sewing → Finishing → QC → Finished Goods Receipt → Brand Transfer`

Blocked stages display the exact dependency causing the delay.

## 7. Purchase workflow
`Material Need → Purchase Suggestion → Review → PO → Approval → Supplier Confirmation → Goods Receipt → QC → Invoice/AP → Payment`

Price variance and quantity variance are visible before invoice matching is completed.

## 8. Sales workflow
Shopify:
`Imported → Validated → Reserved → Fulfilment → Shipped/Delivered → Completed/Returned`

Moderator/POS:
`Created → Confirmed → Reserved → Paid/Payment Pending → Fulfilled → Completed/Returned`

## 9. Transfer workflow
Factory-to-Brand transfer:
`Production Complete → QC Release → Finished Goods Receipt → Intercompany Invoice → Brand Receipt → Reconciliation`

## 10. Inventory workflow
Stock movement requires source, destination where applicable, quantity, lot, reason and user. Adjustments require approval above configured thresholds.

## 11. Finance workflow
Expenses:
`Draft → Reviewed → Approved → Accrued → Due → Partially Paid/Paid → Closed`

Journals:
`Draft → Reviewed → Posted → Period Locked`

Posted/locked records are never edited directly; corrections use adjustment journals.

## 12. Returns workflow
`Return Requested → Received → Inspection → Resellable/Quarantine/Damaged → Refund/Credit → Inventory/Accounting Completion`

## 13. CRM workflow
Leads/customer-service cases:
`New → Assigned → Contacted → Resolved/Lost`

Moderator leads can convert directly into Brand orders.

## 14. Marketing workflow
`Draft Campaign → Budget Approval → Scheduled → Live → Reconciled → Closed`

Ad-spend imports and accounting spend reconciliation are separate checkpoints.

## 15. HR workflow
Employee changes:
`Draft → HR Review → Approved → Effective`

Attendance corrections, overtime and payroll finalization follow their own approval rules.

## 16. Notifications
Notifications may be in-app and email where configured. Core operations must not depend on email delivery to preserve the transaction state.

## 17. Alert integration
AlertRule/Alert can create workflow tasks. Alerts remain informational unless an approval workflow explicitly requires action.

## 18. Exception queues
Central exception queue groups:
- stock mismatch
- unknown biometric punch
- failed Shopify import
- duplicate customer
- invoice mismatch
- price below floor
- capacity shortage
- material shortage
- overdue approval
- accounting reconciliation difference

## 19. Audit trail
Every state transition records user, timestamp, previous state, new state and reason where required.

## 20. Acceptance criteria
Workflow is complete when critical transactions cannot bypass configured approvals, every operational owner can see their pending work, overdue items escalate, exceptions have a dedicated queue, and every state transition remains auditable across Factory, Brand and Group.