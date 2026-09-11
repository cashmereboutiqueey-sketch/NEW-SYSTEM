/**
 * What counts as a Shopify shop's address.
 *
 * The access token travels in a header on every request to this address, so
 * the address decides who receives the token. Checking that the text merely
 * ends in `.myshopify.com` is not enough: `evil.example/#.myshopify.com` ends
 * that way too, and a URL parser reads everything before the `#` as the host.
 * The request, token included, would go to evil.example.
 *
 * So the rule is the whole shape rather than a suffix: one label of letters,
 * digits and hyphens, then `.myshopify.com`, and nothing else. No slash, `#`,
 * `?`, `@`, colon, port, backslash, percent-encoding or second label can get
 * through, and those are the characters that change which host a URL names.
 */

const SHOP_DOMAIN = /^[a-z0-9][a-z0-9-]{0,62}\.myshopify\.com$/;

/** Shopify's dated API releases: 2024-10, 2025-01 and so on. */
const API_VERSION = /^\d{4}-\d{2}$/;

/** True only for a canonical shop domain, exactly as it should be stored. */
export function isShopDomain(value: string): boolean {
  return SHOP_DOMAIN.test(value);
}

/**
 * The shop domain from what somebody typed, or null when it is not one.
 *
 * Forgives what people paste: surrounding spaces, capitals, a leading
 * `https://` and a trailing slash, since that is how the address appears in a
 * browser bar. Everything else must already be exact.
 */
export function normaliseShopDomain(raw: string): string | null {
  const domain = raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  return isShopDomain(domain) ? domain : null;
}

/** The version goes into the request path, so it is held to a shape as well. */
export function isApiVersion(value: string): boolean {
  return API_VERSION.test(value);
}
