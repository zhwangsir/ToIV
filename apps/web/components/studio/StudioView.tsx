"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createStudioProject,
  deleteStudioProject,
  listStudioProjects,
  studioStatus,
  type StudioNextStep,
  type StudioProjectDetail,
  type StudioProjectSummary,
} from "@/lib/api";
import { useStudioProject } from "@/hooks/useStudioProject";
import { usePoll } from "@/hooks/usePoll";
import { Icon, type IconName } from "@/components/ui/Icon";
import { Empty } from "@/components/ui/Empty";
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

/** Batch2 IA:七步短名;视频/配音/对口型复用 StoryboardStage。 */
const STAGES = [
  { key: "script", label: "剧本", icon: "create" as IconName },
  { key: "cast", label: "资产", icon: "users" as IconName },
  { key: "storyboard", label: "分镜", icon: "film" as IconName },
  { key: "video", label: "视频", icon: "video" as IconName },
  { key: "voice", label: "配音", icon: "mic" as IconName },
  { key: "lipsync", label: "对口型", icon: "sparkles" as IconName },
  { key: "assembly", label: "成片", icon: "playing" as IconName },
] as const;

type StageKey = (typeof STAGES)[number]["key"];
type ReadyState = "pending" | "ready" | "partial" | "error";

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

/** 项目状态 → 流水线进度(副标行「进度 n/7」;error 无进度语义)。 */
const PROJECT_PROGRESS_STEP: Record<string, number> = {
  draft: 1,
  storyboard: 3,
  generating: 4,
  ready: 7,
};

const RENDERED = new Set(["rendered", "voiced", "lipsynced", "done"]);
const VOICED = new Set(["voiced", "lipsynced", "done"]);
const LIPSYNCED = new Set(["lipsynced", "done"]);

function shotHasError(d: StudioProjectDetail): boolean {
  return d.shots.some((s) => s.status === "error");
}

/** 从项目详情推导七步就绪态(pending/partial/ready/error)。 */
export function deriveStageReadiness(
  d: StudioProjectDetail | null,
): Record<StageKey, ReadyState> {
  const base: Record<StageKey, ReadyState> = {
    script: "pending",
    cast: "pending",
    storyboard: "pending",
    video: "pending",
    voice: "pending",
    lipsync: "pending",
    assembly: "pending",
  };
  if (!d) return base;

  base.script = d.premise?.trim() ? "ready" : "pending";

  const chars = d.characters;
  if (chars.length === 0) {
    base.cast = "pending";
  } else {
    const counts = chars.map((c) => (c.reference_images || []).filter(Boolean).length);
    const minRefs = Math.min(...counts);
    const anyRef = counts.some((n) => n >= 1);
    if (minRefs >= 3) base.cast = "ready";
    else if (anyRef || chars.every((c) => c.name?.trim())) base.cast = anyRef ? "partial" : "partial";
    else base.cast = "pending";
    // 有角色名即至少 partial(可进分镜);有 ≥1 参考图强化 partial;≥3 全就绪
    if (chars.length > 0 && base.cast === "pending") base.cast = "partial";
  }

  const shots = d.shots;
  base.storyboard = shots.length > 0 ? "ready" : "pending";

  if (shots.length === 0) {
    base.video = base.voice = base.lipsync = "pending";
  } else if (shotHasError(d)) {
    base.video = shots.some((s) => s.status === "error") ? "error" : base.video;
    // 失败镜优先标视频步;配音/对口型按全体进度
    const allRendered = shots.every((s) => RENDERED.has(s.status));
    const allVoiced = shots.every((s) => VOICED.has(s.status));
    const allLipsynced = shots.every((s) => LIPSYNCED.has(s.status));
    if (!allRendered && base.video !== "error") {
      base.video = shots.some((s) => RENDERED.has(s.status)) ? "partial" : "pending";
    } else if (allRendered) base.video = "ready";
    base.voice = allVoiced ? "ready" : shots.some((s) => VOICED.has(s.status)) ? "partial" : "pending";
    base.lipsync = allLipsynced
      ? "ready"
      : shots.some((s) => LIPSYNCED.has(s.status))
        ? "partial"
        : "pending";
  } else {
    const allRendered = shots.every((s) => RENDERED.has(s.status));
    const allVoiced = shots.every((s) => VOICED.has(s.status));
    const allLipsynced = shots.every((s) => LIPSYNCED.has(s.status));
    base.video = allRendered
      ? "ready"
      : shots.some((s) => RENDERED.has(s.status) || s.status === "rendering" || s.status === "queued")
        ? "partial"
        : "pending";
    base.voice = allVoiced
      ? "ready"
      : shots.some((s) => VOICED.has(s.status))
        ? "partial"
        : "pending";
    base.lipsync = allLipsynced
      ? "ready"
      : shots.some((s) => LIPSYNCED.has(s.status))
        ? "partial"
        : "pending";
  }

  base.assembly = d.final_url?.trim()
    ? "ready"
    : shots.length > 0 && shots.every((s) => LIPSYNCED.has(s.status) || RENDERED.has(s.status))
      ? "partial"
      : "pending";

  return base;
}

/**
 * Studio 做短剧(替代旧 短剧/漫剧 双模块)。
 * Batch2:剧本 → 资产 → 分镜 → 视频 → 配音 → 对口型 → 成片(步骤就绪态)。
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
  const [nextStep, setNextStep] = useState<StudioNextStep | null>(null);
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

  // Batch2:轮询 status.next_step 作紧凑提示(不抢 H3 资源)
  usePoll(
    async () => {
      if (!activeId) return;
      try {
        const s = await studioStatus(activeId);
        setNextStep(s.next_step ?? null);
      } catch {
        /* 轮询失败静默,详情仍可用 */
      }
    },
    { intervalMs: 8000, enabled: Boolean(activeId), backoff: true, immediate: true },
  );

  const readiness = useMemo(() => deriveStageReadiness(project.detail), [project.detail]);

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
          title="做短剧"
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
             2026-09-04 美化 W3:内容升 section 档共享空态(图标 + 标题 + 引导 + 主行动) */
          <div className="empty-state">
            <Empty
              size="section"
              icon="clapperboard"
              title="从一段剧情开始"
              desc="新建项目,按「剧本 → 角色 → 分镜 → 合成」四步完成一部短剧"
              action={
                <button
                  type="button"
                  className="at-btn at-btn--primary"
                  onClick={() => void createProject()}
                >
                  <Icon name="plus" size={14} /> 新建项目
                </button>
              }
            />
          </div>
        ) : (
          <ul className="studio-project-list">
            {projects.map((p) => (
              <li key={p.id} className="studio-project-item at-card-in">
                <div className="studio-project-card at-card at-card--interactive">
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
                            ? `进度 ${PROJECT_PROGRESS_STEP[p.status]}/7`
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

  // ── 工作台(七阶段) ──
  const d = project.detail;
  const nextHint =
    nextStep && nextStep.step !== "done"
      ? `${nextStep.label}${nextStep.todo ? ` · ${nextStep.todo}` : ""}`
      : nextStep?.step === "done"
        ? "全部完成"
        : null;

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
          {STAGES.map((s) => {
            const ready = readiness[s.key];
            const active = stage === s.key;
            const readyClass =
              ready === "ready"
                ? " is-ready is-done"
                : ready === "partial"
                  ? " is-partial"
                  : ready === "error"
                    ? " is-error"
                    : " is-pending";
            return (
              <button
                key={s.key}
                type="button"
                role="tab"
                aria-selected={active}
                data-ready={ready}
                className={`studio-stage-btn${active ? " is-active" : ""}${readyClass}`}
                onClick={() => setStage(s.key)}
              >
                <span className="studio-stage-dot" aria-hidden="true" data-ready={ready} />
                <span className="studio-stage-num" aria-hidden="true">
                  {ready === "ready" ? (
                    <Icon name="check" size={11} />
                  ) : ready === "error" ? (
                    <Icon name="alert" size={11} />
                  ) : (
                    STAGES.findIndex((x) => x.key === s.key) + 1
                  )}
                </span>
                <Icon name={s.icon} size={14} /> {s.label}
              </button>
            );
          })}
        </div>
        {nextHint && (
          <p className="studio-next-hint" data-testid="studio-next-hint">
            <Icon name="zap" size={12} /> {nextHint}
          </p>
        )}
      </nav>

      <ErrorBar message={project.error} onClose={project.clearError} />
      {project.loading && !d ? (
        <LoadingBlock variant="line" count={4} />
      ) : (
        <>
          {stage === "script" && <ScriptStage project={project} onDone={() => setStage("cast")} />}
          {stage === "cast" && <CastStage project={project} onDone={() => setStage("storyboard")} />}
          {(stage === "storyboard" ||
            stage === "video" ||
            stage === "voice" ||
            stage === "lipsync") && (
            <StoryboardStage
              project={project}
              focus={
                stage === "storyboard"
                  ? undefined
                  : (stage as "video" | "voice" | "lipsync")
              }
            />
          )}
          {stage === "assembly" && <AssemblyStage project={project} />}
        </>
      )}
    </div>
  );
}
