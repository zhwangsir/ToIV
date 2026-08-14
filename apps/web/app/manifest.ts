import type { MetadataRoute } from "next";

/**
 * PWA 清单(Next 文件约定自动接线,无需在 metadata 手写)。
 * background/theme 取默认主题「素白」画布色 --bg-canvas = #FAFAF9;
 * 运行期 <meta name="theme-color"> 由 layout 内联脚本与 lib/theme.ts 按当前主题跟随。
 * 注意:apple-touch-icon 需 PNG(iOS Safari 不认 SVG),apple-icon.png 待设计交付后再补;
 * Android/桌面 Chrome 可正常消费下方 SVG 图标完成安装。
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ToIV",
    short_name: "ToIV",
    description: "Film Atelier · AI 驱动的影视创作工作台",
    start_url: "/",
    display: "standalone",
    background_color: "#FAFAF9",
    theme_color: "#FAFAF9",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "maskable",
      },
    ],
  };
}
