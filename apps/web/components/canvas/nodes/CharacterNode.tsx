"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { ModelPicker } from "@/components/ui/ModelPicker";

import { filterModels } from "../models";
import { useCanvas } from "../CanvasContext";
import { CHARACTER_VIEWS, type CharacterNodeData } from "../types";
import { ArchiveButton } from "./ArchiveButton";
import { NodeShell } from "./NodeShell";

/** 🧍 角色三视图节点:一句设定 → 正/侧/背 turnaround 提示词 + 出图。
 *  入口 text(连文本/分镜节点)。输出口 image(选定视角出图灌入下游)。 */
export function CharacterNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as CharacterNodeData;
  const { patchNodeData, deleteNode, runNode, models, ckpts, nsfwEnabled, pipelineBusy } =
    useCanvas();
  const busy = d.run.busy || pipelineBusy;

  const available = filterModels(models, d.nsfw);
  const ckptOptions = available.length ? available : ckpts;
  // 成人向文件名集合(纯展示角标用,不参与上面的过滤)。
  const nsfwSet = new Set(models.all.filter((m) => m.nsfw).map((m) => m.name));

  return (
    <NodeShell
      type="character"
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
          {d.run.busy ? "生成中…" : "出图"}
        </button>
      }
    >
      <textarea
        className="cv-text cv-text--sm nodrag"
        rows={2}
        placeholder="一句角色设定(若已连文本/分镜则以上游为准),如:银发少女,机械义肢,长风衣"
        value={d.brief}
        onChange={(e) => patchNodeData(id, { brief: e.target.value })}
      />

      <div className="cv-chips nodrag" role="group" aria-label="视角">
        {CHARACTER_VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            className={`cv-chip${d.view === v.key ? " active" : ""}`}
            onClick={() => patchNodeData(id, { view: v.key })}
          >
            {v.label}
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

      {d.run.outputUrl ? (
        <figure className="cv-media">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="cv-media__el" src={d.run.outputUrl} alt="角色三视图" />
        </figure>
      ) : (
        <div className="cv-media cv-media--empty" aria-hidden="true">
          <span className="cv-media__hint">🧍 三视图在此预览</span>
        </div>
      )}

      <div className="cv-row cv-row--end nodrag">
        <ArchiveButton nodeId={id} outputUrl={d.run.outputUrl} />
      </div>

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
