# Cashmere OS — Quality, QA, Nonconformance, Rework & Scrap Specification

## Purpose
Make quality a controlled production and financial dimension, not a note outside the system. Quality events must explain material loss, rework cost, delays and customer returns.

## 1. Quality checkpoints
Quality checks may occur at:
- incoming material receipt
- cutting
- sewing operation/stage
- finishing
- final inspection
- packing
- pre-event transfer
- customer return inspection

## 2. Inspection records
Store inspection date, order/style/SKU, stage, inspector, quantity inspected, pass quantity, fail quantity, defect category, severity and disposition.

Inspection results are linked to production and inventory source records.

## 3. Defect taxonomy
Configurable defect categories include:
- fabric defect
- shade/colour mismatch
- measurement/specification
- sewing defect
- finishing defect
- stain/damage
- missing trim
- packing error
- other

Categories can be assigned to source, operation and responsibility where evidence supports it.

## 4. Nonconformance
A failed inspection can create a Nonconformance record:
`Detected → Contained → Root Cause → Corrective Action → Verified → Closed`

Containment can quarantine affected inventory so it cannot be sold or issued accidentally.

## 5. Rework
Rework records capture affected quantity, operation, additional minutes, material consumption, labour/cost impact, reason and outcome.

Rework cost is separate from standard production cost and appears in variance reporting.

Do not rewrite the original CostSnapshot because of rework.

## 6. Scrap
Scrap records capture quantity, material/SKU, reason, stage, disposition and value at the appropriate valuation basis.

Dispositions may include destruction, recycling, salvage or other approved treatment.

Scrap creates explicit inventory/accounting effects; it is never hidden by simply reducing expected production quantity.

## 7. Material waste vs scrap
Actual cutting waste is measured through MaterialIssue and waste-rate calculations. Production scrap is a separate quality/production event. Avoid double counting the same physical loss.

## 8. Yield
Calculate:
`Yield = Good Quantity / Total Processed Quantity`

Track by style, operation, line, period and material where meaningful.

## 9. First-pass yield
`FPY = Quantity Passing First Inspection / Quantity Inspected`

Reworked units must not be treated as first-pass successes.

## 10. Cost of poor quality
Track:
- rework cost
- scrap value
- additional material
- additional minutes
- inspection cost where configured
- return handling
- customer-returned product cost

Report total and per unit.

## 11. Root cause
Root-cause records support controlled categories and free-text notes. Corrective actions have owner, due date, status and verification.

## 12. Supplier quality
Incoming material inspections link defects to supplier/material/lot. Supplier scorecards can incorporate defect rate, accepted quantity, rejection, price variance and delivery performance.

## 13. Production quality
Quality dashboards compare line/operation/style performance while considering product complexity and assigned work.

## 14. Customer returns
Return inspection connects customer-return defects back to SKU/style, production order and quality categories when traceability exists.

This creates a feedback loop from Brand returns to Factory quality without assuming every return is a Factory defect.

## 15. Quarantine
Quarantined stock is excluded from available-to-sell and production issue availability until released, reworked, returned to supplier or scrapped.

## 16. Approval controls
High-value scrap, write-offs, material disposal and exceptional rework require configured approval thresholds.

## 17. Quality alerts
Alert rules may trigger on:
- FPY below threshold
- scrap above threshold
- rework minutes above threshold
- style defect spike
- supplier defect spike
- repeated defect category
- customer return defect spike

## 18. Quality vs costing
Standard cost remains immutable. Actual quality costs are captured as variances. This preserves the distinction between planned economics and operational reality.

## 19. Dashboard
Quality dashboard:
- FPY
- yield
- defect rate
- scrap quantity/value
- rework quantity/minutes/cost
- top defects
- supplier quality
- line/operation quality
- customer return defects
- cost of poor quality

## 20. Acceptance criteria
Quality is complete when material and production inspections are traceable, failed stock can be quarantined, rework and scrap have explicit quantities/costs, quality feeds supplier and production analytics, customer returns can close the loop, and none of these events silently rewrite historical standard costs or inventory history.
