import type { Metadata } from "next";

import "./globals.css";

export const metadata: Metadata = {
  title: "ToIV 管理系统",
  description: "ToIV 平台独立管理系统(内部)",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
