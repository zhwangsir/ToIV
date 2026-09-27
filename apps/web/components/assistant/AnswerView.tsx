"use client";

/**
 * 助手回答呈现组件(2026-09-28 助手 UI 重做,参考 ChatGPT / Claude):
 * - AvProcess:思考 + 工具步骤的过程块。进行中显示扫光标题(思考中… / 当前工具),
 *   时间线展开;正文到达后自动收起为「已思考 N 秒 · 调用了 K 个工具」,可点开复看。
 * - AvMarkdown:块级 markdown(标题/列表/代码块带复制/引用/表格/分隔线)。
 * - AvSmoothText:流式时逐字显现(rAF 自适应步长);历史消息与减弱动效直接整段显示。
 * - AvMsgActions:回答下方的复制 / 重新生成。
 */
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";
import { Icon } from "@/components/ui/Icon";
import {
  hasThinkingText,
  parseMarkdownBlocks,
  processSummaryLabel,
  revealStep,
  splitInline,
  type ThinkingRound,
} from "./assistantFormat";
import type { ToolChip } from "./AssistantView";

// ───── 复制 ─────

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

export function AvCopyButton({
  text,
  label = "复制",
  className = "av-act-btn",
  showLabel = false,
}: {
  text: string;
  label?: string;
  className?: string;
  showLabel?: boolean;
}) {
  const [done, setDone] = useState(false);
  const timer = useRef<number | null>(null);
  useEffect(() => () => {
    if (timer.current) window.clearTimeout(timer.current);
  }, []);
  return (
    <button
      type="button"
      className={`${className}${done ? " is-done" : ""}`}
      title={done ? "已复制" : label}
      aria-label={done ? "已复制" : label}
      onClick={async () => {
        if (await copyText(text)) {
          setDone(true);
          if (timer.current) window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => setDone(false), 1600);
        }
      }}
    >
      <Icon name={done ? "check" : "copy"} size={14} strokeWidth={1.8} />
      {showLabel ? <span>{done ? "已复制" : label}</span> : null}
    </button>
  );
}

// ───── Markdown ─────

function renderInline(text: string, key: string): ReactNode[] {
  return splitInline(text).map((seg, i) => {
    const k = `${key}-${i}`;
    switch (seg.t) {
      case "code":
        return <code key={k} className="av-md-icode">{seg.v}</code>;
      case "link":
        return (
          <a key={k} href={seg.href} target={seg.href.startsWith("/") ? undefined : "_blank"} rel="noreferrer">
            {seg.v}
          </a>
        );
      case "strong":
        return <strong key={k}>{renderInline(seg.v, k)}</strong>;
      case "em":
        return <em key={k}>{seg.v}</em>;
      default: {
        // 段内软换行保留
        const parts = seg.v.split("\n");
        return (
          <Fragment key={k}>
            {parts.map((p, j) => (
              <Fragment key={j}>
                {j > 0 ? <br /> : null}
                {p}
              </Fragment>
            ))}
          </Fragment>
        );
      }
    }
  });
}

/** 块级渲染;引用块内容递归走块级(引用里的列表/段落),深度封顶防病态嵌套 */
function renderBlocks(text: string, prefix: string, depth = 0): ReactNode[] {
  return parseMarkdownBlocks(text).map((b, i) => {
        const k = `${prefix}b${i}`;
        switch (b.type) {
          case "h": {
            const Tag = (`h${b.level + 2}` as "h3" | "h4" | "h5");
            return <Tag key={k} className={`av-md-h av-md-h${b.level}`}>{renderInline(b.text, k)}</Tag>;
          }
          case "ul":
            return (
              <ul key={k} className="av-md-list">
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `${k}-${j}`)}</li>)}
              </ul>
            );
          case "ol":
            return (
              <ol key={k} className="av-md-list" start={b.start}>
                {b.items.map((it, j) => <li key={j}>{renderInline(it, `${k}-${j}`)}</li>)}
              </ol>
            );
          case "code":
            return (
              <div key={k} className="av-md-code">
                <div className="av-md-code-head">
                  <span className="av-md-code-lang">{b.lang || "代码"}</span>
                  {!b.open ? <AvCopyButton text={b.code} className="av-md-code-copy" showLabel /> : null}
                </div>
                <pre><code>{b.code}</code></pre>
              </div>
            );
          case "quote":
            return (
              <blockquote key={k} className="av-md-quote">
                {depth < 2 ? renderBlocks(b.text, `${k}-`, depth + 1) : renderInline(b.text, k)}
              </blockquote>
            );
          case "hr":
            return <hr key={k} className="av-md-hr" />;
          case "table":
            return (
              <div key={k} className="av-md-table-wrap">
                <table className="av-md-table">
                  <thead>
                    <tr>{b.head.map((c, j) => <th key={j}>{renderInline(c, `${k}-h${j}`)}</th>)}</tr>
                  </thead>
                  <tbody>
                    {b.rows.map((r, ri) => (
                      <tr key={ri}>
                        {b.head.map((_, ci) => <td key={ci}>{renderInline(r[ci] ?? "", `${k}-${ri}-${ci}`)}</td>)}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            );
          default:
            return <p key={k} className="av-md-p">{renderInline(b.text, k)}</p>;
        }
  });
}

export function AvMarkdown({ text, caret = false }: { text: string; caret?: boolean }) {
  return <div className={`av-md${caret ? " is-streaming" : ""}`}>{renderBlocks(text, "")}</div>;
}

// ───── 逐字显现 ─────

function prefersReducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** 挂载时处于流式(live)才启用动画;之后即使流结束也把剩余部分平滑显完。 */
/** 已完成逐字展开的消息 id:切会话/视图回来重挂载时不重播动画 */
const revealedIds = new Set<string>();

export function AvSmoothText({
  text,
  live,
  fresh = false,
  id,
}: {
  text: string;
  live: boolean;
  /** 本页会话内刚收到的回答:后端一次性下发整段时(busy 与正文同帧结束)也逐字展开 */
  fresh?: boolean;
  id?: string;
}) {
  const [animate] = useState(
    () => (live || fresh) && !(id && revealedIds.has(id)) && !prefersReducedMotion(),
  );
  const [shown, setShown] = useState(() => (animate ? 0 : text.length));
  const shownRef = useRef(shown);
  const textRef = useRef(text);
  useEffect(() => {
    textRef.current = text;
  }, [text]);
  const rafRef = useRef<number | null>(null);

  useEffect(() => {
    if (!animate) return;
    if (shownRef.current >= text.length) {
      if (shownRef.current > text.length) {
        shownRef.current = text.length;
        setShown(text.length);
      }
      return;
    }
    if (rafRef.current != null) return;
    const tick = () => {
      const target = textRef.current.length;
      const next = revealStep(shownRef.current, target);
      shownRef.current = next;
      setShown(next);
      if (next >= target && id) revealedIds.add(id);
      rafRef.current = next < target ? window.requestAnimationFrame(tick) : null;
    };
    rafRef.current = window.requestAnimationFrame(tick);
  }, [text, animate, id]);

  useEffect(() => () => {
    if (rafRef.current != null) window.cancelAnimationFrame(rafRef.current);
  }, []);

  const visible = animate ? text.slice(0, shown) : text;
  return <AvMarkdown text={visible} caret={animate && (live || shown < text.length)} />;
}

// ───── 过程块(思考 + 工具时间线) ─────

export interface AvProcessProps {
  rounds?: ThinkingRound[];
  tools?: ToolChip[];
  /** 本条消息仍在流式生成 */
  live: boolean;
  /** 正文已开始出现(用于自动收起) */
  hasText: boolean;
}

function currentActivity(rounds: ThinkingRound[] | undefined, tools: ToolChip[] | undefined): string {
  const running = (tools ?? []).filter((t) => t.status === "start");
  if (running.length) return running[running.length - 1].summary || running[running.length - 1].name;
  const lastRound = rounds?.[rounds.length - 1];
  if (!lastRound || lastRound.status === "start") return "思考中…";
  return (tools ?? []).length ? "整理结果中…" : "组织回答中…";
}

export function AvProcess({ rounds, tools, live, hasText }: AvProcessProps) {
  const toolList = tools ?? [];
  const hasDetail = hasThinkingText(rounds) || toolList.length > 0;
  const autoOpen = live && !hasText;
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? autoOpen;

  // 历史消息/纯聊天:没有可展示的过程就不占位
  if (!live && !hasDetail) return null;
  // 流式但正文已出且无过程细节:不显示空壳
  if (live && hasText && !hasDetail) return null;

  const working = live && (!hasText || toolList.some((t) => t.status === "start"));
  const label = working ? currentActivity(rounds, tools) : processSummaryLabel(rounds, toolList.length);

  // 时间线:按轮次交织「思考」与该轮调用的工具;无轮次标记的工具(历史)放最后
  const steps: ReactNode[] = [];
  const usedTools = new Set<string>();
  for (const r of rounds ?? []) {
    if (r.content?.trim()) {
      steps.push(
        <li key={`r${r.round}`} className="av-step is-think">
          <span className="av-step-dot" aria-hidden />
          <div className="av-step-body">
            <div className="av-step-title">思考</div>
            <div className="av-step-think">{r.content.trim()}</div>
          </div>
        </li>,
      );
    } else if (r.status === "start" && live) {
      steps.push(
        <li key={`r${r.round}`} className="av-step is-think is-running">
          <span className="av-step-dot" aria-hidden />
          <div className="av-step-body">
            <div className="av-step-title av-shimmer">思考中…</div>
          </div>
        </li>,
      );
    }
    for (const t of toolList) {
      if (t.round === r.round && !usedTools.has(t.id)) {
        usedTools.add(t.id);
        steps.push(<ToolStep key={t.id} t={t} />);
      }
    }
  }
  for (const t of toolList) if (!usedTools.has(t.id)) steps.push(<ToolStep key={t.id} t={t} />);

  return (
    <div className={`av-process${open ? " is-open" : ""}${working ? " is-working" : ""}`}>
      <button
        type="button"
        className="av-process-head"
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
        disabled={!steps.length}
      >
        <span className={`av-process-label${working ? " av-shimmer" : ""}`}>{label}</span>
        {steps.length ? (
          <span className="av-process-chevron" aria-hidden>
            <Icon name="chevron-down" size={14} strokeWidth={1.8} />
          </span>
        ) : null}
      </button>
      {steps.length ? (
        <div className="av-process-panel" aria-hidden={!open}>
          <div className="av-process-panel-inner">
            <ol className="av-steps">{steps}</ol>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ToolStep({ t }: { t: ToolChip }) {
  return (
    <li className={`av-step is-tool is-${t.status}`}>
      <span className="av-step-dot" aria-hidden>
        <Icon
          name={t.status === "start" ? "loading" : t.status === "ok" ? "check" : "close"}
          size={10}
          strokeWidth={2.2}
        />
      </span>
      <div className="av-step-body">
        <div className={`av-step-title${t.status === "start" ? " av-shimmer" : ""}`}>{t.summary || t.name}</div>
        {t.status === "error" && t.detail ? <div className="av-step-detail">{t.detail}</div> : null}
      </div>
    </li>
  );
}

// ───── 消息操作栏 ─────

export function AvMsgActions({
  text,
  canRegenerate,
  onRegenerate,
  pinned,
}: {
  text: string;
  canRegenerate: boolean;
  onRegenerate?: () => void;
  /** 最后一条常显,其余悬停显示 */
  pinned: boolean;
}) {
  if (!text.trim() && !canRegenerate) return null;
  return (
    <div className={`av-msg-actions${pinned ? " is-pinned" : ""}`}>
      {text.trim() ? <AvCopyButton text={text} /> : null}
      {canRegenerate && onRegenerate ? (
        <button type="button" className="av-act-btn" title="重新生成" aria-label="重新生成" onClick={onRegenerate}>
          <Icon name="refresh" size={14} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}
