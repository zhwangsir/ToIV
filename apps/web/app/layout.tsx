import type { Metadata, Viewport } from "next";
import { Fraunces, Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./styles/glass.css";
import "./styles/island.css";
import "./styles/stage.css";
import "./styles/motion.css";
import "./styles/library.css";
import { ToastProvider } from "@/components/ui/Toast";

const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

const inter = Inter({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ToIV — AI 创作平台",
  description: "Film Atelier · AI 驱动的影视创作工作台",
};

export const viewport: Viewport = {
  // 曜石熔岩深色单主题(2026-08-06 v5;light/auto 主题死路径已移除)
  themeColor: "#0A0908",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      className={`${fraunces.variable} ${inter.variable} ${jetbrainsMono.variable}`}
    >
      <body>
        <a href="#main" className="skip-link">跳到主内容</a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
