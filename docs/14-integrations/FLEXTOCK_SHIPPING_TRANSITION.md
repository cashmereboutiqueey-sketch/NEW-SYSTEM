# Flextock shipping transition

Decision on 2026-10-07: Flextock will handle delivery only. Cashmere keeps inventory, picking, packing, and its own order and accounting records. Do not enable Flextock inventory or fulfillment ownership without a separate decision.

## Verified public information

- Flextock offers delivery aggregation, returns handling, and cash collection: https://www.flextock.com/solutions-2/delivery-aggregation
- Flextock's Shopify app advertises order, fulfillment, inventory, SKU, return, and tracking sync. It asks for access to products, inventory, orders, fulfillments, and locations: https://apps.shopify.com/flextock
- Flextock mentions API and manual upload as integration options on its site, but no current, public API contract for Egypt delivery-only shipments was found: https://www.flextock.com/ar-eg/solutions-2/cross-boarder-trade

These pages do not define API endpoints, authentication, request/response formats, or whether the Shopify app can be configured for delivery only. Obtain those details from Flextock before coding a live connector.

## Cashmere order flow

- `src/lib/shipping.ts` prepares Flextock delivery areas and records a handoff only after a user confirms Flextock accepted the orders. This manual record does not send them to Flextock.
- A confirmed status can update the shipment, delivery date, and COD figures through one provider-neutral data shape. No status feed has been connected yet.
- `src/lib/shopify.ts` imports Shopify orders, publishes stock, and publishes Shopify fulfillments for shipped orders. A Flextock Shopify connection could overlap with these writes and create duplicate shipments or conflicting inventory/fulfillment state.
- Orders also come from the moderator and manual sales flows, so a Shopify-only connection cannot cover all deliveries.

## Request from Flextock

1. Delivery-only API documentation or the current manual import template, including sandbox access and authentication method. Share credentials through a secret channel, not in this document.
2. Create, cancel, and look up shipment operations; external reference/idempotency rules; tracking number and label/manifest response; pickup and handoff rules.
3. Egypt governorate/area identifiers, coverage, rates, weight/size rules, and whether COD includes customer-paid shipping.
4. Status vocabulary, webhook or polling contract, webhook verification, retry behavior, returns and exchanges, and how collected cash, fees, and remittances are reported.
5. Whether their Shopify app can be restricted to delivery and tracking, with inventory sync and order fulfillment creation disabled. Confirm which system should publish the Shopify fulfillment and tracking number.

## Implementation boundary

Build against the supplied contract and test with non-live shipments first. Record Flextock's shipment ID alongside the internal order number. Mark an order shipped only after Flextock accepts it; make retries idempotent. Reconcile COD and returns from Flextock's confirmed events without treating a status label alone as proof of cash receipt or stock return. Verify both Shopify and non-Shopify orders end to end before enabling automatic submission.
