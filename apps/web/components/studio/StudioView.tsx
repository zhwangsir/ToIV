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

/** 项目状态 → 编辑徽章色调(.at-badge 变体;草稿走默认 hairline) */
const PROJECT_STATUS_TONE: Record<string, string> = {
  storyboard: " at-badge--accent",
  generating: " at-badge--accent",
  ready: " at-badge--ok",
  error: " at-badge--err",
};

/** 项目状态 → 流水线进度(副标行「进度 n/4」;error 无进度语义)。 */
const PROJECT_PROGRESS_STEP: Record<string, number> = {
  draft: 1,
  storyboard: 2,
  generating: 3,
  ready: 4,
};

/**
 * Studio 创作工作室(替代旧 短剧/漫剧 双模块)。
 * 四阶段流水线:剧本 → 角色 → 分镜(分镜级 视频/图像运镜 混合)→ 合成。
 */
export function StudioView({
  onBack,
  initialProjectId,
}: {
  onBack?: () => void;
  /** 外部指定直开的项目 id(2026-08-30 批 D 透传:动态分镜「前往工作室」携带),
      仅作 activeId 初值,项目内部逻辑不变 */
  initialProjectId?: string | null;
}) {
  const [projects, setProjects] = useState<StudioProjectSummary[]>([]);
  const [activeId, setActiveId] = useState<string | null>(initialProjectId ?? null);
  const [stage, setStage] = useState<StageKey>("script");
  const [error, setError] = useState<string | null>(null);
  // 项目列表三态(2026-08-30 UX 批 C):加载中骨架 / 失败 ErrorBar+重试 / 真空态,
  // 失败不再静默降级成空列表(区分「空」与「挂了」)
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<StudioProjectSummary | null>(null);
  const [deleting, setDeleting] = useState(false);
  const toast = useToast();
  const project = useStudioProject(activeId);

  const reload = useCallback(() => {
    setListLoading(true);
    setListError(null);
    listStudioProjects()
      .then(setProjects)
      .catch((e) =>
        setListError(e instanceof Error ? e.message : "项目列表加载失败"),
      )
      .finally(() => setListLoading(false));
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
      <div className="studio-home view-shell">
        <PageHeader
          title="创作工作室"
          desc="剧本 → 角色 → 分镜混合生成 → 合成,四步完成一部短剧"
          icon="clapperboard"
          onBack={onBack}
          backLabel="返回融合"
          actions={
            /* btn-primary 类保留:e2e(authed-studio)锚点;视觉走 .at-btn--primary 墨丸 */
            <button
              type="button"
              className="at-btn at-btn--primary btn-primary"
              onClick={() => void createProject()}
            >
              <Icon name="plus" size={14} /> 新建项目
            </button>
          }
        />
        <ErrorBar message={error} onClose={() => setError(null)} />
        {listLoading ? (
          /* 加载态:骨架卡片(grid 形态与项目卡列表一致) */
          <LoadingBlock variant="grid" count={3} />
        ) : listError ? (
          /* 失败态(TrainView 范式):ErrorBar + 条外重试,不再静默显示为空列表 */
          <div className="studio-list-error">
            <ErrorBar message={listError} onClose={() => setListError(null)} />
            <Button
              variant="secondary"
              size="sm"
              icon={<Icon name="refresh" size={13} />}
              onClick={reload}
            >
              重试
            </Button>
          </div>
        ) : projects.length === 0 ? (
          /* empty-state 类保留:e2e(authed-studio)空态计数锚点;
             Studio Console v1(2026-08-31):kicker/长描述退役,只留一行引导 */
          <div className="at-empty empty-state">
            <h3 className="at-empty-title">从一段剧情开始</h3>
          </div>
        ) : (
          <ul className="studio-project-list">
            {projects.map((p) => (
              <li key={p.id} className="studio-project-item at-card-in">
                <div className="studio-project-card at-card at-card--lift">
                  <button
                    type="button"
                    className="studio-project-open"
                    onClick={() => {
                      setActiveId(p.id);
                      setStage("script");
                    }}
                  >
                    <span className="studio-project-text">
                      <span className="studio-project-title">{p.title || "未命名"}</span>
                      {/* 副标行(2026-08-16 批 2):#短id + 更新时间 + 流水线进度,
                          同名「未命名项目」可区分;镜数需后端字段,本期不加(不改数据流) */}
                      <span className="studio-project-sub">
                        <span className="studio-project-id">#{p.id.slice(0, 6)}</span>
                        <time className="studio-project-date">
                          {new Date(p.updated_at).toLocaleString("zh-CN", {
                            month: "2-digit",
                            day: "2-digit",
                            hour: "2-digit",
                            minute: "2-digit",
                          })}
                        </time>
                        <span className="studio-project-stage">
                          {PROJECT_PROGRESS_STEP[p.status]
                            ? `进度 ${PROJECT_PROGRESS_STEP[p.status]}/4`
                            : "进度 —"}
                        </span>
                      </span>
                    </span>
                    <span className="studio-project-meta">
                      <span
                        className={`at-badge${PROJECT_STATUS_TONE[p.status] ?? ""}`}
                      >
                        {PROJECT_STATUS_LABEL[p.status] ?? p.status}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="studio-shot-del studio-project-del"
                    title="删除项目"
                    aria-label={`删除项目 ${p.title || "未命名"}`}
                    onClick={() => removeProject(p)}
                  >
                    <Icon name="delete" size={14} />
                  </button>
                </div>
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
