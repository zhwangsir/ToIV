"use client";

// 全局错误边界(Next.js App Router 约定 + @sentry/nextjs v9 推荐)。
// 捕获根布局层渲染错误并上报 Sentry;无 Sentry DSN 时 captureException 为 no-op。
// ⚠️ global-error 替换根布局渲染,globals.css 不加载,CSS 变量不可用——
//    色值按 globals.css token 表内联镜像(2026-08-14 UI-A 对齐,禁旧紫 #5b5bd6):
//    亮色:--bg-canvas #FAFAF9 / --text-primary #17181A / --text-muted #64666C /
//    --accent #17181A / --text-on-accent #FFFFFF;暗色(v7):--bg-canvas #101114 /
//    --text-primary #F4F4F3 / --text-muted #9A9EA6 / --accent #F5F5F4 /
//    --text-on-accent #17181A;--radius-control 8px;弱暗角与全站 vignette 同源。
//    模式经 localStorage["toiv_mode"] 挂载后判定(SSR 恒亮色,与防 FOUC 脚本同默认)。
import * as Sentry from "@sentry/nextjs";
import { useEffect, useState } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [dark, setDark] = useState(false);

  useEffect(() => {
    Sentry.captureException(error);
    try {
      setDark(window.localStorage.getItem("toiv_mode") === "dark");
    } catch {
      /* localStorage 不可用时保持亮色兜底 */
    }
  }, [error]);

  const canvas = dark ? "#101114" : "#FAFAF9";
  const text = dark ? "#F4F4F3" : "#17181A";
  const muted = dark ? "#9A9EA6" : "#64666C";
  const accent = dark ? "#F5F5F4" : "#17181A";
  const onAccent = dark ? "#17181A" : "#FFFFFF";
  const vignette = dark ? "rgba(0, 0, 0, 0.22)" : "rgba(23, 20, 18, 0.04)";

  return (
    <html lang="zh-CN">
      <body
        style={{
          margin: 0,
          minHeight: "100vh",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 16,
          fontFamily:
            '"Inter", "PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
          background: `radial-gradient(ellipse 120% 105% at 50% 46%, transparent 62%, ${vignette} 100%), ${canvas}`,
          color: text,
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.015em" }}>
          页面出错了
        </h1>
        <p style={{ fontSize: 14, color: muted, margin: 0 }}>
          应用发生未预期的错误,请尝试重新加载。
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "10px 24px",
            borderRadius: 8,
            border: "none",
            background: accent,
            color: onAccent,
            fontSize: 14,
            fontWeight: 500,
            cursor: "pointer",
          }}
        >
          重新加载
        </button>
      </body>
    </html>
  );
}
