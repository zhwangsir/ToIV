"use client";

import { useCallback, useEffect, useState } from "react";

import { dramaListSkills, dramaApplySkill } from "@/lib/api";
import type { DramaProjectDetail, DramaSkill } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";

// category 中文标签
const CATEGORY_LABEL: Record<string, string> = {
  action: "动作",
  romance: "言情",
  scifi: "科幻",
  comedy: "喜剧",
};

// category 过滤标签(顶部)
const FILTERS: { key: string; label: string }[] = [
  { key: "", label: "全部" },
  { key: "action", label: "动作" },
  { key: "romance", label: "言情" },
  { key: "scifi", label: "科幻" },
  { key: "comedy", label: "喜剧" },
];

interface SkillMarketProps {
  onApplied: (project: DramaProjectDetail) => void;
  onClose?: () => void;
}

export function SkillMarket({ onApplied, onClose }: SkillMarketProps) {
  const [skills, setSkills] = useState<DramaSkill[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [filter, setFilter] = useState<string>("");
  const [applyingId, setApplyingId] = useState<string | null>(null);

  const { show: showToast } = useToast();

  const load = useCallback((category: string) => {
    setLoading(true);
    setError("");
    dramaListSkills(category || undefined)
      .then((res) => setSkills(res.skills ?? []))
      .catch((err) =>
        setError(err instanceof Error ? err.message : "加载 Skill 列表失败"),
      )
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load(filter);
  }, [filter, load]);

  const handleApply = useCallback(
    (skill: DramaSkill) => {
      if (applyingId) {
        showToast("info", "已有 Skill 应用中,请稍候");
        return;
      }
      setApplyingId(skill.id);
      dramaApplySkill(skill.id)
        .then((project) => {
          showToast("success", `已基于 Skill「${skill.name}」创建新项目`);
          onApplied(project);
        })
        .catch((err) =>
          showToast(
            "error",
            err instanceof Error ? err.message : "应用 Skill 失败",
          ),
        )
        .finally(() => setApplyingId(null));
    },
    [applyingId, onApplied, showToast],
  );

  return (
    <section className="ds-skill-market">
      <div className="ds-skill-head">
        <div className="ds-skill-title">
          <Icon name="sparkles" size={16} />
          <span>Skill 市场</span>
          <span className="ds-skill-sub">一键套用模板创建新项目</span>
        </div>
        {onClose && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
            title="返回项目列表"
          >
            <Icon name="close" size={13} />
            返回
          </button>
        )}
      </div>

      <div className="ds-skill-filters" role="tablist">
        {FILTERS.map((f) => (
          <button
            key={f.key || "all"}
            type="button"
            role="tab"
            aria-selected={filter === f.key}
            className={`ds-skill-filter ${filter === f.key ? "ds-skill-filter-active" : ""}`}
            onClick={() => setFilter(f.key)}
          >
            {f.label}
          </button>
        ))}
      </div>

      {loading && (
        <div className="ds-skill-loading">
          <Icon name="loading" size={18} className="ds-spin" />
          <span>加载 Skill 列表…</span>
        </div>
      )}

      {!loading && error && (
        <div className="ds-skill-error">
          <Icon name="error" size={20} />
          <span>{error}</span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => load(filter)}
          >
            <Icon name="refresh" size={12} />
            重试
          </button>
        </div>
      )}

      {!loading && !error && skills.length === 0 && (
        <div className="ds-skill-empty">
          <Icon name="sparkles" size={28} strokeWidth={1.3} />
          <span>暂无 Skill 模板</span>
          <span className="ds-skill-empty-hint">
            切换其他分类,或直接新建项目
          </span>
        </div>
      )}

      {!loading && !error && skills.length > 0 && (
        <ul className="ds-skill-grid">
          {skills.map((s) => {
            const cls = `ds-skill-card ds-skill-cat-${
              CATEGORY_LABEL[s.category] ? s.category : "default"
            }`;
            const isApplying = applyingId === s.id;
            return (
              <li key={s.id} className={cls}>
                <div className="ds-skill-card-head">
                  <span className="ds-skill-cat-badge">
                    {CATEGORY_LABEL[s.category] ?? s.category}
                  </span>
                  <span className="ds-skill-shots">
                    {s.default_num_shots} 镜
                  </span>
                </div>
                <div className="ds-skill-name" title={s.name}>
                  {s.name}
                </div>
                <p className="ds-skill-desc">{s.description}</p>
                {s.tags.length > 0 && (
                  <div className="ds-skill-tags">
                    {s.tags.slice(0, 6).map((t) => (
                      <span key={t} className="ds-skill-tag">
                        {t}
                      </span>
                    ))}
                  </div>
                )}
                <div className="ds-skill-card-foot">
                  <span className="ds-skill-spec">
                    {s.width}×{s.height} · {s.fps}fps
                  </span>
                  <button
                    type="button"
                    className="btn btn-primary btn-sm"
                    onClick={() => handleApply(s)}
                    disabled={applyingId !== null}
                    title={`基于「${s.name}」创建新项目`}
                  >
                    {isApplying ? (
                      <>
                        <Icon name="loading" size={12} className="ds-spin" />
                        应用中…
                      </>
                    ) : (
                      <>
                        <Icon name="sparkles" size={12} />
                        应用此 Skill
                      </>
                    )}
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <style jsx>{`
        .ds-skill-market {
          display: flex;
          flex-direction: column;
          gap: 0.85rem;
          padding: 0.85rem 1rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
        }
        .ds-skill-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .ds-skill-title {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: -0.01em;
        }
        .ds-skill-title :global(svg) {
          color: var(--accent);
        }
        .ds-skill-sub {
          font-size: 0.72rem;
          color: var(--ink-faint);
          font-weight: 400;
          letter-spacing: 0.02em;
        }
        .ds-skill-filters {
          display: flex;
          align-items: center;
          gap: 0.35rem;
          flex-wrap: wrap;
        }
        .ds-skill-filter {
          padding: 0.25rem 0.7rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-full);
          color: var(--ink-soft);
          font-size: 0.76rem;
          font-family: inherit;
          cursor: pointer;
          transition: color var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .ds-skill-filter:hover {
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .ds-skill-filter-active {
          color: #fff;
          background: var(--accent);
          border-color: var(--accent);
        }
        .ds-skill-loading,
        .ds-skill-error,
        .ds-skill-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: var(--space-5) var(--space-3);
          color: var(--ink-faint);
          font-size: 0.82rem;
          text-align: center;
        }
        .ds-skill-error {
          color: var(--danger);
        }
        .ds-skill-empty-hint {
          font-size: 0.72rem;
          color: var(--ink-faint);
        }
        .ds-skill-grid {
          list-style: none;
          margin: 0;
          padding: 0;
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: 0.7rem;
        }
        .ds-skill-card {
          display: flex;
          flex-direction: column;
          gap: 0.4rem;
          padding: 0.75rem 0.85rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-left: 3px solid var(--hairline-2);
          border-radius: var(--radius-sm);
          transition: border-color var(--dur) var(--ease),
            transform var(--dur-2) var(--ease),
            box-shadow var(--dur-2) var(--ease);
        }
        .ds-skill-card:hover {
          transform: translateY(-2px);
          box-shadow: 0 8px 24px -12px var(--bg-sunken);
        }
        /* category 颜色映射:淡色背景左条 + 深色 badge 文字 */
        .ds-skill-cat-action {
          border-left-color: #dc2626;
        }
        .ds-skill-cat-romance {
          border-left-color: #ec4899;
        }
        .ds-skill-cat-scifi {
          border-left-color: #2563eb;
        }
        .ds-skill-cat-comedy {
          border-left-color: #ca8a04;
        }
        .ds-skill-cat-default {
          border-left-color: var(--accent);
        }
        .ds-skill-card-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.4rem;
        }
        .ds-skill-cat-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.08rem 0.5rem;
          border-radius: var(--radius-xs);
          font-size: 0.66rem;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          background: var(--bg-3);
          color: var(--ink-soft);
        }
        .ds-skill-cat-action .ds-skill-cat-badge {
          background: #fee2e2;
          color: #991b1b;
        }
        .ds-skill-cat-romance .ds-skill-cat-badge {
          background: #fce7f3;
          color: #9d174d;
        }
        .ds-skill-cat-scifi .ds-skill-cat-badge {
          background: #dbeafe;
          color: #1e40af;
        }
        .ds-skill-cat-comedy .ds-skill-cat-badge {
          background: #fef9c3;
          color: #854d0e;
        }
        .ds-skill-shots {
          font-size: 0.66rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }
        .ds-skill-name {
          font-size: 0.92rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.3;
          letter-spacing: -0.01em;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .ds-skill-desc {
          margin: 0;
          font-size: 0.78rem;
          color: var(--ink-soft);
          line-height: 1.5;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .ds-skill-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 0.25rem;
        }
        .ds-skill-tag {
          display: inline-flex;
          align-items: center;
          padding: 0.06rem 0.4rem;
          background: var(--bg-3);
          border-radius: var(--radius-xs);
          font-size: 0.64rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
        }
        .ds-skill-card-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 0.4rem;
          margin-top: 0.2rem;
          padding-top: 0.4rem;
          border-top: 1px dashed var(--hairline);
        }
        .ds-skill-spec {
          font-size: 0.66rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }
        .ds-skill-loading :global(svg),
        .ds-skill-empty :global(svg) {
          color: var(--accent);
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
          .ds-skill-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </section>
  );
}
