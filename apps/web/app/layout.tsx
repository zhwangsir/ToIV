import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import "./styles/glass.css";
import "./styles/cornernav.css";
/* V2 CSS 按视图分割(2026-08-14):library/settings/animatic/avatartalk/landing/fusion/docs
   已迁移到各视图入口 tsx 随 lazy chunk 分割;studio.css/agent-runs.css 此前已分割。
   stage.css 保持全局:① 被 generate/audio/avatartalk 三视图消费;② 与 motion.css 存在
   加载顺序依赖(.stage-skeleton+.skeleton-shimmer 同元素混用,当前 stage 先于 motion,
   微光渐变依赖 motion 后置胜出;分割后 stage 必然晚于全局 motion,background 简写会
   重置渐变造成视觉回归),保守保留全局。 */
import "./styles/stage.css";
import "./styles/motion.css";
import "./styles/effects.css";
import { ToastProvider } from "@/components/ui/Toast";
import { ReleaseWatch } from "@/components/ReleaseWatch";

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

/* Display 展示位衬线(2026-08-14 UI-A):落地大标题/empty-display 专用,正文仍 Inter */
const fraunces = Fraunces({
  subsets: ["latin"],
  weight: ["600", "700"],
  variable: "--font-fraunces",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ToIV — AI 创作平台",
  description: "Film Atelier · AI 驱动的影视创作工作台",
};

export const viewport: Viewport = {
  // 浅色五色板主题系统(2026-08-07;默认「素白」,localStorage["toiv_theme"] 持久化)
  // themeColor 默认值为素白画布色 --bg-canvas;首帧后由内联脚本按当前主题计算值跟随更新
  themeColor: "#FAFAF9",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* 防 FOUC:首帧前从 localStorage 读主题写入 <html data-theme>,无效值忽略(回落 :root 素白);
   主题应用后把 <meta name="theme-color"> 同步为 --bg-canvas 计算值(内联脚本可能早于
   样式表解析,故在 DOMContentLoaded/load 再各补一次,确保取到真实计算值)。 */
const themeInitScript = `(function(){try{var t=localStorage.getItem("toiv_theme");if(t==="wood"||t==="mono"||t==="mint"||t==="apricot"){document.documentElement.dataset.theme=t;}var s=function(){var v=getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim();if(!v)return;var m=document.querySelector('meta[name="theme-color"]');if(!m){m=document.createElement("meta");m.name="theme-color";document.head.appendChild(m);}if(m.content!==v){m.content=v;}};s();document.addEventListener("DOMContentLoaded",s);window.addEventListener("load",s);}catch(e){}})();`;

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html
      lang="zh-CN"
      className={`${inter.variable} ${jetbrainsMono.variable} ${fraunces.variable}`}
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body>
        <a href="#main" className="skip-link">跳到主内容</a>
        <ToastProvider>
          {/* 发版软提示(三件套之一):轮询 /version.json 比对 BUILD_ID,不一致 toast 提醒 */}
          <ReleaseWatch />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
