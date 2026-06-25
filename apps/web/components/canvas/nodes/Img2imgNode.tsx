"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";
import { Slider } from "@/components/ui/Slider";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { type Img2imgNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🖌 重绘(img2img)节点:必须连上游图片节点作源图;denoise 控制重绘强度。
 *  入口 image(源图)/ text(提示词);输出口 image。接 /generate/img2img。 */
export function Img2imgNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as Img2imgNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="img2img"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "重绘中…" : "重绘"}
        </button>
      }
    >
      <p className="cv-hint-line">连一个图片 / 角色节点作源图,再重绘。</p>

      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="重绘方向提示词(可空;留空则按原图增强)"
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
            <img className="cv-media__el" src={d.run.outputUrl} alt="重绘结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🖌 重绘后在此预览</span>
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
