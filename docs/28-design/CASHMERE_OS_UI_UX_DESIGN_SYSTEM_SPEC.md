# Cashmere OS — UI/UX & Cashmere Design System Specification

## Purpose
Replace generic ERP/admin styling with a premium Cashmere-branded operational interface while preserving accounting clarity, density and RTL usability.

## 1. Product identity
Cashmere OS is the internal operating system for Cashmere Factory, Cashmere Brand and Group management. It should feel premium, calm, precise and operational rather than decorative.

## 2. Design principles
- Accounting-first clarity
- Arabic-first RTL, with complete English LTR mirror
- Premium feminine brand DNA without making factory screens ornamental
- High information density where decisions require it
- Clear hierarchy between operational, financial and diagnostic information
- Consistent interaction patterns across modules
- Accessible contrast and keyboard-friendly controls

## 3. Brand application
Use the existing Cashmere brand identity as the source for the primary palette, typography direction and visual tone. Do not invent a competing palette.

Recommended hierarchy:
- soft Cashmere neutral background
- brand pink as controlled accent, not full-screen fill
- deep neutral text for financial readability
- restrained status colors for success/warning/error

Status colors must remain distinguishable independently of hue.

## 4. Typography
Use a modern Arabic-capable font family with a matching Latin fallback. Numbers, accounting tables and SKUs must remain highly legible. Financial figures use Latin digits by default in Arabic UI for accounting readability.

## 5. RTL architecture
RTL is the default. Direction-aware spacing, icons, breadcrumbs, tables, drawers, forms and charts must mirror correctly. English mode switches to LTR without changing business logic.

## 6. Global shell
Desktop shell:
- compact sidebar/navigation
- top bar with entity switcher, period, search, notifications and user menu
- contextual page header
- content area

Mobile/tablet behavior prioritizes operational tasks and POS workflows rather than shrinking desktop dashboards.

## 7. Entity switcher
Prominent switch:
`Factory | Brand | Group`

The selected entity changes data scope and visual context but never changes underlying records.

## 8. Dashboard cards
Cards must show:
- KPI
- unit
- period
- comparison
- formula/info affordance where useful
- severity/status
- drill-down action

Never show a bare “Profit” label; specify Contribution, Operating Result, Group Profit, etc.

## 9. Financial tables
Tables prioritize:
- amount
- date
- account/source
- entity
- status
- reconciliation

Support sorting, filtering, column visibility, export and drill-down. Sticky headers are used for long accounting tables.

## 10. Operational tables
Production, inventory and CRM tables support saved views and dense scanning. SKU, style, variant and location identifiers remain visible when relevant.

## 11. Forms
Forms use clear sections, inline validation, calculated fields and explicit save/submit/approve actions. Destructive actions require confirmation and reason when policy requires it.

## 12. Workflow UI
Workflow status is represented as a visible state progression:
`Draft → Submitted → Approved → Posted/Executed → Closed`

Exceptions appear separately and never look like successful completion.

## 13. Alerts
Alert center uses severity + action. Alerts link to exact source records. Avoid decorative notifications that do not require action.

## 14. POS design
POS is optimized for speed:
- large touch targets
- barcode/SKU search
- variant selection
- cart
- discounts subject to permission
- payment split support
- receipt state
- offline indicator
- shift close

POS must remain visually consistent with Cashmere while being operationally simpler than ERP screens.

## 15. Moderator order UI
Fast order entry for social DMs:
- customer search/create
- conversation/source
- moderator identity
- SKU/variant
- quantity
- price/discount permission
- delivery
- payment
- notes
- fulfillment

The UI should minimize keystrokes and expose attribution without slowing order creation.

## 16. Inventory UI
Inventory pages distinguish:
- Raw Material
- WIP
- Finished Goods

Location is always visible. Lot, FIFO age, reserved quantity, available quantity and cost are drillable.

## 17. Production UI
Production screens show planned vs actual quantity/material/minutes/cost, stages, line, operator productivity, QC, rework and scrap without exposing unnecessary HR-sensitive fields.

## 18. Accounting UI
Accounting screens prioritize journal integrity, period status, reconciliation, debit/credit balance and source traceability. Lock status is always visible.

## 19. Costing UI
Costing views expose:
- material cost
- conversion cost
- overhead
- marketing allocation where applicable
- transfer price
- contribution
- assumptions/version

Never hide the calculation behind one unexplained final number.

## 20. Design tokens
Define reusable tokens for spacing, radius, typography scale, elevation, borders, surfaces and semantic status. Component implementation must consume tokens rather than hard-coded page-specific values.

## 21. Charts
Charts should be decision-oriented. Every chart has title, unit, date range and source context. Hover/tooltips or accessible tables provide exact values.

## 22. Empty/loading/error states
Every data screen has explicit loading, empty, permission-denied and error states. Empty state must explain what action creates the first record.

## 23. Accessibility
Keyboard navigation, visible focus, semantic labels, sufficient contrast, screen-reader-friendly form labels and non-color-only status indicators are required.

## 24. Localization
All UI strings use translation keys. No business-critical text is hard-coded. Arabic and English translations are version-controlled.

## 25. Branding boundary
Brand aesthetics are strongest in the owner/brand/customer-facing areas. Factory, accounting and compliance screens remain restrained and highly legible.

## 26. Acceptance criteria
The UI system is complete when the same Cashmere design language is applied consistently across dashboards, POS, Moderator, Inventory, Production, CRM, HR and Accounting; Arabic RTL and English LTR mirror correctly; financial figures remain readable; and no module looks like an unrelated generic ERP product.
