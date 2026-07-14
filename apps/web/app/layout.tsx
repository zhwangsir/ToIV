import type { Metadata, Viewport } from "next";
import { Fraunces, Geist, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { ToastProvider } from "@/components/ui/Toast";

/* ── 品牌字体(next/font 自托管,零 FOUC,自动优化)──
 *   Fraunces:可变衬线,有光学尺寸轴,大字号锐利小字号柔和 → display/serif
 *   Geist:Vercel 几何无衬线,比 Inter 更有性格 → body/sans
 *   JetBrains Mono:等宽 → 代码/技术标签/数值 */
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
  style: ["normal", "italic"],
  variable: "--font-fraunces",
  display: "swap",
});

const geist = Geist({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-geist",
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
  description: "由 ComfyUI 驱动的 AI 图像 / 视频 / 3D / 音频生成平台",
};

// 移动端浏览器地址栏着色,匹配靛蓝深底
export const viewport: Viewport = {
  themeColor: "#0a0a0c",
};

// 首屏前同步读取已存主题,避免闪烁(FOUC)。默认暗色靛蓝。
const themeInitScript = `(function(){try{var t=localStorage.getItem('toiv_theme');if(t==='light'){document.documentElement.dataset.theme='light';return;}document.documentElement.dataset.theme='dark';}catch(e){document.documentElement.dataset.theme='dark';}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      suppressHydrationWarning
      data-theme="dark"
      className={`${fraunces.variable} ${geist.variable} ${jetbrainsMono.variable}`}
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
