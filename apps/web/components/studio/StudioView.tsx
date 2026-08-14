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
import { PageHeader } from "@/components/ui/PageHeader";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { useToast } from "@/components/ui/Toast";
import { ScriptStage } from "./stages/ScriptStage";
import { CastStage } from "./stages/CastStage";
import { StoryboardStage } from "./stages/StoryboardStage";
import { AssemblyStage } from "./stages/AssemblyStage";
import "@/app/styles/studio.css";

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
  const [confirmDelete, setConfirmDelete] = useState<StudioProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
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

  const removeProject = (p: StudioProjectSummary) => setConfirmDelete(p);

  const doRemoveProject = async () => {
    if (!confirmDelete || deleting) return;
    setDeleting(true);
    try {
      await deleteStudioProject(confirmDelete.id);
      if (activeId === confirmDelete.id) setActiveId(null);
      reload();
      toast.success(`项目「${confirmDelete.title || "未命名"}」已删除`);
      setConfirmDelete(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "删除失败");
    } finally {
      setDeleting(false);
    }
  };

  // ── 项目列表(首页) ──
  if (!activeId) {
    return (
      <div className="studio-home">
        <PageHeader
          title="创作工作室"
          desc="剧本 → 角色 → 分镜混合生成 → 合成,四步完成一部短剧"
          icon="clapperboard"
          actions={
            <button type="button" className="btn btn-primary" onClick={() => void createProject()}>
              <Icon name="plus" size={14} /> 新建项目
            </button>
          }
        />
        <ErrorBar message={error} onClose={() => setError(null)} />
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
                  onClick={() => removeProject(p)}
                >
                  <Icon name="delete" size={14} />
                </button>
              </li>
            ))}
          </ul>
        )}
        {/* 删除项目确认(替代原生 window.confirm) */}
        <Modal
          open={!!confirmDelete}
          onClose={() => setConfirmDelete(null)}
          title="删除项目"
          danger
          preventClose={deleting}
          footer={
            <>
              <Button
                variant="secondary"
                disabled={deleting}
                onClick={() => setConfirmDelete(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                loading={deleting}
                icon={<Icon name="delete" size={14} />}
                onClick={() => void doRemoveProject()}
              >
                {deleting ? "删除中…" : "确认删除"}
              </Button>
            </>
          }
        >
          <p style={{ margin: 0, color: "var(--text-secondary)", lineHeight: 1.6 }}>
            删除项目「{confirmDelete?.title || "未命名"}」及其全部分镜?此操作不可撤销。
          </p>
        </Modal>
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

      <ErrorBar message={project.error} onClose={project.clearError} />
      {project.loading && !d ? (
        <LoadingBlock variant="line" count={4} />
      ) : (
        <>
          {stage === "script" && <ScriptStage project={project} onDone={() => setStage("cast")} />}
          {stage === "cast" && <CastStage project={project} onDone={() => setStage("storyboard")} />}
          {stage === "storyboard" && <StoryboardStage project={project} />}
          {stage === "assembly" && <AssemblyStage project={project} />}
        </>
      )}
    </div>
  );
}
