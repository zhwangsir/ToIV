"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";
import { Slider } from "@/components/ui/Slider";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { type InpaintNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🎯 局部重绘(文字定向 Inpaint)节点:说哪改哪,无需手绘蒙版。
 *  上游图 + 目标区域文字(Florence2 分割)+ 重绘提示词 → 仅重绘该区域。
 *  入口 image;输出口 image。接 /generate/inpaint。 */
export function InpaintNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as InpaintNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="inpaint"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "重绘中…" : "重绘"}
        </button>
      }
    >
      <p className="cv-hint-line">连一张图,说出要改的区域和改成什么 — 无需手绘蒙版。</p>

      <input
        className="cv-input nodrag"
        type="text"
        placeholder="目标区域(英文,如 the hat / the sky)"
        value={d.target}
        onChange={(e) => patchNodeData(id, { target: e.target.value })}
      />

      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="重绘内容:把该区域画成什么(必填)"
        value={d.prompt}
        onChange={(e) => patchNodeData(id, { prompt: e.target.value })}
      />

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
          label="重绘强度"
          value={d.denoise}
          min={0.1}
          max={1}
          step={0.05}
          onChange={(v) => patchNodeData(id, { denoise: v })}
        />
      </div>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="局部重绘结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🎯 重绘后在此预览</span>
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
