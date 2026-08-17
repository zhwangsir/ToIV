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
  // 模式 × 色板主题系统(2026-08-16 v7;默认「素白」亮色,三 key localStorage 持久化)
  // themeColor 静态默认保持浅色画布色 --bg-canvas;首帧后由内联脚本按当前模式/色板计算值跟随更新
  themeColor: "#FAFAF9",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

/* 防 FOUC:首帧前从 localStorage 读三 key 写入 <html>——toiv_theme(白名单 4 板)、
   toiv_mode(仅 "dark" 有效,缺省/其他值回落亮色)、toiv_theme_custom(JSON 白名单校验:
   accent 须 #rrggbb、pureBlack 须布尔 true),自定义 accent 的 hover/soft/glow 派生逻辑
   内联一份精简实现(与 lib/theme.ts deriveAccentVars 同算法,改则同步),inline 写入
   documentElement.style(inline 优先级天然最高)。无效值全部忽略,回落 :root 素白亮色。
   主题应用后把 <meta name="theme-color"> 同步为 --bg-canvas 计算值(内联脚本可能早于
   样式表解析,故在 DOMContentLoaded/load 再各补一次,确保取到真实计算值;
   viewport.themeColor 静态默认保持浅色,此处按当前模式/色板修正)。 */
const themeInitScript = `(function(){try{var d=document.documentElement;var t=localStorage.getItem("toiv_theme");if(t==="wood"||t==="mono"||t==="mint"||t==="apricot"){d.dataset.theme=t;}var m=localStorage.getItem("toiv_mode");if(m==="dark"){d.dataset.mode="dark";}var raw=localStorage.getItem("toiv_theme_custom");if(raw){try{var o=JSON.parse(raw);if(o&&o.pureBlack===true){d.dataset.pureBlack="1";}if(o&&typeof o.accent==="string"&&/^#[0-9a-fA-F]{6}$/.test(o.accent)){var r=parseInt(o.accent.slice(1,3),16),g=parseInt(o.accent.slice(3,5),16),b=parseInt(o.accent.slice(5,7),16);var dark=m==="dark";var tg=dark?[255,255,255]:[0,0,0],hp=dark?0.12:0.10;var hv=[r+(tg[0]-r)*hp,g+(tg[1]-g)*hp,b+(tg[2]-b)*hp];var bg=dark?[16,17,20]:[250,250,249];var sf=[r*0.11+bg[0]*0.89,g*0.11+bg[1]*0.89,b*0.11+bg[2]*0.89];var hx=function(v){return "#"+v.map(function(x){return Math.round(x).toString(16).padStart(2,"0");}).join("");};var luma=(0.2126*r+0.7152*g+0.0722*b)/255;var st=d.style;st.setProperty("--accent",o.accent);st.setProperty("--accent-hover",hx(hv));st.setProperty("--accent-soft",hx(sf));st.setProperty("--accent-glow","rgba("+r+", "+g+", "+b+", 0.30)");st.setProperty("--text-on-accent",luma>0.5?"#17181A":"#FFFFFF");}}catch(e2){}}var s=function(){var v=getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim();if(!v)return;var mt=document.querySelector('meta[name="theme-color"]');if(!mt){mt=document.createElement("meta");mt.name="theme-color";document.head.appendChild(mt);}if(mt.content!==v){mt.content=v;}};s();document.addEventListener("DOMContentLoaded",s);window.addEventListener("load",s);}catch(e){}})();`;

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
