"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import { STORYBOARD_SHOT_COUNTS, type StoryboardNodeData } from "../types";
import { NodeShell } from "./NodeShell";

/** 📋 分镜节点:剧情 premise → 多镜剧本(复用 /api/manju/storyboard)。
 *  无入口(管线起点)。输出口 text(把分镜文本灌入下游图像/视频)。 */
export function StoryboardNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as StoryboardNodeData;
  const { patchNodeData, deleteNode, runNode, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  return (
    <NodeShell
      type="storyboard"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button
          type="button"
          className="cv-gen nodrag"
          disabled={busy || !d.premise.trim()}
          onClick={() => runNode(id)}
        >
          {d.run.busy ? "拆镜中…" : "拆分镜"}
        </button>
      }
    >
      <textarea
        className="cv-text nodrag"
        rows={3}
        placeholder="一句剧情梗概,如:少年在废墟中找到会发光的种子,决定守护它"
        value={d.premise}
        onChange={(e) => patchNodeData(id, { premise: e.target.value })}
      />

      <label className="cv-field nodrag">
        <span className="cv-label">风格</span>
        <input
          className="cv-input"
          value={d.style}
          placeholder="电影感 / 赛博朋克 / 水彩…"
          onChange={(e) => patchNodeData(id, { style: e.target.value })}
        />
      </label>

      <div className="cv-chips nodrag" role="group" aria-label="镜数">
        {STORYBOARD_SHOT_COUNTS.map((n) => (
          <button
            key={n}
            type="button"
            className={`cv-chip${d.numShots === n ? " active" : ""}`}
            onClick={() => patchNodeData(id, { numShots: n })}
          >
            {n} 镜
          </button>
        ))}
      </div>

      {d.shots.length > 0 && (
        <ol className="cv-shots nodrag">
          {d.shots.map((s, i) => (
            <li key={s.id} className="cv-shot">
              <span className="cv-shot__idx">{String(i + 1).padStart(2, "0")}</span>
              <span className="cv-shot__body">
                <strong>{s.scene || "场景"}</strong>
                <em>{s.camera}</em>
                <span>{s.description}</span>
                {s.dialogue && <q>{s.dialogue}</q>}
              </span>
            </li>
          ))}
        </ol>
      )}

      <Handle
        type="source"
        position={Position.Right}
        id="text"
        className="cv-handle cv-handle--text"
      />
    </NodeShell>
  );
}
