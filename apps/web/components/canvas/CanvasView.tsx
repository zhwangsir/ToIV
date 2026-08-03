"use client";

import { useMemo } from "react";

const COMFYUI_WEB_URL = process.env.NEXT_PUBLIC_COMFYUI_WEB_URL || "http://192.168.71.127:8188";

export function CanvasView() {
  const src = useMemo(() => {
    if (typeof window === "undefined") return COMFYUI_WEB_URL;
    return window.localStorage.getItem("toiv_comfyui_web_url") || COMFYUI_WEB_URL;
  }, []);

  return (
    <div className="canvas-view">
      <iframe
        src={src}
        title="ComfyUI"
        className="canvas-iframe"
        allow="clipboard-read; clipboard-write"
        sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads"
      />
      <style jsx>{`
        .canvas-view {
          width: 100%;
          height: 100%;
          overflow: hidden;
          background: var(--bg-canvas);
        }
        .canvas-iframe {
          width: 100%;
          height: 100%;
          border: none;
          display: block;
        }
      `}</style>
    </div>
  );
}
