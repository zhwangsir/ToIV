import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ToIV — AI 创作工作台",
  description: "由 ComfyUI 驱动的 AI 图像生成平台（P0）",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
