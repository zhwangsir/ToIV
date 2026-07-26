"use client";

import { memo } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import type { CanvasNodeData, MediaPayload } from "@/lib/canvas/types";

interface AudioNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** 音频节点 body —— 展示 payload.urls 中的音频,<audio controls> 播放。 */
function AudioNodeBodyImpl({ data }: AudioNodeBodyProps) {
  const payload = data.payload as MediaPayload;
  const urls = payload.urls ?? [];
  const first = urls[0];
  const isRunning = data.status === "running";

  if (!first) {
    return (
      <div className="tn-media" style={{ minHeight: 56 }}>
        <div className="tn-media-empty">
          <Icon name="audio" size={22} strokeWidth={1.4} />
          <span>{isRunning ? "合成中…" : "暂无音频"}</span>
        </div>
        {isRunning && <div className="tn-media-loading">合成中…</div>}
      </div>
    );
  }

  return (
    <div className="tn-media" style={{ minHeight: 40, padding: "0.3rem" }}>
      <audio src={imageUrl(first)} controls preload="metadata" style={{ width: "100%" }} />
    </div>
  );
}

// 只比较渲染用到的关键字段:urls 首项、status
export const AudioNodeBody = memo(AudioNodeBodyImpl, (prev, next) => {
  if (prev.data.status !== next.data.status) return false;
  const pu = (prev.data.payload as MediaPayload).urls ?? [];
  const nu = (next.data.payload as MediaPayload).urls ?? [];
  return pu[0] === nu[0];
});
