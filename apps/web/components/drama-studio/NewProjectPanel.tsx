"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { createDramaProject, createManjuProject } from "@/lib/api";
import type { DramaProjectInput, ManjuProjectInput } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { consumeEngineDraft } from "@/lib/engine";

interface NewProjectPanelProps {
  /** 取消新建,返回列表。 */
  onCancel: () => void;
  /** 创建成功后回调(传入新项目 id 与类型,父组件切到对应视图)。 */
  onCreated: (id: string, type: "drama" | "manju") => void;
  /** 初始草稿(从 /engine 快速输入带入)。 */
  initialDraft?: { title?: string; script?: string };
}

type ProjectSource = "drama" | "manju";

/**
 * 新建项目表单(右侧主区独立面板)。
 * 支持选择来源:剧本项目 或 漫画项目,分别调用对应 API。
 */
export function NewProjectPanel({
  onCancel,
  onCreated,
  initialDraft,
}: NewProjectPanelProps) {
  const engineDraft = consumeEngineDraft();
  const draft = useMemo(() => {
    if (initialDraft) return { ...initialDraft, type: "drama" as ProjectSource };
    if (engineDraft?.target === "drama") {
      return {
        title: engineDraft.prompt.slice(0, 80),
        script: engineDraft.prompt,
        type: "drama" as ProjectSource,
      };
    }
    if (engineDraft?.target === "manju") {
      return {
        title: engineDraft.prompt.slice(0, 80),
        script: engineDraft.prompt,
        type: "manju" as ProjectSource,
      };
    }
    return undefined;
  }, [initialDraft, engineDraft]);

  const [source, setSource] = useState<ProjectSource>(draft?.type ?? "drama");

  // 剧本字段
  const [draftTitle, setDraftTitle] = useState(draft?.title ?? "");
  const [draftPremise, setDraftPremise] = useState("");
  const [draftStyle, setDraftStyle] = useState("");
  const [draftScript, setDraftScript] = useState(draft?.script ?? "");
  const [draftW, setDraftW] = useState(768);
  const [draftH, setDraftH] = useState(384);
  const [draftFps, setDraftFps] = useState(16);

  // 漫画字段
  const [manjuPremise, setManjuPremise] = useState<string>(
    draft?.type === "manju" ? draft.script || "" : "",
  );
  const [manjuCkpt, setManjuCkpt] = useState<string>("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string>("");

  const { show: showToast } = useToast();

  // 组件挂载后再次尝试消费 engine draft(作为 props 未传入时的兜底)
  useEffect(() => {
    if (draftTitle || draftScript || manjuPremise) return;
    const d = consumeEngineDraft();
    if (d?.target === "drama") {
      setDraftTitle(d.prompt.slice(0, 80));
      setDraftScript(d.prompt);
      setSource("drama");
    } else if (d?.target === "manju") {
      setDraftTitle(d.prompt.slice(0, 80));
      setManjuPremise(d.prompt);
      setSource("manju");
    }
  }, []);

  const handleCreate = useCallback(() => {
    if (!draftTitle.trim()) {
      setCreateError("请填写标题");
      return;
    }
    setCreating(true);
    setCreateError("");

    if (source === "drama") {
      if (!draftScript.trim()) {
        setCreateError("请填写主剧本(script),AI 据此拆分镜");
        setCreating(false);
        return;
      }
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
          onCreated(p.id, "drama");
        })
        .catch((err) =>
          setCreateError(err instanceof Error ? err.message : "创建项目失败"),
        )
        .finally(() => setCreating(false));
    } else {
      const body: ManjuProjectInput = {
        title: draftTitle.trim(),
        ...(manjuPremise.trim() ? { premise: manjuPremise.trim() } : {}),
        ...(draftStyle.trim() ? { style: draftStyle.trim() } : {}),
        ...(manjuCkpt.trim() ? { ckpt_name: manjuCkpt.trim() } : {}),
      };
      createManjuProject(body)
        .then((p) => {
          showToast("success", `漫画项目「${p.title}」已创建`);
          onCreated(p.id, "manju");
        })
        .catch((err) =>
          setCreateError(err instanceof Error ? err.message : "创建项目失败"),
        )
        .finally(() => setCreating(false));
    }
  }, [
    source,
    draftTitle,
    draftPremise,
    draftStyle,
    draftScript,
    draftW,
    draftH,
    draftFps,
    manjuPremise,
    manjuCkpt,
    showToast,
    onCreated,
  ]);

  return (
    <section className="card ds-new-panel">
      <div className="ds-panel-head">
        <Icon name="create" size={16} />
        <span>新建项目</span>
      </div>

      <div className="ds-source-tabs">
        <button
          type="button"
          className={`ds-source-tab ${source === "drama" ? "active" : ""}`}
          onClick={() => setSource("drama")}
          aria-pressed={source === "drama"}
        >
          <Icon name="filevideo" size={13} />
          剧本项目
        </button>
        <button
          type="button"
          className={`ds-source-tab ${source === "manju" ? "active" : ""}`}
          onClick={() => setSource("manju")}
          aria-pressed={source === "manju"}
        >
          <Icon name="image" size={13} />
          漫画项目
        </button>
      </div>

      <label className="ds-field">
        <span className="ds-field-label">标题 *</span>
        <input
          className="ds-input"
          value={draftTitle}
          onChange={(e) => setDraftTitle(e.target.value)}
          placeholder="给项目起个名字"
          maxLength={80}
        />
      </label>

      {source === "drama" ? (
        <>
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
        </>
      ) : (
        <>
          <label className="ds-field">
            <span className="ds-field-label">故事文本(可选)</span>
            <textarea
              className="ds-textarea ds-script-textarea"
              value={manjuPremise}
              onChange={(e) => setManjuPremise(e.target.value)}
              rows={8}
              placeholder="粘贴故事梗概 / 分镜描述 / 角色设定…"
            />
          </label>
          <label className="ds-field">
            <span className="ds-field-label">风格(可选)</span>
            <input
              className="ds-input"
              value={draftStyle}
              onChange={(e) => setDraftStyle(e.target.value)}
              placeholder="如:日系少女漫 / 美漫硬核 / 水墨古风"
            />
          </label>
          <label className="ds-field">
            <span className="ds-field-label">底模名称(可选)</span>
            <input
              className="ds-input"
              value={manjuCkpt}
              onChange={(e) => setManjuCkpt(e.target.value)}
              placeholder="留空使用平台默认底模"
            />
          </label>
        </>
      )}

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

      <style jsx>{`
        .ds-source-tabs {
          display: inline-flex;
          gap: 0.25rem;
          padding: 0.25rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          align-self: flex-start;
        }
        .ds-source-tab {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.7rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          color: var(--ink2);
          font-size: 0.78rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .ds-source-tab:hover {
          color: var(--ink);
          background: var(--bg-2);
        }
        .ds-source-tab.active {
          background: var(--accent-quiet);
          border-color: color-mix(in srgb, var(--accent) 35%, transparent);
          color: var(--accent);
        }
      `}</style>
    </section>
  );
}
