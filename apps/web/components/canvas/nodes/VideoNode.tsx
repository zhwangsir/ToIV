"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { useCanvas } from "../CanvasContext";
import { VID_LENGTHS, VID_SIZES, type VideoNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🎬 视频节点:入口 image(连图片节点 → 图生视频)或 text(连文本 → 文生视频)。
 *  生成 → 视频显示在节点内。NSFW 档(底模后端只读,开关作意图标记)。输出口:video。 */
export function VideoNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as VideoNodeData;
  const { patchNodeData, deleteNode, runNode, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const activeSize =
    VID_SIZES.find((s) => s.w === d.width && s.h === d.height)?.key ?? "";

  return (
    <NodeShell
      type="video"
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
        placeholder="运动描述(连图片→图生视频;连文本/留空→文生视频)"
        value={d.prompt}
        onChange={(e) => patchNodeData(id, { prompt: e.target.value })}
      />

      <div className="cv-chips nodrag" role="group" aria-label="画幅">
        {VID_SIZES.map((s) => (
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

      <div className="cv-chips nodrag" role="group" aria-label="时长">
        {VID_LENGTHS.map((l) => (
          <button
            key={l.v}
            type="button"
            className={`cv-chip${d.length === l.v ? " active" : ""}`}
            onClick={() => patchNodeData(id, { length: l.v })}
          >
            {l.label}
          </button>
        ))}
      </div>

      <label className="cv-switch nodrag">
        <input
          type="checkbox"
          checked={d.nsfw}
          onChange={(e) => patchNodeData(id, { nsfw: e.target.checked })}
        />
        <span className="cv-switch__track" aria-hidden="true" />
        <span className="cv-switch__label">NSFW 档</span>
      </label>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media cv-media--video">
            <video
              className="cv-media__el"
              src={d.run.outputUrl}
              controls
              loop
              muted
              playsInline
            />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🎬 成片后在此播放</span>
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
        id="video"
        className="cv-handle cv-handle--video"
      />
    </NodeShell>
  );
}
