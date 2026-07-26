"use client";

import { memo } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import type { CanvasNodeData, MediaPayload } from "@/lib/canvas/types";

interface ImageNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** 图像节点 body —— 展示 payload.urls 中的图片,空态提示。 */
function ImageNodeBodyImpl({ data }: ImageNodeBodyProps) {
  const payload = data.payload as MediaPayload;
  const urls = payload.urls ?? [];
  const first = urls[0];
  const isRunning = data.status === "running";

  if (!first) {
    return (
      <div className="tn-media">
        <div className="tn-media-empty">
          <Icon name="image" size={28} strokeWidth={1.4} />
          <span>{isRunning ? "生成中…" : "暂无图像"}</span>
        </div>
        {isRunning && <div className="tn-media-loading">采样中…</div>}
      </div>
    );
  }

  return (
    <div className="tn-media">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={imageUrl(first)} alt={data.title} loading="lazy" />
      {urls.length > 1 && (
        <div className="tn-media-loading">共 {urls.length} 张</div>
      )}
    </div>
  );
}

// 只比较渲染用到的关键字段:urls 首项 + 数量、status、title(img alt)
export const ImageNodeBody = memo(ImageNodeBodyImpl, (prev, next) => {
  if (prev.data.status !== next.data.status || prev.data.title !== next.data.title) {
    return false;
  }
  const pu = (prev.data.payload as MediaPayload).urls ?? [];
  const nu = (next.data.payload as MediaPayload).urls ?? [];
  return pu.length === nu.length && pu[0] === nu[0];
});
