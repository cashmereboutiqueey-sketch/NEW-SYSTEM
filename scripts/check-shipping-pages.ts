/**
 * Do the shipping screens render against real data, signed in as the owner?
 *
 * Read only: it mints a session and fetches pages, and writes nothing else.
 *
 *   npx tsx --conditions=react-server scripts/check-shipping-pages.ts [base-url]
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { sessionToken } from "./qa-session";

const BASE = process.argv[2] ?? "http://localhost:3100";

const owner = await db.user.findFirstOrThrow({ where: { role: "OWNER", isActive: true } });
const token = await sessionToken(owner);
const zones = await db.courierZone.count({ where: { isActive: true } });
const cmtOrders = await db.cMTOrder.count();

const PAGES: { path: string; wants: string[] }[] = [
  { path: "/shipping", wants: ["الشحن", zones > 0 ? "حدّث من تقرير MG" : "مناطق MG لسه ماتحمّلتش"] },
  { path: "/sales", wants: ["المحافظة", "العنوان بالتفصيل", zones > 0 ? "القاهرة" : "المحافظة"] },
  // The billing columns are on the orders table, which only exists once there are orders.
  { path: "/cmt/orders", wants: cmtOrders > 0 ? ["الفاتورة", "المستحق"] : ["لسه مفيش أوامر تصنيع"] },
  { path: "/hr", wants: ["بيتحاسب بالـ", "أجر القطعة"] },
];

let failures = 0;
for (const page of PAGES) {
  const res = await fetch(BASE + page.path, {
    headers: { cookie: `cashmere_session=${token}; cashmere_prefs=${encodeURIComponent(JSON.stringify({ locale: "ar", scope: "GROUP" }))}` },
    redirect: "manual",
  });
  const html = await res.text();
  const missing = page.wants.filter((w) => !html.includes(w));
  const ok = res.status === 200 && missing.length === 0;
  if (!ok) failures += 1;
  console.log(`${ok ? "✓" : "✗"} ${page.path}  HTTP ${res.status}${missing.length ? `  missing: ${missing.join(", ")}` : ""}`);
}

await db.$disconnect();
process.exit(failures > 0 ? 1 : 0);
