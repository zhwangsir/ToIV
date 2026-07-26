"use client";

import { memo } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import type { CanvasNodeData, MediaPayload } from "@/lib/canvas/types";

interface VideoNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** 视频节点 body —— 展示 payload.urls 中的视频,<video controls> 播放。 */
function VideoNodeBodyImpl({ data }: VideoNodeBodyProps) {
  const payload = data.payload as MediaPayload;
  const urls = payload.urls ?? [];
  const first = urls[0];
  const isRunning = data.status === "running";

  if (!first) {
    return (
      <div className="tn-media">
        <div className="tn-media-empty">
          <Icon name="video" size={28} strokeWidth={1.4} />
          <span>{isRunning ? "渲染中…" : "暂无视频"}</span>
        </div>
        {isRunning && <div className="tn-media-loading">渲染中…</div>}
      </div>
    );
  }

  return (
    <div className="tn-media">
      <video src={imageUrl(first)} controls playsInline preload="metadata" />
    </div>
  );
}

// 只比较渲染用到的关键字段:urls 首项、status
export const VideoNodeBody = memo(VideoNodeBodyImpl, (prev, next) => {
  if (prev.data.status !== next.data.status) return false;
  const pu = (prev.data.payload as MediaPayload).urls ?? [];
  const nu = (next.data.payload as MediaPayload).urls ?? [];
  return pu[0] === nu[0];
});
