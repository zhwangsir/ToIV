"use client";

/**
 * ToivArcReelRootMount — 根路径产品主壳。
 * 全屏 iframe → /arcreel/（独立 Vite bundle，AGPL ArcReel FE）。
 * 禁 import freezone-web / vendor/canvas；本波无 BE。
 */
export default function ToivArcReelRootMount() {
  return (
    <main
      style={{
        margin: 0,
        padding: 0,
        width: "100vw",
        height: "100vh",
        overflow: "hidden",
        background: "#0b0b0f",
      }}
      aria-label="ArcReel 产品主壳"
    >
      <iframe
        title="ArcReel"
        src="/arcreel/"
        style={{ border: 0, width: "100%", height: "100%", display: "block" }}
        allow="clipboard-read; clipboard-write; fullscreen"
      />
    </main>
  );
}
