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
        <header className="page-header">
          <div>
            <h1 className="page-header-title">
              <Icon name="clapperboard" size={22} /> 创作工作室
            </h1>
            <p className="page-header-desc">
              剧本 → 角色 → 分镜混合生成 → 合成,四步完成一部短剧
            </p>
          </div>
          <div className="page-header-actions">
            <button type="button" className="btn btn-primary" onClick={() => void createProject()}>
              <Icon name="plus" size={14} /> 新建项目
            </button>
          </div>
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
                    <time>{new Date(p.updated_at).toLocaleDateString("zh-CN")}</time>
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
        <div className="studio-stages-top">
          <button type="button" className="studio-back" onClick={() => setActiveId(null)}>
            <Icon name="chevron-left" size={14} /> 项目列表
          </button>
          {d && <span className="studio-view-title">{d.title || "未命名"}</span>}
        </div>
        <div className="studio-stage-tabs" role="tablist">
          {STAGES.map((s, i) => (
            <button
              key={s.key}
              type="button"
              role="tab"
              aria-selected={stage === s.key}
              className={`studio-stage-btn${stage === s.key ? " is-active" : ""}`}
              onClick={() => setStage(s.key)}
            >
              <span className="studio-stage-num" aria-hidden="true">
                {i + 1}
              </span>
              <Icon name={s.icon} size={14} /> {s.label}
            </button>
          ))}
        </div>
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
      /* ── 布局:内容区 max-width 1200 居中,与 single-view 版型对齐 ── */
      .studio-home,
      .studio-view {
        display: flex;
        flex-direction: column;
        gap: var(--space-7);
        width: 100%;
        max-width: 1200px;
        margin: 0 auto;
        height: 100%;
        overflow-y: auto;
        padding: var(--space-8);
      }
      /* 首页页头用全局 .page-header*(桌面端自动避让 CornerNav);容器 gap 已提供间距 */
      .studio-home .page-header {
        margin-bottom: 0;
      }
      .studio-home .page-header-title {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--text-primary);
      }
      .studio-error {
        font-size: var(--text-aux);
        color: var(--err);
        background: var(--err-soft);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        padding: var(--space-2) var(--space-3);
      }

      /* ── 项目列表:大行高卡片式,hover 升浮 ── */
      .studio-project-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-3);
        max-width: 800px;
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
        min-width: 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: var(--space-3);
        padding: var(--space-4) var(--space-5);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-panel);
        cursor: pointer;
        text-align: left;
        transition:
          border-color var(--duration-fast) var(--ease-standard),
          box-shadow var(--duration-fast) var(--ease-standard),
          transform var(--duration-fast) var(--ease-standard);
      }
      .studio-project-open:hover {
        border-color: var(--border-strong);
        box-shadow: var(--shadow-md);
        transform: translateY(-2px);
      }
      .studio-project-title {
        font-size: var(--text-section);
        font-weight: 600;
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .studio-project-meta {
        display: flex;
        align-items: center;
        gap: var(--space-3);
        font-size: var(--text-label);
        color: var(--text-muted);
        white-space: nowrap;
        flex-shrink: 0;
      }
      .studio-badge {
        font-size: var(--text-label);
        font-weight: 500;
        padding: 2px var(--space-2);
        border-radius: var(--radius-badge);
        background: var(--bg-surface-2);
        color: var(--text-muted);
        white-space: nowrap;
      }
      .studio-badge.is-ready {
        color: var(--accent);
        background: var(--accent-soft);
      }
      .studio-badge.is-error {
        color: var(--err);
        background: var(--err-soft);
      }

      /* ── 阶段导航:长列表滚动时吸附顶部 ── */
      .studio-stages {
        position: sticky;
        top: 0;
        z-index: var(--z-sticky);
        display: flex;
        align-items: center;
        gap: var(--space-3);
        padding: var(--space-2) 0 var(--space-3);
        background: var(--bg-canvas);
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
        white-space: nowrap;
        flex-shrink: 0;
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .studio-back:hover {
        color: var(--text-primary);
        background: var(--bg-surface-2);
      }
      .studio-stage-tabs {
        display: flex;
        gap: var(--space-1);
        background: var(--bg-surface-2);
        padding: var(--space-1);
        border-radius: var(--radius-control);
        min-width: 0;
        overflow-x: auto;
        scrollbar-width: none;
      }
      .studio-stage-tabs::-webkit-scrollbar {
        display: none;
      }
      .studio-stage-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: var(--space-1);
        font-size: var(--text-aux);
        font-weight: 500;
        color: var(--text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: var(--space-1) var(--space-3);
        border-radius: calc(var(--radius-control) - 4px);
        white-space: nowrap;
        flex-shrink: 0;
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
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
        max-width: 32%;
      }

      /* ── 阶段通用 ── */
      .studio-stage {
        display: flex;
        flex-direction: column;
        gap: var(--space-4);
        width: 100%;
        max-width: 960px;
      }
      /* 卡片网格类阶段用满内容宽(1200) */
      .studio-stage-cast,
      .studio-stage-board,
      .studio-stage-assembly {
        max-width: none;
      }
      .studio-field {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .studio-label {
        font-size: var(--text-label);
        font-weight: 500;
        color: var(--text-muted);
      }
      .studio-stage-actions {
        display: flex;
        align-items: center;
        justify-content: flex-end;
        flex-wrap: wrap;
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
      /* 下拉类内联字段(分辨率/帧率)不压缩,随内容伸展 */
      .studio-inline-field select.input {
        width: auto;
        min-width: 150px;
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
        transition: border-color var(--duration-fast) var(--ease-standard);
      }
      .studio-char:hover {
        border-color: var(--border-strong);
      }
      .studio-char-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        color: var(--accent);
      }
      .studio-char-name {
        flex: 1;
        min-width: 0;
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
        flex-wrap: wrap;
        gap: var(--space-2) var(--space-3);
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
        transition: border-color var(--duration-fast) var(--ease-standard);
      }
      .studio-shot:hover {
        border-color: var(--border-strong);
      }
      .studio-shot[data-status="error"],
      .studio-shot[data-status="error"]:hover {
        border-color: var(--err);
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
        font-weight: 500;
        padding: 2px var(--space-2);
        border-radius: var(--radius-badge);
        background: var(--overlay-light); /* 图片上 scrim 恒深色 */
        color: var(--text-on-accent);
        backdrop-filter: blur(4px);
      }
      .studio-shot-badge.is-done {
        background: var(--accent);
      }
      .studio-shot-badge.is-error {
        background: var(--err);
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
        gap: var(--space-1);
        background: var(--bg-surface-2);
        padding: var(--space-1);
        border-radius: var(--radius-control);
      }
      .studio-shot-mode button {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-size: var(--text-label);
        color: var(--text-muted);
        background: none;
        border: none;
        cursor: pointer;
        padding: 2px var(--space-2);
        border-radius: calc(var(--radius-control) - 4px);
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .studio-shot-mode button.is-active {
        color: var(--accent);
        background: var(--bg-surface-1);
        box-shadow: var(--shadow-sm);
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
        transition:
          color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard);
      }
      .studio-shot-del:hover {
        color: var(--err);
        background: var(--bg-surface-2);
      }
      .studio-shot-line {
        display: flex;
        gap: var(--space-2);
      }
      .studio-shot-line .input:first-child {
        flex: 1;
        min-width: 0;
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
        padding: var(--space-1) 0;
        transition: color var(--duration-fast) var(--ease-standard);
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
        min-width: 0;
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .studio-shot-error {
        font-size: var(--text-label);
        color: var(--err);
      }
      .studio-shot-actions {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
        padding-top: var(--space-2);
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
        border-radius: var(--radius-panel);
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
        min-width: 0;
        display: -webkit-box;
        -webkit-box-orient: vertical;
        -webkit-line-clamp: 2;
        overflow: hidden;
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
        background: var(--bg-canvas);
      }
      .studio-final .btn {
        align-self: flex-start;
      }

      /* ── 窄屏 <1024px:内容区 padding 对齐 single-view ── */
      @media (max-width: 1023px) {
        .studio-home,
        .studio-view {
          padding: var(--space-5);
        }
      }

      /* ── 移动 <768px:触控目标 ≥44px,时间轴压缩,项目标题让位 ── */
      @media (max-width: 767px) {
        .studio-home,
        .studio-view {
          padding: var(--space-4);
        }
        .studio-view-title {
          display: none;
        }
        .studio-back,
        .studio-stage-btn {
          min-height: 44px;
        }
        .studio-shot-del {
          width: 44px;
          height: 44px;
        }
        .studio-shot-adv-toggle {
          min-height: 44px;
        }
        .studio-timeline-item {
          grid-template-columns: 28px 120px 1fr;
          gap: var(--space-2);
        }
      }

      /* 小屏:阶段条横向滑动(右缘渐隐暗示可滑) */
      @media (max-width: 767px) {
        .studio-stages {
          gap: var(--space-2);
        }
        .studio-stage-tabs {
          -webkit-mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);
          mask-image: linear-gradient(to right, black calc(100% - 28px), transparent);
        }
      }

      /* ── 小屏 <576px ── */
      @media (max-width: 575px) {
        .studio-home,
        .studio-view {
          padding: var(--space-3);
        }
        .studio-timeline-item {
          grid-template-columns: 24px 88px 1fr;
        }
      }

      @media (prefers-reduced-motion: reduce) {
        .studio-project-open,
        .studio-stage-btn,
        .studio-shot,
        .studio-char,
        .studio-back,
        .studio-shot-del,
        .studio-shot-mode button,
        .studio-shot-adv-toggle {
          transition: none;
        }
      }
    `}</style>
  );
}
