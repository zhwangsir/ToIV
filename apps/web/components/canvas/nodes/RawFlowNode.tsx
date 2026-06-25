"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import { type RawFlowNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🧬 工作流(Raw)节点:粘贴任意 ComfyUI API-format 图 JSON 直接运行。
 *  无入口(自包含);输出口 image(产物可串下游)。接 /generate/raw。
 *  提示:用 ComfyUI 的「保存(API 格式)」导出,图须含 SaveImage 类产物节点。 */
export function RawFlowNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as RawFlowNodeData;
  const { patchNodeData, deleteNode, runNode, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  return (
    <NodeShell
      type="rawflow"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button
          type="button"
          className="cv-gen nodrag"
          disabled={busy || !d.json.trim()}
          onClick={() => runNode(id)}
        >
          {d.run.busy ? "运行中…" : "运行"}
        </button>
      }
    >
      <p className="cv-hint-line">
        粘贴 ComfyUI「API 格式」工作流 JSON,直接在集群运行。图须含 SaveImage 节点。
      </p>

      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={6}
        spellCheck={false}
        placeholder='{"3": {"class_type": "KSampler", "inputs": {…}}, …}'
        value={d.json}
        onChange={(e) => patchNodeData(id, { json: e.target.value })}
      />

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="工作流产物" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🧬 运行后在此预览产物</span>
        </div>
      )}

      <Handle
        type="source"
        position={Position.Right}
        id="image"
        className="cv-handle cv-handle--image"
      />
    </NodeShell>
  );
}
