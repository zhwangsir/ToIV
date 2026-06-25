"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";
import { Slider } from "@/components/ui/Slider";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { type FaceDetailerNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🩹 脸修复(FaceDetailer)节点:检测上游图人脸 → 局部高清重绘。
 *  入口 image;输出口 image。接 /generate/facedetailer(worker 检测/SAM 模型已装)。 */
export function FaceDetailerNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as FaceDetailerNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="facedetailer"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "修复中…" : "修脸"}
        </button>
      }
    >
      <p className="cv-hint-line">连一个图片 / 角色节点,自动检测人脸并高清重绘。</p>

      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="脸部提示词(可空;默认通用脸部细节)"
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
          label="脸部重绘强度"
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
            <img className="cv-media__el" src={d.run.outputUrl} alt="脸修复结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🩹 修复后在此预览</span>
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
