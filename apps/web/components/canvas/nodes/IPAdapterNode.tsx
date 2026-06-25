"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";
import { Slider } from "@/components/ui/Slider";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { type IPAdapterNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🪞 角色一致(IPAdapter)节点:上游图作参考图,使新图人物外观与之保持一致。
 *  入口 image(参考图)/ text(提示词);输出口 image。接 /manju/shot(character_ref)。
 *  worker 已装 ip-adapter face 模型(SD1.5 + SDXL)。 */
export function IPAdapterNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as IPAdapterNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="ipadapter"
      selected={selected}
      run={d.run}
      onDelete={() => deleteNode(id)}
      action={
        <button type="button" className="cv-gen nodrag" disabled={busy} onClick={() => runNode(id)}>
          {d.run.busy ? "生成中…" : "生成"}
        </button>
      }
    >
      <p className="cv-hint-line">连一张人物参考图,新图保持同一角色外观。</p>

      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="提示词(必填;新场景/姿态描述)"
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
          label="参考强度"
          value={d.weight}
          min={0.1}
          max={1}
          step={0.05}
          onChange={(v) => patchNodeData(id, { weight: v })}
        />
      </div>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="角色一致结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🪞 出图后在此预览</span>
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
