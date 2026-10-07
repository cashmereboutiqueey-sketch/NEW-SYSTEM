# Flextock shipping transition

Decision on 2026-10-07: Flextock will handle delivery only. Cashmere keeps inventory, picking, packing, and its own order and accounting records. Do not enable Flextock inventory or fulfillment ownership without a separate decision.

## Verified public information

- Flextock offers delivery aggregation, returns handling, and cash collection: https://www.flextock.com/solutions-2/delivery-aggregation
- Flextock's Shopify app advertises order, fulfillment, inventory, SKU, return, and tracking sync. It asks for access to products, inventory, orders, fulfillments, and locations: https://apps.shopify.com/flextock
- Flextock mentions API and manual upload as integration options on its site, but no current, public API contract for Egypt delivery-only shipments was found: https://www.flextock.com/ar-eg/solutions-2/cross-boarder-trade

Flextock subsequently supplied **External APIs Integration, revision 1.5 (2026-08-25)**. It defines authentication, product identity creation, outbound order creation, order status lookup, cancellation, and AWB PDF retrieval. The older public-source gap above is historical.

## Delivery-only API prepared in code

- `src/lib/flextock-api.ts` calls the documented `https://api.flextock.com` endpoints with username, password, and API key; bearer tokens remain server-side. It never calls inventory sync, product listing, returns, or exchange APIs.
- `src/lib/flextock-payload.ts` builds EGP outbound orders with `requires_self_delivery: false`. It sends SKU identity and price so Flextock can accept line items, without publishing Cashmere stock. Collected payments are `prepaid`; the unpaid COD amount is `cash_on_delivery`. A mismatch between the sale total and its payments blocks submission.
- `src/lib/flextock-shipping.ts` loads the current sale from Cashmere, sends required SKUs, creates the remote order, then records a local shipment only after acceptance. It uses the internal order number as Flextock's unique merchant `order_code`. If create times out or returns a duplicate/validation error, it checks that same code at Flextock before treating it as accepted. It does not generate a new code for retries.
- The shipping desk switches from confirmed manual handoff to direct submission only when `FLEXTOCK_API_ENABLED=true`. It sends up to 10 orders per action and can manually refresh up to 20 API-submitted shipments. Manual handoffs are never polled. Tracking number and URL are stored when the status endpoint returns them.
- A delivery status with COD remains **needs review** until cash collection is confirmed separately. Returns and partial deliveries also require review; the API status does not move stock or post remittances.

## What is still needed to enable it

1. Flextock must confirm the merchant account is configured for **delivery only** and grants `CreateOrderAPI.POST` plus product creation and order-status permissions. Obtain username, password, and API key through a secret channel. Set `FLEXTOCK_USERNAME`, `FLEXTOCK_PASSWORD`, and `FLEXTOCK_API_KEY` in the production `.env` on the server, not in Git; Docker Compose passes them only to the app container.
2. Obtain Flextock's exact supported Egyptian `city` and `area` strings, plus contracted rates. Enter only confirmed zones and prices in the shipping desk. Existing Cashmere governorate names may differ from Flextock's accepted names; validate them with a non-live order before activation.
3. Test one part-paid and one fully prepaid order with Flextock. Confirm that `payment_data`, EGP, SKU catalog creation, and `requires_self_delivery: false` work for the delivery-only account. Then set `FLEXTOCK_API_ENABLED=true` and restart the app.
4. The AWB endpoint requires **Flextock's own order code**, while create-order only documents `{"message":"Order created successfully."}` and order-status does not document that code. The connector can request AWB once Flextock supplies how to get/store its code; the shipping desk does not offer a label button yet.
5. The document does not describe webhooks, collection/fees/remittance data, or a sandbox. Status refresh is manual and does not infer cash received. Agree a separate reconciliation feed or report with Flextock before automating finance.

## Cashmere order flow

- `src/lib/shipping.ts` prepares Flextock delivery areas and records manual handoffs only after a user confirms acceptance. API handoffs use the same local record after Flextock accepts an order.
- The documented order-status endpoint can be polled for API-submitted orders. It carries delivery/tracking state, but no confirmed collected cash or remittance fields.
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
