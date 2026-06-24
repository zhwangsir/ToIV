"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import {
  LIGHTING_INTENSITY,
  LIGHTING_PRESETS,
  lightingFragment,
  type LightingNodeData,
} from "../types";
import { NodeShell } from "./NodeShell";

const INTENSITIES: LightingNodeData["intensity"][] = [
  "subtle",
  "standard",
  "dramatic",
];

/** 🔦 打光预设节点:选光型 + 强度 → 输出光照提示词片段(text 语义)。
 *  无入口(管线起点)。下游图像/视频会把该片段叠加进提示词。 */
export function LightingNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as LightingNodeData;
  const { patchNodeData, deleteNode } = useCanvas();
  const fragment = lightingFragment(d);

  return (
    <NodeShell type="lighting" selected={selected} onDelete={() => deleteNode(id)}>
      <div className="cv-chips cv-chips--wrap nodrag" role="group" aria-label="光型">
        {LIGHTING_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            className={`cv-chip${d.preset === p.key ? " active" : ""}`}
            onClick={() => patchNodeData(id, { preset: p.key })}
            title={p.prompt}
          >
            {p.label}
          </button>
        ))}
      </div>

      <div className="cv-chips nodrag" role="group" aria-label="强度">
        {INTENSITIES.map((k) => (
          <button
            key={k}
            type="button"
            className={`cv-chip${d.intensity === k ? " active" : ""}`}
            onClick={() => patchNodeData(id, { intensity: k })}
          >
            {LIGHTING_INTENSITY[k].label}
          </button>
        ))}
      </div>

      <p className="cv-fragment nodrag" aria-label="光照提示词片段">
        {fragment || "无叠加"}
      </p>

      <Handle
        type="source"
        position={Position.Right}
        id="text"
        className="cv-handle cv-handle--text"
      />
    </NodeShell>
  );
}
