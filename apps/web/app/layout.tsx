import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import "./styles/glass.css";
import "./styles/island.css";
import "./styles/stage.css";
import "./styles/motion.css";
import "./styles/library.css";
import { ToastProvider } from "@/components/ui/Toast";

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
  // 浅色五色板主题系统(2026-08-07;默认「素白」,localStorage["toiv_theme"] 持久化)
  themeColor: "#FFFFFF",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* 防 FOUC:首帧前从 localStorage 读主题写入 <html data-theme>,无效值忽略(回落 :root 素白) */
const themeInitScript = `(function(){try{var t=localStorage.getItem("toiv_theme");if(t==="wood"||t==="mono"||t==="mint"||t==="apricot"){document.documentElement.dataset.theme=t;}}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      className={`${inter.variable} ${jetbrainsMono.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a href="#main" className="skip-link">跳到主内容</a>
        <ToastProvider>{children}</ToastProvider>
      </body>
    </html>
  );
}
