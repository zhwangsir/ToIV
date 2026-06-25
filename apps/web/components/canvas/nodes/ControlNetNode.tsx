"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";
import { Slider } from "@/components/ui/Slider";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { CONTROL_TYPES, type ControlNetNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🧭 构图控制(ControlNet)节点:上游图作控制图,锁住构图/姿态/线稿出新图。
 *  入口 image(控制图)/ text(提示词);输出口 image。接 /generate/controlnet。 */
export function ControlNetNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ControlNetNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="controlnet"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "生成中…" : "生成"}
        </button>
      }
    >
      <p className="cv-hint-line">连一个图片 / 角色节点作控制图,锁构图出新图。</p>

      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="提示词(必填;描述要生成的画面)"
        value={d.prompt}
        onChange={(e) => patchNodeData(id, { prompt: e.target.value })}
      />

      <div className="cv-chips nodrag" role="group" aria-label="控制类型">
        {CONTROL_TYPES.map((c) => (
          <button
            key={c.key}
            type="button"
            className={`cv-chip${d.controlType === c.key ? " active" : ""}`}
            onClick={() => patchNodeData(id, { controlType: c.key })}
          >
            {c.label}
          </button>
        ))}
      </div>

      <div className="nodrag">
        <ModelPicker
          models={ckptOptions}
          value={d.ckpt}
          onChange={(v) => patchNodeData(id, { ckpt: v })}
          label="模型"
          nsfwSet={nsfwSet}
        />
      </div>

      {nsfwEnabled && (
        <label className="cv-switch nodrag">
          <input
            type="checkbox"
            checked={d.nsfw}
            onChange={(e) => patchNodeData(id, { nsfw: e.target.checked })}
          />
          <span className="cv-switch__track" aria-hidden="true" />
          <span className="cv-switch__label">NSFW 档</span>
        </label>
      )}

      <div className="cv-slider-wrap nodrag">
        <Slider
          label="控制强度"
          value={d.strength}
          min={0}
          max={2}
          step={0.05}
          onChange={(v) => patchNodeData(id, { strength: v })}
        />
      </div>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="构图控制结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🧭 出图后在此预览</span>
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
