"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { OptimizeButton } from "@/components/ui/OptimizeButton";

import { useCanvas } from "../CanvasContext";
import { AUDIO_SECONDS, type AudioNodeData } from "../types";
import { NodeShell } from "./NodeShell";

/** 🎵 音频节点:入口 text(连文本节点)或本地 prompt → 文生音乐。无输出口。 */
export function AudioNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as AudioNodeData;
  const { patchNodeData, deleteNode, runNode, pipelineBusy } = useCanvas();
  const busy = d.run.busy || pipelineBusy;

  return (
    <NodeShell
      type="audio"
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
        placeholder="风格标签,如:lofi hip hop, 钢琴, 90bpm"
        value={d.prompt}
        onChange={(e) => patchNodeData(id, { prompt: e.target.value })}
      />
      <div className="cv-row cv-row--end nodrag">
        <OptimizeButton
          value={d.prompt}
          kind="audio"
          onResult={(opt) => patchNodeData(id, { prompt: opt })}
        />
      </div>

      <div className="cv-chips nodrag" role="group" aria-label="时长">
        {AUDIO_SECONDS.map((s) => (
          <button
            key={s}
            type="button"
            className={`cv-chip${d.seconds === s ? " active" : ""}`}
            onClick={() => patchNodeData(id, { seconds: s })}
          >
            {s}s
          </button>
        ))}
      </div>

      {d.run.outputUrl && (
        <div className="cv-output cv-output--audio">
          <audio src={d.run.outputUrl} controls />
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
