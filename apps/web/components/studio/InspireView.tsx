"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createDramaProject,
  dramaApplySkill,
  dramaListSkills,
  getDramaProject,
  imageUrl,
  listDramaProjects,
} from "@/lib/api";
import type {
  DramaProcessStep,
  DramaProjectSummary,
  DramaSkill,
} from "@/lib/api";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";

// Skill 分类 → 中文标签(与 SkillMarket 保持一致)
const CATEGORY_LABEL: Record<string, string> = {
  action: "动作",
  romance: "言情",
  scifi: "科幻",
  comedy: "喜剧",
};

// 项目状态 → 徽章文案
const STATUS_LABEL: Record<string, string> = {
  draft: "草稿",
  storyboard: "分镜中",
  ready: "已成片",
};

// 创作过程步骤 → 图标 + 中文标签(渲染逻辑对齐 ProcessTab)
function processStepMeta(step: string): { icon: IconName; label: string } {
  const s = (step || "").toLowerCase();
  if (s === "storyboard" || s === "storyboard_done")
    return { icon: "filevideo", label: "剧本拆镜" };
  if (s === "generate_video" || s === "generate-video")
    return { icon: "film", label: "视频生成" };
  if (s === "assemble" || s === "assembly")
    return { icon: "manju", label: "合成成片" };
  if (s === "generate_reference" || s === "generate-reference")
    return { icon: "users", label: "角色三视图" };
  if (s === "grid_storyboard" || s === "grid-storyboard")
    return { icon: "canvas", label: "宫格分镜" };
  if (s === "create" || s === "init" || s === "create_project")
    return { icon: "create", label: "创建项目" };
  return { icon: "history", label: step || "步骤" };
}

// ISO 时间戳 → 相对时间(时间线节点用)
function relTime(ts: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  const diff = Date.now() - d.getTime();
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const days = Math.floor(h / 24);
  if (days < 30) return `${days} 天前`;
  return d.toLocaleDateString("zh-CN");
}

export function InspireView({
  onOpenProject,
}: {
  onOpenProject?: (id: string) => void;
}) {
  const { show: showToast } = useToast();

  // ── 题材模板(Skill) ──
  const [skills, setSkills] = useState<DramaSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [skillsError, setSkillsError] = useState("");

  // ── 成片墙 ──
  const [projects, setProjects] = useState<DramaProjectSummary[]>([]);
  const [projectsLoading, setProjectsLoading] = useState(true);
  const [projectsError, setProjectsError] = useState("");

  // ── 异步按钮防重入 ──
  const [applyingId, setApplyingId] = useState<string | null>(null);
  const [remixingId, setRemixingId] = useState<string | null>(null);

  // ── 创作过程展开(卡片内时间线,按项目缓存) ──
  const [processOpenId, setProcessOpenId] = useState<string | null>(null);
  const [processLoadingId, setProcessLoadingId] = useState<string | null>(null);
  const [processCache, setProcessCache] = useState<
    Record<string, DramaProcessStep[]>
  >({});

  const loadSkills = useCallback(() => {
    setSkillsLoading(true);
    setSkillsError("");
    dramaListSkills()
      .then((res) => setSkills(res.skills ?? []))
      .catch((err) =>
        setSkillsError(
          err instanceof Error ? err.message : "加载题材模板失败",
        ),
      )
      .finally(() => setSkillsLoading(false));
  }, []);

  const loadProjects = useCallback(() => {
    setProjectsLoading(true);
    setProjectsError("");
    listDramaProjects()
      .then((list) => setProjects(list ?? []))
      .catch((err) => {
        const msg = err instanceof Error ? err.message : "加载成片列表失败";
        setProjectsError(msg);
        showToast("error", msg);
      })
      .finally(() => setProjectsLoading(false));
  }, [showToast]);

  // 并行拉取 Skills + 项目列表
  useEffect(() => {
    loadSkills();
    loadProjects();
  }, [loadSkills, loadProjects]);

  // 成片墙只展示已合成成片的项目
  const finishedProjects = useMemo(
    () => projects.filter((p) => Boolean(p.video_url)),
    [projects],
  );

  // 「一键开拍」:应用 Skill 创建新项目 → 跳转工作室
  const handleApplySkill = useCallback(
    (skill: DramaSkill) => {
      if (applyingId) return;
      setApplyingId(skill.id);
      dramaApplySkill(skill.id)
        .then((project) => {
          showToast("success", `已基于「${skill.name}」开拍新项目`);
          onOpenProject?.(project.id);
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "一键开拍失败",
          ),
        )
        .finally(() => setApplyingId(null));
    },
    [applyingId, onOpenProject, showToast],
  );

  // 「用作模板」:复制项目基础参数创建灵感复刻版
  const handleRemix = useCallback(
    (p: DramaProjectSummary) => {
      if (remixingId) return;
      setRemixingId(p.id);
      createDramaProject({
        title: `${p.title} · 灵感复刻`,
        premise: p.premise,
        style: p.style,
        script: p.script,
        width: p.width,
        height: p.height,
        fps: p.fps,
      })
        .then((created) => {
          showToast("success", `已复刻「${p.title}」,新项目已创建`);
          onOpenProject?.(created.id);
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "复刻模板失败",
          ),
        )
        .finally(() => setRemixingId(null));
    },
    [remixingId, onOpenProject, showToast],
  );

  // 「查看创作过程」:展开/收起卡片内时间线,首次展开时拉取 process_data
  const toggleProcess = useCallback(
    (p: DramaProjectSummary) => {
      if (processOpenId === p.id) {
        setProcessOpenId(null);
        return;
      }
      setProcessOpenId(p.id);
      if (processCache[p.id] || processLoadingId === p.id) return;
      setProcessLoadingId(p.id);
      getDramaProject(p.id)
        .then((detail) =>
          setProcessCache((prev) => ({
            ...prev,
            [p.id]: detail.process_data ?? [],
          })),
        )
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "加载创作过程失败",
          ),
        )
        .finally(() => setProcessLoadingId(null));
    },
    [processOpenId, processCache, processLoadingId, showToast],
  );

  return (
    <div className="fa-inspire">
      {/* ── Hero 头 ── */}
      <header className="fa-hero">
        <h1 className="fa-hero-title">灵感广场</h1>
        <p className="fa-hero-sub">题材模板 · 成片灵感 · 创作过程全公开</p>
        <span className="fa-hero-line" aria-hidden="true" />
      </header>

      {/* ── 题材模板横排 ── */}
      <section className="fa-section">
        <div className="fa-section-head">
          <Icon name="sparkles" size={15} />
          <h2 className="fa-section-title">题材模板</h2>
          <span className="fa-section-hint">一键开拍,直接进工作室</span>
        </div>

        {skillsLoading && (
          <div className="fa-skill-row" aria-busy="true">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="fa-skill-card fa-skeleton-card">
                <div className="fa-skeleton fa-skeleton-cover" />
                <div className="fa-skeleton fa-skeleton-line" />
                <div className="fa-skeleton fa-skeleton-line fa-skeleton-line-short" />
              </div>
            ))}
          </div>
        )}

        {!skillsLoading && skillsError && (
          <div className="fa-inline-state">
            <Icon name="error" size={16} />
            <span>{skillsError}</span>
            <button type="button" className="fa-btn fa-btn-ghost" onClick={loadSkills}>
              <Icon name="refresh" size={12} />
              重试
            </button>
          </div>
        )}

        {!skillsLoading && !skillsError && skills.length === 0 && (
          <div className="fa-inline-state fa-inline-empty">
            <Icon name="sparkles" size={18} strokeWidth={1.4} />
            <span>暂无题材模板</span>
          </div>
        )}

        {!skillsLoading && !skillsError && skills.length > 0 && (
          <div className="fa-skill-row">
            {skills.map((s) => {
              const isApplying = applyingId === s.id;
              return (
                <article key={s.id} className="fa-skill-card">
                  <div className="fa-skill-cover">
                    <Icon name="film" size={26} strokeWidth={1.2} />
                    <span className="fa-skill-badge">
                      {CATEGORY_LABEL[s.category] ?? s.category}
                    </span>
                  </div>
                  <div className="fa-skill-body">
                    <h3 className="fa-skill-name" title={s.name}>
                      {s.name}
                    </h3>
                    <p className="fa-skill-desc">{s.description}</p>
                    <div className="fa-skill-foot">
                      <span className="fa-skill-spec">
                        {s.default_num_shots} 镜 · {s.width}×{s.height}
                      </span>
                      <button
                        type="button"
                        className="fa-btn fa-btn-primary"
                        onClick={() => handleApplySkill(s)}
                        disabled={applyingId !== null}
                        title={`基于「${s.name}」创建新项目`}
                      >
                        {isApplying ? (
                          <>
                            <Icon name="loading" size={12} className="fa-spin" />
                            开拍中…
                          </>
                        ) : (
                          <>
                            <Icon name="sparkles" size={12} />
                            一键开拍
                          </>
                        )}
                      </button>
                    </div>
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 成片墙 ── */}
      <section className="fa-section">
        <div className="fa-section-head">
          <Icon name="video" size={15} />
          <h2 className="fa-section-title">成片墙</h2>
          {finishedProjects.length > 0 && (
            <span className="fa-section-count">{finishedProjects.length}</span>
          )}
        </div>

        {projectsLoading && (
          <div className="fa-wall" aria-busy="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="fa-card fa-skeleton-card">
                <div className="fa-skeleton fa-skeleton-video" />
                <div className="fa-card-body">
                  <div className="fa-skeleton fa-skeleton-line" />
                  <div className="fa-skeleton fa-skeleton-line fa-skeleton-line-short" />
                </div>
              </div>
            ))}
          </div>
        )}

        {!projectsLoading && projectsError && (
          <div className="fa-inline-state">
            <Icon name="error" size={16} />
            <span>{projectsError}</span>
            <button
              type="button"
              className="fa-btn fa-btn-ghost"
              onClick={loadProjects}
            >
              <Icon name="refresh" size={12} />
              重试
            </button>
          </div>
        )}

        {!projectsLoading && !projectsError && finishedProjects.length === 0 && (
          <div className="fa-empty">
            <Icon name="film" size={30} strokeWidth={1.2} />
            <span>还没有成片 · 去工作室完成第一部短剧</span>
          </div>
        )}

        {!projectsLoading && !projectsError && finishedProjects.length > 0 && (
          <div className="fa-wall">
            {finishedProjects.map((p) => {
              const isOpen = processOpenId === p.id;
              const isLoadingProcess = processLoadingId === p.id;
              const steps = processCache[p.id];
              const isRemixing = remixingId === p.id;
              return (
                <article key={p.id} className="fa-card">
                  <div className="fa-card-media">
                    <video
                      className="fa-card-video"
                      src={imageUrl(p.video_url)}
                      preload="metadata"
                      muted
                      playsInline
                    />
                    <span className="fa-card-status">
                      {STATUS_LABEL[p.status] ?? p.status}
                    </span>
                    {/* hover 浮现操作条 */}
                    <div className="fa-card-actions">
                      <button
                        type="button"
                        className="fa-action"
                        onClick={() => toggleProcess(p)}
                        title="查看创作过程"
                      >
                        <Icon
                          name={isOpen ? "chevron-down" : "history"}
                          size={13}
                        />
                        {isOpen ? "收起过程" : "查看创作过程"}
                      </button>
                      <button
                        type="button"
                        className="fa-action"
                        onClick={() => handleRemix(p)}
                        disabled={remixingId !== null}
                        title="用作模板"
                      >
                        {isRemixing ? (
                          <Icon name="loading" size={13} className="fa-spin" />
                        ) : (
                          <Icon name="create" size={13} />
                        )}
                        用作模板
                      </button>
                      <button
                        type="button"
                        className="fa-action"
                        onClick={() => onOpenProject?.(p.id)}
                        title="打开项目"
                      >
                        <Icon name="eye" size={13} />
                        打开
                      </button>
                    </div>
                  </div>
                  <div className="fa-card-body">
                    <h3 className="fa-card-title" title={p.title}>
                      {p.title}
                    </h3>
                    {p.premise && <p className="fa-card-premise">{p.premise}</p>}
                    <div className="fa-card-spec">
                      <span>{p.duration_sec}s</span>
                      <span className="fa-card-spec-dot">·</span>
                      <span>
                        {p.width}×{p.height}
                      </span>
                    </div>
                  </div>

                  {/* 卡片内展开:创作过程时间线 */}
                  {isOpen && (
                    <div className="fa-process">
                      {isLoadingProcess && (
                        <div className="fa-process-loading">
                          <Icon name="loading" size={14} className="fa-spin" />
                          <span>加载创作过程…</span>
                        </div>
                      )}
                      {!isLoadingProcess && steps && steps.length === 0 && (
                        <div className="fa-process-loading">
                          <Icon name="history" size={14} strokeWidth={1.4} />
                          <span>暂无创作过程记录</span>
                        </div>
                      )}
                      {!isLoadingProcess && steps && steps.length > 0 && (
                        <ol className="fa-timeline">
                          {steps.map((st, i) => {
                            const meta = processStepMeta(st.step);
                            const isLast = i === steps.length - 1;
                            return (
                              <li key={`${st.step}-${i}`} className="fa-tl-node">
                                <div className="fa-tl-rail">
                                  <span
                                    className={`fa-tl-dot ${
                                      isLast ? "fa-tl-dot-active" : ""
                                    }`}
                                  >
                                    <Icon name={meta.icon} size={11} />
                                  </span>
                                  {!isLast && <span className="fa-tl-line" />}
                                </div>
                                <div className="fa-tl-content">
                                  <div className="fa-tl-step">
                                    {meta.label}
                                    <span className="fa-tl-ts">
                                      {relTime(st.ts)}
                                    </span>
                                  </div>
                                  {st.detail && (
                                    <p className="fa-tl-detail">{st.detail}</p>
                                  )}
                                </div>
                              </li>
                            );
                          })}
                        </ol>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </section>

      <style jsx>{`
        .fa-inspire {
          display: flex;
          flex-direction: column;
          gap: 2.2rem;
          padding: 2rem 2.4rem 3rem;
          max-width: 1280px;
          margin: 0 auto;
          color: var(--fa-ink);
        }

        /* ── Hero ── */
        .fa-hero {
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
        }
        .fa-hero-title {
          margin: 0;
          font-family: var(--fa-serif);
          font-size: 2.4rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          line-height: 1.15;
          color: var(--fa-ink);
        }
        .fa-hero-sub {
          margin: 0;
          font-size: 0.86rem;
          color: var(--fa-ink2);
          letter-spacing: 0.06em;
        }
        .fa-hero-line {
          display: block;
          width: 64px;
          height: 2px;
          margin-top: 0.5rem;
          background: linear-gradient(
            90deg,
            var(--fa-amber),
            var(--fa-amber-soft)
          );
          border-radius: 2px;
        }

        /* ── 区块 ── */
        .fa-section {
          display: flex;
          flex-direction: column;
          gap: 0.9rem;
        }
        .fa-section-head {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          color: var(--fa-amber);
        }
        .fa-section-title {
          margin: 0;
          font-family: var(--fa-serif);
          font-size: 1.15rem;
          font-weight: 600;
          letter-spacing: 0.02em;
          color: var(--fa-ink);
        }
        .fa-section-hint {
          font-size: 0.72rem;
          color: var(--fa-ink3);
        }
        .fa-section-count {
          font-family: var(--fa-mono);
          font-size: 0.7rem;
          color: var(--fa-ink2);
          padding: 0.05rem 0.5rem;
          border: 1px solid var(--fa-line);
          border-radius: 999px;
        }

        /* ── 题材模板横排 ── */
        .fa-skill-row {
          display: flex;
          gap: 0.8rem;
          overflow-x: auto;
          padding-bottom: 0.4rem;
          scrollbar-width: thin;
        }
        .fa-skill-card {
          flex: 0 0 240px;
          display: flex;
          flex-direction: column;
          background: var(--fa-card);
          border: 1px solid var(--fa-line);
          border-radius: 10px;
          overflow: hidden;
          transition: border-color 0.2s ease, transform 0.2s ease;
        }
        .fa-skill-card:hover {
          border-color: var(--fa-line-hi);
          transform: translateY(-2px);
        }
        .fa-skill-cover {
          position: relative;
          display: flex;
          align-items: center;
          justify-content: center;
          height: 96px;
          background: var(--fa-hi);
          color: var(--fa-ink3);
        }
        .fa-skill-badge {
          position: absolute;
          top: 8px;
          left: 8px;
          padding: 0.1rem 0.5rem;
          font-size: 0.64rem;
          font-family: var(--fa-mono);
          letter-spacing: 0.04em;
          color: var(--fa-amber);
          background: var(--fa-amber-soft);
          border: 1px solid var(--fa-amber-line);
          border-radius: 4px;
        }
        .fa-skill-body {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.7rem 0.8rem 0.8rem;
        }
        .fa-skill-name {
          margin: 0;
          font-size: 0.92rem;
          font-weight: 600;
          color: var(--fa-ink);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-skill-desc {
          margin: 0;
          font-size: 0.76rem;
          line-height: 1.5;
          color: var(--fa-ink2);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          min-height: 2.3em;
        }
        .fa-skill-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.4rem;
          margin-top: 0.15rem;
          padding-top: 0.5rem;
          border-top: 1px dashed var(--fa-line);
        }
        .fa-skill-spec {
          font-family: var(--fa-mono);
          font-size: 0.66rem;
          color: var(--fa-ink3);
          letter-spacing: 0.02em;
        }

        /* ── 按钮 ── */
        .fa-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.32rem 0.75rem;
          font-size: 0.74rem;
          font-family: inherit;
          border-radius: 6px;
          border: 1px solid transparent;
          cursor: pointer;
          transition: opacity 0.15s ease, background-color 0.15s ease,
            border-color 0.15s ease;
        }
        .fa-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .fa-btn-primary {
          background: var(--fa-amber);
          color: var(--fa-bg);
          font-weight: 600;
        }
        .fa-btn-primary:hover:not(:disabled) {
          background: var(--fa-amber-hi);
        }
        .fa-btn-ghost {
          background: transparent;
          border-color: var(--fa-line-hi);
          color: var(--fa-ink2);
        }
        .fa-btn-ghost:hover:not(:disabled) {
          color: var(--fa-ink);
          border-color: var(--fa-amber-line);
        }

        /* ── 行内状态(失败 / 空) ── */
        .fa-inline-state {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.9rem 1rem;
          font-size: 0.8rem;
          color: var(--fa-red);
          background: var(--fa-bg2);
          border: 1px solid var(--fa-line);
          border-radius: 8px;
        }
        .fa-inline-empty {
          color: var(--fa-ink3);
        }

        /* ── 成片墙 ── */
        .fa-wall {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 0.9rem;
        }
        .fa-card {
          display: flex;
          flex-direction: column;
          background: var(--fa-card);
          border: 1px solid var(--fa-line);
          border-radius: 10px;
          overflow: hidden;
          transition: border-color 0.2s ease, transform 0.2s ease;
        }
        .fa-card:hover {
          border-color: var(--fa-line-hi);
          transform: translateY(-2px);
        }
        .fa-card-media {
          position: relative;
          aspect-ratio: 16 / 9;
          background: var(--fa-bg);
        }
        .fa-card-video {
          display: block;
          width: 100%;
          height: 100%;
          object-fit: cover;
        }
        .fa-card-status {
          position: absolute;
          top: 8px;
          right: 8px;
          padding: 0.1rem 0.5rem;
          font-size: 0.64rem;
          font-family: var(--fa-mono);
          letter-spacing: 0.04em;
          color: var(--fa-green);
          background: rgba(18, 17, 16, 0.72);
          border: 1px solid var(--fa-line-hi);
          border-radius: 4px;
          backdrop-filter: blur(4px);
        }
        .fa-card-actions {
          position: absolute;
          left: 0;
          right: 0;
          bottom: 0;
          display: flex;
          gap: 0.35rem;
          padding: 0.55rem 0.6rem;
          background: rgba(18, 17, 16, 0.82);
          backdrop-filter: blur(4px);
          opacity: 0;
          transform: translateY(6px);
          transition: opacity 0.2s ease, transform 0.2s ease;
        }
        .fa-card-media:hover .fa-card-actions,
        .fa-card-media:focus-within .fa-card-actions {
          opacity: 1;
          transform: translateY(0);
        }
        .fa-action {
          display: inline-flex;
          align-items: center;
          gap: 0.28rem;
          padding: 0.28rem 0.55rem;
          font-size: 0.68rem;
          font-family: inherit;
          color: var(--fa-ink);
          background: var(--fa-hi);
          border: 1px solid var(--fa-line-hi);
          border-radius: 5px;
          cursor: pointer;
          transition: color 0.15s ease, border-color 0.15s ease;
        }
        .fa-action:hover:not(:disabled) {
          color: var(--fa-amber-hi);
          border-color: var(--fa-amber-line);
        }
        .fa-action:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        .fa-card-body {
          display: flex;
          flex-direction: column;
          gap: 0.35rem;
          padding: 0.75rem 0.85rem 0.85rem;
        }
        .fa-card-title {
          margin: 0;
          font-family: var(--fa-serif);
          font-size: 1rem;
          font-weight: 600;
          color: var(--fa-ink);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .fa-card-premise {
          margin: 0;
          font-size: 0.75rem;
          line-height: 1.5;
          color: var(--fa-ink2);
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .fa-card-spec {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          font-family: var(--fa-mono);
          font-size: 0.68rem;
          color: var(--fa-ink3);
          letter-spacing: 0.03em;
        }
        .fa-card-spec-dot {
          color: var(--fa-line-hi);
        }

        /* ── 创作过程时间线 ── */
        .fa-process {
          border-top: 1px solid var(--fa-line);
          padding: 0.7rem 0.85rem 0.85rem;
          background: var(--fa-bg2);
        }
        .fa-process-loading {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.74rem;
          color: var(--fa-ink3);
          padding: 0.3rem 0;
        }
        .fa-timeline {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
        }
        .fa-tl-node {
          display: flex;
          gap: 0.55rem;
        }
        .fa-tl-rail {
          display: flex;
          flex-direction: column;
          align-items: center;
          flex: 0 0 auto;
        }
        .fa-tl-dot {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: 50%;
          color: var(--fa-ink2);
          background: var(--fa-hi);
          border: 1px solid var(--fa-line-hi);
        }
        .fa-tl-dot-active {
          color: var(--fa-amber);
          border-color: var(--fa-amber-line);
          background: var(--fa-amber-soft);
        }
        .fa-tl-line {
          flex: 1;
          width: 1px;
          min-height: 10px;
          background: var(--fa-line);
        }
        .fa-tl-content {
          flex: 1;
          min-width: 0;
          padding-bottom: 0.7rem;
        }
        .fa-tl-node:last-child .fa-tl-content {
          padding-bottom: 0.1rem;
        }
        .fa-tl-step {
          display: flex;
          align-items: baseline;
          justify-content: space-between;
          gap: 0.5rem;
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--fa-ink);
        }
        .fa-tl-ts {
          font-family: var(--fa-mono);
          font-size: 0.64rem;
          font-weight: 400;
          color: var(--fa-ink3);
          flex: 0 0 auto;
        }
        .fa-tl-detail {
          margin: 0.2rem 0 0;
          font-size: 0.72rem;
          line-height: 1.5;
          color: var(--fa-ink2);
        }

        /* ── 空态 ── */
        .fa-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.6rem;
          padding: 3rem 1rem;
          font-size: 0.84rem;
          color: var(--fa-ink3);
          border: 1px dashed var(--fa-line-hi);
          border-radius: 10px;
          background: var(--fa-bg2);
        }
        .fa-empty :global(svg) {
          color: var(--fa-ink3);
        }

        /* ── 骨架屏(呼吸灰块) ── */
        .fa-skeleton-card {
          pointer-events: none;
        }
        .fa-skeleton {
          background: var(--fa-hi);
          border-radius: 6px;
          animation: fa-breathe 1.6s ease-in-out infinite;
        }
        .fa-skeleton-cover {
          height: 96px;
          border-radius: 0;
        }
        .fa-skeleton-video {
          aspect-ratio: 16 / 9;
          border-radius: 0;
        }
        .fa-skeleton-line {
          height: 12px;
          margin: 0.35rem 0.8rem;
        }
        .fa-card-body .fa-skeleton-line {
          margin: 0;
        }
        .fa-skeleton-line-short {
          width: 55%;
        }
        @keyframes fa-breathe {
          0%,
          100% {
            opacity: 0.45;
          }
          50% {
            opacity: 1;
          }
        }

        /* ── 旋转动画 ── */
        .fa-spin {
          animation: fa-spin 1s linear infinite;
        }
        @keyframes fa-spin {
          to {
            transform: rotate(360deg);
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .fa-spin,
          .fa-skeleton {
            animation: none;
          }
          .fa-skill-card,
          .fa-card,
          .fa-card-actions,
          .fa-btn,
          .fa-action {
            transition: none;
          }
        }

        @media (max-width: 720px) {
          .fa-inspire {
            padding: 1.4rem 1rem 2.4rem;
          }
          .fa-hero-title {
            font-size: 1.8rem;
          }
          .fa-card-actions {
            opacity: 1;
            transform: none;
          }
        }
      `}</style>
    </div>
  );
}
