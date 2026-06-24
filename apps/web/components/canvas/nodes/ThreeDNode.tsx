"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import { THREED_OCTREE, THREED_STEPS, type ThreeDNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🧊 3D 节点:入口 image(连图片/角色节点)→ Hunyuan3D 网格(glb)。
 *  无输出口(管线终点)。产物为可下载 glb。 */
export function ThreeDNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ThreeDNodeData;
  const { deleteNode, runNode, patchNodeData, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  return (
    <NodeShell
      type="threed"
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
          {d.run.busy ? "建模中…" : "生成 3D"}
        </button>
      }
    >
      <p className="cv-hint-line nodrag">连一个图片 / 角色节点 → 转三维网格</p>

      <div className="cv-chips nodrag" role="group" aria-label="精度步数">
        {THREED_STEPS.map((s) => (
          <button
            key={s}
            type="button"
            className={`cv-chip${d.steps === s ? " active" : ""}`}
            onClick={() => patchNodeData(id, { steps: s })}
          >
            {s} 步
          </button>
        ))}
      </div>

      <div className="cv-chips nodrag" role="group" aria-label="网格分辨率">
        {THREED_OCTREE.map((o) => (
          <button
            key={o}
            type="button"
            className={`cv-chip${d.octree === o ? " active" : ""}`}
            onClick={() => patchNodeData(id, { octree: o })}
          >
            {o}
          </button>
        ))}
      </div>

      {d.run.outputUrl && (
        <div className="cv-output cv-output--glb">
          <a className="cv-glb-dl" href={d.run.outputUrl} download>
            ⬇ 下载 GLB 模型
          </a>
          <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
        </div>
      )}

      <Handle
        type="target"
        position={Position.Left}
        id="in"
        className="cv-handle cv-handle--in"
      />
    </NodeShell>
  );
}
