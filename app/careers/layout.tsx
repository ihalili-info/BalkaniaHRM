import type { Metadata } from "next";

// Public page: no sign-in, and not part of the installable employee app, so
// it drops the root PWA manifest instead of offering "install Balkania".
export const metadata: Metadata = {
  title: "Careers at Balkania",
  description: "Open positions at Balkania. See what we're hiring for and apply online.",
  manifest: null,
  robots: { index: true, follow: true },
};

export default function CareersLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return children;
}
