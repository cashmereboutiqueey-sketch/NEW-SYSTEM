/**
 * Do the new screens actually render, signed in as a real owner?
 *
 * A page that typechecks and builds has proved nothing: every failure worth
 * catching happens at request time, against real rows. This signs in the way
 * the audit does — minting the session rather than driving the login form,
 * because a Server Action cannot be posted to over plain HTTP — and then
 * reads the bytes on the wire for the figures that are supposed to be there.
 *
 * Expectations are derived from the same functions the pages call, never
 * hardcoded: the demo reseeds into a fresh cycle with different figures, and a
 * check that asserts last week's numbers fails for the one reason that does
 * not matter.
 *
 *   npx tsx --conditions=react-server scripts/check-pages.ts [baseUrl]
 */
import "dotenv/config";
import { SignJWT } from "jose";
import { db } from "../src/lib/db";
import { collectionPerformance } from "../src/lib/analytics";
import { brandPriceList } from "../src/lib/brand-pricing";
import { formatMoney, formatPercent } from "../src/lib/money";

const BASE = process.argv[2] ?? "http://localhost:3100";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER" } });
const token = await new SignJWT({
  userId: owner.id, email: owner.email, name: owner.name, role: owner.role,
})
  .setProtectedHeader({ alg: "HS256" })
  .setIssuedAt()
  .setExpirationTime("1h")
  .sign(new TextEncoder().encode(process.env.AUTH_SECRET!));

const brand = await db.entity.findFirstOrThrow({ where: { kind: "BRAND" } });
const factory = await db.entity.findFirstOrThrow({ where: { kind: "FACTORY" } });

// Whatever the current cycle happens to hold, asked of the same functions the
// pages ask.
const factorySide = await collectionPerformance(factory.id, "FACTORY");
const brandSide = await collectionPerformance(brand.id, "BRAND");
const typed = await brandPriceList(brand.id, { overrides: { monthlyUnits: 120 } });
const aPricedStyle = typed.styles.find((s) => s.trueCost && s.retailPrice);

/** Every page, with the words and figures that prove it did its work. */
const PAGES: { path: string; label: string; wants: string[] }[] = [
  {
    path: "/pricing",
    label: "brand pricing, on the books' own numbers",
    wants: ["تسعير البراند", "التكلفة الحقيقية"],
  },
  {
    path: "/pricing?units=120",
    label: "brand pricing, volume typed in",
    wants: [
      "تسعير البراند",
      ...(aPricedStyle?.trueCost ? [formatMoney(aPricedStyle.trueCost.toString())] : []),
      ...(typed.basis.costToSellPerUnit
        ? [formatMoney(typed.basis.costToSellPerUnit.toString())]
        : []),
    ],
  },
  {
    path: "/collections?entity=FACTORY",
    label: "collection performance as the factory",
    wants: [
      "أداء التشكيلة", "أحسن موديل",
      ...(factorySide[0] ? [formatMoney(factorySide[0].revenue.toString())] : []),
    ],
  },
  {
    path: "/collections?entity=BRAND",
    label: "collection performance as the brand",
    wants: [
      "أداء التشكيلة", "أحسن موديل",
      ...(brandSide[0] ? [formatMoney(brandSide[0].revenue.toString())] : []),
    ],
  },
  {
    path: "/suppliers/statements",
    label: "supplier statements",
    wants: ["كشف حساب الموردين", "فات ميعاده"],
  },
  {
    path: "/costing",
    label: "factory costing, markup shown beside margin",
    wants: ["سعر التحويل"],
  },
];

let failures = 0;

for (const page of PAGES) {
  const res = await fetch(`${BASE}${page.path}`, {
    redirect: "manual",
    headers: { Cookie: `cashmere_session=${token}` },
  });
  const body = res.status === 200 ? await res.text() : "";

  if (res.status !== 200) {
    failures += 1;
    console.log(`   ✗ ${page.path} → ${res.status} ${res.headers.get("location") ?? ""}`);
    continue;
  }

  const missing = page.wants.filter((w) => !body.includes(w));
  if (missing.length) {
    failures += 1;
    console.log(`   ✗ ${page.path} rendered but is missing: ${missing.join(", ")}`);
  } else {
    console.log(`   ✓ ${page.label}`);
  }
}

// The one that matters most on the pricing screen: the flattering number and
// the honest one have to be different, and both have to be visible. A page
// showing only the margin over the transfer price is the page this replaced.
if (aPricedStyle?.grossMargin && aPricedStyle.actualMargin) {
  const priced = await fetch(`${BASE}/pricing?units=120`, {
    redirect: "manual",
    headers: { Cookie: `cashmere_session=${token}` },
  }).then((r) => r.text());

  const flattering = formatPercent(aPricedStyle.grossMargin.toString());
  const honest = formatPercent(aPricedStyle.actualMargin.toString());

  if (flattering === honest) {
    failures += 1;
    console.log(`   ✗ the two margins came out identical (${flattering}) — nothing is being shown`);
  } else if (priced.includes(flattering) && priced.includes(honest)) {
    console.log(
      `   ✓ ${aPricedStyle.code}: ${flattering} against the transfer price, ${honest} after the shop`,
    );
  } else {
    failures += 1;
    console.log(
      `   ✗ both margins are not on the page (${flattering}: ${priced.includes(flattering)}, ` +
        `${honest}: ${priced.includes(honest)})`,
    );
  }
} else {
  console.log("   — no style is both costed and priced, so the two margins cannot be compared");
}

console.log(failures === 0 ? "\nall pages render" : `\n${failures} problem(s)`);
await db.$disconnect();
process.exit(failures === 0 ? 0 : 1);
