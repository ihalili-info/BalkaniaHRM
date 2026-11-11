import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ServiceWorker } from "../components/service-worker";
import "./globals.css";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter", display: "swap" });

export const metadata: Metadata = {
  title: "Balkania Check-in",
  description: "Balkania employee attendance and leave portal",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icon.png", apple: "/icon.png" },
  appleWebApp: { capable: true, statusBarStyle: "default", title: "Balkania" },
};

export const viewport: Viewport = { themeColor: "#1c2260" };

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-IE" className={inter.variable}><body><ServiceWorker />{children}</body></html>;
}
