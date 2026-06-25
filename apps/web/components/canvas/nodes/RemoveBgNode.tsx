"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import { type RemoveBgNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

const MODES: { key: string; label: string }[] = [
  { key: "general", label: "通用" },
  { key: "anime", label: "动漫" },
  { key: "human", label: "人物" },
];

/** ✂️ 抠图去背(Remove Background)节点:上游图 → 去背透明 RGBA。
 *  入口 image;输出口 image。接 /generate/removebg(worker rembg 已装)。 */
export function RemoveBgNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as RemoveBgNodeData;
  const { deleteNode, runNode, patchNodeData, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  return (
    <NodeShell
      type="removebg"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "抠图中…" : "抠图"}
        </button>
      }
    >
      <p className="cv-hint-line">连一个图片 / 角色节点,自动去背成透明 PNG。</p>

      <div className="cv-chips nodrag" role="group" aria-label="抠图模式">
        {MODES.map((m) => (
          <button
            key={m.key}
            type="button"
            className={`cv-chip${d.mode === m.key ? " active" : ""}`}
            onClick={() => patchNodeData(id, { mode: m.key })}
          >
            {m.label}
          </button>
        ))}
      </div>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="抠图结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">✂️ 去背后在此预览</span>
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
