import type { Metadata, Viewport } from "next";
import { getPrefs } from "@/lib/session";
import { isRtl } from "@/lib/i18n";
import "./globals.css";

export const metadata: Metadata = {
  title: "Cashmere OS — كاشمير أو إس",
  description: "نظام تشغيل المصنع والبراند — Factory & Brand Operating System",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const { locale } = await getPrefs();
  const dir = isRtl(locale) ? "rtl" : "ltr";

  return (
    <html lang={locale} dir={dir}>
      <body className="min-h-screen antialiased">{children}</body>
    </html>
  );
}
