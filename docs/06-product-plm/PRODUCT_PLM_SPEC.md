# Cashmere OS — Product / PLM Specification

**Status:** Draft for implementation
**Scope:** Collections, styles, variants, SKUs, colors, sizes, materials, BOMs, operations, SMV, product lifecycle, costing dependencies, commercial data.

## 1. Purpose

The Product/PLM domain is the single source of truth for what a product is and how it is manufactured and sold.

It connects:

`Collection → Style → Variant → SKU → BOM → Materials → Operations → SMV → Cost → Production → Inventory → Sales`

No downstream module should create a second independent definition of a product.

## 2. Collection

A Collection is a commercial grouping of styles.

Examples:

- Ramadan collection
- Eid collection
- Summer collection
- Winter collection
- Core collection

A collection may contain many styles.
A style may belong to a primary collection and may optionally be associated with additional campaigns/collections according to configuration.

Collection fields:

- name AR
- name EN
- code
- season
- year
- launch date
- end date
- status
- description
- campaign metadata

Collection status:

`Draft → Development → Ready → Launched → Archived`

## 3. Style

A Style is the base product design.

Examples might be a kaftan, abaya, shirt, set, etc.

Style fields include:

- style code
- name AR/EN
- collection
- category
- subcategory
- description
- gender/target segment where applicable
- lifecycle status
- default retail price
- default discount policy
- default return-rate source
- planned waste rate
- trailing actual waste rate
- factory margin override where applicable
- marketing allocation override where applicable
- product images/media references
- notes

A Style is not itself a sellable stock unit.

## 4. Variant

A Variant is the combination of:

`Colour × Size`

Every sellable variant has a unique SKU.

Variant fields:

- style
- colour
- size
- SKU
- barcode
- active status
- retail price override where permitted
- cost multiplier references
- Shopify external ID where integrated
- POS item reference where integrated

## 5. SKU rule

Canonical format:

`[STYLENAME]-[COLORCODE]-[SIZE]`

Rules:

- uppercase
- deterministic
- no spaces unless explicitly encoded by the canonicalization rule
- colour uses one of the configured official colour codes
- size uses the configured size code

The generator must be deterministic and tested.

A SKU is never manually duplicated.

## 6. Colours

Colours are master data, not free-text variant labels.

Each colour has:

- official code
- AR name
- EN name
- display name
- hex/reference value for UI where available
- active status
- sort order

The system must enforce the configured official colour-code set.

Material colour and finished-product colour are separate concepts but may be linked where needed for production.

## 7. Sizes

Sizes are master data.

A size contains:

- code
- AR name
- EN name
- sequence
- active status
- measurement profile where applicable

The system must support size-specific BOM consumption multipliers.

Default multiplier: `1.0`.

Example:

`L = 1.05` means the BOM consumption for L is 5% higher than the base line quantity.

## 8. Product categories

Category hierarchy must be configurable:

`Department → Category → Subcategory`

Examples:

- Women → Abayas → Formal
- Women → Kaftans → Occasion
- Men → Shirts → Linen

Categories support reporting, POS filtering, Shopify taxonomy mapping, and marketing segmentation.

## 9. Material master

Materials are shared manufacturing master data.

Material types include:

- fabric
- trim
- accessory
- packaging material where configured

Each material stores:

- code
- AR/EN name
- type
- unit of measure
- purchase unit
- conversion factor
- MOQ
- pack size
- active status
- supplier relationships
- quality attributes
- lot tracking rules

A material may be used in many styles.
A style may consume many materials.

## 10. BOM structure

BOM is a many-to-many relationship between Style and Material through BOM lines.

A BOM line includes:

- style
- BOM version
- material
- base quantity
- unit
- planned waste rate
- size multiplier
- optional variant/color applicability
- effective from/to
- active status

The same style may have multiple BOM versions over time.

Historical production orders always retain the BOM version used at confirmation.

## 11. Multiple fabrics and shared fabrics

The data model must explicitly support:

### One product → multiple fabrics

Example:

- body fabric
- sleeve fabric
- lining
- contrast panel

### One fabric → multiple products

Example:

`Jersey 168` can be used by Style A, B, C, and D.

Consumption, waste, and cost remain line-specific.

Never store a single `style.material_id` as the manufacturing model.

## 12. Operations and SMV

Operations are master data where reusable, with style-specific overrides where required.

Each StyleOperation contains:

- sequence
- operation
- SMV minutes
- work center/line
- machine requirement
- skill requirement
- quality checkpoint
- active status

Formula:

`style_smv = Σ StyleOperation.smv_minutes`

SMV must be drillable down to individual operations.

## 13. Product development lifecycle

Recommended lifecycle:

`Idea → Development → Sample → Costed → Approved → Production Ready → Active → Discontinued → Archived`

Transitions may require approvals.

A product cannot become Production Ready without the required manufacturing data.

Minimum production-readiness checks:

- active BOM version
- all required material definitions
- valid units
- SMV defined
- operations defined
- size/color matrix defined
- costing inputs available
- quality requirements where applicable

## 14. Sample development

Samples are separate from commercial inventory unless explicitly received into inventory.

Sample records can include:

- sample number
- style
- version
- material usage
- operation notes
- fit comments
- measurement notes
- approval status
- photos
- revision history

Approved sample revisions must map to the production-ready style version.

## 15. Product revisions

Product master data is version-aware.

A revision may change:

- BOM
- material
- consumption
- waste plan
- operation
- SMV
- size matrix
- measurements
- packaging requirements

A revision does not rewrite historical production costs.

## 16. Costing relationship

The Product domain supplies the Cost Engine with:

- BOM version
- material quantities
- planned waste
- size multipliers
- operation list
- SMV
- product-level margin settings

The Cost Engine returns the calculated cost; Product does not duplicate or independently calculate the authoritative factory cost.

## 17. Commercial pricing relationship

Product stores commercial price inputs/configuration but the Brand Pricing Calculator is authoritative for derived economics.

Retail pricing can have:

- base price
- variant override
- channel override
- effective dates
- discount rules
- campaign price

Historical sales must retain the price actually used on the order line.

## 18. Shopify mapping

A Variant can map to an external Shopify variant/product.

Mapping fields:

- internal variant ID
- Shopify product ID
- Shopify variant ID
- SKU
- sync status
- last synced timestamp
- sync error

External IDs must not replace internal IDs.

## 19. POS mapping

A Variant can be sold through Brand POS using the same SKU.

POS must not maintain a separate product master.

Barcode scanning resolves to the internal Variant.

## 20. Media

Product media can be associated with:

- collection
- style
- variant
- campaign

Media metadata should support:

- type
- URL/storage reference
- alt text AR/EN
- sort order
- primary flag
- usage context

## 21. Product profitability dimensions

Every style/variant should support reporting by:

- collection
- category
- color
- size
- sales channel
- location
- production run
- campaign

This is essential for identifying profitable products versus products that consume cash through inventory.

## 22. Dead-stock linkage

A discontinued style does not automatically write off stock.

The inventory engine determines remaining stock and aging.

Product lifecycle can trigger a commercial alert:

`Discontinued + inventory remaining → clearance/dead-stock candidate`

## 23. Required product reports

1. Product master list
2. Collection performance
3. Style profitability
4. Variant profitability
5. BOM cost composition
6. Material usage by style
7. Material dependency map
8. SMV by style
9. Operation time analysis
10. Product lifecycle status
11. Product revision history
12. SKU/Barcode registry
13. Shopify mapping status
14. POS catalog
15. Production-ready exceptions
16. Discontinued stock exposure
17. Product contribution margin
18. Product inventory capital locked

## 24. Controls

The system must block:

- duplicate SKU
- invalid colour code
- duplicate variant combination
- production-ready style without BOM
- production-ready style without SMV
- production order against an inactive/discontinued definition without authorization
- historical BOM edits that would alter an existing CostSnapshot

## 25. Acceptance criteria

The PLM/product domain is correct when:

- every SKU resolves to exactly one Style + Colour + Size
- every Style can have multiple materials
- every Material can be used by multiple Styles
- SMV is operation-level and reconstructible
- BOM revisions do not rewrite history
- POS and Shopify use the same internal product identity
- production and costing consume the approved product version
- collections are commercially reportable without becoming manufacturing entities
- product lifecycle changes are auditable
