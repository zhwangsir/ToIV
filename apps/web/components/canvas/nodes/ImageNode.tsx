"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";
import { Slider } from "@/components/ui/Slider";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { IMG_SIZES, type ImageNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 📷 图片节点:入口 text(连文本节点)/ image(连图片节点 → 图生图)。
 *  紧凑参数(模型 + 尺寸 Slider)+ 生成按钮 + NSFW 档。输出口:image。 */
export function ImageNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as ImageNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const activeSize =
    IMG_SIZES.find((s) => s.w === d.width && s.h === d.height)?.key ?? "";

  // NSFW 档:筛选模型;无标记时 filterModels 回退全部,再兜底 ckpts。
  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  // 成人向文件名集合(纯展示角标用,不参与上面的过滤)。
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="image"
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
        placeholder="本地提示词(若已连文本节点则以上游为准)"
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

      <div className="cv-chips nodrag" role="group" aria-label="尺寸">
        {IMG_SIZES.map((s) => (
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

      <div className="cv-slider-wrap nodrag">
        <Slider
          label="宽"
          value={d.width}
          min={384}
          max={1280}
          step={64}
          suffix="px"
          onChange={(v) => patchNodeData(id, { width: v })}
        />
        <Slider
          label="高"
          value={d.height}
          min={384}
          max={1280}
          step={64}
          suffix="px"
          onChange={(v) => patchNodeData(id, { height: v })}
        />
      </div>

      {d.run.outputUrl ? (
        <>
          <figure className="cv-media">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img className="cv-media__el" src={d.run.outputUrl} alt="生成结果" />
          </figure>
          <div className="cv-row cv-row--end nodrag">
            <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
          </div>
        </>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">📷 出图后在此预览</span>
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
        id="image"
        className="cv-handle cv-handle--image"
      />
    </NodeShell>
  );
}
