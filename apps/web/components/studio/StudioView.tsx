"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createStudioProject,
  deleteStudioProject,
  listStudioProjects,
  type StudioProjectSummary,
} from "@/lib/api";
import { useStudioProject } from "@/hooks/useStudioProject";
import { Icon } from "@/components/ui/Icon";
import { ScriptStage } from "./stages/ScriptStage";
import { CastStage } from "./stages/CastStage";
import { StoryboardStage } from "./stages/StoryboardStage";
import { AssemblyStage } from "./stages/AssemblyStage";

const STAGES = [
  { key: "script", label: "剧本", icon: "create" },
  { key: "cast", label: "角色", icon: "users" },
  { key: "storyboard", label: "分镜", icon: "film" },
  { key: "assembly", label: "合成", icon: "playing" },
] as const;

type StageKey = (typeof STAGES)[number]["key"];

const PROJECT_STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  storyboard: "已拆解",
  generating: "生成中",
  ready: "已完成",
  error: "失败",
};

/**
 * Studio 创作工作室(替代旧 短剧/漫剧 双模块)。
 * 四阶段流水线:剧本 → 角色 → 分镜(分镜级 视频/图像运镜 混合)→ 合成。
 */
export function StudioView() {
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [stage, setStage] = useState<StageKey>("script");
  const [error, setError] = useState<string | null>(null);
  const project = useStudioProject(activeId);

  const reload = useCallback(() => {
    listStudioProjects()
      .then(setProjects)
      .catch(() => setProjects([]));
  }, []);

  useEffect(reload, [reload]);

  const createProject = async () => {
    try {
      const p = await createStudioProject({ title: "未命名项目" });
      setProjects((prev) => [p, ...prev]);
      setActiveId(p.id);
      setStage("script");
    } catch (e) {
      setError(e instanceof Error ? e.message : "新建项目失败");
    }
  };

  const removeProject = async (p: StudioProjectSummary) => {
    if (!window.confirm(`删除项目「${p.title || "未命名"}」及其全部分镜?`)) return;
    try {
      await deleteStudioProject(p.id);
      if (activeId === p.id) setActiveId(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    }
  };

  // ── 项目列表(首页) ──
  if (!activeId) {
    return (
      <div className="studio-home">
        <header className="studio-home-head">
          <div className="studio-home-title-group">
            <h1 className="studio-home-title">
              <Icon name="clapperboard" size={20} /> 创作工作室
            </h1>
            <p className="studio-home-sub">剧本 → 角色 → 分镜混合生成 → 合成</p>
          </div>
          <button type="button" className="btn btn-primary" onClick={() => void createProject()}>
            <Icon name="plus" size={14} /> 新建项目
          </button>
        </header>
        {error && <p className="studio-error">{error}</p>}
        {projects.length === 0 ? (
          <div className="empty-state">
            <div className="empty-state-icon">
              <Icon name="film" size={40} />
            </div>
            <h3 className="empty-state-title">从一段剧情开始</h3>
            <p className="empty-state-desc">
              输入剧情概要,AI 自动拆解角色与分镜;每个分镜可独立选择「视频生成」或「图像运镜」。
            </p>
          </div>
        ) : (
          <ul className="studio-project-list">
            {projects.map((p) => (
              <li key={p.id} className="studio-project-item">
                <button
                  type="button"
                  className="studio-project-open"
                  onClick={() => {
                    setActiveId(p.id);
                    setStage("script");
                  }}
                >
                  <span className="studio-project-title">{p.title || "未命名"}</span>
                  <span className="studio-project-meta">
                    <span className={`studio-badge is-${p.status}`}>
                      {PROJECT_STATUS_LABEL[p.status] ?? p.status}
                    </span>
                    <time>{new Date(p.updated_at).toLocaleDateString()}</time>
                  </span>
                </button>
                <button
                  type="button"
                  className="studio-shot-del"
                  title="删除项目"
                  onClick={() => void removeProject(p)}
                >
                  <Icon name="delete" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        <StudioStyles />
      </div>
    );
  }

  // ── 工作台(四阶段) ──
  const d = project.detail;
  return (
    <div className="studio-view">
      <nav className="studio-stages" aria-label="创作阶段">
        <button type="button" className="studio-back" onClick={() => setActiveId(null)}>
          <Icon name="chevron-left" size={14} /> 项目列表
        </button>
        <div className="studio-stage-tabs" role="tablist">
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={stage === s.key}
              className={`studio-stage-btn${stage === s.key ? " is-active" : ""}`}
              onClick={() => setStage(s.key)}
            >
              <Icon name={s.icon} size={14} /> {s.label}
            </button>
          ))}
        </div>
        {d && <span className="studio-view-title">{d.title || "未命名"}</span>}
      </nav>

      {project.error && <p className="studio-error">{project.error}</p>}
      {project.loading && !d ? (
        <div className="empty-state">
          <div className="empty-state-icon">
            <Icon name="loading" size={32} />
          </div>
          <p className="empty-state-desc">项目加载中…</p>
        </div>
      ) : (
        <>
          {stage === "script" && <ScriptStage project={project} onDone={() => setStage("cast")} />}
          {stage === "cast" && <CastStage project={project} onDone={() => setStage("storyboard")} />}
          {stage === "storyboard" && <StoryboardStage project={project} />}
          {stage === "assembly" && <AssemblyStage project={project} />}
        </>
      )}
      <StudioStyles />
    </div>
  );
}

/** Studio 模块全部样式(全局,覆盖子组件):Film Atelier 变量体系。 */
function StudioStyles() {
  return (
    <style jsx global>{`
      /* ── 布局 ── */
      .studio-home,
      .studio-view {
        display: flex;
        flex-direction: column;
        gap: var(--space-5);
        height: 100%;
        overflow-y: auto;
        padding: var(--space-6);
      }
      .studio-home-head {
        display: flex;
        align-items: flex-end;
        justify-content: space-between;
        gap: var(--space-4);
        padding-bottom: var(--space-3);
        border-bottom: 1px solid var(--border-subtle);
      }
      .studio-home-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-title);
        font-weight: 600;
        color: var(--text-primary);
        letter-spacing: -0.02em;
      }
      .studio-home-sub {
        margin-top: var(--space-1);
        font-size: var(--text-aux);
        color: var(--text-muted);
      }
      .studio-error {
        font-size: var(--text-aux);
        color: var(--color-danger, #dc2626);
        background: var(--bg-surface-2);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        padding: var(--space-2) var(--space-3);
      }

      /* ── 项目列表 ── */
      .studio-project-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        max-width: 720px;
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .studio-project-item {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .studio-project-open {
        flex: 1;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-3) var(--space-4);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        cursor: pointer;
        text-align: left;
        transition:
          border-color var(--duration-fast) var(--ease-standard),
          transform var(--duration-fast) var(--ease-standard);
      }
      .studio-project-open:hover {
        border-color: var(--border-strong);
        transform: translateY(-1px);
      }
      .studio-project-title {
        font-size: var(--text-section);
        font-weight: 600;
        color: var(--text-primary);
      }
      .studio-project-meta {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .studio-badge {
        font-size: var(--text-label);
        padding: 2px var(--space-2);
        border-radius: var(--radius-full);
        background: var(--bg-surface-2);
        color: var(--text-muted);
      }
      .studio-badge.is-ready {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .studio-badge.is-error {
        color: var(--color-danger, #dc2626);
      }

      /* ── 阶段导航 ── */
      .studio-stages {
        display: flex;
        align-items: center;
        gap: var(--space-4);
        padding-bottom: var(--space-3);
        border-bottom: 1px solid var(--border-subtle);
        flex-shrink: 0;
      }
      .studio-back {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-aux);
        color: var(--text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: var(--space-1) var(--space-2);
        border-radius: var(--radius-control);
      }
      .studio-back:hover {
        color: var(--text-primary);
        background: var(--bg-surface-2);
      }
      .studio-stage-tabs {
        display: flex;
        gap: var(--space-1);
        background: var(--bg-surface-2);
        padding: 3px;
        border-radius: var(--radius-control);
      }
      .studio-stage-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-aux);
        font-weight: 500;
        color: var(--text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: var(--space-1) var(--space-3);
        border-radius: calc(var(--radius-control) - 3px);
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .studio-stage-btn:hover {
        color: var(--text-primary);
      }
      .studio-stage-btn.is-active {
        color: var(--accent);
        background: var(--bg-surface-1);
        box-shadow: var(--shadow-sm);
      }
      .studio-view-title {
        margin-left: auto;
        font-size: var(--text-aux);
        color: var(--text-muted);
      }

      /* ── 阶段通用 ── */
      .studio-stage {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        max-width: 960px;
      }
      .studio-field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .studio-label {
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .studio-stage-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        gap: var(--space-3);
      }
      .studio-inline-field {
        display: inline-flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-aux);
        color: var(--text-secondary);
      }
      .studio-inline-field .input {
        width: 72px;
      }

      /* ── 角色卡 ── */
      .studio-cast-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
        gap: var(--space-3);
      }
      .studio-char {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-4);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .studio-char-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--accent);
      }
      .studio-char-name {
        flex: 1;
        font-weight: 600;
      }
      .studio-char-new {
        justify-content: center;
        border-style: dashed;
      }
      .studio-char-voice {
        display: flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-label);
        color: var(--accent);
      }

      /* ── 分镜网格 ── */
      .studio-board-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
      }
      .studio-board-stat {
        font-size: var(--text-aux);
        color: var(--text-muted);
      }
      .studio-board-actions {
        display: flex;
        gap: var(--space-2);
      }
      .studio-shot-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
        gap: var(--space-3);
      }
      .studio-shot {
        display: flex;
        flex-direction: column;
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        overflow: hidden;
      }
      .studio-shot[data-status="error"] {
        border-color: var(--color-danger, #dc2626);
      }
      .studio-shot-media {
        position: relative;
        aspect-ratio: 16 / 9;
        background: var(--bg-surface-2);
      }
      .studio-shot-media video,
      .studio-shot-media img {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .studio-shot-empty {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        width: 100%;
        height: 100%;
        color: var(--text-muted);
        font-size: var(--text-label);
      }
      .studio-shot-badge {
        position: absolute;
        top: var(--space-2);
        right: var(--space-2);
        font-size: var(--text-label);
        padding: 2px var(--space-2);
        border-radius: var(--radius-full);
        background: rgba(0, 0, 0, 0.55);
        color: #fff;
        backdrop-filter: blur(4px);
      }
      .studio-shot-badge.is-done {
        background: var(--accent);
      }
      .studio-shot-badge.is-error {
        background: var(--color-danger, #dc2626);
      }
      .studio-shot-body {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        padding: var(--space-3);
      }
      .studio-shot-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
      }
      .studio-shot-idx {
        font-size: var(--text-label);
        font-weight: 600;
        color: var(--text-muted);
      }
      .studio-shot-mode {
        display: flex;
        gap: 2px;
        background: var(--bg-surface-2);
        padding: 2px;
        border-radius: var(--radius-control);
      }
      .studio-shot-mode button {
        display: inline-flex;
        align-items: center;
        gap: 3px;
        font-size: var(--text-label);
        color: var(--text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px var(--space-2);
        border-radius: calc(var(--radius-control) - 2px);
      }
      .studio-shot-mode button.is-active {
        color: var(--accent);
        background: var(--bg-surface-1);
      }
      .studio-shot-mode button:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .studio-shot-del {
        margin-left: auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 26px;
        height: 26px;
        color: var(--text-muted);
        background: none;
        border: none;
        border-radius: var(--radius-control);
        cursor: pointer;
      }
      .studio-shot-del:hover {
        color: var(--color-danger, #dc2626);
        background: var(--bg-surface-2);
      }
      .studio-shot-line {
        display: flex;
        gap: var(--space-2);
      }
      .studio-shot-line .input:first-child {
        flex: 1;
      }
      .studio-shot-speaker {
        width: 110px;
        flex-shrink: 0;
      }
      .studio-shot-adv-toggle {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        align-self: flex-start;
        font-size: var(--text-label);
        color: var(--text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: 0;
      }
      .studio-shot-adv-toggle:hover {
        color: var(--text-primary);
      }
      .studio-shot-adv {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
      }
      .studio-shot-adv-row {
        display: flex;
        gap: var(--space-2);
      }
      .studio-shot-adv-row label {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 2px;
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .studio-shot-error {
        font-size: var(--text-label);
        color: var(--color-danger, #dc2626);
      }
      .studio-shot-actions {
        display: flex;
        gap: var(--space-2);
        padding-top: var(--space-1);
        border-top: 1px solid var(--border-subtle);
      }

      /* ── 合成时间轴 ── */
      .studio-timeline {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        list-style: none;
        margin: 0;
        padding: 0;
      }
      .studio-timeline-item {
        display: grid;
        grid-template-columns: 40px 200px 1fr;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        opacity: 0.55;
      }
      .studio-timeline-item[data-ready="true"] {
        opacity: 1;
      }
      .studio-timeline-idx {
        font-size: var(--text-label);
        font-weight: 600;
        color: var(--text-muted);
        text-align: center;
      }
      .studio-timeline-media {
        aspect-ratio: 16 / 9;
        background: var(--bg-surface-2);
        border-radius: var(--radius-control);
        overflow: hidden;
      }
      .studio-timeline-media video {
        width: 100%;
        height: 100%;
        object-fit: cover;
        display: block;
      }
      .studio-timeline-scene {
        font-size: var(--text-aux);
        color: var(--text-secondary);
      }
      .studio-final {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        padding: var(--space-4);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
      }
      .studio-final-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        font-size: var(--text-section);
        font-weight: 600;
        color: var(--text-primary);
      }
      .studio-final-player {
        width: 100%;
        max-width: 720px;
        border-radius: var(--radius-control);
        background: #000;
      }
      .studio-final .btn {
        align-self: flex-start;
      }

      @media (prefers-reduced-motion: reduce) {
        .studio-project-open,
        .studio-stage-btn {
          transition: none;
        }
      }
    `}</style>
  );
}
