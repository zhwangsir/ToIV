import type { Metadata } from "next";
import "./globals.css";
import { CursorGlow } from "@/components/ui/CursorGlow";

export const metadata: Metadata = {
  title: "ToIV — 极光 AI 创作平台",
  description: "由 ComfyUI 驱动的 AI 图像 / 视频 / 3D / 音频生成平台",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght@0,9..144,400;0,9..144,500;0,9..144,600;1,9..144,400;1,9..144,500&family=Inter:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        <CursorGlow />
        {children}
      </body>
    </html>
  );
}
