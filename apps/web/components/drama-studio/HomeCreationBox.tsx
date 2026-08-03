"use client";

import { useCallback, useEffect, useState } from "react";

import {
  createDramaProject,
  dramaListSkills,
  dramaApplySkill,
} from "@/lib/api";
import type { DramaProjectSummary, DramaSkill } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";

interface HomeCreationBoxProps {
  /** 创建项目成功后回调(传入新项目 id,父组件切到 dramaStudio 视图)。 */
  onCreate: (projectId: string) => void;
  /** 应用 Skill 创建项目成功后回调。 */
  onSkillApplied: (projectId: string) => void;
}

// category 中文标签
const CATEGORY_LABEL: Record<string, string> = {
  action: "动作",
  romance: "言情",
  scifi: "科幻",
  comedy: "喜剧",
};

export function HomeCreationBox({ onCreate, onSkillApplied }: HomeCreationBoxProps) {
  const [title, setTitle] = useState("");
  const [script, setScript] = useState("");
  const [style, setStyle] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>("");

  // Skill 快捷入口
  const [skills, setSkills] = useState<DramaSkill[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const { show: showToast } = useToast();

  // 加载 4 个内置 Skill 作快捷入口
  const loadSkills = useCallback(() => {
    setSkillsLoading(true);
    dramaListSkills()
      .then((res) => setSkills((res.skills ?? []).slice(0, 4)))
      .catch(() => setSkills([]))
      .finally(() => setSkillsLoading(false));
  }, []);

  useEffect(() => {
    loadSkills();
  }, [loadSkills]);

  const handleCreate = useCallback(() => {
    if (creating) return;
    if (!title.trim()) {
      setError("请给短剧起个名字");
      return;
    }
    if (!script.trim()) {
      setError("请写下你的故事");
      return;
    }
    setCreating(true);
    setError("");
    createDramaProject({
      title: title.trim(),
      script: script.trim(),
      ...(style.trim() ? { style: style.trim() } : {}),
      width: 768,
      height: 384,
      fps: 16,
    })
      .then((p: DramaProjectSummary) => {
        showToast("success", `项目「${p.title}」已创建`);
        setTitle("");
        setScript("");
        setStyle("");
        onCreate(p.id);
      })
      .catch((err) =>
        setError(err instanceof Error ? err.message : "创建项目失败"),
      )
      .finally(() => setCreating(false));
  }, [creating, title, script, style, onCreate, showToast]);

  const handleApplySkill = useCallback(
    (skill: DramaSkill) => {
      if (applyingId) {
        showToast("info", "已有 Skill 应用中,请稍候");
        return;
      }
      setApplyingId(skill.id);
      dramaApplySkill(skill.id)
        .then((project) => {
          showToast("success", `已基于 Skill「${skill.name}」创建项目`);
          onSkillApplied(project.id);
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "应用 Skill 失败",
          ),
        )
        .finally(() => setApplyingId(null));
    },
    [applyingId, onSkillApplied, showToast],
  );

  // Ctrl/Cmd+Enter 提交
  const onKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        handleCreate();
      }
    },
    [handleCreate],
  );

  return (
    <section className="ds-home-box" aria-label="快速开始创作">
      <div className="ds-home-glow" aria-hidden="true" />
      <div className="ds-home-card">
        <div className="ds-home-head">
          <div className="ds-home-title">
            <Icon name="drama" size={22} strokeWidth={1.6} />
            <span>开启一段新故事</span>
          </div>
          <p className="ds-home-sub">
            填写标题与剧本 · AI 自动拆分镜、生成视频、配音、合成成片
          </p>
        </div>

        <div className="ds-home-form">
          <label className="ds-home-field ds-home-field-title">
            <input
              className="ds-home-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="给你的短剧起个名字..."
              maxLength={80}
              disabled={creating}
            />
          </label>
          <label className="ds-home-field">
            <textarea
              className="ds-home-textarea"
              value={script}
              onChange={(e) => setScript(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder="写下你的故事...或者选择一个 Skill 模板快速开始"
              rows={5}
              disabled={creating}
            />
            <span className="ds-home-hint">⌘/Ctrl + Enter 快速提交</span>
          </label>
          <label className="ds-home-field ds-home-field-style">
            <input
              className="ds-home-input"
              value={style}
              onChange={(e) => setStyle(e.target.value)}
              placeholder="风格(可选,如:都市悬疑 / 古风言情)"
              disabled={creating}
            />
          </label>

          {error && <div className="ds-home-error">{error}</div>}

          <div className="ds-home-actions">
            <button
              type="button"
              className="btn btn-primary ds-home-submit"
              onClick={handleCreate}
              disabled={creating}
            >
              {creating ? (
                <>
                  <Icon name="loading" size={14} className="ds-spin" />
                  创建中…
                </>
              ) : (
                <>
                  <Icon name="sparkles" size={14} />
                  开始创作
                </>
              )}
            </button>
          </div>
        </div>

        {/* Skill 模板快捷入口 */}
        <div className="ds-home-skills">
          <div className="ds-home-skills-head">
            <Icon name="sparkles" size={13} />
            <span>Skill 模板 · 一键套用</span>
          </div>
          {skillsLoading && (
            <div className="ds-home-skills-loading">
              <Icon name="loading" size={14} className="ds-spin" />
              <span>加载模板…</span>
            </div>
          )}
          {!skillsLoading && skills.length === 0 && (
            <div className="ds-home-skills-empty">
              暂无 Skill 模板,可填写左侧表单手动创建
            </div>
          )}
          {!skillsLoading && skills.length > 0 && (
            <ul className="ds-home-skills-list">
              {skills.map((s) => {
                const isApplying = applyingId === s.id;
                return (
                  <li key={s.id} className="ds-home-skill-card">
                    <div className="ds-home-skill-head">
                      <span className={`ds-home-skill-cat ds-home-skill-cat-${s.category}`}>
                        {CATEGORY_LABEL[s.category] ?? s.category}
                      </span>
                      <span className="ds-home-skill-shots">
                        {s.default_num_shots} 镜
                      </span>
                    </div>
                    <div className="ds-home-skill-name" title={s.name}>
                      {s.name}
                    </div>
                    <p className="ds-home-skill-desc">{s.description}</p>
                    <button
                      type="button"
                      className="btn btn-sm ds-home-skill-apply"
                      onClick={() => handleApplySkill(s)}
                      disabled={applyingId !== null}
                      title={`基于「${s.name}」创建新项目`}
                    >
                      {isApplying ? (
                        <>
                          <Icon name="loading" size={11} className="ds-spin" />
                          应用中…
                        </>
                      ) : (
                        <>
                          <Icon name="sparkles" size={11} />
                          应用
                        </>
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      <style jsx>{`
        .ds-home-box {
          position: relative;
          width: 100%;
          max-width: 760px;
          margin: 0 auto;
          padding: 2px;
          border-radius: var(--radius-control);
          background: linear-gradient(
            135deg,
            var(--accent),
            transparent 30%,
            transparent 70%,
            var(--accent)
          );
          box-shadow: 0 24px 64px -28px var(--accent-soft);
        }
        .ds-home-glow {
          position: absolute;
          inset: -40px;
          z-index: -1;
          background: radial-gradient(
            circle at 50% 0%,
            var(--accent-soft),
            transparent 60%
          );
          pointer-events: none;
        }
        .ds-home-card {
          display: flex;
          flex-direction: column;
          gap: 1rem;
          padding: 1.5rem 1.6rem 1.4rem;
          background: var(--bg-surface-1);
          border-radius: calc(var(--radius-control) - 2px);
        }
        .ds-home-head {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
        }
        .ds-home-title {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          font-family: var(--font-sans);
          font-size: 1.3rem;
          font-weight: 500;
          color: var(--text-primary);
          letter-spacing: -0.02em;
        }
        .ds-home-title :global(svg) {
          color: var(--accent);
          filter: drop-shadow(0 0 6px var(--accent-soft));
        }
        .ds-home-sub {
          margin: 0;
          font-size: 0.78rem;
          color: var(--text-muted);
          line-height: 1.5;
        }
        .ds-home-form {
          display: flex;
          flex-direction: column;
          gap: 0.7rem;
        }
        .ds-home-field {
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          position: relative;
        }
        .ds-home-field-title .ds-home-input {
          font-size: 1rem;
          font-weight: 600;
          letter-spacing: -0.01em;
        }
        .ds-home-input {
          width: 100%;
          padding: 0.6rem 0.75rem;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-xs);
          color: var(--text-primary);
          font-size: 0.86rem;
          font-family: inherit;
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .ds-home-input:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .ds-home-textarea {
          width: 100%;
          padding: 0.7rem 0.85rem;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-xs);
          color: var(--text-primary);
          font-size: 0.86rem;
          font-family: inherit;
          line-height: 1.6;
          resize: vertical;
          min-height: 120px;
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .ds-home-textarea:focus {
          outline: none;
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .ds-home-hint {
          position: absolute;
          right: 0.5rem;
          bottom: 0.35rem;
          font-size: 0.62rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          pointer-events: none;
          opacity: 0.7;
        }
        .ds-home-error {
          padding: 0.45rem 0.6rem;
          background: var(--err-soft);
          border: 1px solid var(--err);
          border-radius: var(--radius-xs);
          color: var(--err);
          font-size: 0.78rem;
        }
        .ds-home-actions {
          display: flex;
          justify-content: flex-end;
        }
        .ds-home-submit {
          min-width: 140px;
          justify-content: center;
        }

        /* ── Skill 模板快捷入口 ── */
        .ds-home-skills {
          display: flex;
          flex-direction: column;
          gap: 0.5rem;
          padding-top: 0.85rem;
          border-top: 1px dashed var(--border-subtle);
        }
        .ds-home-skills-head {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          font-size: 0.74rem;
          font-weight: 600;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .ds-home-skills-head :global(svg) {
          color: var(--accent);
        }
        .ds-home-skills-loading,
        .ds-home-skills-empty {
          display: flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.5rem 0.6rem;
          font-size: 0.76rem;
          color: var(--text-muted);
        }
        .ds-home-skills-list {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          gap: 0.6rem;
          overflow-x: auto;
          padding-bottom: 4px;
          scroll-snap-type: x mandatory;
        }
        .ds-home-skills-list::-webkit-scrollbar {
          height: 6px;
        }
        .ds-home-skills-list::-webkit-scrollbar-thumb {
          background: var(--border-strong);
          border-radius: 3px;
        }
        .ds-home-skill-card {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          padding: 0.55rem 0.7rem;
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-xs);
          min-width: 180px;
          max-width: 220px;
          scroll-snap-align: start;
        }
        .ds-home-skill-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.35rem;
        }
        .ds-home-skill-cat {
          display: inline-flex;
          align-items: center;
          padding: 0.05rem 0.4rem;
          border-radius: var(--radius-xs);
          font-size: 0.62rem;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          background: var(--bg-surface-3);
          color: var(--text-secondary);
        }
        .ds-home-skill-cat-action {
          background: var(--err-soft);
          color: var(--err);
        }
        .ds-home-skill-cat-romance {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .ds-home-skill-cat-scifi {
          background: var(--run-soft);
          color: var(--run);
        }
        .ds-home-skill-cat-comedy {
          background: var(--warn-soft);
          color: var(--warn);
        }
        .ds-home-skill-shots {
          font-size: 0.62rem;
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .ds-home-skill-name {
          font-size: 0.82rem;
          font-weight: 600;
          color: var(--text-primary);
          line-height: 1.3;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ds-home-skill-desc {
          margin: 0;
          font-size: 0.7rem;
          color: var(--text-secondary);
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
          min-height: 1.9rem;
        }
        .ds-home-skill-apply {
          align-self: flex-start;
          margin-top: 0.15rem;
        }

        /* ── 旋转动画 ── */
        .ds-spin {
          animation: ds-spin 1s linear infinite;
        }
        @keyframes ds-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .ds-spin {
            animation: none;
          }
        }

        @media (max-width: 560px) {
          .ds-home-card {
            padding: 1.1rem 1rem;
          }
          .ds-home-title {
            font-size: 1.1rem;
          }
          .ds-home-submit {
            width: 100%;
          }
        }
      `}</style>
    </section>
  );
}
