import type { Metadata, Viewport } from "next";
import { Inter, JetBrains_Mono, Fraunces } from "next/font/google";
import "./globals.css";
import "./styles/glass.css";
import "./styles/nav-account.css";
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
import { GlobalProgress } from "@/components/ui/GlobalProgress";

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
  // 预设主题 × 明暗 × 自定义强调色(2026-09-07 v9;默认 minimal 亮色,四 key localStorage 持久化)
  // themeColor 静态默认保持浅色画布色 --bg-canvas;首帧后由内联脚本按当前主题/模式计算值跟随更新
  themeColor: "#FAFAF9",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* 防 FOUC(主题系统 v9,2026-09-07):首帧前从 localStorage 读四 key 写 <html>——
   toiv_theme(预设主题:minimal 缺省不写属性;非法值含 v7 旧色板名读取时清除)、
   toiv_mode(仅 "dark" 有效,缺省/其他值回落亮色)、toiv_theme_custom(仅 pureBlack
   子档;旧 accent 字段迁移到 toiv_accent_custom 后剥离)、toiv_accent_custom(hex6
   自定义强调色:写 dataset.accentCustom + 内联 --accent-user/--accent-user-on,
   派生由 globals.css [data-accent-custom] 块 color-mix 完成)。
   主题应用后把 <meta name="theme-color"> 同步为 --bg-canvas 计算值(内联脚本可能早于
   样式表解析,故在 DOMContentLoaded/load 再各补一次,确保取到真实计算值)。 */
const themeInitScript = `(function(){try{var d=document.documentElement;var t=localStorage.getItem("toiv_theme");if(t==="cinema"||t==="paper"||t==="graphite"){d.dataset.theme=t;}else if(t&&t!=="minimal"){localStorage.removeItem("toiv_theme");}var m=localStorage.getItem("toiv_mode");if(m==="dark"){d.dataset.mode="dark";}var raw=localStorage.getItem("toiv_theme_custom");if(raw){try{var o=JSON.parse(raw);if(o){if(typeof o.accent==="string"&&/^#[0-9a-fA-F]{6}$/.test(o.accent)&&!localStorage.getItem("toiv_accent_custom")){localStorage.setItem("toiv_accent_custom",o.accent);}if(o.pureBlack===true){d.dataset.pureBlack="1";localStorage.setItem("toiv_theme_custom",JSON.stringify({pureBlack:true}));}else{localStorage.removeItem("toiv_theme_custom");}}}catch(e2){}}var a=localStorage.getItem("toiv_accent_custom");if(a){if(/^#[0-9a-fA-F]{6}$/.test(a)){d.dataset.accentCustom="1";d.style.setProperty("--accent-user",a);var r=parseInt(a.substr(1,2),16),g=parseInt(a.substr(3,2),16),b=parseInt(a.substr(5,2),16);var l=(0.2126*r+0.7152*g+0.0722*b)/255;d.style.setProperty("--accent-user-on",l>0.55?"#17181A":"#FFFFFF");}else{localStorage.removeItem("toiv_accent_custom");}}var s=function(){var v=getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim();if(!v)return;var mt=document.querySelector('meta[name="theme-color"]');if(!mt){mt=document.createElement("meta");mt.name="theme-color";document.head.appendChild(mt);}if(mt.content!==v){mt.content=v;}};s();document.addEventListener("DOMContentLoaded",s);window.addEventListener("load",s);}catch(e){}})();`;

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
          {/* 全局生成进度条:顶部 3px 细条 + 任务胶囊,数据源 lib/generationBus */}
          <GlobalProgress />
          {children}
        </ToastProvider>
      </body>
    </html>
  );
}
