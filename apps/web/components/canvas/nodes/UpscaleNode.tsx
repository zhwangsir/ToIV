"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import { type UpscaleNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

const SCALES = [2, 4] as const;

/** 🔍 放大(Upscale)节点:上游图 → ESRGAN 高清放大。无底模/提示词,仅选倍数。
 *  入口 image;输出口 image。接 /generate/upscale。 */
export function UpscaleNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as UpscaleNodeData;
  const { deleteNode, runNode, patchNodeData, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  return (
    <NodeShell
      type="upscale"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "放大中…" : "放大"}
        </button>
      }
    >
      <p className="cv-hint-line">连一个图片 / 角色节点作源图,高清放大。</p>

      <div className="cv-chips nodrag" role="group" aria-label="放大倍数">
        {SCALES.map((s) => (
          <button
            key={s}
            type="button"
            className={`cv-chip${d.scale === s ? " active" : ""}`}
            onClick={() => patchNodeData(id, { scale: s })}
          >
            {s}×
          </button>
        ))}
      </div>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="放大结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🔍 放大后在此预览</span>
        </div>
      )}

      <Handle type="target" position={Position.Left} id="in" className="cv-handle cv-handle--in" />
      <Handle
        type="source"
        position={Position.Right}
        id="image"
        className="cv-handle cv-handle--image"
      />
    </NodeShell>
  );
}
