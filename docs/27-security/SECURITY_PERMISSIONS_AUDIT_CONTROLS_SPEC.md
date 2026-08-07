# Cashmere OS — Security, Permissions, Audit & Internal Controls Specification

## Purpose
Protect financial, inventory, HR, customer and operational data while enforcing segregation of duties and a complete audit trail.

## 1. Roles
Baseline roles:
- Owner
- Accountant
- Production
- Viewer

Additional operational roles:
- Brand manager
- Moderator
- POS cashier
- Warehouse
- HR/payroll
- Marketing
- Finance approver
- Integration/service account

Permissions are capability-based, not only screen-based.

## 2. Permission dimensions
Permissions may be restricted by:
- action: view/create/edit/approve/post/export
- module
- entity: Factory/Brand/Group
- location
- sensitive field

Example: a moderator may create Brand social orders but cannot post journals, change transfer prices or perform unrestricted stock adjustments.

## 3. Segregation of duties
High-risk workflows require separation where practical:
- purchase creation vs approval
- supplier invoice posting vs payment approval
- payroll preparation vs payroll approval
- inventory adjustment vs approval
- journal creation vs period closing
- user/permission administration vs audit review

Owner may have override capability, but every override is logged.

## 4. Authentication
Credentials authentication is supported. Passwords are hashed using a modern password hashing algorithm. Sessions are server-side or signed securely with expiration and revocation support.

## 5. Account lifecycle
Support invitation, activation, password reset, lockout/rate limiting, suspension, termination and session revocation.

Inactive users cannot authenticate or execute actions.

## 6. Service accounts
Integration connectors use scoped service accounts/credentials with minimum permissions. They cannot access unrelated human-user functions.

## 7. Audit log
Record at minimum:
- actor
- action
- timestamp
- entity/scope
- object type/id
- before/after values where safe
- reason/reference
- source/IP/device metadata where policy permits

Audit entries are append-only.

## 8. Financial immutability
Posted journals, CostSnapshots, InventoryMovements, payments and locked-period records cannot be edited. Corrections are new records linked to the original.

## 9. Sensitive data
Restrict:
- salaries
- payroll details
- bank details
- customer personal data
- credentials/secrets
- tax identifiers

Do not expose secrets in logs or client-side bundles.

## 10. Customer privacy
CRM exports and bulk customer operations require permission. Consent and suppression status must be respected by marketing workflows.

## 11. Inventory controls
Stock adjustments require reason and appropriate approval. Negative stock is blocked by default except for an explicitly approved operational policy.

Transfers require source/destination locations and cannot change quantity without a ledger movement.

## 12. Accounting controls
Require approval/validation for manual journals, write-offs, unusual adjustments, tax adjustments and period closing according to role matrix.

## 13. Cost controls
Transfer-price changes, factory margin changes, minute-rate inputs and costing overrides require authorized approval and create history.

Historical CostSnapshots remain immutable.

## 14. HR controls
Salary changes, attendance corrections, overtime approvals and payroll finalization are audited. Sensitive HR fields are hidden from production/POS/moderator users.

## 15. Integration security
Webhook signatures are validated where supported. API credentials are server-side. External events are idempotent. Failed authentication or signature checks are rejected and logged.

## 16. Rate limiting
Protect login, password reset, webhooks and sensitive endpoints from brute-force or replay abuse. Limits are configurable.

## 17. Input validation
Every server action validates input at the boundary using the configured schema validation layer (Zod). Authorization is checked after authentication and before mutation.

## 18. CSRF / request integrity
State-changing browser requests use framework-supported request protections and server-side authorization. Never trust client-provided entity, role or permission claims.

## 19. Export controls
Exports require permission and include filters, entity, date range and generated timestamp. Sensitive exports are auditable.

## 20. Backups and recovery
Database backups are scheduled and encrypted. Recovery procedures define RPO/RTO targets as configuration decisions. Backup restoration must be tested periodically.

## 21. Monitoring
Monitor authentication failures, permission denials, integration failures, unusual inventory adjustments, manual journals and repeated reconciliation exceptions.

## 22. Audit review
Provide an audit explorer with filters by user, action, entity, module, date and object. High-risk events can be flagged for review.

## 23. Approval evidence
Approvals store approver, timestamp, decision, optional comment and workflow version. Approval cannot be silently reassigned after the fact.

## 24. Data deletion
Business records required for accounting/audit are not hard-deleted. Privacy-required customer deletion/anonymization follows retention policy while preserving non-PII accounting evidence where legally necessary.

## 25. Acceptance criteria
Security is complete when permissions are action/entity/location aware, sensitive data is protected, high-risk duties are separated, immutable ledgers remain immutable, all consequential changes are auditable, integrations use scoped credentials, and backups/recovery and security monitoring are operationally defined.
