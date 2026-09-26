"use client";

/**
 * A1 工具结果卡片(2026-09-22):agent tool ok 事件 payload → 结构化卡。
 * 纪律:
 * - 纯渲染、零 hooks——registry 以 createElement 调用,字段全部防御式解析,
 *   关键字段缺失/类型错 → 返回 null(渲染点回退为仅 chip,绝不炸消息流);
 * - 样式走 ToolCardStyle 内联 <style jsx global>(styled-jsx 只编译内联模板串),
 *   av-tc- 前缀、零 hex、仅 globals.css 既有 token(tests/assistantToolCards 钉死)。
 */
import type { ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";

/** 卡片动作回调:由 AssistantView 注入(setInput / market 深链 / library 兜底)。 */
export interface ToolCardCtx {
  onApplyInput?: (text: string) => void;
  onOpenApp?: (appId: string) => void;
  onOpenBoard?: (boardId: string) => void;
}

export interface ToolCardProps {
  payload: Record<string, unknown>;
  ctx: ToolCardCtx;
}

/* ── 防御式取值:任何形态异常归空,由调用方判空回退 ── */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const objArr = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v)
    ? v.filter(
        (x): x is Record<string, unknown> =>
          !!x && typeof x === "object" && !Array.isArray(x),
      )
    : [];

/** ① optimize_prompt:原文⇄优化文对照 + 负向提示词 + 应用到输入框。 */
export function OptimizePromptCard({ payload, ctx }: ToolCardProps): ReactNode {
  const original = str(payload.original);
  const optimized = str(payload.optimized);
  const negative = str(payload.negative);
  if (!optimized) return null;
  return (
    <div className="av-tc av-tc-optimize">
      <ToolCardStyle />
      <div className={`av-tc-compare${original ? "" : " is-single"}`}>
        {original ? (
          <div className="av-tc-compare-col">
            <div className="av-tc-label">原文</div>
            <div className="av-tc-text">{original}</div>
          </div>
        ) : null}
        <div className="av-tc-compare-col is-optimized">
          <div className="av-tc-label">优化后</div>
          <div className="av-tc-text">{optimized}</div>
        </div>
      </div>
      {negative ? (
        <div className="av-tc-negative">
          <div className="av-tc-label">负向提示词</div>
          <div className="av-tc-text av-tc-mono">{negative}</div>
        </div>
      ) : null}
      {ctx.onApplyInput ? (
        <div className="av-tc-actions">
          <button
            type="button"
            className="av-tc-btn is-primary"
            onClick={() => ctx.onApplyInput?.(optimized)}
          >
            <Icon name="check" size={12} strokeWidth={2} />
            应用到输入框
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** ② search_knowledge:知识条目列表(标题+摘要+「知识库」出处徽标)。 */
export function KnowledgeCard({ payload }: ToolCardProps): ReactNode {
  const items = objArr(payload.items)
    .map((it) => ({ title: str(it.title), snippet: str(it.snippet) }))
    .filter((it) => it.title || it.snippet);
  if (!items.length) return null;
  return (
    <div className="av-tc av-tc-knowledge">
      <ToolCardStyle />
      {items.map((it, i) => (
        <div key={i} className="av-tc-row">
          <div className="av-tc-row-head">
            <Icon name="database" size={12} strokeWidth={1.8} />
            <span className="av-tc-row-title">{it.title || "知识条目"}</span>
            <span className="av-tc-badge">知识库</span>
          </div>
          {it.snippet ? <div className="av-tc-row-sub">{it.snippet}</div> : null}
        </div>
      ))}
    </div>
  );
}

/** ③ list_apps:应用横条(封面/名称/用途/打开深链);is_nsfw 仅标 18+ 不过滤。 */
export function AppListCard({ payload, ctx }: ToolCardProps): ReactNode {
  const items = objArr(payload.items)
    .map((it) => ({
      id: str(it.id),
      name: str(it.name),
      description: str(it.description),
      cover: str(it.cover_url),
      useCase: str(it.use_case),
      nsfw: it.is_nsfw === true,
    }))
    .filter((it) => it.id && it.name);
  if (!items.length) return null;
  const total = num(payload.total);
  return (
    <div className="av-tc av-tc-apps">
      <ToolCardStyle />
      {items.map((it) => (
        <div key={it.id} className="av-tc-app">
          <span className="av-tc-thumb">
            <Icon name="grid" size={14} strokeWidth={1.8} />
            {it.cover ? (
              <img
                src={imageUrl(it.cover)}
                alt={it.name}
                loading="lazy"
                decoding="async"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            ) : null}
          </span>
          <span className="av-tc-app-main">
            <span className="av-tc-app-name">
              {it.name}
              {it.nsfw ? <span className="av-tc-badge is-warn">18+</span> : null}
            </span>
            <span className="av-tc-app-sub">
              {[it.useCase, it.description].filter(Boolean).join(" · ") || "—"}
            </span>
          </span>
          {ctx.onOpenApp ? (
            <button
              type="button"
              className="av-tc-btn"
              onClick={() => ctx.onOpenApp?.(it.id)}
            >
              打开应用
            </button>
          ) : null}
        </div>
      ))}
      {total !== null && total > items.length ? (
        <div className="av-tc-foot">共 {total} 个应用</div>
      ) : null}
    </div>
  );
}

/** ④ list_models:模型名 chips 云。 */
export function ModelsCard({ payload }: ToolCardProps): ReactNode {
  const models = (Array.isArray(payload.models) ? payload.models : [])
    .map((m) => str(m))
    .filter(Boolean);
  if (!models.length) return null;
  return (
    <div className="av-tc av-tc-models">
      <ToolCardStyle />
      <div className="av-tc-chips">
        {models.map((m) => (
          <span key={m} className="av-tc-chip">
            <Icon name="cpu" size={11} strokeWidth={1.8} />
            {m}
          </span>
        ))}
      </div>
    </div>
  );
}

/** ⑤ create_storyboard:板名 + 分镜/角色计数 + 打开画板。 */
export function StoryboardCard({ payload, ctx }: ToolCardProps): ReactNode {
  const boardId = str(payload.board_id);
  const name = str(payload.name);
  if (!name) return null;
  const itemCount = num(payload.item_count);
  const castCount = num(payload.cast_count);
  const stats = [
    itemCount !== null ? `${itemCount} 分镜行` : "",
    castCount !== null ? `${castCount} 角色` : "",
  ]
    .filter(Boolean)
    .join(" / ");
  return (
    <div className="av-tc av-tc-storyboard">
      <ToolCardStyle />
      <div className="av-tc-row-head">
        <Icon name="clapperboard" size={13} strokeWidth={1.8} />
        <span className="av-tc-row-title">{name}</span>
        {stats ? <span className="av-tc-badge">{stats}</span> : null}
      </div>
      {boardId && ctx.onOpenBoard ? (
        <div className="av-tc-actions">
          <button
            type="button"
            className="av-tc-btn"
            onClick={() => ctx.onOpenBoard?.(boardId)}
          >
            打开画板
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** ⑥ list_smoke_failures / explain_app_failure:双形态自愈诊断卡。 */
export function SelfhealCard({ payload, ctx }: ToolCardProps): ReactNode {
  // 形态 A:批量失败清单(items)
  const failureItems = objArr(payload.items)
    .map((it) => ({
      id: str(it.id),
      name: str(it.name),
      cls: str(it.cls),
      advice: str(it.advice),
      error: str(it.error),
    }))
    .filter((it) => it.name || it.cls || it.advice || it.error);
  if (failureItems.length) {
    return (
      <div className="av-tc av-tc-selfheal">
        <ToolCardStyle />
        {failureItems.map((it, i) => (
          <div key={it.id || i} className="av-tc-row">
            <div className="av-tc-row-head">
              <span className="av-tc-row-title">{it.name || "未命名应用"}</span>
              {it.cls ? <span className="av-tc-badge is-err">{it.cls}</span> : null}
            </div>
            {it.advice ? <div className="av-tc-row-sub">建议:{it.advice}</div> : null}
            {it.error ? <div className="av-tc-row-err">{it.error}</div> : null}
          </div>
        ))}
      </div>
    );
  }
  // 形态 B:单应用诊断(explain_app_failure)
  const appId = str(payload.app_id);
  const name = str(payload.name);
  const status = str(payload.smoke_status);
  const cls = str(payload.smoke_cls);
  const error = str(payload.smoke_error);
  const advice = str(payload.advice);
  const proposals = objArr(payload.proposals)
    .map((p) => ({
      id: str(p.id),
      status: str(p.status),
      cls: str(p.failure_cls),
      note: str(p.note),
    }))
    .filter((p) => p.id || p.status || p.cls || p.note);
  if (!appId && !name && !status && !cls && !advice && !error) return null;
  return (
    <div className="av-tc av-tc-selfheal">
      <ToolCardStyle />
      <div className="av-tc-row-head">
        <Icon name="shield-check" size={13} strokeWidth={1.8} />
        <span className="av-tc-row-title">{name || appId || "应用诊断"}</span>
        {cls ? <span className="av-tc-badge is-err">{cls}</span> : null}
        {status ? <span className="av-tc-badge">{status}</span> : null}
      </div>
      {advice ? <div className="av-tc-row-sub">建议:{advice}</div> : null}
      {error ? <div className="av-tc-row-err">{error}</div> : null}
      {proposals.length ? (
        <div className="av-tc-list">
          <div className="av-tc-label">修复提案</div>
          {proposals.map((p, i) => (
            <div key={p.id || i} className="av-tc-row">
              <div className="av-tc-row-head">
                {p.cls ? <span className="av-tc-badge is-warn">{p.cls}</span> : null}
                {p.status ? <span className="av-tc-badge">{p.status}</span> : null}
              </div>
              {p.note ? <div className="av-tc-row-sub">{p.note}</div> : null}
            </div>
          ))}
        </div>
      ) : null}
      {appId && ctx.onOpenApp ? (
        <div className="av-tc-actions">
          <button
            type="button"
            className="av-tc-btn"
            onClick={() => ctx.onOpenApp?.(appId)}
          >
            查看应用
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** ⑦ submit_generation / run_app / generate_image:作业快照卡(复用 av-job-* 样式)。
 *  纯渲染零 hooks;直播进度仍走消息级 AvJobCards,MessageList 对同 job_id 去重。 */
export function GenerationJobCard({ payload }: ToolCardProps): ReactNode {
  const jobId = str(payload.job_id);
  const kind = str(payload.kind) || "image";
  const status = str(payload.status) || "queued";
  const label = str(payload.label);
  const holdReason = str(payload.hold_reason);
  const error = str(payload.error);
  const results = (Array.isArray(payload.results) ? payload.results : [])
    .map((u) => str(u))
    .filter(Boolean);
  if (!jobId && !label && !results.length) return null;
  const statusLabel =
    status === "queued"
      ? "排队中"
      : status === "held"
        ? "资源等待"
        : status === "running"
          ? "运行中"
          : status === "done"
            ? "完成"
            : status === "error"
              ? "失败"
              : status === "canceled"
                ? "已中止"
                : status || "排队中";
  const kindText =
    kind.includes("video") || kind === "video"
      ? "视频"
      : kind.includes("audio") || kind === "audio"
        ? "音频"
        : kind.includes("3d")
          ? "3D"
          : "图像";
  return (
    <div className={`av-tc av-tc-job av-job-card is-${status === "queued" || status === "held" || status === "running" ? "active" : status}`}>
      <ToolCardStyle />
      <div className="av-job-card-head">
        <span className="av-job-card-kind">
          <Icon
            name={kindText === "视频" ? "video" : kindText === "音频" ? "audio" : kindText === "3D" ? "box" : "image"}
            size={12}
            strokeWidth={1.8}
          />
          {kindText}
        </span>
        <span className="av-job-card-actions">
          <span className={`av-job-badge is-${status}`}>{statusLabel}</span>
        </span>
      </div>
      {label ? <div className="av-job-card-label">{label}</div> : null}
      {status === "held" && holdReason ? (
        <div className="av-job-card-hold">{holdReason}</div>
      ) : null}
      {status === "error" && (error || holdReason) ? (
        <div className="av-job-error">
          <div className="av-job-error-reason">{error || holdReason}</div>
        </div>
      ) : null}
      {status === "done" && results.length ? (
        <div className="av-tc-job-results">
          {results.slice(0, 4).map((url) => (
            <span key={url} className="av-tc-thumb">
              <Icon name="image" size={14} strokeWidth={1.8} />
              <img
                src={imageUrl(url)}
                alt=""
                loading="lazy"
                decoding="async"
                onError={(e) => {
                  e.currentTarget.style.display = "none";
                }}
              />
            </span>
          ))}
        </div>
      ) : null}
      {jobId ? <div className="av-tc-foot">作业 {jobId}</div> : null}
    </div>
  );
}

/** av-tc 一族样式(零 hex,仅 globals.css 既有 token;对照网格移动端纵排)。 */
function ToolCardStyle() {
  return (
    <style jsx global>{`
      .av-tc {
        display: flex;
        flex-direction: column;
        gap: var(--space-2);
        min-width: 240px;
        max-width: 100%;
        margin-top: var(--space-2);
        padding: var(--space-3);
        background: var(--bg-surface-2);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-control);
        font-size: var(--text-aux);
        white-space: normal; /* 气泡 pre-wrap 不传染卡片内部排版 */
      }
      .av-tc-label {
        font-size: var(--text-label);
        color: var(--text-muted);
      }
      .av-tc-text {
        color: var(--text-secondary);
        line-height: 1.55;
        white-space: pre-wrap;
        word-break: break-word;
      }
      .av-tc-mono {
        font-family: var(--font-mono);
        font-size: var(--text-label);
      }
      .av-tc-compare {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: var(--space-2);
      }
      .av-tc-compare.is-single {
        grid-template-columns: 1fr;
      }
      @media (max-width: 767px) {
        .av-tc-compare {
          grid-template-columns: 1fr;
        }
      }
      .av-tc-compare-col {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        min-width: 0;
        padding: var(--space-2);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: calc(var(--radius-control) - 2px);
      }
      .av-tc-compare-col.is-optimized {
        background: var(--accent-soft);
        border-color: var(--accent-halo);
      }
      .av-tc-negative {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
        padding-top: var(--space-2);
        border-top: 1px dashed var(--border-subtle);
      }
      .av-tc-actions {
        display: flex;
        justify-content: flex-end;
        gap: var(--space-2);
      }
      .av-tc-btn {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        flex-shrink: 0;
        height: 26px;
        padding: 0 var(--space-3);
        background: transparent;
        border: 1px solid var(--border-strong);
        border-radius: var(--radius-control);
        color: var(--text-primary);
        font-size: var(--text-label);
        font-weight: var(--font-medium);
        font-family: var(--font-sans);
        cursor: pointer;
        transition: color var(--duration-fast) var(--ease-standard),
          background-color var(--duration-fast) var(--ease-standard),
          border-color var(--duration-fast) var(--ease-standard);
      }
      .av-tc-btn:hover {
        color: var(--accent);
        background: var(--accent-soft);
        border-color: var(--accent-halo);
      }
      .av-tc-btn.is-primary {
        color: var(--accent);
        border-color: var(--accent-halo);
      }
      .av-tc-row {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 0;
      }
      .av-tc-row + .av-tc-row {
        padding-top: var(--space-2);
        border-top: 1px solid var(--border-subtle);
      }
      .av-tc-row-head {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
        color: var(--text-primary);
      }
      .av-tc-row-title {
        font-weight: var(--font-medium);
        color: var(--text-primary);
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .av-tc-row-sub {
        color: var(--text-secondary);
        line-height: 1.5;
        word-break: break-word;
      }
      .av-tc-row-err {
        color: var(--err);
        font-size: var(--text-label);
        line-height: 1.45;
        word-break: break-word;
      }
      .av-tc-badge {
        display: inline-flex;
        align-items: center;
        flex-shrink: 0;
        padding: 1px var(--space-2);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-full);
        font-size: var(--text-label);
        color: var(--text-secondary);
        white-space: nowrap;
      }
      .av-tc-badge.is-warn {
        color: var(--warn);
        border-color: color-mix(in oklab, var(--warn) 40%, transparent);
        background: var(--warn-soft);
      }
      .av-tc-badge.is-err {
        color: var(--err);
        border-color: color-mix(in oklab, var(--err) 40%, transparent);
        background: var(--err-soft);
      }
      .av-tc-app {
        display: flex;
        align-items: center;
        gap: var(--space-2);
        min-width: 0;
      }
      .av-tc-app + .av-tc-app {
        padding-top: var(--space-2);
        border-top: 1px solid var(--border-subtle);
      }
      .av-tc-thumb {
        position: relative;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        width: 40px;
        height: 40px;
        overflow: hidden;
        color: var(--text-muted);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: calc(var(--radius-control) - 2px);
      }
      .av-tc-thumb img {
        position: absolute;
        inset: 0;
        width: 100%;
        height: 100%;
        object-fit: cover;
      }
      .av-tc-app-main {
        display: flex;
        flex-direction: column;
        gap: 2px;
        flex: 1 1 auto;
        min-width: 0;
      }
      .av-tc-app-name {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        font-weight: var(--font-medium);
        color: var(--text-primary);
      }
      .av-tc-app-sub {
        overflow: hidden;
        color: var(--text-muted);
        font-size: var(--text-label);
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .av-tc-chips {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-1);
      }
      .av-tc-chip {
        display: inline-flex;
        align-items: center;
        gap: var(--space-1);
        padding: 2px var(--space-2);
        background: var(--bg-surface-1);
        border: 1px solid var(--border-subtle);
        border-radius: var(--radius-full);
        color: var(--text-secondary);
        font-family: var(--font-mono);
        font-size: var(--text-label);
      }
      .av-tc-foot {
        color: var(--text-muted);
        font-size: var(--text-label);
      }
      .av-tc-list {
        display: flex;
        flex-direction: column;
        gap: var(--space-1);
      }
      .av-tc-job-results {
        display: flex;
        flex-wrap: wrap;
        gap: var(--space-2);
      }
    `}</style>
  );
}
