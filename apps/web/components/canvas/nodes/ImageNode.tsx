"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { Slider } from "@/components/ui/Slider";

import { useCanvas } from "../CanvasContext";
import { IMG_SIZES, type ImageNodeData } from "../types";
import { NodeShell } from "./NodeShell";

/** 📷 图片节点:入口 text(连文本节点)/ image(连图片节点 → 图生图)。
 *  紧凑参数(模型 + 尺寸 Slider)+ 生成按钮。输出口:image。 */
export function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ImageNodeData;
  const { patchNodeData, deleteNode, runNode, ckpts, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const activeSize =
    IMG_SIZES.find((s) => s.w === d.width && s.h === d.height)?.key ?? "";

  return (
    <NodeShell
      type="image"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button
          type="button"
          className="cv-gen nodrag"
          disabled={busy}
          onClick={() => runNode(id)}
        >
          {d.run.busy ? "生成中…" : "生成"}
        </button>
      }
    >
      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="本地提示词(若已连文本节点则以上游为准)"
        value={d.prompt}
        onChange={(e) => patchNodeData(id, { prompt: e.target.value })}
      />

      <label className="cv-field nodrag">
        <span className="cv-label">模型</span>
        <select
          className="cv-select"
          value={d.ckpt}
          onChange={(e) => patchNodeData(id, { ckpt: e.target.value })}
        >
          {ckpts.length === 0 && <option value="">默认模型</option>}
          {ckpts.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
      </label>

      <div className="cv-chips nodrag" role="group" aria-label="尺寸">
        {IMG_SIZES.map((s) => (
          <button
            key={s.key}
            type="button"
            className={`cv-chip${activeSize === s.key ? " active" : ""}`}
            onClick={() => patchNodeData(id, { width: s.w, height: s.h })}
          >
            {s.label}
          </button>
        ))}
      </div>

      <div className="cv-slider-wrap nodrag">
        <Slider
          label="宽"
          value={d.width}
          min={384}
          max={1280}
          step={64}
          suffix="px"
          onChange={(v) => patchNodeData(id, { width: v })}
        />
        <Slider
          label="高"
          value={d.height}
          min={384}
          max={1280}
          step={64}
          suffix="px"
          onChange={(v) => patchNodeData(id, { height: v })}
        />
      </div>

      {d.run.outputUrl && (
        <div className="cv-output">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={d.run.outputUrl} alt="生成结果" />
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="cv-handle cv-handle--in"
      />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        className="cv-handle cv-handle--image"
      />
    </NodeShell>
  );
}
