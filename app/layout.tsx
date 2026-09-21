import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "CineRadar — Opportunities for AI filmmakers",
    template: "%s · CineRadar",
  },
  description:
    "A verified, continuously updated radar for film festivals, AI video contests, grants, residencies and creative calls.",
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
