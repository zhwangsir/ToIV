"use client";

import { useCallback, useState } from "react";

import { createDramaProject } from "@/lib/api";
import type { DramaProjectInput } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";

interface NewProjectPanelProps {
  /** 取消新建,返回列表。 */
  onCancel: () => void;
  /** 创建成功后回调(传入新项目 id,父组件切到详情视图)。 */
  onCreated: (id: string) => void;
}

/**
 * 新建短剧项目表单(右侧主区独立面板)。
 * 封装标题/简介/风格/剧本/宽高/FPS 草稿状态,提交后回调 onCreated。
 */
export function NewProjectPanel({ onCancel, onCreated }: NewProjectPanelProps) {
  const [draftTitle, setDraftTitle] = useState("");
  const [draftPremise, setDraftPremise] = useState("");
  const [draftStyle, setDraftStyle] = useState("");
  const [draftScript, setDraftScript] = useState("");
  const [draftW, setDraftW] = useState(768);
  const [draftH, setDraftH] = useState(384);
  const [draftFps, setDraftFps] = useState(16);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>("");

  const { show: showToast } = useToast();

  const handleCreate = useCallback(() => {
    if (!draftTitle.trim()) {
      setCreateError("请填写标题");
      return;
    }
    if (!draftScript.trim()) {
      setCreateError("请填写主剧本(script),AI 据此拆分镜");
      return;
    }
    setCreating(true);
    setCreateError("");
    const body: DramaProjectInput = {
      title: draftTitle.trim(),
      script: draftScript.trim(),
      ...(draftPremise.trim() ? { premise: draftPremise.trim() } : {}),
      ...(draftStyle.trim() ? { style: draftStyle.trim() } : {}),
      width: draftW,
      height: draftH,
      fps: draftFps,
    };
    createDramaProject(body)
      .then((p) => {
        showToast("success", `项目「${p.title}」已创建`);
        onCreated(p.id);
      })
      .catch((err) =>
        setCreateError(err instanceof Error ? err.message : "创建项目失败"),
      )
      .finally(() => setCreating(false));
  }, [
    draftTitle,
    draftPremise,
    draftStyle,
    draftScript,
    draftW,
    draftH,
    draftFps,
    showToast,
    onCreated,
  ]);

  return (
    <section className="card ds-new-panel">
      <div className="ds-panel-head">
        <Icon name="create" size={16} />
        <span>新建短剧项目</span>
      </div>
      <label className="ds-field">
        <span className="ds-field-label">标题 *</span>
        <input
          className="ds-input"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="给短剧起个名字"
          maxLength={80}
        />
      </label>
      <label className="ds-field">
        <span className="ds-field-label">简介(可选)</span>
        <input
          className="ds-input"
          value={draftPremise}
          onChange={(e) => setDraftPremise(e.target.value)}
          placeholder="一句话简介"
          maxLength={140}
        />
      </label>
      <label className="ds-field">
        <span className="ds-field-label">风格(可选)</span>
        <input
          className="ds-input"
          value={draftStyle}
          onChange={(e) => setDraftStyle(e.target.value)}
          placeholder="如:都市悬疑 / 古风言情"
        />
      </label>
      <label className="ds-field">
        <span className="ds-field-label">主剧本 * (AI 据此拆分镜)</span>
        <textarea
          className="ds-textarea ds-script-textarea"
          value={draftScript}
          onChange={(e) => setDraftScript(e.target.value)}
          rows={10}
          placeholder="粘贴完整剧本 / 故事梗概 / 分场大纲…"
        />
      </label>
      <div className="ds-field-row">
        <label className="ds-field">
          <span className="ds-field-label">宽</span>
          <input
            className="ds-input"
            type="number"
            min={256}
            max={1920}
            value={draftW}
            onChange={(e) =>
              setDraftW(
                Math.max(
                  256,
                  Math.min(1920, Number(e.target.value) || 768),
                ),
              )
            }
          />
        </label>
        <label className="ds-field">
          <span className="ds-field-label">高</span>
          <input
            className="ds-input"
            type="number"
            min={128}
            max={1080}
            value={draftH}
            onChange={(e) =>
              setDraftH(
                Math.max(
                  128,
                  Math.min(1080, Number(e.target.value) || 384),
                ),
              )
            }
          />
        </label>
        <label className="ds-field">
          <span className="ds-field-label">FPS</span>
          <input
            className="ds-input"
            type="number"
            min={1}
            max={60}
            value={draftFps}
            onChange={(e) =>
              setDraftFps(
                Math.max(1, Math.min(60, Number(e.target.value) || 16)),
              )
            }
          />
        </label>
      </div>
      {createError && <div className="ds-error-inline">{createError}</div>}
      <div className="ds-form-actions">
        <button
          type="button"
          className="btn btn-ghost btn-sm"
          onClick={onCancel}
          disabled={creating}
        >
          取消
        </button>
        <button
          type="button"
          className="btn btn-primary btn-sm"
          onClick={handleCreate}
          disabled={creating}
        >
          {creating ? (
            <>
              <Icon name="loading" size={13} className="ds-spin" />
              创建中…
            </>
          ) : (
            <>
              <Icon name="check" size={13} />
              创建
            </>
          )}
        </button>
      </div>
    </section>
  );
}
