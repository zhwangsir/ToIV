"use client";

/**
 * 助手消息列表渲染模块(2026-09-22 A3 组件工程化):
 * 自 AssistantView.tsx 拆出——消息气泡/媒体产物/胶片条/工具 chip+结果卡/作业卡/提案卡渲染,
 * 以及作业卡纯函数(jobCardStatusLabel/isJobCardActive/mediaTypeForJob,与消息渲染同源,
 * 置此消除 AssistantView↔MessageList 运行时循环 import;AssistantView 经 re-export 保持原路径可导入)。
 * 行为零变化:JSX/类名/文案逐字保留,仅闭包变量改为同名 props。
 */
import { Fragment, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Icon } from "@/components/ui/Icon";
import { imageUrl } from "@/lib/api";
import { isVideoKind, kindLabel, kindToFilter } from "@/lib/libraryQuery";
import { mediaKindOf } from "@/lib/mediaKind";
import { ModelViewer } from "@/components/ui/ModelViewer";
import { docKindFromFilename, docKindIcon } from "@/lib/docs";
import {
  TOOL_RENDERERS,
  renderToolCard,
  type ToolCardCtx,
} from "@/components/assistant/toolcards/registry";
import type { AgentJobCard, AgentProposalCard, ChatMessage } from "./AssistantView";
import { JobErrorSelfheal } from "./JobErrorSelfheal";

// ───── 助手气泡行内 markdown(2026-08-16 审计修复):最小手写解析,不引第三方 md 库 ─────
// 此前气泡纯文本直出,LLM 的 `**` 标记原样泄漏。边界规则(CommonMark flanking 简化版):
// 开定界符后随空白不成立(`* *操作:…` 保持原文,不吞星号),闭定界符前是空白也不成立;
// 内容可含全角引号与单 `*`(`**…"视频超分"…**` 整体加粗,不会被引号/嵌套星号截断)。
const BOLD_RE = /\*\*(?=\S)([\s\S]*?\S)\*\*/g;
const ITALIC_RE = /\*(?=\S)([^*\n]*?\S)\*/g;

/** 片段内斜体替换(星号配对失败的按原文保留)。 */
function renderItalicSegments(text: string, keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(ITALIC_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push(<em key={`${keyPrefix}i${idx}`}>{m[1]}</em>);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** 助手消息行内渲染:`**加粗**` / `*斜体*`;仅助手气泡使用(用户消息纯文本直出,避免 `2*3*5` 误斜体)。 */
export function renderInlineMarkdown(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(BOLD_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(...renderItalicSegments(text.slice(last, idx), `p${idx}`));
    out.push(<strong key={`b${idx}`}>{renderItalicSegments(m[1], `b${idx}`)}</strong>);
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(...renderItalicSegments(text.slice(last), `t${last}`));
  return out;
}

/** 媒体产物渲染(image/video/audio/model3d 四分支):消息气泡媒体与作业卡 done 产物共用。
 *  W4 修复(2026-08-31):src 一律经 imageUrl 补 token——/api/images 强制登录态
 *  (Bearer 或 ?token=),<img>/<video> 无法带请求头,裸 sig URL 会 401 破图;
 *  渲染时现取现 token,轮换/续期自然跟随。 */
export function renderAvMedia(
  m: { type: string; urls: string[] },
  key: number | string,
): ReactNode {
  const src = m.urls[0] ? imageUrl(m.urls[0]) : "";
  return (
    <div key={key} className="av-media">
      {m.type === "image" && src && (
        <img
          src={src}
          alt="生成结果"
          className="av-media-img"
          loading="lazy"
          decoding="async"
        />
      )}
      {m.type === "video" && src && (
        <video src={src} controls className="av-media-video" />
      )}
      {m.type === "audio" && src && (
        <audio src={src} controls className="av-media-audio" />
      )}
      {m.type === "model3d" && src && (
        <>
          <div className="av-media-3d">
            <ModelViewer src={src} />
          </div>
          <a
            href={src}
            target="_blank"
            rel="noreferrer"
            className="av-media-link"
          >
            <Icon name="box" size={14} strokeWidth={1.8} />
            下载 3D 模型
          </a>
        </>
      )}
    </div>
  );
}

// ───── W4(2026-08-31)产物胶片条:对话流内多产物以 Film Atelier 胶片条横排内嵌 ─────

export interface AvMediaGroup {
  type: string;
  urls: string[];
}
export interface AvFrame {
  type: string;
  url: string;
}

/** 拍平媒体组为视觉帧序列(纯函数,单测锚点):仅 image/video 成帧;
 *  audio/model3d 非视觉产物不进胶片条,由调用方走 renderAvMedia 块级渲染。 */
export function flattenVisualFrames(media: readonly AvMediaGroup[]): AvFrame[] {
  const out: AvFrame[] = [];
  for (const m of media) {
    if (m.type !== "image" && m.type !== "video") continue;
    for (const u of m.urls) if (u) out.push({ type: m.type, url: u });
  }
  return out;
}

/** ≥2 帧走胶片条(导轨+打孔+帧号);单帧保持 renderAvMedia hero 直出;零帧不渲染。 */
export function renderAvFrames(frames: readonly AvFrame[], keyPrefix: string): ReactNode {
  if (frames.length === 0) return null;
  if (frames.length === 1) {
    return renderAvMedia({ type: frames[0].type, urls: [frames[0].url] }, `${keyPrefix}-0`);
  }
  return (
    <div className="av-filmstrip" role="group" aria-label="产物胶片条">
      <div className="av-filmstrip-track">
        {frames.map((f, i) => {
          // imageUrl 补 token(同 renderAvMedia 的 W4 修复):裸 sig URL 在 <img> 下 401
          const src = imageUrl(f.url);
          return (
          <figure key={`${keyPrefix}-${i}`} className="av-film-frame">
            {f.type === "video" ? (
              <video src={src} controls className="av-film-media" />
            ) : (
              <img
                src={src}
                alt={`产物 ${i + 1}`}
                className="av-film-media"
                loading="lazy"
                decoding="async"
              />
            )}
            <figcaption className="av-film-no">{String(i + 1).padStart(2, "0")}</figcaption>
          </figure>
          );
        })}
      </div>
    </div>
  );
}

/** 消息媒体列表:视觉帧进胶片条(或单帧 hero),audio/3d 块级跟随。 */
export function AvMediaList({ media }: { media: readonly AvMediaGroup[] }) {
  const frames = flattenVisualFrames(media);
  const blocks = media.filter((m) => m.type !== "image" && m.type !== "video");
  return (
    <>
      {renderAvFrames(frames, "ms")}
      {blocks.map((m, i) => renderAvMedia(m, `mb${i}`))}
    </>
  );
}

/** 作业卡 done 产物:results 逐个判定媒体类型后同上分流(视觉帧胶片条化)。 */
export function AvJobResults({
  kind,
  results,
  jobId,
}: {
  kind: string;
  results: readonly string[];
  jobId: string;
}) {
  const groups = results
    .filter(Boolean)
    .map((u) => ({ type: mediaTypeForJob(kind, u), urls: [u] }));
  const frames = flattenVisualFrames(groups);
  const blocks = groups.filter((g) => g.type !== "image" && g.type !== "video");
  return (
    <>
      {renderAvFrames(frames, `j${jobId}`)}
      {blocks.map((m, i) => renderAvMedia(m, `jb${jobId}-${i}`))}
    </>
  );
}

/** 同消息多作业卡产物聚合(纯函数,单测锚点):≥2 个 done 卡且合并视觉帧 ≥2 时,
 *  产物从各卡抽出、合并为一条胶片条(卡内不再重复渲染,对话流更紧凑);
 *  否则返回空数组,各卡照旧自带产物。 */

/** U2:从结构化 steps 或 body 编号/列表行提取步骤标题。 */
export function extractPlanSteps(steps: readonly string[] | undefined, body: string | undefined): string[] {
  const fromArgs = (steps ?? []).map((s) => String(s || "").trim()).filter(Boolean).map((s) => s.slice(0, 80));
  if (fromArgs.length >= 2) return fromArgs.slice(0, 8);
  const inferred: string[] = [];
  for (const line of (body || "").split(/\r?\n/)) {
    const m = line.trim().match(/^(?:\d+[\.、\)]\s+|[-*]\s+)(.+)$/);
    if (!m) continue;
    const t = m[1].trim();
    if (t) inferred.push(t.slice(0, 80));
    if (inferred.length >= 8) break;
  }
  return inferred.length >= 2 ? inferred : fromArgs;
}

export type PlanStepPhase = "planned" | "active" | "done" | "idle";

/** U2:提案态 → 步骤条相位。pending=全计划;approve/modify+busy=首步进行中;完成后全完成;reject=idle。 */
export function planStepPhases(
  steps: readonly string[],
  resolution: AgentProposalCard["resolution"] | undefined,
  busy: boolean,
): PlanStepPhase[] {
  if (!steps.length) return [];
  if (resolution === "reject") return steps.map(() => "idle");
  if (!resolution) return steps.map(() => "planned");
  if (busy) {
    return steps.map((_, i) => (i === 0 ? "active" : "planned"));
  }
  return steps.map(() => "done");
}

export function AvPlanSteps({
  steps,
  phases,
}: {
  steps: readonly string[];
  phases: readonly PlanStepPhase[];
}) {
  if (steps.length < 2) return null;
  const phaseLabel: Record<PlanStepPhase, string> = {
    planned: "计划",
    active: "进行中",
    done: "完成",
    idle: "已取消",
  };
  return (
    <ol className="av-plan-steps" aria-label="任务步骤">
      {steps.map((label, i) => {
        const phase = phases[i] ?? "planned";
        return (
          <li key={`${i}-${label}`} className={`av-plan-step is-${phase}`}>
            <span className="av-plan-step-index" aria-hidden="true">
              {phase === "done" ? "✓" : i + 1}
            </span>
            <span className="av-plan-step-label">{label}</span>
            <span className="av-plan-step-phase">{phaseLabel[phase]}</span>
          </li>
        );
      })}
    </ol>
  );
}

export function aggregateJobFrames(jobs: readonly AgentJobCard[]): AvFrame[] {
  const done = jobs.filter((j) => j.status === "done" && j.results?.length);
  if (done.length < 2) return [];
  const frames: AvFrame[] = [];
  for (const j of done) {
    for (const u of j.results ?? []) {
      if (!u) continue;
      const t = mediaTypeForJob(j.kind, u);
      if (t === "image" || t === "video") frames.push({ type: t, url: u });
    }
  }
  return frames.length >= 2 ? frames : [];
}

/** 进行中作业状态(需前端轮询跟进)。 */
export const JOB_CARD_ACTIVE_STATUSES = ["queued", "held", "running"] as const;

export function isJobCardActive(status: string): boolean {
  return (JOB_CARD_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/** 作业卡状态徽章文案(纯函数,单测锚点)。 */
export function jobCardStatusLabel(status: string): string {
  switch (status) {
    case "queued":
      return "排队中";
    case "held":
      return "资源等待";
    case "running":
      return "运行中";
    case "done":
      return "完成";
    case "error":
      return "失败";
    case "canceled":
      return "已中止";
    default:
      return status || "排队中";
  }
}

/** 作业产物 → 媒体渲染分支(纯函数,单测锚点)。
 *  已收敛为 lib/mediaKind.mediaKindOf 的薄封装(扩展名优先、kind 兜底),勿再各自维护正则。 */
export function mediaTypeForJob(kind: string, url = ""): string {
  return mediaKindOf(url, kind);
}

/** 作业卡组 + 聚合胶片条(W4):卡片只承担状态/进度/中止,视觉产物统一汇聚展示。
 *  U1:失败态展示大白话原因 + 一键重试 / 换一张同类卡。 */
export function AvJobCards({
  jobs,
  msgId,
  onCancel,
  onJobRetry,
  onOpenApp,
  busy = false,
}: {
  jobs: readonly AgentJobCard[];
  msgId: string;
  onCancel: (jobId: string) => void;
  onJobRetry?: (job: AgentJobCard) => void | Promise<void>;
  onOpenApp?: (appId: string) => void;
  busy?: boolean;
}) {
  const agg = aggregateJobFrames(jobs);
  return (
    <>
      {jobs.map((j) => (
        <div key={j.jobId} className={`av-job-card is-${isJobCardActive(j.status) ? "active" : j.status}`}>
          <div className="av-job-card-head">
            <span className="av-job-card-kind">
              <Icon name={isVideoKind(j.kind) ? "video" : kindToFilter(j.kind) === "audio" ? "audio" : kindToFilter(j.kind) === "3d" ? "box" : "image"} size={12} strokeWidth={1.8} />
              {kindLabel(j.kind)}
            </span>
            <span className="av-job-card-actions">
              <span className={`av-job-badge is-${j.status}`}>
                {jobCardStatusLabel(j.status)}
              </span>
              {isJobCardActive(j.status) ? (
                <button
                  type="button"
                  className="av-job-cancel"
                  title="中止后端作业并停止本页跟踪"
                  onClick={() => onCancel(j.jobId)}
                >
                  停止
                </button>
              ) : null}
            </span>
          </div>
          {j.label ? <div className="av-job-card-label">{j.label}</div> : null}
          {j.status === "held" && j.holdReason ? (
            <div className="av-job-card-hold">{j.holdReason}</div>
          ) : null}
          {j.status === "error" && onJobRetry && onOpenApp ? (
            <JobErrorSelfheal
              job={j}
              busy={busy}
              onRetry={onJobRetry}
              onOpenApp={onOpenApp}
            />
          ) : j.status === "error" ? (
            <div className="av-job-error">
              <div className="av-job-error-reason">
                {j.error || j.holdReason || "生成失败"}
              </div>
            </div>
          ) : null}
          {/* 聚合模式:产物上移合并胶片条,卡内不再重复渲染 */}
          {agg.length === 0 && j.status === "done" && j.results?.length ? (
            <AvJobResults kind={j.kind} results={j.results} jobId={j.jobId} />
          ) : null}
        </div>
      ))}
      {agg.length > 0 && renderAvFrames(agg, `agg-${msgId}`)}
    </>
  );
}

/** 气泡时间戳(消息/会话列表共用,SessionDrawer 经此导入)。 */
export function formatTime(ts: number) {
  const d = new Date(ts);
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
}

export interface AvMessageListProps {
  messages: ChatMessage[];
  /** 渲染窗口(2026-08-29 性能):默认只渲染最近 80 条,true=全量展开 */
  showAllHistory: boolean;
  setShowAllHistory: Dispatch<SetStateAction<boolean>>;
  /** pending = 已发送、等待首个响应块(打字指示器) */
  pending: boolean;
  busy: boolean;
  retry: () => void;
  toolCardCtx: ToolCardCtx;
  onJobCancel: (jobId: string) => void;
  /** U1:作业失败一键重试 */
  onJobRetry: (job: AgentJobCard) => void | Promise<void>;
  onProposalDecision: (
    card: AgentProposalCard,
    action: "approve" | "modify" | "reject",
    note?: string,
  ) => void;
  onOpenCanvasProposal: (card: AgentProposalCard) => void | Promise<void>;
  /** 「修改」展开的提案卡 id + 修改意见草稿(主壳持有,受控下传) */
  modifyFor: string | null;
  setModifyFor: (v: string | null) => void;
  modifyNote: string;
  setModifyNote: (v: string) => void;
}

/** 消息列表(会话态对话流):渲染窗口/气泡/工具 chip+卡/作业卡/提案卡/媒体/打字指示器。 */
export function AvMessageList({
  messages,
  showAllHistory,
  setShowAllHistory,
  pending,
  busy,
  retry,
  toolCardCtx,
  onJobCancel,
  onJobRetry,
  onProposalDecision,
  onOpenCanvasProposal,
  modifyFor,
  setModifyFor,
  modifyNote,
  setModifyNote,
}: AvMessageListProps) {
  return (
    <div className="av-msg-list">
      {(() => {
        const MSG_RENDER_WINDOW = 80;
        const hiddenCount = showAllHistory ? 0 : Math.max(0, messages.length - MSG_RENDER_WINDOW);
        const visible = hiddenCount > 0 ? messages.slice(-MSG_RENDER_WINDOW) : messages;
        return (
          <>
            {hiddenCount > 0 && (
              <button
                type="button"
                className="av-msg-history-more"
                onClick={() => setShowAllHistory(true)}
              >
                加载更早的 {hiddenCount} 条消息(默认只渲染最近 {MSG_RENDER_WINDOW} 条,防长会话卡顿)
              </button>
            )}
            {visible.map((msg) => (
        <div
          key={msg.id}
          className={`av-msg${msg.role === "user" ? " is-user" : " is-assistant"}`}
        >
          <div className="av-msg-body">
            <div className={`av-msg-bubble${msg.kind === "error" ? " av-msg-bubble--error" : ""}`}>
              {msg.kind === "error" ? (
                <>
                  <span className="av-msg-error-text">{msg.content}</span>
                  <button
                    type="button"
                    className="av-msg-retry"
                    onClick={retry}
                    disabled={busy}
                    title="重发上一条消息"
                  >
                    <Icon name="refresh" size={12} strokeWidth={1.8} />
                    <span>重试</span>
                  </button>
                </>
              ) : msg.content || msg.media?.length || msg.tools?.length || msg.jobs?.length || msg.proposals?.length ? (
                <>
                  {msg.docs?.length ? (
                    <span className="doc-chips doc-chips--msg">
                      {msg.docs.map((d) => (
                        <span key={d.id} className="doc-chip">
                          <Icon name={docKindIcon(docKindFromFilename(d.filename))} size={11} strokeWidth={1.8} />
                          {d.filename}
                        </span>
                      ))}
                    </span>
                  ) : null}
                  {msg.role === "assistant" ? renderInlineMarkdown(msg.content) : msg.content}
                  {/* 工具调用小条:转圈(start)/绿勾(ok)/红叉(error+detail) */}
                  {msg.tools?.map((t) => (
                    <Fragment key={t.id}>
                      <div className={`av-tool-chip is-${t.status}`}>
                        <span className="av-tool-chip-icon">
                          <Icon
                            name={t.status === "start" ? "loading" : t.status === "ok" ? "check" : "close"}
                            size={12}
                            strokeWidth={2}
                          />
                        </span>
                        <span className="av-tool-chip-text">
                          <span className="av-tool-chip-summary">{t.summary || t.name}</span>
                          {t.status === "error" && t.detail ? (
                            <span className="av-tool-chip-detail">{t.detail}</span>
                          ) : null}
                        </span>
                      </div>
                      {/* A1 工具结果卡:ok + 注册工具 + payload 时在 chip 下追加
                          (chip 保留作状态条目;payload 解析失败 renderToolCard
                          归 null,回退仅 chip);未注册工具完全维持现状 */}
                      {t.status === "ok" && t.payload && TOOL_RENDERERS[t.name]
                        ? renderToolCard(t.name, t.payload, toolCardCtx)
                        : null}
                    </Fragment>
                  ))}
                  {/* 生成作业卡:kind 中文名 + label + 状态徽章;W4 起经 AvJobCards
                      聚合——同消息 ≥2 个 done 作业的视觉产物合并为一条胶片条 */}
                  {msg.jobs?.length ? (
                    <AvJobCards
                      jobs={msg.jobs}
                      msgId={msg.id}
                      onCancel={onJobCancel}
                      onJobRetry={onJobRetry}
                      onOpenApp={toolCardCtx.onOpenApp}
                      busy={busy}
                    />
                  ) : null}
                  {/* 提案确认卡:确认执行/修改/放弃;落锤后只读 */}
                  {msg.proposals?.map((p) => (
                    <div key={p.proposalId} className={`av-proposal${p.resolution ? " is-resolved" : ""}`}>
                      <div className="av-proposal-head">
                        <Icon name="sparkles" size={13} strokeWidth={1.8} />
                        <span className="av-proposal-title">{p.title}</span>
                        {p.estimate ? (
                          <span className="av-proposal-estimate">{p.estimate}</span>
                        ) : null}
                      </div>
                      {p.body ? (
                        <div className="av-proposal-body">{renderInlineMarkdown(p.body)}</div>
                      ) : null}
                      {(() => {
                        const steps = extractPlanSteps(p.steps, p.body);
                        const phases = planStepPhases(steps, p.resolution, busy);
                        return <AvPlanSteps steps={steps} phases={phases} />;
                      })()}
                      {p.resolution ? (
                        <div className={`av-proposal-result is-${p.resolution}`}>
                          <Icon
                            name={p.resolution === "reject" ? "close" : "check"}
                            size={12}
                            strokeWidth={2}
                          />
                          {p.resolution === "approve"
                            ? "已确认执行"
                            : p.resolution === "modify"
                              ? "已修改并执行"
                              : "已放弃"}
                          {p.resolution === "modify" && p.note ? (
                            <span className="av-proposal-result-note">{p.note}</span>
                          ) : null}
                        </div>
                      ) : (
                        <>
                          <div className="av-proposal-actions">
                            {p.kind === "canvas_graph" ? (
                              <button
                                type="button"
                                className="av-proposal-btn is-primary"
                                disabled={busy}
                                onClick={() => void onOpenCanvasProposal(p)}
                              >
                                在画布中打开
                              </button>
                            ) : null}
                            <button
                              type="button"
                              className={`av-proposal-btn${p.kind === "canvas_graph" ? "" : " is-primary"}`}
                              disabled={busy}
                              onClick={() => onProposalDecision(p, "approve")}
                            >
                              确认执行
                            </button>
                            <button
                              type="button"
                              className="av-proposal-btn"
                              disabled={busy}
                              onClick={() => {
                                setModifyFor(modifyFor === p.proposalId ? null : p.proposalId);
                                setModifyNote("");
                              }}
                            >
                              修改
                            </button>
                            <button
                              type="button"
                              className="av-proposal-btn is-danger"
                              disabled={busy}
                              onClick={() => onProposalDecision(p, "reject")}
                            >
                              放弃
                            </button>
                          </div>
                          {modifyFor === p.proposalId && (
                            <div className="av-proposal-modify">
                              <textarea
                                className="av-proposal-note"
                                placeholder="填写修改意见…"
                                value={modifyNote}
                                onChange={(e) => setModifyNote(e.target.value)}
                                rows={3}
                              />
                              <button
                                type="button"
                                className="av-proposal-btn is-primary"
                                disabled={busy || !modifyNote.trim()}
                                onClick={() => onProposalDecision(p, "modify", modifyNote.trim())}
                              >
                                提交修改
                              </button>
                            </div>
                          )}
                        </>
                      )}
                    </div>
                  ))}
                  {msg.media?.length ? <AvMediaList media={msg.media} /> : null}
                </>
              ) : (
                <span className="av-typing">
                  <span className="av-typing-dot" />
                  <span className="av-typing-dot" />
                  <span className="av-typing-dot" />
                </span>
              )}
            </div>
            <span className="av-msg-time">{formatTime(msg.timestamp)}</span>
          </div>
        </div>
            ))}
          </>
        );
      })()}
      {pending && (
        <div className="av-msg is-assistant" aria-live="polite">
          <div className="av-msg-body">
            <div className="av-msg-bubble">
              <span className="av-typing">
                <span className="av-typing-dot" />
                <span className="av-typing-dot" />
                <span className="av-typing-dot" />
              </span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
