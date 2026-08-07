# Cashmere OS Documentation

This directory is the canonical specification layer for Cashmere OS.

## Source of truth

Start with [`MASTER_SPEC.md`](./MASTER_SPEC.md). It captures the business model, accounting rules, costing engine, inventory, manufacturing, MRP, sales, POS, CRM, HR, marketing, integrations, workflows, traceability and technical constraints agreed so far.

## Documentation rule

**Documentation → Architecture → Database → API → UI → Code → Tests**

If implementation conflicts with the specification, stop and resolve the specification/decision first. Do not silently invent business rules in code.

## Planned documentation tree

```text
docs/
├── MASTER_SPEC.md
├── 00-introduction/
├── 01-business/
├── 02-architecture/
├── 03-accounting/
├── 04-factory/
├── 05-brand/
├── 06-procurement/
├── 07-inventory/
├── 08-mrp/
├── 09-sales/
├── 10-pos/
├── 11-crm/
├── 12-hr/
├── 13-pricing/
├── 14-capital/
├── 15-reports/
├── 16-integrations/
├── 17-security/
├── 18-api/
├── 19-ui/
├── 20-roadmap/
├── decisions/
└── glossary/
```

## Status

Version 1.0 is the consolidated business specification. It deliberately contains a small number of open decisions instead of guessing. See the final section of `MASTER_SPEC.md`.
