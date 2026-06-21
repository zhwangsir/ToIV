"use client";

import { createElement, useEffect } from "react";

/**
 * GLB 3D 查看器(Google model-viewer Web Component,CDN 注入)。
 * 可旋转/缩放查看,供 3D 模块与 AI 助手对话内复用。
 */
export function ModelViewer({ src }: { src: string }) {
  useEffect(() => {
    if (document.querySelector("script[data-model-viewer]")) return;
    const s = document.createElement("script");
    s.type = "module";
    s.src = "https://cdn.jsdelivr.net/npm/@google/model-viewer@4.0.0/dist/model-viewer.min.js";
    s.setAttribute("data-model-viewer", "");
    document.head.appendChild(s);
  }, []);

  return createElement("model-viewer", {
    src,
    "camera-controls": true,
    "auto-rotate": true,
    "shadow-intensity": "1",
    exposure: "1.1",
    style: {
      width: "100%",
      height: "100%",
      background: "transparent",
      "--poster-color": "transparent",
    },
  });
}
