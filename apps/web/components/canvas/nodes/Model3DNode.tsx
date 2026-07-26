"use client";

import { memo } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import type { CanvasNodeData, MediaPayload } from "@/lib/canvas/types";

interface Model3DNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

// urls 过多时只渲染前 3 个,其余折叠为 "+N"(避免大节点卡顿)
const MAX_VISIBLE_URLS = 3;

/** 3D 模型节点 body —— 列出文件下载链接(.glb / .gltf / .obj 等)。 */
function Model3DNodeBodyImpl({ data }: Model3DNodeBodyProps) {
  const payload = data.payload as MediaPayload;
  const urls = payload.urls ?? [];
  const isRunning = data.status === "running";

  if (urls.length === 0) {
    return (
      <div className="tn-media">
        <div className="tn-media-empty">
          <Icon name="model3d" size={28} strokeWidth={1.4} />
          <span>{isRunning ? "建模中…" : "暂无模型文件"}</span>
        </div>
        {isRunning && <div className="tn-media-loading">建模中…</div>}
      </div>
    );
  }

  const visible = urls.length > MAX_VISIBLE_URLS + 1 ? urls.slice(0, MAX_VISIBLE_URLS) : urls;
  const hiddenCount = urls.length - visible.length;

  return (
    <div className="tn-field" style={{ gap: "0.3rem" }}>
      {visible.map((u, i) => {
        const name = u.split("/").pop() ?? u;
        return (
          <a
            key={u + i}
            className="tn-link"
            href={imageUrl(u)}
            target="_blank"
            rel="noreferrer"
            download
            title={`下载 ${name}`}
          >
            <Icon name="download" size={12} strokeWidth={1.8} />
            <span className="tn-file-name">{name}</span>
          </a>
        );
      })}
      {hiddenCount > 0 && (
        <span className="tn-file-name" title={`共 ${urls.length} 个文件`}>
          +{hiddenCount} 个文件
        </span>
      )}
    </div>
  );
}

// 只比较渲染用到的关键字段:urls 引用 + status
export const Model3DNodeBody = memo(Model3DNodeBodyImpl, (prev, next) => {
  if (prev.data.status !== next.data.status) return false;
  const pu = (prev.data.payload as MediaPayload).urls ?? [];
  const nu = (next.data.payload as MediaPayload).urls ?? [];
  return pu === nu || (pu.length === nu.length && pu.every((u, i) => u === nu[i]));
});
