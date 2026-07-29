"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";

import {
  listDramaProjects,
  deleteDramaProject,
  imageUrl,
} from "@/lib/api";
import { consumeEngineDraft } from "@/lib/engine";
import type {
  DramaProjectSummary,
  DramaProjectDetail,
  DramaProjectPatch,
  DramaShotItem,
} from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { SkillMarket } from "@/components/drama-studio/SkillMarket";
import { NewProjectPanel } from "@/components/drama-studio/NewProjectPanel";
import { ScriptTab } from "@/components/drama-studio/ScriptTab";
import { CharacterTab } from "@/components/drama-studio/CharacterTab";
import { AssetLibrary } from "@/components/drama-studio/AssetLibrary";
import { ShotTab } from "@/components/drama-studio/ShotTab";
import { DirectorPanel } from "@/components/drama-studio/ShotCard";
import { AssembleTab } from "@/components/drama-studio/AssembleTab";
import { ProcessTab } from "@/components/drama-studio/ProcessTab";
import { FilmstripTimeline } from "@/components/drama-studio/FilmstripTimeline";
import { AnalyticsPanel } from "@/components/drama-studio/AnalyticsPanel";
import { ManjuView } from "@/components/manju/ManjuView";
import { useDramaProject } from "@/hooks/useDramaProject";

interface DramaStudioViewProps {
  account?: string;
  onLogout?: () => void;
  onNavigate?: (view: string) => void;
}

type StudioView = "hub" | "workspace" | "cinema";
type StudioMode = "drama" | "manju";
type StageKey = "script" | "character" | "asset" | "shot" | "assemble" | "process" | "data";

const STAGES: { key: StageKey; label: string; icon: IconName }[] = [
  { key: "script", label: "剧本", icon: "filevideo" },
  { key: "character", label: "角色", icon: "users" },
  { key: "asset", label: "资产", icon: "box" },
  { key: "shot", label: "分镜", icon: "film" },
  { key: "assemble", label: "合成", icon: "playing" },
  { key: "process", label: "过程", icon: "history" },
  { key: "data", label: "数据", icon: "barchart" },
];

const SKILL_CHIPS = [
  { id: "hit", name: "爆款短剧复刻", desc: "上传参考视频，Agent 自动拉片重制", shots: "24 镜 · 45 秒", accent: "#f59e0b" },
  { id: "romance", name: "都市言情节奏", desc: "对话情绪递进 + 反转卡点", shots: "18 镜 · 60 秒", accent: "#ec4899" },
  { id: "wuxia", name: "古风武侠快剪", desc: "慢动作 + 环绕运镜 + 水墨调色", shots: "22 镜 · 55 秒", accent: "#3b82f6" },
  { id: "scifi", name: "3D 科幻预演", desc: "角色一致 + 虚拟场景 + 双语字幕", shots: "30 镜 · 90 秒", accent: "#a855f7" },
];

function projectStatusMeta(status: string): { label: string; cls: string } {
  const s = (status || "").toLowerCase();
  if (s === "ready") return { label: "成片完成", cls: "ready" };
  if (s === "storyboard") return { label: "已拆分镜", cls: "story" };
  return { label: "草稿", cls: "draft" };
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    const diff = Date.now() - d.getTime();
    const min = 60_000;
    const hr = 60 * min;
    const day = 24 * hr;
    if (diff < min) return "刚刚";
    if (diff < hr) return `${Math.floor(diff / min)} 分钟前`;
    if (diff < day) return `${Math.floor(diff / hr)} 小时前`;
    if (diff < 7 * day) return `${Math.floor(diff / day)} 天前`;
    return d.toLocaleDateString("zh-CN");
  } catch {
    return iso;
  }
}

function formatDuration(sec: number): string {
  if (!sec || sec <= 0) return "00:00";
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

export function DramaStudioView({ account, onLogout, onNavigate }: DramaStudioViewProps) {
  const engineDraft = useMemo(() => consumeEngineDraft(), []);
  const searchParams = useSearchParams();

  // ── 项目列表 ──
  const [projects, setProjects] = useState<DramaProjectSummary[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string>("");

  // ── 视图状态 ──
  const initialStudioMode: StudioMode =
    searchParams.get("mode") === "manju" || engineDraft?.target === "manju"
      ? "manju"
      : "drama";
  const [studioMode, setStudioMode] = useState<StudioMode>(initialStudioMode);
  const [studioView, setStudioView] = useState<StudioView>(engineDraft?.target === "drama" ? "workspace" : "hub");
  const [activeId, setActiveId] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<StageKey>("script");

  // ── Skill Hub / 新建项目 ──
  const [showSkillHub, setShowSkillHub] = useState(false);
  const [showNewProject, setShowNewProject] = useState(engineDraft?.target === "drama");
  const [manjuInitialActiveId, setManjuInitialActiveId] = useState<string | null>(null);

  // ── 删除确认 ──
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const timersRef = useRef<Set<number>>(new Set());
  const safeSetTimeout = useCallback((fn: () => void, ms: number): number => {
    const id = window.setTimeout(() => {
      timersRef.current.delete(id);
      fn();
    }, ms);
    timersRef.current.add(id);
    return id;
  }, []);

  useEffect(() => {
    return () => {
      timersRef.current.forEach((id) => clearTimeout(id));
      timersRef.current.clear();
    };
  }, []);

  const { show: showToast } = useToast();

  const handleSummaryChange = useCallback(
    (id: string, patch: Partial<DramaProjectSummary>) => {
      setProjects((prev) =>
        prev.map((p) => (p.id === id ? { ...p, ...patch } : p)),
      );
    },
    [],
  );

  const project = useDramaProject(activeId, handleSummaryChange);

  useEffect(() => {
    if (activeId) project.reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // ── 加载项目列表 ──
  const loadList = useCallback(() => {
    setListLoading(true);
    setListError("");
    listDramaProjects()
      .then((list) => setProjects(list))
      .catch((err) =>
        setListError(err instanceof Error ? err.message : "加载项目失败"),
      )
      .finally(() => setListLoading(false));
  }, []);

  useEffect(() => {
    loadList();
  }, [loadList]);

  // ── 打开/关闭项目 ──
  const openProject = useCallback((pid: string) => {
    setActiveId(pid);
    setStudioView("workspace");
    setActiveStage("script");
    setShowSkillHub(false);
    setShowNewProject(false);
  }, []);

  const openHub = useCallback(() => {
    setActiveId(null);
    setStudioView("hub");
    setShowSkillHub(false);
    setShowNewProject(false);
  }, []);

  // ── 删除项目 ──
  const handleDelete = useCallback(
    (pid: string, title: string) => {
      setDeletingId(pid);
      deleteDramaProject(pid)
        .then(() => {
          setProjects((prev) => prev.filter((p) => p.id !== pid));
          if (activeId === pid) openHub();
          setDeleteConfirmId(null);
          showToast("success", `项目「${title}」已删除`);
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "删除项目失败",
          ),
        )
        .finally(() => setDeletingId(null));
    },
    [activeId, openHub, showToast],
  );

  // ── Skill 应用 / 新建项目回调 ──
  const handleSkillApplied = useCallback(
    (detail: DramaProjectDetail) => {
      setShowSkillHub(false);
      const summary: DramaProjectSummary = {
        id: detail.id,
        title: detail.title,
        premise: detail.premise ?? "",
        style: detail.style ?? "",
        script: detail.script ?? "",
        status: detail.status,
        video_url: detail.video_url ?? "",
        duration_sec: detail.duration_sec ?? 0,
        width: detail.width ?? 768,
        height: detail.height ?? 384,
        fps: detail.fps ?? 16,
        created_at: detail.created_at,
        updated_at: detail.updated_at,
      };
      setProjects((prev) => [summary, ...prev]);
      showToast("success", `项目「${detail.title}」已创建`);
      openProject(detail.id);
    },
    [openProject, showToast],
  );

  const handleCreated = useCallback(
    (id: string, type: "drama" | "manju") => {
      setShowNewProject(false);
      if (type === "manju") {
        setManjuInitialActiveId(id);
        setStudioMode("manju");
        return;
      }
      loadList();
      openProject(id);
    },
    [loadList, openProject],
  );

  // ── 项目头部编辑 ──
  const [editingProject, setEditingProject] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editPremise, setEditPremise] = useState("");
  const [editStyle, setEditStyle] = useState("");
  const [editScript, setEditScript] = useState("");
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState<string>("");

  const startEditProject = useCallback(() => {
    const c = project.current;
    if (!c) return;
    setEditTitle(c.title ?? "");
    setEditPremise(c.premise ?? "");
    setEditStyle(c.style ?? "");
    setEditScript(c.script ?? "");
    setEditError("");
    setEditingProject(true);
  }, [project.current]);

  const handleUpdateProject = useCallback(() => {
    if (!project.current) return;
    if (!editTitle.trim()) {
      setEditError("标题不能为空");
      return;
    }
    setEditSaving(true);
    setEditError("");
    const body: DramaProjectPatch = {
      title: editTitle.trim(),
      ...(editPremise.trim() ? { premise: editPremise.trim() } : {}),
      ...(editStyle.trim() ? { style: editStyle.trim() } : {}),
      script: editScript,
    };
    project
      .patchProject(body)
      .then(() => {
        setEditingProject(false);
        showToast("success", "项目已更新");
      })
      .catch((err) =>
        setEditError(err instanceof Error ? err.message : "更新项目失败"),
      )
      .finally(() => setEditSaving(false));
  }, [project, editTitle, editPremise, editStyle, editScript, showToast]);

  // ── 当前分镜 ──
  const [selectedShotId, setSelectedShotId] = useState<string | null>(null);
  const shots = project.shots;
  const selectedShot = selectedShotId
    ? shots.find((s) => s.id === selectedShotId) ?? shots[0]
    : shots[0];

  const handleSelectShot = useCallback(
    (sid: string) => {
      setSelectedShotId(sid);
      project.setSelectedShotId(sid);
    },
    [project.setSelectedShotId],
  );

  // ── 面板折叠状态 ──
  // M1.1: 右侧面板默认收起(检查器模式),选中分镜时自动展开
  const [rightCollapsed, setRightCollapsed] = useState(true);
  // M4: 底部时间线默认展开
  const [filmstripCollapsed, setFilmstripCollapsed] = useState(false);
  const [taskDropdownOpen, setTaskDropdownOpen] = useState(false);
  const taskDropdownRef = useRef<HTMLDivElement>(null);

  // M1.1: 选中分镜时自动展开右侧检查器,取消选中时自动收起
  // 仅在 selectedShotId 显式变化时触发,不影响手动 toggle
  useEffect(() => {
    if (selectedShotId) {
      setRightCollapsed(false);
    } else {
      setRightCollapsed(true);
    }
  }, [selectedShotId]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (taskDropdownRef.current && !taskDropdownRef.current.contains(e.target as Node)) {
        setTaskDropdownOpen(false);
      }
    }
    if (taskDropdownOpen) {
      document.addEventListener("mousedown", handleClickOutside);
      return () => document.removeEventListener("mousedown", handleClickOutside);
    }
  }, [taskDropdownOpen]);

  // ── 键盘快捷键 ──
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const target = e.target as HTMLElement;
      const isInput =
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA" ||
        target.isContentEditable;

      // Esc 关闭弹窗/面板
      if (e.key === "Escape" && !isInput) {
        if (taskDropdownOpen) setTaskDropdownOpen(false);
        else if (project.directorOverlayShot) project.closeDirectorOverlay();
        else if (showNewProject) setShowNewProject(false);
        else if (showSkillHub) setShowSkillHub(false);
        else if (editingProject) setEditingProject(false);
        else if (project.refPreview) project.setRefPreview(null);
        return;
      }

      if (studioView !== "workspace") return;

      // ⌘S 保存项目(编辑模式)
      if (mod && e.key === "s" && editingProject) {
        e.preventDefault();
        handleUpdateProject();
        return;
      }

      if (isInput) return;

      // ⌘1~7 切换 Tab
      if (mod && e.key >= "1" && e.key <= "7") {
        e.preventDefault();
        const stages: StageKey[] = ["script", "character", "asset", "shot", "assemble", "process", "data"];
        const idx = parseInt(e.key) - 1;
        if (stages[idx]) setActiveStage(stages[idx]);
      }
    }
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [studioView, taskDropdownOpen, showNewProject, showSkillHub, editingProject, project.refPreview, project.setRefPreview, setActiveStage, handleUpdateProject, setTaskDropdownOpen, setShowNewProject, setShowSkillHub, setEditingProject]);

  useEffect(() => {
    if (shots.length > 0 && !selectedShot) {
      setSelectedShotId(shots[0].id);
      project.setSelectedShotId(shots[0].id);
    }
  }, [shots, selectedShot, project.setSelectedShotId]);

  // ── 主区渲染 ──
  const renderMain = () => {
    if (studioMode === "manju") {
      return (
        <div className="manju-embed">
          <ManjuView initialActiveId={manjuInitialActiveId ?? undefined} />
        </div>
      );
    }

    if (studioView === "hub") {
      return (
        <div className="hub-view">
          <div className="hero-bar">
            <div className="hero-text">
              <h1>导演控制中心</h1>
              <p>基于本地 ComfyUI 集群与 AICG 共享算力，把剧本一键拆分为可交付的短剧成片。选一个 Skill 模板，或从零开始创作。</p>
            </div>
            <div className="hero-actions">
              <button
                type="button"
                className="btn btn-primary"
                onClick={() => {
                  setShowNewProject(true);
                  setStudioView("workspace");
                }}
              >
                <Icon name="create" size={14} />
                新建项目
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => setShowSkillHub(true)}
              >
                <Icon name="sparkles" size={14} />
                浏览 Skill
              </button>
            </div>
          </div>

          <div className="section-head">
            <h2><span className="dot" /> 推荐 Skill</h2>
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => setShowSkillHub(true)}
            >
              查看全部 →
            </button>
          </div>
          <div className="skills-row">
            {SKILL_CHIPS.map((s) => (
              <div
                key={s.id}
                className="skill-chip"
                style={{ "--chip-accent": s.accent } as React.CSSProperties}
                onClick={() => setShowSkillHub(true)}
              >
                <b>{s.name}</b>
                <span>{s.desc}</span>
                <span className="shots">{s.shots}</span>
              </div>
            ))}
          </div>

          <div className="section-head">
            <h2><span className="dot" /> 最近项目</h2>
            <span className="tag">{projects.length} 个项目</span>
          </div>
          {listLoading && (
            <div className="loading-spinner hub-loading">
              <Icon name="loading" size={18} className="ds-spin" />
              <span>加载项目…</span>
            </div>
          )}
          {listError && !listLoading && (
            <div className="hub-error">
              <Icon name="error" size={20} />
              <span>{listError}</span>
              <button type="button" className="btn btn-sm" onClick={loadList}>
                <Icon name="refresh" size={12} />
                重试
              </button>
            </div>
          )}
          {!listLoading && !listError && projects.length === 0 && (
            <div className="hub-empty">
              <Icon name="drama" size={40} strokeWidth={1.3} />
              <span>暂无项目</span>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={() => {
                  setShowNewProject(true);
                  setStudioView("workspace");
                }}
              >
                新建第一个
              </button>
            </div>
          )}
          {!listLoading && !listError && projects.length > 0 && (
            <div className="project-grid">
              {projects.map((p) => {
                const active = p.id === activeId;
                const sMeta = projectStatusMeta(p.status);
                return (
                  <div
                    key={p.id}
                    className={`project-card ${active ? "active" : ""}`}
                    onClick={() => openProject(p.id)}
                  >
                    <div className="proj-thumb">
                      <Icon name="film" size={24} strokeWidth={1.3} />
                    </div>
                    <div className="proj-title" title={p.title}>
                      {p.title || "未命名"}
                    </div>
                    {p.premise && <div className="proj-premise">{p.premise}</div>}
                    <div className="proj-meta">
                      <span className={`proj-status ${sMeta.cls}`}>{sMeta.label}</span>
                      <span>{formatTime(p.updated_at || p.created_at)}</span>
                    </div>
                    <button
                      type="button"
                      className="proj-del"
                      title="删除项目"
                      onClick={(e) => {
                        e.stopPropagation();
                        const isConfirming = deleteConfirmId === p.id;
                        if (deletingId) return;
                        if (isConfirming) {
                          handleDelete(p.id, p.title || "未命名");
                        } else {
                          setDeleteConfirmId(p.id);
                          safeSetTimeout(() => {
                            setDeleteConfirmId((cur) => (cur === p.id ? null : cur));
                          }, 4000);
                        }
                      }}
                      disabled={deletingId === p.id}
                    >
                      <Icon
                        name={deletingId === p.id ? "loading" : "delete"}
                        size={12}
                        className={deletingId === p.id ? "ds-spin" : undefined}
                      />
                      {deleteConfirmId === p.id ? "确认?" : ""}
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      );
    }

    if (studioView === "cinema") {
      const current = project.current;
      return (
        <div className="cinema-view">
          <div className="cinema-screen">
            {current?.video_url ? (
              <video
                src={imageUrl(current.video_url)}
                controls
                autoPlay
                playsInline
                preload="metadata"
              />
            ) : (
              <div className="cinema-placeholder">
                <Icon name="playing" size={48} strokeWidth={1.2} />
                <span>暂无成片，请先到工作台合成</span>
              </div>
            )}
          </div>
          <div className="cinema-info">
            <div>
              <div className="cinema-title">{current?.title || "未命名项目"}</div>
              <div className="cinema-meta">
                {current && (
                  <>
                    {current.width}×{current.height} · {current.fps}fps ·{" "}
                    {formatDuration(current.duration_sec || 0)}
                  </>
                )}
              </div>
            </div>
            <div className="cinema-actions">
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => setStudioView("workspace")}
              >
                <Icon name="canvas" size={13} />
                返回工作台
              </button>
              {current?.video_url && (
                <a
                  className="btn btn-primary btn-sm"
                  href={imageUrl(current.video_url)}
                  target="_blank"
                  rel="noreferrer"
                >
                  <Icon name="download" size={13} />
                  下载成片
                </a>
              )}
            </div>
          </div>
        </div>
      );
    }

    // workspace
    const current = project.current;
    if (!current) {
      if (showNewProject) {
        return (
          <div className="workspace-empty">
            <NewProjectPanel
              onCancel={() => {
                setShowNewProject(false);
                setStudioView("hub");
              }}
              onCreated={handleCreated}
              initialDraft={
                engineDraft?.target === "drama"
                  ? { title: engineDraft.prompt.slice(0, 80), script: engineDraft.prompt }
                  : undefined
              }
            />
          </div>
        );
      }
      return (
        <div className="workspace-empty">
          <Icon name="drama" size={48} strokeWidth={1.2} />
          <div className="workspace-empty-title">选择一个项目开始创作</div>
          <button type="button" className="btn btn-primary" onClick={openHub}>
            返回项目中心
          </button>
        </div>
      );
    }

    const sMeta = projectStatusMeta(current.status);

    return (
      <div className="workspace-view">
        <div className="workspace-header">
          <div className="workspace-title">
            <h2>{current.title}</h2>
            <div className="workspace-meta">
              <span className={`proj-status ${sMeta.cls}`}>{sMeta.label}</span>
              {current.style && <span className="tag">{current.style}</span>}
              <span className="spec">{current.width}×{current.height} · {current.fps}fps</span>
              <span className="time"><Icon name="queued" size={11} /> {formatTime(current.updated_at || current.created_at)}</span>
            </div>
          </div>
          <div className="workspace-actions">
            {editingProject ? (
              <>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setEditingProject(false)}
                  disabled={editSaving}
                >
                  取消
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={handleUpdateProject}
                  disabled={editSaving}
                >
                  {editSaving ? (
                    <><Icon name="loading" size={13} className="ds-spin" /> 保存中</>
                  ) : (
                    <><Icon name="check" size={13} /> 保存</>
                  )}
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn btn-sm" onClick={startEditProject}>
                  <Icon name="create" size={12} /> 编辑
                </button>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setStudioView("cinema")}
                >
                  <Icon name="playing" size={12} /> 放映厅
                </button>
                <button
                  type="button"
                  className="btn btn-primary btn-sm"
                  onClick={project.assemble}
                  disabled={project.assembling}
                >
                  {project.assembling ? (
                    <><Icon name="loading" size={13} className="ds-spin" /> 合成中</>
                  ) : (
                    <><Icon name="playing" size={13} /> 一键成片</>
                  )}
                </button>
              </>
            )}
          </div>
        </div>

        {editingProject && (
          <div className="edit-panel">
            <label className="prop-row">
              <span>标题</span>
              <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} />
            </label>
            <label className="prop-row">
              <span>简介</span>
              <input value={editPremise} onChange={(e) => setEditPremise(e.target.value)} />
            </label>
            <label className="prop-row">
              <span>风格</span>
              <input value={editStyle} onChange={(e) => setEditStyle(e.target.value)} />
            </label>
            <label className="prop-row">
              <span>剧本</span>
              <textarea
                rows={5}
                value={editScript}
                onChange={(e) => setEditScript(e.target.value)}
              />
            </label>
            {editError && <div className="edit-error">{editError}</div>}
          </div>
        )}

        <div className="workspace-body">
          <div className="main-panel-wrap">
            <div className="main-panel">
              {activeStage === "script" && <ScriptTab project={project} />}
              {activeStage === "character" && <CharacterTab project={project} />}
              {activeStage === "asset" && <AssetLibrary project={project} />}
              {activeStage === "shot" && (
                <ShotTab project={project} onGoToScript={() => setActiveStage("script")} />
              )}
              {activeStage === "assemble" && (
                <AssembleTab project={project} onGoToShot={() => setActiveStage("shot")} />
              )}
              {activeStage === "process" && <ProcessTab project={project} />}
              {activeStage === "data" && (
                <AnalyticsPanel projectId={project.current?.id ?? ""} />
              )}
            </div>
            <button
              type="button"
              className={`panel-toggle right-toggle ${rightCollapsed ? "collapsed" : ""}`}
              title={rightCollapsed ? "展开右侧面板" : "收起右侧面板"}
              onClick={() => setRightCollapsed((v) => !v)}
            >
              <Icon name={rightCollapsed ? "chevron-left" : "chevron-right"} size={12} />
            </button>
          </div>

          <aside className="right-panel">
            <div className="r-panel">
              <div className="r-panel-head"><h4>项目设定</h4></div>
              <div className="r-prop"><label>标题</label><div className="r-val">{current.title}</div></div>
              <div className="r-prop"><label>风格</label><div className="r-val">{current.style || "—"}</div></div>
              <div className="r-prop"><label>简介</label><div className="r-val">{current.premise || "—"}</div></div>
              <div className="r-prop compact">
                <label>分辨率</label>
                <span className="tag">{current.width} × {current.height}</span>
              </div>
              <div className="r-prop compact">
                <label>FPS</label>
                <span className="tag">{current.fps}</span>
              </div>
            </div>

            <div className="r-panel">
              <div className="r-panel-head"><h4>视频模型</h4></div>
              <div className="r-prop compact">
                <label>当前模型</label>
                <select
                  value={project.videoModel}
                  onChange={(e) => project.setVideoModel(e.target.value)}
                  disabled={project.videoModelLoading}
                >
                  {project.videoGenerators.length === 0 && <option value="ltx">ltx (local)</option>}
                  {project.videoGenerators.map((g) => (
                    <option key={g.name} value={g.name}>{g.display_name || g.name}</option>
                  ))}
                </select>
              </div>
              <div className="r-prop compact"><label>Worker</label><span className="tag">192.168.71.127:8188</span></div>
            </div>

            {selectedShot && (
              <div className="r-panel">
                <div className="r-panel-head"><h4>当前分镜 #{selectedShot.idx}</h4></div>
                <div className="r-prop"><label>场景</label><div className="r-val">{selectedShot.scene || "—"}</div></div>
                <div className="r-prop"><label>提示词</label><div className="r-val mono">{selectedShot.prompt || "—"}</div></div>
                <div className="r-prop"><label>台词</label><div className="r-val">{selectedShot.dialogue || "—"}</div></div>
                <div className="r-prop compact"><label>说话人</label><span className="tag">{selectedShot.speaker || "narrator"}</span></div>
                <div className="r-prop compact"><label>时长</label><span className="tag">{selectedShot.duration_sec || 0}s</span></div>
              </div>
            )}
          </aside>
        </div>
      </div>
    );
  };

  const comfyWorkerCount = 6;

  return (
    <div
      className={`studio-shell ${studioMode === "manju" ? "manju-mode" : ""} ${rightCollapsed ? "right-collapsed" : ""} ${filmstripCollapsed ? "film-collapsed" : ""}`}
    >
      {/* 顶部导航 */}
      <header className="studio-topbar">
        <div className="brand">
          <div className="brand-mark">T</div>
          <div className="brand-text">
            <span className="brand-name">ToIV</span>
            <span className="brand-sub">AI Studio</span>
          </div>
        </div>
        <div className="topbar-center">
          <div className="studio-title">工作室</div>
        </div>
        <div className="topbar-right">
          <span className="status-pill">
            <span className="led" />
            ComfyUI · {comfyWorkerCount} workers
          </span>
          {project.activeTaskCount > 0 && (
            <div className="task-pill-wrap" ref={taskDropdownRef}>
              <button
                type="button"
                className={`task-pill task-pill-btn${taskDropdownOpen ? " is-open" : ""}`}
                onClick={() => setTaskDropdownOpen((v) => !v)}
                title={project.activeTaskLabel}
              >
                <Icon name="loading" size={11} className="ds-spin" />
                {project.activeTaskCount} 任务进行中
                <Icon name="chevron-down" size={10} className={`task-pill-caret${taskDropdownOpen ? " is-up" : ""}`} />
              </button>
              {taskDropdownOpen && (
                <div className="task-dropdown">
                  <div className="task-dropdown-head">
                    <span>进行中的任务</span>
                    {project.activeTaskCount > 0 && (
                      <span className="task-dropdown-count">{project.activeTaskCount}</span>
                    )}
                  </div>
                  <ul className="task-dropdown-list">
                    {project.activeTasks.length === 0 && (
                      <li className="task-dropdown-item task-dropdown-empty">
                        <span className="task-dropdown-label">暂无进行中任务</span>
                      </li>
                    )}
                    {project.activeTasks.map((t) => (
                      <li key={t.key} className="task-dropdown-item">
                        <span className="task-dropdown-dot" />
                        <span className="task-dropdown-label">{t.label}</span>
                        {t.detail && <span className="task-dropdown-detail">{t.detail}</span>}
                      </li>
                    ))}
                  </ul>
                  {/* M3.1:已完成任务分区(最近 10 条,从 localStorage 恢复) */}
                  {project.taskLog.filter((e) => e.status !== "running").length > 0 && (
                    <>
                      <div className="task-dropdown-head task-dropdown-head-done">
                        <span>已完成</span>
                      </div>
                      <ul className="task-dropdown-list">
                        {project.taskLog
                          .filter((e) => e.status !== "running")
                          .slice(0, 10)
                          .map((e) => (
                            <li
                              key={`done-${e.key}-${e.startedAt}`}
                              className="task-dropdown-item task-dropdown-item-done"
                            >
                              <Icon
                                name={e.status === "error" ? "error" : "success"}
                                size={11}
                              />
                              <span className="task-dropdown-label">{e.label}</span>
                              <span className="task-dropdown-time">
                                {new Date(e.endedAt ?? e.startedAt).toLocaleTimeString(
                                  "zh-CN",
                                  { hour12: false },
                                )}
                              </span>
                            </li>
                          ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setShowSkillHub(true)}
          >
            <Icon name="sparkles" size={13} /> Skill Hub
          </button>
          <button
            type="button"
            className="btn btn-primary btn-sm"
            onClick={() => {
              setShowNewProject(true);
              setStudioView("workspace");
            }}
          >
            <Icon name="create" size={13} /> 新建项目
          </button>
          {account && (
            <button type="button" className="account-btn" title={account}>
              <span className="account-avatar">{account.slice(0, 1).toUpperCase()}</span>
            </button>
          )}
        </div>
      </header>

      {/* 左侧阶段栏 */}
      {studioMode === "drama" && (
        <nav className="stage-sidebar" aria-label="创作阶段">
          {STAGES.map((s) => (
            <button
              key={s.key}
              type="button"
              className={`stage-item ${activeStage === s.key ? "active" : ""}`}
              onClick={() => {
                setActiveStage(s.key);
                if (studioView !== "workspace") setStudioView("workspace");
              }}
              title={s.label}
            >
              <Icon name={s.icon} size={18} />
              <span>{s.label}</span>
            </button>
          ))}
          <div className="stage-sidebar-foot">
            <button
              type="button"
              className="stage-item"
              onClick={() => setShowSkillHub(true)}
              title="Skill Hub"
            >
              <Icon name="braincircuit" size={18} />
              <span>Agent</span>
            </button>
          </div>
        </nav>
      )}

      {/* 主舞台 */}
      {/* 本视图在 page.tsx 中以独立分支渲染(不带 app-main),自带 main 地标 + skip-link 锚点 */}
      <main id="main" className="stage-main">
        <h1 className="sr-only">工作室</h1>
        {renderMain()}
      </main>

      {/* 底部胶片时间线 */}
      {studioMode === "drama" && studioView === "workspace" && project.current && shots.length > 0 && (
        <FilmstripTimeline
          shots={shots}
          selectedShotId={selectedShotId}
          onSelectShot={handleSelectShot}
          collapsed={filmstripCollapsed}
          onToggleCollapse={() => setFilmstripCollapsed((v) => !v)}
        />
      )}

      {/* M2.3:导演台 overlay(全屏聚焦 2D 编辑) */}
      {project.directorOverlayShot && (
        <div
          className="overlay ds-director-overlay"
          onClick={() => project.closeDirectorOverlay()}
        >
          <div
            className="overlay-panel ds-director-overlay-panel"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="overlay-head">
              <h2>
                <Icon name="canvas" size={16} />
                导演台 · 分镜 #{project.directorOverlayShot.idx}
              </h2>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => project.closeDirectorOverlay()}
                title="关闭(Esc)"
              >
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="ds-director-body">
              {project.directorLayout ? (
                <DirectorPanel
                  shot={project.directorOverlayShot}
                  characters={project.characters}
                  layout={project.directorLayout}
                  onLayoutChange={project.directorLayoutChange}
                  busy={project.directorBusy}
                  loading={project.directorLoading}
                  onSave={(g) =>
                    project.saveDirector(project.directorOverlayShot!, g)
                  }
                />
              ) : (
                <div className="ds-director-loading">
                  <Icon name="loading" size={16} className="ds-spin" />
                  <span>加载场景布局…</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Skill Hub 浮层 */}
      {showSkillHub && (
        <div className="overlay" onClick={() => setShowSkillHub(false)}>
          <div className="overlay-panel" onClick={(e) => e.stopPropagation()}>
            <div className="overlay-head">
              <h2><Icon name="sparkles" size={18} /> Skill Hub · 导演级工作流</h2>
              <button type="button" className="btn btn-sm" onClick={() => setShowSkillHub(false)}>
                <Icon name="close" size={13} />
              </button>
            </div>
            <div className="overlay-body">
              <SkillMarket
                onApplied={handleSkillApplied}
                onClose={() => setShowSkillHub(false)}
              />
            </div>
          </div>
        </div>
      )}

      {/* 图片大图预览 */}
      {project.refPreview && (
        <div
          className="ref-overlay"
          onClick={() => project.setRefPreview(null)}
        >
          <div className="ref-overlay-inner" onClick={(e) => e.stopPropagation()}>
            <div className="ref-overlay-head">
              <span><Icon name="eye" size={13} /> {project.refPreview.label}</span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => project.setRefPreview(null)}
              >
                <Icon name="close" size={12} />
              </button>
            </div>
            <img
              src={imageUrl(project.refPreview.url)}
              alt={project.refPreview.label}
            />
          </div>
        </div>
      )}

      <style jsx global>{`
        /* 工作室视觉统一:复用全局设计令牌,不再覆盖 :root,跟随系统 light/dark 主题 */

        /* 通用:ds-spin / ds-section / ds-empty */
        .ds-spin { animation: dsspin 0.8s linear infinite; }
        @keyframes dsspin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .ds-spin { animation: none; } }
        .ds-section { display: flex; flex-direction: column; gap: 0.8rem; }
        .ds-section.card { background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); padding: 1rem; }
        .ds-section-head { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
        .ds-section-title { font-size: 0.92rem; font-weight: 600; color: var(--ink); display: inline-flex; align-items: center; gap: 0.4rem; }
        .ds-section-count { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 20px; padding: 0 0.45rem; background: var(--accent-quiet); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); border-radius: 999px; font-size: 0.68rem; font-weight: 700; color: var(--accent); font-family: var(--font-mono); }
        .ds-section-hint { margin-left: auto; font-size: 0.72rem; color: var(--ink3); font-family: var(--font-mono); }
        .ds-empty { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.6rem; padding: 2rem 1rem; color: var(--ink3); text-align: center; }
        .ds-empty-inline { padding: 1.5rem 1rem; }
        .studio-shell .empty-state-icon { opacity: 0.3; }
        .studio-shell .empty-state-title { color: var(--ink2); }
        .studio-shell .empty-state-desc { color: var(--ink3); }
        /* 表单 */
        .ds-input, .ds-textarea { width: 100%; padding: 0.45rem 0.6rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); color: var(--ink); font-size: 0.84rem; transition: border-color 0.15s ease; }
        .ds-input:focus, .ds-textarea:focus { outline: none; border-color: var(--accent); }
        .ds-textarea { resize: vertical; min-height: 80px; font-family: inherit; }
        .ds-field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
        .ds-field-sm { max-width: 110px; }
        .ds-field-label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

        /* ScriptTab: grid picker + preview */
        .ds-storyboard-controls { display: flex; align-items: center; gap: 0.55rem; flex-wrap: wrap; }
        .ds-grid-bar { position: relative; display: inline-flex; }
        .ds-grid-picker { position: absolute; top: calc(100% + 6px); left: 0; z-index: 20; display: flex; flex-direction: column; gap: 0.3rem; padding: 0.4rem; background: var(--bg-2); border: 1px solid var(--hairline-strong); border-radius: var(--radius); box-shadow: 0 8px 24px rgba(0,0,0,0.4); min-width: 180px; }
        .ds-grid-pick { display: flex; align-items: center; gap: 0.55rem; padding: 0.5rem 0.6rem; background: transparent; border: 1px solid transparent; border-radius: var(--radius-sm); color: var(--ink); cursor: pointer; text-align: left; transition: all 0.15s ease; }
        .ds-grid-pick:hover { background: var(--bg-3); border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent); }
        .ds-grid-pick span { display: flex; flex-direction: column; gap: 0.1rem; }
        .ds-grid-pick strong { font-size: 0.85rem; font-weight: 600; }
        .ds-grid-pick em { font-size: 0.68rem; color: var(--ink3); font-style: normal; }
        .ds-script-preview { border-top: 1px solid var(--hairline); padding-top: 0.7rem; margin-top: 0.2rem; }
        .ds-script-preview summary { cursor: pointer; font-size: 0.78rem; color: var(--ink2); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; user-select: none; padding: 0.3rem 0; }
        .ds-script-pre { width: 100%; padding: 0.7rem 0.8rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); color: var(--ink); font-size: 0.85rem; line-height: 1.65; font-family: var(--font-sans); resize: vertical; min-height: 180px; }
        .ds-script-pre:focus { outline: none; border-color: var(--accent); }
        .ds-grid-dl { margin-left: auto; }
        .ds-grid-loading { display: flex; align-items: center; justify-content: center; gap: 0.6rem; padding: 2rem; color: var(--ink3); }
        .ds-grid-image { display: grid; gap: 2px; border-radius: var(--radius); overflow: hidden; background: var(--bg-1); border: 1px solid var(--hairline); }
        .ds-grid-img { width: 100%; display: block; cursor: zoom-in; transition: opacity 0.15s ease; }
        .ds-grid-img:hover { opacity: 0.9; }
        .ds-grid-shots { list-style: none; margin: 0; padding: 0; display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 0.5rem; }
        .ds-grid-shot { display: flex; gap: 0.5rem; padding: 0.6rem 0.7rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); }
        .ds-grid-shot-idx { flex-shrink: 0; width: 28px; height: 22px; display: grid; place-items: center; background: var(--accent-quiet); color: var(--accent); font-size: 0.7rem; font-weight: 700; font-family: var(--font-mono); border-radius: 4px; }
        .ds-grid-shot-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 0.2rem; }
        .ds-grid-shot-scene { font-size: 0.82rem; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ds-grid-shot-prompt { margin: 0; font-size: 0.72rem; color: var(--ink2); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

        /* ShotTab + ShotCard */
        .ds-shots-section { padding: 1rem 0; }
        .ds-shots { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 0.8rem; }
        .ds-shots-empty { padding: 3rem 1rem; }
        .ds-shot-card { display: flex; flex-direction: column; gap: 0.6rem; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); padding: 0.8rem; transition: border-color 0.18s ease; }
        .ds-shot-card:hover { border-color: var(--hairline-strong); }
        .ds-shot-head { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; }
        .ds-shot-idx { display: inline-flex; align-items: center; gap: 0.4rem; font-size: 0.78rem; font-weight: 700; color: var(--accent); font-family: var(--font-mono); }
        .ds-shot-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; }
        .ds-shot-tag { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.15rem 0.45rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); font-size: 0.66rem; color: var(--ink2); font-family: var(--font-mono); }
        .ds-shot-tag-speaker { background: var(--accent-quiet); border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent); }
        .ds-shot-media { aspect-ratio: 16/9; background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--radius-sm); overflow: hidden; display: grid; place-items: center; color: var(--ink3); position: relative; }
        .ds-shot-media video, .ds-shot-media img { width: 100%; height: 100%; object-fit: cover; }
        .ds-shot-placeholder { display: flex; flex-direction: column; align-items: center; gap: 0.4rem; font-size: 0.72rem; }
        .ds-shot-body { display: flex; flex-direction: column; gap: 0.4rem; }
        .ds-shot-scene { font-size: 0.85rem; font-weight: 600; color: var(--ink); }
        .ds-shot-prompt { font-size: 0.76rem; color: var(--ink2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .ds-shot-dialogue { font-size: 0.74rem; color: var(--ink3); font-style: italic; padding: 0.3rem 0.5rem; background: var(--bg-3); border-radius: var(--radius-sm); border-left: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); }
        .ds-shot-audio, .ds-shot-voice { display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: var(--ink2); }
        .ds-shot-actions { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
        .ds-shot-edit { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--hairline); }
        .ds-shot-edit-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; }
        .ds-shot-video { width: 100%; }
        .ds-model-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .ds-model-label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
        .ds-model-select { padding: 0.3rem 0.5rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); color: var(--ink); font-size: 0.74rem; }
        .ds-model-select:focus { outline: none; border-color: var(--accent); }
        .ds-model-warn { font-size: 0.66rem; color: var(--danger); }
        .ds-mini-btn { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.22rem 0.45rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); color: var(--ink2); font-size: 0.68rem; cursor: pointer; transition: all 0.15s ease; }
        .ds-mini-btn:hover { background: var(--bg-3); color: var(--ink); border-color: var(--hairline-strong); }
        .ds-mini-btn-danger:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-quiet); }
        .ds-mini-btn-ref { font-size: 0.66rem; }

        /* M1:可视化流水线步骤条 */
        .ds-shot-pipeline { display: flex; align-items: center; gap: 0.35rem; padding: 0.35rem 0.45rem; background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--radius-sm); }
        .ds-pipeline-step { display: flex; align-items: center; gap: 0.35rem; }
        .ds-step-icon { width: 22px; height: 22px; display: grid; place-items: center; border-radius: var(--radius-full); background: var(--bg-3); color: var(--ink-faint); border: 1px solid var(--hairline); }
        .ds-step-icon.ds-step-done { background: var(--success-quiet); color: var(--success); border-color: color-mix(in srgb, var(--success) 35%, transparent); }
        .ds-step-icon.ds-step-run { background: var(--warn-quiet); color: var(--warn); border-color: color-mix(in srgb, var(--warn) 35%, transparent); }
        .ds-step-icon.ds-step-err { background: var(--danger-quiet); color: var(--danger); border-color: color-mix(in srgb, var(--danger) 35%, transparent); }
        .ds-step-icon.ds-step-pending { color: var(--ink-faint); }
        .ds-step-label { font-size: 0.68rem; color: var(--ink-soft); white-space: nowrap; }
        .ds-step-line { width: 12px; height: 1px; background: var(--hairline); }

        /* M1:候选视频网格 */
        .ds-candidate-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(140px, 1fr)); gap: 0.5rem; }
        .ds-candidate-item { display: flex; flex-direction: column; gap: 0.35rem; padding: 0.45rem; background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--radius-sm); transition: border-color 0.15s ease; }
        .ds-candidate-item:hover { border-color: var(--hairline-strong); }
        .ds-candidate-picked { border-color: var(--success); background: var(--success-quiet); }
        .ds-candidate-media { aspect-ratio: 16/9; background: var(--bg-2); border-radius: var(--radius-sm); overflow: hidden; display: grid; place-items: center; }
        .ds-candidate-media video { width: 100%; height: 100%; object-fit: cover; }
        .ds-candidate-placeholder { display: flex; flex-direction: column; align-items: center; gap: 0.25rem; font-size: 0.65rem; color: var(--ink-faint); padding: 0.4rem; text-align: center; }
        .ds-candidate-info { display: flex; flex-direction: column; gap: 0.15rem; }
        .ds-candidate-seed { font-size: 0.66rem; color: var(--ink-soft); font-family: var(--font-mono); }
        .ds-candidate-model { font-size: 0.62rem; color: var(--ink-faint); }
        .ds-candidate-error { font-size: 0.62rem; color: var(--danger); line-height: 1.4; }
        .ds-candidate-actions { display: flex; gap: 0.25rem; flex-wrap: wrap; }

        /* CharacterTab */
        .ds-char-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.8rem; }
        .ds-char-form { display: flex; flex-direction: column; gap: 0.6rem; padding: 1rem; background: var(--bg-2); border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent); border-radius: var(--radius); margin-bottom: 0.8rem; }
        .ds-char-form-title { font-size: 0.88rem; font-weight: 600; color: var(--accent); }
        .ds-char-ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
        .ds-char-item { display: grid; grid-template-columns: 80px 1fr auto; gap: 0.8rem; padding: 0.8rem; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); align-items: start; }
        .ds-char-ref-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.3rem; width: 80px; }
        .ds-char-ref-thumb { aspect-ratio: 3/4; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: 4px; overflow: hidden; display: grid; place-items: center; color: var(--ink3); font-size: 0.6rem; cursor: pointer; transition: border-color 0.15s ease; position: relative; }
        .ds-char-ref-thumb:hover { border-color: var(--accent); }
        .ds-char-ref-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .ds-char-ref-loading { color: var(--accent); animation: dsspin 1s linear infinite; }
        .ds-char-ref-label { position: absolute; bottom: 1px; left: 1px; padding: 0.05rem 0.2rem; background: rgba(0,0,0,0.7); font-size: 0.5rem; border-radius: 2px; }
        .ds-char-name { font-size: 0.88rem; font-weight: 600; color: var(--ink); }
        .ds-char-desc { font-size: 0.74rem; color: var(--ink2); line-height: 1.5; margin-top: 0.25rem; }
        .ds-char-voice { font-size: 0.7rem; color: var(--ink3); font-family: var(--font-mono); margin-top: 0.3rem; }
        .ds-char-vp { font-size: 0.68rem; color: var(--ink3); font-family: var(--font-mono); margin-top: 0.2rem; word-break: break-all; }
        .ds-char-add { margin-left: auto; }
        .ds-char-foot { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
        .ds-char-ref { position: relative; }

        /* AssetLibrary */
        .ds-asset-section { gap: 0.75rem; }
        .ds-asset-toolbar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; }
        .ds-asset-kind-filter { display: flex; align-items: center; gap: 0.3rem; }
        .ds-asset-kind-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.32rem 0.55rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink2);
          font-size: 0.72rem;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .ds-asset-kind-btn:hover { background: var(--bg-2); color: var(--ink); border-color: var(--hairline-strong); }
        .ds-asset-kind-btn.active { background: var(--accent-quiet); color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); }
        .ds-asset-search { position: relative; display: flex; align-items: center; flex: 1; min-width: 180px; max-width: 360px; }
        .ds-asset-search .icon { position: absolute; left: 0.55rem; color: var(--ink3); pointer-events: none; }
        .ds-asset-search-input {
          width: 100%;
          padding: 0.38rem 0.55rem 0.38rem 1.9rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink);
          font-size: 0.8rem;
          transition: border-color 0.15s ease;
        }
        .ds-asset-search-input:focus { outline: none; border-color: var(--accent); }
        .ds-asset-search-clear {
          position: absolute;
          right: 0.35rem;
          display: grid;
          place-items: center;
          width: 18px;
          height: 18px;
          padding: 0;
          background: transparent;
          border: none;
          color: var(--ink3);
          cursor: pointer;
        }
        .ds-asset-search-clear:hover { color: var(--ink); }
        .ds-asset-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
        .ds-asset-item {
          display: grid;
          grid-template-columns: 64px 1fr auto;
          gap: 0.75rem;
          padding: 0.75rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          align-items: start;
          transition: border-color 0.15s ease;
        }
        .ds-asset-item:hover { border-color: var(--hairline-strong); }
        .ds-asset-thumb {
          width: 64px;
          height: 64px;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          overflow: hidden;
          display: grid;
          place-items: center;
          color: var(--ink3);
        }
        .ds-asset-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .ds-asset-body { min-width: 0; display: flex; flex-direction: column; gap: 0.3rem; }
        .ds-asset-head { display: flex; align-items: center; gap: 0.45rem; flex-wrap: wrap; }
        .ds-asset-kind {
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.1rem 0.35rem;
          background: var(--accent-quiet);
          border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
          border-radius: var(--radius-sm);
          font-size: 0.62rem;
          color: var(--accent);
          font-weight: 600;
          text-transform: uppercase;
        }
        .ds-asset-name { font-size: 0.9rem; font-weight: 600; color: var(--ink); }
        .ds-asset-desc { font-size: 0.74rem; color: var(--ink2); line-height: 1.45; }
        .ds-asset-vp { font-size: 0.68rem; color: var(--ink3); font-family: var(--font-mono); word-break: break-all; display: flex; align-items: center; gap: 0.3rem; }
        .ds-asset-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; }
        .ds-asset-tag {
          display: inline-flex;
          align-items: center;
          padding: 0.1rem 0.4rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: 999px;
          font-size: 0.65rem;
          color: var(--ink2);
        }
        .ds-asset-actions { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
        .ds-mini-btn-primary { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 35%, transparent); background: var(--accent-quiet); }
        .ds-mini-btn-primary:hover { background: color-mix(in srgb, var(--accent) 15%, var(--bg-3)); color: var(--accent); }
        .ds-mini-btn-primary:disabled { opacity: 0.6; cursor: not-allowed; }

        /* AssembleTab */
        .ds-assemble { display: flex; flex-direction: column; gap: 0.8rem; }
        .ds-assemble-row { display: flex; align-items: center; justify-content: space-between; gap: 0.8rem; padding: 0.8rem 1rem; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); }
        .ds-assemble-hint { font-size: 0.85rem; color: var(--ink2); }
        .ds-assemble-result { display: flex; flex-direction: column; gap: 0.6rem; padding: 0.8rem 1rem; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); }
        .ds-assemble-result-head { display: flex; align-items: center; gap: 0.5rem; font-size: 0.88rem; font-weight: 600; color: var(--color-success); flex-wrap: wrap; }
        .ds-assemble-dur { margin-left: auto; font-size: 0.75rem; color: var(--ink3); font-family: var(--font-mono); }
        .ds-assemble-video { width: 100%; max-height: 60vh; border-radius: var(--radius-sm); background: #000; }

        /* ProcessTab + Director */
        .ds-process-section { display: flex; flex-direction: column; gap: 0.8rem; }
        .ds-process-content { display: flex; flex-direction: column; gap: 0.8rem; }
        .ds-process-empty { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; padding: 3rem 1rem; color: var(--ink3); text-align: center; }
        .ds-process-refresh { margin-left: auto; }
        .ds-process-timeline { position: relative; display: flex; flex-direction: column; gap: 0; padding-left: 1.4rem; }
        .ds-process-rail { position: absolute; left: 7px; top: 4px; bottom: 4px; width: 2px; background: var(--hairline); }
        .ds-process-node { position: relative; padding: 0.6rem 0 1rem; }
        .ds-process-node::before { content: ""; position: absolute; left: -1.4rem; top: 0.9rem; width: 16px; height: 16px; border-radius: 50%; background: var(--bg-3); border: 2px solid var(--ink3); }
        .ds-process-step { display: flex; align-items: center; gap: 0.4rem; font-size: 0.88rem; font-weight: 600; }
        .ds-process-step-key { font-size: 0.7rem; color: var(--ink3); font-family: var(--font-mono); text-transform: uppercase; }
        .ds-process-ts { font-size: 0.68rem; color: var(--ink3); font-family: var(--font-mono); }
        .ds-process-line { font-size: 0.78rem; color: var(--ink2); margin-top: 0.2rem; line-height: 1.5; }
        .ds-process-detail { font-size: 0.72rem; color: var(--ink3); margin-top: 0.25rem; font-family: var(--font-mono); }
        .ds-process-list { margin: 0.3rem 0 0; padding-left: 1rem; display: flex; flex-direction: column; gap: 0.2rem; }
        .ds-process-list-field { font-size: 0.72rem; color: var(--ink3); }
        .ds-process-list-name { color: var(--ink2); font-weight: 500; }
        .ds-process-list-group { font-size: 0.7rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 0.3rem; }
        .ds-process-list-title { font-size: 0.82rem; font-weight: 600; color: var(--ink); margin-top: 0.4rem; }
        .ds-process-list-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem; color: var(--ink2); }
        .ds-process-list-field-scale { color: var(--accent); font-family: var(--font-mono); }
        .ds-process-toolbar { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
        .ds-process-toolbar-label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; align-self: center; }
        .ds-process-toolbar-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .ds-process-slider { flex: 1; min-width: 120px; accent-color: var(--accent); }
        .ds-process-prop { display: flex; flex-direction: column; gap: 0.25rem; }
        .ds-process-prop-input { padding: 0.3rem 0.45rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); color: var(--ink); font-size: 0.74rem; width: 100%; }
        .ds-process-canvas { background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); padding: 1rem; min-height: 300px; position: relative; }
        .ds-process-canvas-empty { display: flex; flex-direction: column; align-items: center; gap: 0.5rem; padding: 3rem 1rem; color: var(--ink3); text-align: center; }
        .ds-process-loading { display: flex; align-items: center; gap: 0.5rem; padding: 2rem; color: var(--ink3); justify-content: center; }
        .ds-process-empty-hint { font-size: 0.78rem; }
        .ds-process-actor-chips { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
        .ds-process-actor { padding: 0.18rem 0.5rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: 999px; font-size: 0.7rem; color: var(--ink2); }
        .ds-director-panel { display: flex; flex-direction: column; gap: 0.7rem; }
        .ds-director-head { display: flex; align-items: center; gap: 0.5rem; }
        .ds-director-hint { font-size: 0.72rem; color: var(--ink3); line-height: 1.5; }
        .ds-director-foot { display: flex; gap: 0.4rem; margin-top: 0.4rem; flex-wrap: wrap; }
        .ds-director-genref { padding: 0.25rem 0.5rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: var(--radius-sm); color: var(--ink2); font-size: 0.72rem; }
        .ds-director-notes { font-size: 0.74rem; color: var(--ink2); line-height: 1.5; }
        .ds-director-mark-name { font-size: 0.8rem; font-weight: 600; color: var(--ink); }

        .studio-shell {
          position: relative;
          width: 100%;
          height: 100%;
          min-height: 100%;
          z-index: 1;
          display: grid;
          grid-template-rows: 56px 1fr 180px;
          grid-template-columns: 64px 1fr;
          grid-template-areas:
            "topbar topbar"
            "sidebar main"
            "filmstrip filmstrip";
          background: var(--bg-1);
          color: var(--ink);
          font-size: 14px;
          transition: grid-template-rows 0.25s ease;
        }
        .studio-shell.film-collapsed {
          grid-template-rows: 56px 1fr 40px;
        }
        .studio-shell.manju-mode {
          grid-template-rows: 56px 1fr;
          grid-template-columns: 1fr;
          grid-template-areas:
            "topbar"
            "main";
        }
        .studio-shell::before {
          content: "";
          position: absolute;
          inset: 0;
          pointer-events: none;
          background:
            radial-gradient(ellipse 80% 50% at 50% -10%, rgba(245,158,11,0.06), transparent 60%),
            radial-gradient(ellipse 60% 40% at 85% 90%, rgba(59,130,246,0.04), transparent 50%);
          z-index: 0;
        }

        /* ── Topbar ── */
        .studio-topbar {
          grid-area: topbar;
          position: relative;
          z-index: 2;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0 1.1rem;
          border-bottom: 1px solid var(--hairline);
          background: var(--bg-1);
          backdrop-filter: blur(12px);
        }
        .brand {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }
        .brand-mark {
          width: 32px;
          height: 32px;
          border-radius: var(--radius);
          background: linear-gradient(135deg, var(--accent), var(--accent-hover));
          display: grid;
          place-items: center;
          font-weight: 800;
          font-size: 12px;
          color: var(--color-text-inverse);
          box-shadow: 0 0 20px color-mix(in srgb, var(--accent) 30%, transparent);
        }
        .brand-text {
          display: flex;
          flex-direction: column;
          line-height: 1.1;
        }
        .brand-name { font-size: 1rem; font-weight: 700; letter-spacing: -0.02em; }
        .brand-sub { font-size: 0.65rem; color: var(--ink2); font-family: var(--font-mono); text-transform: uppercase; letter-spacing: 0.08em; }
        .topbar-right {
          display: flex;
          align-items: center;
          gap: 0.6rem;
        }
        .topbar-center {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.6rem;
        }
        .studio-title {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: 0.02em;
        }
        .status-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.32rem 0.7rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: 999px;
          font-size: 0.72rem;
          color: var(--ink2);
          font-family: var(--font-mono);
        }
        .status-pill .led {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--color-success);
          box-shadow: 0 0 8px var(--color-success);
        }
        .task-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.3rem 0.65rem;
          background: color-mix(in srgb, var(--accent) 15%, var(--bg-3));
          border: 1px solid color-mix(in srgb, var(--accent) 40%, var(--hairline));
          border-radius: 999px;
          font-size: 0.7rem;
          color: var(--accent);
          font-family: var(--font-mono);
          animation: task-pulse 2s ease-in-out infinite;
        }
        @keyframes task-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.75; }
        }
        .task-pill-wrap { position: relative; display: inline-flex; }
        .task-pill-btn {
          cursor: pointer;
          appearance: none;
          font: inherit;
        }
        .task-pill-btn:hover {
          background: color-mix(in srgb, var(--accent) 25%, var(--bg-3));
        }
        .task-pill-btn.is-open {
          border-bottom-left-radius: 6px;
          border-bottom-right-radius: 6px;
          border-top-left-radius: 999px;
          border-top-right-radius: 999px;
        }
        .task-pill-caret { margin-left: 0.15rem; transition: transform 0.15s ease; }
        .task-pill-caret.is-up { transform: rotate(180deg); }
        .task-dropdown {
          position: absolute;
          top: calc(100% - 2px);
          right: 0;
          min-width: 220px;
          z-index: 60;
          background: var(--bg-2);
          border: 1px solid var(--hairline-strong);
          border-radius: var(--radius);
          border-top-right-radius: 6px;
          box-shadow: 0 12px 32px rgba(0,0,0,0.5);
          overflow: hidden;
          animation: td-fade 0.15s ease;
        }
        @keyframes td-fade { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: translateY(0); } }
        .task-dropdown-head {
          padding: 0.5rem 0.7rem;
          font-size: 0.66rem;
          font-weight: 600;
          color: var(--ink3);
          text-transform: uppercase;
          letter-spacing: 0.06em;
          border-bottom: 1px solid var(--hairline);
        }
        .task-dropdown-list {
          list-style: none;
          margin: 0;
          padding: 0.3rem;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .task-dropdown-item {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.45rem 0.55rem;
          font-size: 0.78rem;
          color: var(--ink);
          border-radius: var(--radius-sm);
        }
        .task-dropdown-item:hover { background: var(--bg-3); }
        .task-dropdown-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 6px var(--accent);
          flex-shrink: 0;
          animation: task-pulse 2s ease-in-out infinite;
        }
        /* M3.1:已完成任务分区样式 */
        .task-dropdown-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 16px;
          height: 16px;
          padding: 0 4px;
          margin-left: auto;
          font-size: 0.62rem;
          font-weight: 700;
          color: var(--color-text-inverse);
          background: var(--accent);
          border-radius: 8px;
          font-family: var(--font-mono);
        }
        .task-dropdown-head-done {
          border-top: 1px solid var(--hairline);
          border-bottom: none;
          color: var(--ink3);
          opacity: 0.85;
        }
        .task-dropdown-item-done {
          color: var(--ink3);
          opacity: 0.8;
        }
        .task-dropdown-item-done .task-dropdown-label { flex: 1; }
        .task-dropdown-time {
          margin-left: auto;
          font-size: 0.62rem;
          color: var(--ink3);
          font-family: var(--font-mono);
          opacity: 0.7;
        }
        .task-dropdown-empty {
          color: var(--ink3);
          opacity: 0.6;
          font-style: italic;
        }
        .task-dropdown-label { flex: 1; font-weight: 500; }
        .task-dropdown-detail {
          font-size: 0.68rem;
          color: var(--ink3);
          font-family: var(--font-mono);
          max-width: 100px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .account-btn {
          display: grid;
          place-items: center;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: var(--accent-quiet);
          border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
          color: var(--accent);
          cursor: pointer;
        }

        /* 按钮复用全局 .btn/.btn-primary,仅在尺寸上微调 */
        .btn-sm { padding: 0.32rem 0.6rem; font-size: 0.76rem; }

        /* ── Stage Sidebar ── */
        .stage-sidebar {
          grid-area: sidebar;
          position: relative;
          z-index: 2;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.7rem 0.5rem;
          border-right: 1px solid var(--hairline);
          background: var(--bg-2);
        }
        .stage-item {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.3rem;
          padding: 0.7rem 0.25rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-sm);
          /* ink3 对比度仅 ~2.7:1,阶段按钮为交互文本须过 WCAG AA 4.5:1 → 用 ink2(~5.6:1) */
          color: var(--ink2);
          font-size: 0.62rem;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.04em;
          cursor: pointer;
          transition: all 0.18s ease;
          position: relative;
        }
        .stage-item:hover { color: var(--ink); background: rgba(255,255,255,0.04); }
        .stage-item.active {
          color: var(--accent);
          background: var(--accent-quiet);
          border-color: color-mix(in srgb, var(--accent) 35%, transparent);
        }
        .stage-item.active::before {
          content: "";
          position: absolute;
          left: -0.5rem;
          top: 50%;
          transform: translateY(-50%);
          width: 3px;
          height: 20px;
          background: var(--accent);
          border-radius: 0 2px 2px 0;
        }
        .stage-sidebar-foot {
          margin-top: auto;
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
        }

        /* ── Main Stage ── */
        .stage-main {
          grid-area: main;
          position: relative;
          z-index: 2;
          overflow: auto;
          padding: 1rem;
        }
        .manju-embed {
          height: 100%;
          min-height: 100%;
          overflow: auto;
        }

        /* ── Hub View ── */
        .hub-view {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          max-width: 1400px;
          margin: 0 auto;
        }
        .hero-bar {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 1rem;
          padding: 1.25rem;
          background: linear-gradient(135deg, rgba(245,158,11,0.08), rgba(59,130,246,0.05));
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .hero-text h1 { margin: 0 0 0.35rem; font-family: var(--font-display); font-size: 1.6rem; font-weight: 600; }
        .hero-text p { margin: 0; color: var(--ink2); font-size: 0.85rem; max-width: 520px; line-height: 1.55; }
        .hero-actions { display: flex; gap: 0.5rem; }
        .section-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          margin-top: 0.25rem;
        }
        .section-head h2 { margin: 0; font-size: 0.92rem; font-weight: 600; display: flex; align-items: center; gap: 0.4rem; }
        .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--accent); box-shadow: 0 0 10px var(--accent); }
        .skills-row {
          display: flex;
          gap: 0.6rem;
          overflow-x: auto;
          padding-bottom: 0.25rem;
        }
        .skill-chip {
          flex: 0 0 auto;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          width: 180px;
          padding: 0.85rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-left: 3px solid var(--chip-accent, var(--accent));
          border-radius: var(--radius-sm);
          cursor: pointer;
          transition: all 0.18s ease;
        }
        .skill-chip:hover { background: var(--bg-3); border-color: var(--hairline-strong); transform: translateY(-2px); }
        .skill-chip b { font-size: 0.86rem; }
        /* ink3 ~2.7:1 不达 AA,卡片描述文本提升为 ink2 */
        .skill-chip span { font-size: 0.72rem; color: var(--ink2); }
        .skill-chip .shots { font-size: 0.66rem; color: var(--accent); font-family: var(--font-mono); margin-top: 0.15rem; }
        .tag {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.15rem 0.5rem;
          background: rgba(255,255,255,0.05);
          border-radius: var(--radius-sm);
          font-size: 0.7rem;
          color: var(--ink2);
        }
        .project-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
          gap: 0.8rem;
        }
        .project-card {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding: 0.85rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          cursor: pointer;
          transition: all 0.18s ease;
          overflow: hidden;
        }
        .project-card:hover { border-color: var(--hairline-strong); background: var(--bg-3); transform: translateY(-2px); }
        .project-card.active { border-color: var(--accent); box-shadow: 0 0 0 1px var(--accent) inset, 0 8px 24px -12px rgba(245,158,11,0.2); }
        .proj-thumb {
          aspect-ratio: 16/9;
          background: var(--bg-3);
          border-radius: var(--radius-sm);
          display: grid;
          place-items: center;
          color: var(--ink3);
        }
        .proj-title { font-weight: 600; font-size: 0.95rem; }
        .proj-premise { font-size: 0.72rem; color: var(--ink2); display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
        .proj-meta { display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; color: var(--ink2); }
        .proj-status {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.12rem 0.45rem;
          border-radius: 999px;
          font-size: 0.65rem;
          font-weight: 600;
          font-family: var(--font-mono);
        }
        .proj-status.ready { background: color-mix(in srgb, var(--color-success) 12%, transparent); color: var(--color-success); }
        .proj-status.draft { background: var(--bg-2); color: var(--ink2); }
        .proj-status.story { background: var(--accent-quiet); color: var(--accent); }
        .proj-del {
          position: absolute;
          top: 8px;
          right: 8px;
          display: inline-flex;
          align-items: center;
          gap: 0.2rem;
          padding: 0.2rem 0.4rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink3);
          font-size: 0.65rem;
          opacity: 0;
          transition: opacity 0.18s ease;
          cursor: pointer;
        }
        .project-card:hover .proj-del { opacity: 1; }
        .proj-del:hover { color: var(--danger); border-color: var(--danger); }
        .hub-loading, .hub-error, .hub-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.6rem;
          padding: 3rem 1rem;
          color: var(--ink3);
          text-align: center;
        }
        .hub-error { color: var(--danger); }

        /* ── Workspace View ── */
        .workspace-view {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          max-width: 1600px;
          margin: 0 auto;
          height: 100%;
        }
        .workspace-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.85rem 1rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .workspace-title { display: flex; flex-direction: column; gap: 0.35rem; }
        .workspace-title h2 { margin: 0; font-family: var(--font-display); font-size: 1.25rem; font-weight: 600; }
        .workspace-meta { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .workspace-meta .spec { font-size: 0.72rem; color: var(--ink3); font-family: var(--font-mono); }
        .workspace-meta .time { display: inline-flex; align-items: center; gap: 0.25rem; font-size: 0.72rem; color: var(--ink3); font-family: var(--font-mono); }
        .workspace-actions { display: flex; align-items: center; gap: 0.5rem; }
        .edit-panel {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.7rem;
          padding: 0.85rem 1rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .edit-error {
          grid-column: 1 / -1;
          padding: 0.5rem 0.7rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-sm);
          color: var(--danger);
          font-size: 0.8rem;
        }
        .workspace-body {
          flex: 1;
          display: grid;
          grid-template-columns: 1fr 320px;
          gap: 1rem;
          min-height: 0;
        }
        .right-collapsed .workspace-body {
          grid-template-columns: 1fr 0px;
          gap: 0;
        }
        .main-panel-wrap {
          position: relative;
          min-width: 0;
          display: flex;
          flex-direction: column;
          min-height: 0;
        }
        .main-panel {
          flex: 1;
          min-width: 0;
          overflow: auto;
        }
        .right-panel {
          display: flex;
          flex-direction: column;
          gap: 0.8rem;
          min-width: 0;
          overflow: hidden;
          transition: width 0.25s ease, opacity 0.2s ease;
        }
        .right-collapsed .right-panel {
          width: 0;
          min-width: 0;
          opacity: 0;
          gap: 0;
        }
        .right-collapsed .main-panel-wrap {
          margin-right: 0;
        }
        .panel-toggle {
          position: absolute;
          right: -10px;
          top: 50%;
          transform: translateY(-50%);
          z-index: 10;
          width: 20px;
          height: 44px;
          display: grid;
          place-items: center;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: 4px 0 0 4px;
          color: var(--ink3);
          cursor: pointer;
          transition: all 0.2s ease;
        }
        .panel-toggle:hover {
          background: var(--bg-3);
          color: var(--accent);
          border-color: color-mix(in srgb, var(--accent) 35%, transparent);
        }
        .panel-toggle.collapsed {
          right: 0;
          border-radius: 4px 0 0 4px;
        }
        .r-panel {
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          padding: 0.85rem;
        }
        .r-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.7rem; }
        .r-panel-head h4 { margin: 0; font-size: 0.78rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; color: var(--ink2); }
        .r-prop { display: flex; flex-direction: column; gap: 0.3rem; margin-bottom: 0.55rem; }
        .r-prop label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
        .r-prop .r-val { font-size: 0.84rem; color: var(--ink); word-break: break-word; }
        .r-prop .r-val.mono { font-family: var(--font-mono); color: var(--ink2); font-size: 0.76rem; }
        .r-prop.compact { flex-direction: row; align-items: center; gap: 0.5rem; }
        .r-prop.compact label { margin: 0; }
        .r-prop input, .r-prop select, .r-prop textarea {
          width: 100%;
          padding: 0.4rem 0.55rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          font-size: 0.82rem;
          color: var(--ink);
        }
        .r-prop input:focus, .r-prop select:focus, .r-prop textarea:focus { outline: none; border-color: var(--accent); }
        .prop-row { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
        .prop-row span { font-size: 0.68rem; color: var(--ink3); font-weight: 600; }
        .prop-row input, .prop-row textarea {
          width: 100%;
          padding: 0.45rem 0.55rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          font-size: 0.84rem;
          color: var(--ink);
        }
        .prop-row textarea { resize: vertical; min-height: 80px; }
        .workspace-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.8rem;
          height: 100%;
          color: var(--ink3);
          padding: 2rem;
        }
        .workspace-empty-title { font-size: 1.1rem; color: var(--ink); }
        .workspace-empty .ds-new-panel {
          width: min(720px, 100%);
          margin: 0 auto;
          text-align: left;
          align-self: center;
          max-height: calc(100% - 1.5rem);
          overflow-y: auto;
        }
        .ds-new-panel {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
          padding: 1.1rem 1.25rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .ds-panel-head {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          font-size: 1rem;
          font-weight: 600;
          color: var(--ink);
          margin-bottom: 0.2rem;
        }
        .ds-field {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          min-width: 0;
        }
        .ds-field-label {
          font-size: 0.7rem;
          color: var(--ink2);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .ds-field .ds-input,
        .ds-field .ds-textarea {
          width: 100%;
          padding: 0.55rem 0.7rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          font-size: 0.88rem;
          color: var(--ink);
          transition: border-color 0.15s ease;
        }
        .ds-field .ds-input:focus,
        .ds-field .ds-textarea:focus { outline: none; border-color: var(--accent); }
        .ds-field .ds-textarea { resize: vertical; min-height: 120px; }
        .ds-field-row {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.7rem;
        }
        .ds-field-row .ds-input { text-align: center; }
        .ds-error-inline {
          padding: 0.55rem 0.75rem;
          background: var(--danger-quiet);
          border: 1px solid var(--danger);
          border-radius: var(--radius-sm);
          color: var(--danger);
          font-size: 0.82rem;
        }

        /* ── L3 批量精修面板 ── */
        .ds-batch-polish-btn {
          margin-left: auto;
          background: linear-gradient(135deg, #1f1c19, #2a2520);
          color: var(--accent);
          border: 1px solid rgba(217, 164, 65, 0.4);
          letter-spacing: 0.04em;
        }
        .ds-batch-polish-btn:hover:not(:disabled) {
          background: linear-gradient(135deg, #2a2520, #352d24);
          border-color: var(--accent);
        }
        /* M2.1:ShotTab 批量操作工具栏 */
        .ds-batch-toolbar {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.5rem 0.7rem;
          margin-bottom: 0.6rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
        }
        .ds-batch-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 18px;
          height: 18px;
          padding: 0 5px;
          margin-left: 0.35rem;
          font-size: 0.68rem;
          font-weight: 600;
          color: var(--color-text-inverse);
          background: var(--accent);
          border-radius: 9px;
          font-family: var(--font-mono);
        }
        .ds-batch-polish-panel {
          padding: 0.85rem 1rem;
          margin-bottom: 0.8rem;
          background: linear-gradient(135deg, rgba(217, 164, 65, 0.04), transparent);
          border: 1px solid rgba(217, 164, 65, 0.25);
          border-radius: var(--radius);
        }
        .ds-batch-polish-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: 0.6rem;
        }
        .ds-batch-polish-title {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          color: var(--accent);
          font-size: 0.88rem;
          font-weight: 600;
          letter-spacing: 0.04em;
        }
        .ds-batch-polish-model {
          margin-left: 0.5rem;
          padding: 0.1rem 0.4rem;
          font-size: 0.68rem;
          color: var(--ink3);
          background: var(--hairline);
          border-radius: var(--radius-sm);
          font-weight: 400;
          letter-spacing: 0;
        }
        .ds-batch-polish-progress {
          display: flex;
          align-items: center;
          gap: 0.8rem;
        }
        .ds-batch-polish-bar-bg {
          flex: 1;
          height: 6px;
          background: var(--hairline);
          border-radius: 3px;
          overflow: hidden;
        }
        .ds-batch-polish-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--accent-hover));
          border-radius: 3px;
          transition: width 0.6s ease;
        }
        .ds-batch-polish-count {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.82rem;
          color: var(--ink2);
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }
        .ds-batch-polish-status {
          color: var(--ink3);
          font-size: 0.75rem;
        }
        .ds-batch-polish-summary {
          display: flex;
          gap: 1rem;
          margin-top: 0.6rem;
          font-size: 0.82rem;
        }
        .ds-batch-ok { color: var(--color-success); }
        .ds-batch-fail { color: var(--danger); }
        .ds-batch-polish-errors {
          margin-top: 0.6rem;
          font-size: 0.78rem;
          color: var(--ink3);
        }
        .ds-batch-polish-errors summary {
          cursor: pointer;
          color: var(--danger);
          user-select: none;
        }
        .ds-batch-polish-errors ul {
          margin: 0.4rem 0 0;
          padding-left: 1.1rem;
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .ds-batch-polish-errors li {
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
        }
        .ds-batch-polish-errors li strong {
          color: var(--ink2);
          font-size: 0.75rem;
        }
        .ds-form-actions {
          display: flex;
          align-items: center;
          justify-content: flex-end;
          gap: 0.6rem;
          margin-top: 0.3rem;
        }

        /* ── Cinema View ── */
        .cinema-view {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          height: 100%;
          justify-content: center;
        }
        .cinema-screen {
          flex: 1;
          display: grid;
          place-items: center;
          background: #000;
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          overflow: hidden;
        }
        .cinema-screen video { width: 100%; height: 100%; object-fit: contain; }
        .cinema-placeholder { display: flex; flex-direction: column; align-items: center; gap: 0.6rem; color: var(--ink3); }
        .cinema-info {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.85rem 1rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .cinema-title { font-size: 1.1rem; font-weight: 600; }
        .cinema-meta { font-size: 0.74rem; color: var(--ink3); font-family: var(--font-mono); }
        .cinema-actions { display: flex; gap: 0.5rem; }

        /* ── 通用:ds-section / ds-spin / ds-empty ── */
        .ds-spin { animation: spin 0.8s linear infinite; }
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (prefers-reduced-motion: reduce) { .ds-spin { animation: none; } }

        .ds-section {
          display: flex;
          flex-direction: column;
          gap: 0.8rem;
        }
        .ds-section.card {
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          padding: 1rem;
        }
        .ds-section-head {
          display: flex;
          align-items: center;
          gap: 0.55rem;
          flex-wrap: wrap;
        }
        .ds-section-title {
          font-size: 0.92rem;
          font-weight: 600;
          color: var(--ink);
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
        }
        .ds-section-count {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          min-width: 22px;
          height: 20px;
          padding: 0 0.45rem;
          background: var(--accent-quiet);
          border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
          border-radius: 999px;
          font-size: 0.68rem;
          font-weight: 700;
          color: var(--accent);
          font-family: var(--font-mono);
        }
        .ds-section-hint {
          margin-left: auto;
          font-size: 0.72rem;
          color: var(--ink3);
          font-family: var(--font-mono);
        }
        .ds-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.6rem;
          padding: 2rem 1rem;
          color: var(--ink3);
          text-align: center;
        }
        .ds-empty-inline {
          padding: 1.5rem 1rem;
        }

        /* ── ds-input / ds-textarea / ds-field ── */
        .ds-input, .ds-textarea {
          width: 100%;
          padding: 0.45rem 0.6rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink);
          font-size: 0.84rem;
          transition: border-color 0.15s ease;
        }
        .ds-input:focus, .ds-textarea:focus {
          outline: none;
          border-color: var(--accent);
        }
        .ds-textarea { resize: vertical; min-height: 80px; font-family: inherit; }
        .ds-field { display: flex; flex-direction: column; gap: 0.3rem; min-width: 0; }
        .ds-field-sm { max-width: 110px; }
        .ds-field-label {
          font-size: 0.68rem;
          color: var(--ink3);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }

        /* ── ScriptTab:剧本拆解 / 宫格分镜 ── */
        .ds-storyboard-controls {
          display: flex;
          align-items: center;
          gap: 0.55rem;
          flex-wrap: wrap;
        }
        .ds-grid-bar { position: relative; display: inline-flex; }
        .ds-grid-picker {
          position: absolute;
          top: calc(100% + 6px);
          left: 0;
          z-index: 20;
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          padding: 0.4rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-strong);
          border-radius: var(--radius);
          box-shadow: 0 8px 24px rgba(0,0,0,0.4);
          min-width: 180px;
        }
        .ds-grid-pick {
          display: flex;
          align-items: center;
          gap: 0.55rem;
          padding: 0.5rem 0.6rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-sm);
          color: var(--ink);
          cursor: pointer;
          text-align: left;
          transition: all 0.15s ease;
        }
        .ds-grid-pick:hover { background: var(--bg-3); border-color: color-mix(in srgb, var(--accent) 35%, transparent); color: var(--accent); }
        .ds-grid-pick span { display: flex; flex-direction: column; gap: 0.1rem; }
        .ds-grid-pick strong { font-size: 0.85rem; font-weight: 600; }
        .ds-grid-pick em { font-size: 0.68rem; color: var(--ink3); font-style: normal; }
        .ds-script-preview {
          border-top: 1px solid var(--hairline);
          padding-top: 0.7rem;
          margin-top: 0.2rem;
        }
        .ds-script-preview summary {
          cursor: pointer;
          font-size: 0.78rem;
          color: var(--ink2);
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.05em;
          user-select: none;
          padding: 0.3rem 0;
        }
        .ds-script-pre {
          width: 100%;
          padding: 0.7rem 0.8rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink);
          font-size: 0.85rem;
          line-height: 1.65;
          font-family: var(--font-sans);
          resize: vertical;
          min-height: 180px;
        }
        .ds-script-pre:focus { outline: none; border-color: var(--accent); }
        .ds-grid-dl { margin-left: auto; }
        .ds-grid-loading {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 0.6rem;
          padding: 2rem;
          color: var(--ink3);
        }
        .ds-grid-image {
          display: grid;
          gap: 2px;
          border-radius: var(--radius);
          overflow: hidden;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
        }
        .ds-grid-img {
          width: 100%;
          display: block;
          cursor: zoom-in;
          transition: opacity 0.15s ease;
        }
        .ds-grid-img:hover { opacity: 0.9; }
        .ds-grid-shots {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
          gap: 0.5rem;
        }
        .ds-grid-shot {
          display: flex;
          gap: 0.5rem;
          padding: 0.6rem 0.7rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
        }
        .ds-grid-shot-idx {
          flex-shrink: 0;
          width: 28px;
          height: 22px;
          display: grid;
          place-items: center;
          background: var(--accent-quiet);
          color: var(--accent);
          font-size: 0.7rem;
          font-weight: 700;
          font-family: var(--font-mono);
          border-radius: 4px;
        }
        .ds-grid-shot-body { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 0.2rem; }
        .ds-grid-shot-scene { font-size: 0.82rem; font-weight: 600; color: var(--ink); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ds-grid-shot-prompt { margin: 0; font-size: 0.72rem; color: var(--ink2); line-height: 1.45; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

        /* ── ShotTab:分镜板 ── */
        .ds-shots-section { padding: 1rem 0; }
        .ds-shots {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
          gap: 0.8rem;
        }
        .ds-shots-empty {
          padding: 3rem 1rem;
        }

        /* ── ShotCard:分镜卡片 ── */
        .ds-shot-card {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          padding: 0.8rem;
          transition: border-color 0.18s ease;
        }
        .ds-shot-card:hover { border-color: var(--hairline-strong); }
        .ds-shot-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .ds-shot-idx {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.78rem;
          font-weight: 700;
          color: var(--accent);
          font-family: var(--font-mono);
        }
        .ds-shot-tags { display: flex; gap: 0.3rem; flex-wrap: wrap; }
        .ds-shot-tag {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.15rem 0.45rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          font-size: 0.66rem;
          color: var(--ink2);
          font-family: var(--font-mono);
        }
        .ds-shot-tag-speaker {
          background: var(--accent-quiet);
          border-color: color-mix(in srgb, var(--accent) 35%, transparent);
          color: var(--accent);
        }
        .ds-shot-media {
          aspect-ratio: 16/9;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          overflow: hidden;
          display: grid;
          place-items: center;
          color: var(--ink3);
          position: relative;
        }
        .ds-shot-media video, .ds-shot-media img { width: 100%; height: 100%; object-fit: cover; }
        .ds-shot-placeholder { display: flex; flex-direction: column; align-items: center; gap: 0.4rem; font-size: 0.72rem; }
        .ds-shot-body { display: flex; flex-direction: column; gap: 0.4rem; }
        .ds-shot-scene { font-size: 0.85rem; font-weight: 600; color: var(--ink); }
        .ds-shot-prompt { font-size: 0.76rem; color: var(--ink2); line-height: 1.5; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
        .ds-shot-dialogue { font-size: 0.74rem; color: var(--ink3); font-style: italic; padding: 0.3rem 0.5rem; background: var(--bg-3); border-radius: var(--radius-sm); border-left: 2px solid color-mix(in srgb, var(--accent) 35%, transparent); }
        .ds-shot-audio, .ds-shot-voice { display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: var(--ink2); }
        .ds-shot-actions { display: flex; align-items: center; gap: 0.3rem; flex-wrap: wrap; }
        .ds-shot-edit { display: flex; flex-direction: column; gap: 0.5rem; padding-top: 0.5rem; border-top: 1px solid var(--hairline); }
        .ds-shot-edit-actions { display: flex; gap: 0.3rem; flex-wrap: wrap; }
        .ds-shot-video { width: 100%; }
        .ds-model-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .ds-model-label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; }
        .ds-model-select {
          padding: 0.3rem 0.5rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink);
          font-size: 0.74rem;
        }
        .ds-model-select:focus { outline: none; border-color: var(--accent); }
        .ds-model-warn { font-size: 0.66rem; color: var(--danger); }
        .ds-mini-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.22rem 0.45rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink2);
          font-size: 0.68rem;
          cursor: pointer;
          transition: all 0.15s ease;
        }
        .ds-mini-btn:hover { background: var(--bg-3); color: var(--ink); border-color: var(--hairline-strong); }
        .ds-mini-btn-danger:hover { color: var(--danger); border-color: var(--danger); background: var(--danger-quiet); }
        .ds-mini-btn-ref { font-size: 0.66rem; }

        /* ── CharacterTab:角色管理 ── */
        .ds-char-bar { display: flex; align-items: center; justify-content: space-between; gap: 0.5rem; margin-bottom: 0.8rem; }
        .ds-char-form {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          padding: 1rem;
          background: var(--bg-2);
          border: 1px solid color-mix(in srgb, var(--accent) 35%, transparent);
          border-radius: var(--radius);
          margin-bottom: 0.8rem;
        }
        .ds-char-form-title { font-size: 0.88rem; font-weight: 600; color: var(--accent); }
        .ds-char-ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 0.6rem; }
        .ds-char-item {
          display: grid;
          grid-template-columns: 80px 1fr auto;
          gap: 0.8rem;
          padding: 0.8rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          align-items: start;
        }
        .ds-char-ref-grid {
          display: grid;
          grid-template-columns: repeat(3, 1fr);
          gap: 0.3rem;
          width: 80px;
        }
        .ds-char-ref-thumb {
          aspect-ratio: 3/4;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: 4px;
          overflow: hidden;
          display: grid;
          place-items: center;
          color: var(--ink3);
          font-size: 0.6rem;
          cursor: pointer;
          transition: border-color 0.15s ease;
        }
        .ds-char-ref-thumb:hover { border-color: var(--accent); }
        .ds-char-ref-thumb img { width: 100%; height: 100%; object-fit: cover; }
        .ds-char-ref-loading { color: var(--accent); animation: spin 1s linear infinite; }
        .ds-char-ref-label { position: absolute; bottom: 1px; left: 1px; padding: 0.05rem 0.2rem; background: rgba(0,0,0,0.7); font-size: 0.5rem; border-radius: 2px; }
        .ds-char-name { font-size: 0.88rem; font-weight: 600; color: var(--ink); }
        .ds-char-desc { font-size: 0.74rem; color: var(--ink2); line-height: 1.5; margin-top: 0.25rem; }
        .ds-char-voice { font-size: 0.7rem; color: var(--ink3); font-family: var(--font-mono); margin-top: 0.3rem; }
        .ds-char-vp { font-size: 0.68rem; color: var(--ink3); font-family: var(--font-mono); margin-top: 0.2rem; word-break: break-all; }
        .ds-char-add { margin-left: auto; }
        .ds-char-foot { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
        .ds-char-ref { position: relative; }

        /* ── AssembleTab:一键合成 ── */
        .ds-assemble { display: flex; flex-direction: column; gap: 0.8rem; }
        .ds-assemble-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.8rem;
          padding: 0.8rem 1rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .ds-assemble-hint { font-size: 0.85rem; color: var(--ink2); }
        .ds-assemble-result {
          display: flex;
          flex-direction: column;
          gap: 0.6rem;
          padding: 0.8rem 1rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .ds-assemble-result-head {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--color-success);
          flex-wrap: wrap;
        }
        .ds-assemble-dur { margin-left: auto; font-size: 0.75rem; color: var(--ink3); font-family: var(--font-mono); }
        .ds-assemble-video {
          width: 100%;
          max-height: 60vh;
          border-radius: var(--radius-sm);
          background: #000;
        }

        /* ── ProcessTab:过程追踪 ── */
        .ds-process-section { display: flex; flex-direction: column; gap: 0.8rem; }
        .ds-process-content { display: flex; flex-direction: column; gap: 0.8rem; }
        /* M1.3:ProcessTab 两段式容器 */
        .ds-process-wrap {
          display: flex;
          flex-direction: column;
          gap: 1rem;
        }
        .ds-task-log-section { padding: 0.9rem 1rem; }
        .ds-task-log-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          max-height: 420px;
          overflow-y: auto;
        }
        .ds-task-log-item {
          display: flex;
          align-items: center;
          gap: 0.55rem;
          padding: 0.5rem 0.6rem;
          font-size: 0.78rem;
          color: var(--ink);
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
        }
        .ds-task-log-item.ds-task-running {
          border-left: 2px solid var(--accent);
        }
        .ds-task-log-item.ds-task-done {
          opacity: 0.78;
        }
        .ds-task-log-item.ds-task-error {
          border-left: 2px solid var(--danger, #e57373);
        }
        .ds-task-label { font-weight: 500; }
        .ds-task-detail {
          font-size: 0.68rem;
          color: var(--ink3);
          font-family: var(--font-mono);
        }
        .ds-task-status {
          margin-left: auto;
          font-size: 0.66rem;
          padding: 1px 6px;
          border-radius: 4px;
          background: var(--bg-3);
          color: var(--ink3);
        }
        .ds-task-log-item.ds-task-running .ds-task-status {
          background: rgba(217, 164, 65, 0.15);
          color: var(--accent);
        }
        .ds-task-log-item.ds-task-done .ds-task-status {
          background: rgba(120, 180, 120, 0.15);
          color: var(--ink2);
        }
        .ds-task-time {
          font-size: 0.62rem;
          color: var(--ink3);
          font-family: var(--font-mono);
          opacity: 0.7;
        }
        .ds-live-dot {
          width: 7px;
          height: 7px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 6px var(--accent);
          animation: task-pulse 2s ease-in-out infinite;
          flex-shrink: 0;
        }
        .ds-process-history { padding: 0; overflow: hidden; }
        .ds-process-history-head {
          cursor: pointer;
          list-style: none;
          user-select: none;
        }
        .ds-process-history-head::-webkit-details-marker { display: none; }
        .ds-process-history-head .ds-section-title { flex: none; }
        .ds-process-history-hint {
          margin-left: auto;
          font-size: 0.66rem;
          color: var(--ink3);
          opacity: 0.6;
          font-weight: 400;
        }
        .ds-process-history > .ds-process-timeline,
        .ds-process-history > .ds-process-empty {
          padding: 0.8rem 1rem 1.2rem;
        }
        .ds-process-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.6rem;
          padding: 3rem 1rem;
          color: var(--ink3);
          text-align: center;
        }
        .ds-process-refresh { margin-left: auto; }
        .ds-process-timeline {
          position: relative;
          display: flex;
          flex-direction: column;
          gap: 0;
          padding-left: 1.4rem;
        }
        .ds-process-rail {
          position: absolute;
          left: 7px;
          top: 4px;
          bottom: 4px;
          width: 2px;
          background: var(--hairline);
        }
        .ds-process-node {
          position: relative;
          padding: 0.6rem 0 1rem;
        }
        .ds-process-node::before {
          content: "";
          position: absolute;
          left: -1.4rem;
          top: 0.9rem;
          width: 16px;
          height: 16px;
          border-radius: 50%;
          background: var(--bg-3);
          border: 2px solid var(--ink3);
        }
        .ds-process-step {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.88rem;
          font-weight: 600;
        }
        .ds-process-step-key {
          font-size: 0.7rem;
          color: var(--ink3);
          font-family: var(--font-mono);
          text-transform: uppercase;
        }
        .ds-process-ts { font-size: 0.68rem; color: var(--ink3); font-family: var(--font-mono); }
        .ds-process-line { font-size: 0.78rem; color: var(--ink2); margin-top: 0.2rem; line-height: 1.5; }
        .ds-process-detail { font-size: 0.72rem; color: var(--ink3); margin-top: 0.25rem; font-family: var(--font-mono); }
        .ds-process-list { margin: 0.3rem 0 0; padding-left: 1rem; display: flex; flex-direction: column; gap: 0.2rem; }
        .ds-process-list-field { font-size: 0.72rem; color: var(--ink3); }
        .ds-process-list-name { color: var(--ink2); font-weight: 500; }
        .ds-process-list-group { font-size: 0.7rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; margin-top: 0.3rem; }
        .ds-process-list-title { font-size: 0.82rem; font-weight: 600; color: var(--ink); margin-top: 0.4rem; }
        .ds-process-list-row { display: flex; align-items: center; gap: 0.5rem; font-size: 0.72rem; color: var(--ink2); }
        .ds-process-list-field-scale { color: var(--accent); font-family: var(--font-mono); }
        .ds-process-toolbar { display: flex; gap: 0.4rem; flex-wrap: wrap; margin-bottom: 0.5rem; }
        .ds-process-toolbar-label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; align-self: center; }
        .ds-process-toolbar-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .ds-process-slider { flex: 1; min-width: 120px; accent-color: var(--accent); }
        .ds-process-prop { display: flex; flex-direction: column; gap: 0.25rem; }
        .ds-process-prop-input {
          padding: 0.3rem 0.45rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink);
          font-size: 0.74rem;
          width: 100%;
        }
        .ds-process-canvas {
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          padding: 1rem;
          min-height: 300px;
          position: relative;
        }
        .ds-process-canvas-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: 3rem 1rem;
          color: var(--ink3);
          text-align: center;
        }
        .ds-process-loading { display: flex; align-items: center; gap: 0.5rem; padding: 2rem; color: var(--ink3); justify-content: center; }
        .ds-process-empty-hint { font-size: 0.78rem; }
        .ds-process-actor-chips { display: flex; gap: 0.3rem; flex-wrap: wrap; margin-top: 0.4rem; }
        .ds-process-actor {
          padding: 0.18rem 0.5rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: 999px;
          font-size: 0.7rem;
          color: var(--ink2);
        }
        .ds-director-panel { display: flex; flex-direction: column; gap: 0.7rem; }
        .ds-director-head { display: flex; align-items: center; gap: 0.5rem; }
        .ds-director-hint { font-size: 0.72rem; color: var(--ink3); line-height: 1.5; }
        .ds-director-loading { display: flex; align-items: center; gap: 0.5rem; padding: 1rem; color: var(--ink3); justify-content: center; }
        .ds-director-toolbar { display: flex; flex-direction: column; gap: 0.4rem; padding: 0.6rem; background: var(--bg-3); border-radius: var(--radius-sm); border: 1px solid var(--hairline); }
        .ds-director-toolbar-row { display: flex; align-items: center; gap: 0.4rem; flex-wrap: wrap; }
        .ds-director-toolbar-label { font-size: 0.68rem; color: var(--ink3); font-weight: 600; text-transform: uppercase; min-width: 32px; }
        .ds-director-actor-chips { display: flex; gap: 0.3rem; flex-wrap: wrap; flex: 1; }
        .ds-director-empty-hint { font-size: 0.7rem; color: var(--ink3); font-style: italic; }
        .ds-director-prop-input { flex: 1; min-width: 80px; }
        .ds-director-slider { flex: 1; min-width: 100px; display: flex; align-items: center; gap: 0.4rem; font-size: 0.7rem; color: var(--ink2); font-family: var(--font-mono); }
        .ds-director-slider input[type="range"] { flex: 1; accent-color: var(--accent); }
        .ds-director-canvas { position: relative; width: 100%; aspect-ratio: 16/9; background: var(--bg-1); border: 1px solid var(--hairline); border-radius: var(--radius-sm); overflow: hidden; }
        .ds-director-actor { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 2px; transform: translate(-50%, -100%); cursor: move; user-select: none; }
        .ds-director-prop { position: absolute; display: flex; flex-direction: column; align-items: center; gap: 2px; transform: translate(-50%, -50%); cursor: move; user-select: none; }
        .ds-director-canvas-empty { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 0.4rem; color: var(--ink3); font-size: 0.72rem; }
        .ds-director-list { display: flex; flex-direction: column; gap: 0.5rem; }
        .ds-director-list-group { display: flex; flex-direction: column; gap: 0.3rem; }
        .ds-director-list-title { font-size: 0.78rem; font-weight: 600; color: var(--ink); }
        .ds-director-list-row { display: flex; align-items: center; gap: 0.4rem; font-size: 0.72rem; color: var(--ink2); }
        .ds-director-list-name { min-width: 60px; font-weight: 500; }
        .ds-director-list-field { flex: 1; display: flex; align-items: center; gap: 0.3rem; }
        .ds-director-list-field-scale { color: var(--accent); font-family: var(--font-mono); font-size: 0.68rem; min-width: 40px; text-align: right; }
        .ds-director-foot { display: flex; gap: 0.4rem; margin-top: 0.4rem; flex-wrap: wrap; }
        .ds-director-genref {
          padding: 0.25rem 0.5rem;
          background: var(--bg-3);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          color: var(--ink2);
          font-size: 0.72rem;
        }
        .ds-director-notes { font-size: 0.74rem; color: var(--ink2); line-height: 1.5; }
        .ds-director-mark-name { font-size: 0.72rem; font-weight: 600; color: var(--ink); background: var(--accent-quiet); padding: 0.1rem 0.35rem; border-radius: 3px; white-space: nowrap; }
        /* shot ref upload */
        .ds-shot-ref { display: flex; flex-wrap: wrap; gap: 0.3rem; }
        .ds-shot-ref-preview { width: 48px; height: 48px; object-fit: cover; border-radius: 4px; border: 1px solid var(--hairline); cursor: pointer; }
        .ds-char-ref-files { font-size: 0.66rem; color: var(--ink3); margin-top: 0.2rem; font-family: var(--font-mono); word-break: break-all; }

        /* ── M5 AnalyticsPanel 播放洞察 ── */
        .ds-analytics-section { display: flex; flex-direction: column; gap: 0.9rem; }
        .ds-analytics-empty { display: flex; flex-direction: column; align-items: center; gap: 0.55rem; padding: 4rem 1rem; color: var(--ink3); text-align: center; }
        .ds-analytics-summary { display: grid; grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); gap: 0.6rem; }
        .ds-analytics-card { display: flex; flex-direction: column; gap: 0.25rem; padding: 0.75rem 0.9rem; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); }
        .ds-analytics-value { font-size: 1.1rem; font-weight: 700; color: var(--ink); font-family: var(--font-mono); }
        .ds-analytics-label { font-size: 0.7rem; color: var(--ink3); }
        .ds-analytics-list { display: flex; flex-direction: column; gap: 0.55rem; }
        .ds-analytics-shot { display: flex; flex-direction: column; gap: 0.5rem; padding: 0.75rem 0.9rem; background: var(--bg-2); border: 1px solid var(--hairline); border-radius: var(--radius); transition: border-color 0.15s ease; }
        .ds-analytics-shot:hover { border-color: var(--hairline-strong); }
        .ds-analytics-shot.hot { border-left: 3px solid var(--color-success); }
        .ds-analytics-shot.warm { border-left: 3px solid var(--warn); }
        .ds-analytics-shot.cold { border-left: 3px solid var(--ink3); }
        .ds-analytics-shot-main { display: flex; flex-direction: column; gap: 0.35rem; }
        .ds-analytics-shot-head { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
        .ds-analytics-idx { width: 28px; height: 22px; display: grid; place-items: center; background: var(--accent-quiet); color: var(--accent); font-size: 0.7rem; font-weight: 700; font-family: var(--font-mono); border-radius: 4px; }
        .ds-analytics-scene { font-size: 0.86rem; font-weight: 600; color: var(--ink); flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
        .ds-analytics-time { font-size: 0.68rem; color: var(--ink3); font-family: var(--font-mono); }
        .ds-analytics-heat { display: flex; align-items: center; gap: 0.5rem; }
        .ds-analytics-heat-bar { flex: 1; height: 6px; background: var(--hairline); border-radius: 3px; overflow: hidden; }
        .ds-analytics-heat-fill { height: 100%; background: linear-gradient(90deg, var(--accent), var(--accent-hover)); border-radius: 3px; }
        .ds-analytics-heat-score { font-size: 0.75rem; font-weight: 700; color: var(--accent); font-family: var(--font-mono); min-width: 36px; text-align: right; }
        .ds-analytics-metrics { display: flex; flex-wrap: wrap; gap: 0.45rem; font-size: 0.72rem; color: var(--ink2); }
        .ds-analytics-metrics > span { display: inline-flex; align-items: center; gap: 0.25rem; padding: 0.18rem 0.4rem; background: var(--bg-3); border: 1px solid var(--hairline); border-radius: 999px; }
        .ds-analytics-drop { color: var(--danger); border-color: var(--danger); background: var(--danger-quiet); }
        .ds-analytics-suggestions { margin: 0; padding: 0 0 0 1.1rem; display: flex; flex-direction: column; gap: 0.3rem; font-size: 0.76rem; color: var(--ink2); }
        .ds-analytics-suggestions li { display: flex; align-items: flex-start; gap: 0.35rem; }
        .ds-analytics-suggestions li svg { flex-shrink: 0; margin-top: 0.15rem; }

        /* ── Overlays ── */
        .overlay {
          position: fixed;
          inset: 0;
          z-index: 100;
          background: rgba(0,0,0,0.85);
          backdrop-filter: blur(6px);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem;
        }
        .overlay-panel {
          width: min(1000px, 100%);
          max-height: 85vh;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          display: flex;
          flex-direction: column;
          overflow: hidden;
        }
        .overlay-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 1rem 1.1rem;
          border-bottom: 1px solid var(--hairline);
        }
        .overlay-head h2 { margin: 0; font-size: 1.1rem; font-weight: 600; display: flex; align-items: center; gap: 0.5rem; }
        .overlay-body { flex: 1; overflow: auto; padding: 1rem; }

        /* M2.3:导演台 overlay 全屏聚焦(用独立 class 避免与 DirectorPanel 内部 .ds-director-panel 冲突) */
        .ds-director-overlay { z-index: 60; }
        .ds-director-overlay-panel {
          max-width: 1200px;
          width: 92vw;
          height: 88vh;
          display: flex;
          flex-direction: column;
        }
        .ds-director-body {
          flex: 1;
          overflow: auto;
          padding: 1rem;
        }
        .ds-director-loading {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 3rem;
          color: var(--ink3);
          font-size: 0.85rem;
        }

        .ref-overlay {
          position: fixed;
          inset: 0;
          z-index: 1000;
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 2rem;
          background: rgba(0,0,0,0.85);
          backdrop-filter: blur(4px);
          cursor: zoom-out;
        }
        .ref-overlay-inner {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          max-width: min(92vw, 900px);
          max-height: 92vh;
          cursor: default;
        }
        .ref-overlay-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 1rem;
          padding: 0.7rem 0.9rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius) var(--radius) 0 0;
          color: var(--ink);
          font-size: 0.85rem;
        }
        .ref-overlay-inner img {
          max-width: 100%;
          max-height: 80vh;
          object-fit: contain;
          border-radius: 0 0 var(--radius) var(--radius);
          border: 1px solid var(--hairline);
          border-top: none;
        }
      `}</style>
    </div>
  );
}