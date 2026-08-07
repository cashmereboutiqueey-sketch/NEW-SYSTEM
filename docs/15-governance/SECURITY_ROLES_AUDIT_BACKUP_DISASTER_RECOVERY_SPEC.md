# Cashmere OS — Security, Roles, Audit, Backup & Disaster Recovery Specification

## Purpose
Protect financial, inventory, customer, HR and production data while keeping the system usable for a small internal team. Every sensitive action must be attributable, recoverable and reviewable.

## 1. Roles
Core roles:
- Owner
- Accountant
- Production
- Viewer

Additional scoped permissions may be assigned by module, entity, branch/location and action.

## 2. Least privilege
Users receive only the permissions required for their job. A production user can operate production workflows without seeing payroll salaries. A cashier can operate POS without editing accounting rules. Viewers cannot mutate operational or financial data.

## 3. Entity access
Permissions can be scoped to Factory, Brand or Group. Brand staff should not automatically receive Factory financial access and vice versa.

## 4. Approval controls
High-risk actions require approval according to configurable thresholds:
- manual journal entries
- inventory adjustments
- discount overrides
- stock transfers
- production quantity overrides
- material substitutions
- below-floor transfer/CMT pricing
- payroll adjustments
- refunds above threshold
- write-offs
- owner/shared expense allocations

Approval records store requester, approver, timestamp, reason and affected source record.

## 5. Audit log
Audit every create/update/delete/approve/void/lock/unlock/import/reconcile/manual-adjustment action for material records.

Store actor, timestamp, entity, action, record ID, before/after values where appropriate, reason and source/session metadata.

Financial and inventory records are append-only after lock; corrections create adjustment/reversal records.

## 6. Authentication
Credentials authentication with secure password hashing, session management, expiration/revocation and role enforcement.

Support password reset and account disablement. Do not store plaintext passwords or secrets.

## 7. Session security
Sessions must be revocable. Sensitive actions may require re-authentication or step-up confirmation where configured.

## 8. Customer privacy
Customer personal data is accessible only to authorized Brand roles. Exports are controlled and auditable. Marketing consent/preferences are stored separately from financial metrics.

## 9. HR privacy
Salary, payroll, personal and attendance information is restricted by HR/finance permissions. Operational managers see only what is needed for production management.

## 10. Secrets
API keys, Shopify credentials, payment credentials, ad-platform tokens and biometric credentials live in secure environment/secret storage. Never commit secrets to Git.

## 11. Database safety
Use PostgreSQL transactions for multi-record financial/inventory operations. Domain writes must preserve invariants; partial writes are not acceptable for sales, stock movements, payments or accounting events.

## 12. Backups
Minimum backup policy:
- automated daily database backup
- frequent point-in-time recovery capability where infrastructure supports it
- retention policy configurable by environment
- encrypted backups
- separate backup credentials/storage

Backups must be tested, not merely created.

## 13. Restore testing
At least periodically, restore a backup into an isolated environment and verify:
- database integrity
- accounting balances
- inventory quantities/values
- user access
- critical application workflows

Record restore-test date and result.

## 14. Disaster recovery
Define RPO/RTO by environment. Production should prioritize recovery of accounting, inventory, orders and operational master data.

Recovery order:
`Database → Application → Authentication → Integrations → Background Jobs → Reporting`

External systems remain available as sources for controlled re-sync after recovery.

## 15. Integration recovery
After outage, connectors resume from durable event/checkpoint state rather than blindly replaying all history. Idempotency protects against duplicates.

## 16. Data retention
Financial records must follow applicable legal/accounting retention requirements. Operational logs, raw integration payloads and customer data have configurable retention periods where lawful.

## 17. Soft delete vs immutable records
Master records may be archived/deactivated where appropriate. Financial transactions, inventory movements, cost snapshots, payroll locks and audit logs are not physically deleted through normal application workflows.

## 18. Change management
Schema changes require migration scripts and controlled deployment. Changes affecting calculations require regression tests against known accounting/manufacturing cases.

## 19. Environment separation
Maintain separate development/test/production environments. Production credentials and data must not be casually copied into development.

## 20. Monitoring
Monitor application health, database health, failed jobs, integration failures, authentication anomalies, backup status and reconciliation exceptions.

Critical alerts should have an owner and escalation path.

## 21. Financial invariants
System must continuously enforce or report:
- debits = credits for posted journals
- inventory movement balances are reconstructible
- locked cost snapshots are immutable
- intercompany entries reconcile
- payroll totals equal approved payroll detail
- payment settlements cannot exceed source transactions without an explicit adjustment

## 22. Audit-friendly exports
Accountant should be able to export transaction-level ledgers with source references, dates, entity, account, amount, tax, counterparty and reconciliation status.

## 23. Acceptance criteria
The module is complete when role/entity permissions work, high-risk actions are approval-controlled, material records are audited and immutable after lock, secrets are protected, backups and restore tests exist, disaster recovery is documented, integration recovery is idempotent, and accounting/inventory invariants are continuously testable.
