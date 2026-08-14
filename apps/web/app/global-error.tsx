"use client";

// 全局错误边界(Next.js App Router 约定 + @sentry/nextjs v9 推荐)。
// 捕获根布局层渲染错误并上报 Sentry;无 Sentry DSN 时 captureException 为 no-op。
// ⚠️ global-error 替换根布局渲染,globals.css 不加载,CSS 变量不可用——
//    色值按 globals.css token 表内联镜像(2026-08-14 UI-A 对齐,禁旧紫 #5b5bd6):
//    --bg-canvas #FAFAF9 / --text-primary #17181A / --text-muted #686A70 /
//    --accent #17181A / --accent-hover #2C2E33 / --text-on-accent #FFFFFF /
//    --radius-control 8px;弱暗角与全站 vignette 同源(峰值 4%,不显脏)。
import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

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
          background:
            "radial-gradient(ellipse 120% 105% at 50% 46%, transparent 62%, rgba(23, 20, 18, 0.04) 100%), #FAFAF9",
          color: "#17181A",
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, margin: 0, letterSpacing: "-0.015em" }}>
          页面出错了
        </h1>
        <p style={{ fontSize: 14, color: "#686A70", margin: 0 }}>
          应用发生未预期的错误,请尝试重新加载。
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "10px 24px",
            borderRadius: 8,
            border: "none",
            background: "#17181A",
            color: "#FFFFFF",
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
