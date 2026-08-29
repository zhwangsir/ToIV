"use client";

import { useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { Select } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { imageUrl } from "@/lib/api";
import type { EngineInfo, EngineKind } from "@/lib/engines";
import type { QualityWarning } from "@/lib/trackJob";

import { QuickStartGrid } from "./QuickStartGrid";

/** 会话内生成历史条目(不落库,刷新即清空)。 */
export interface HistoryEntry {
  id: string;
  engineId: string;
  engineLabel: string;
  kind: EngineKind;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  paths: string[];
  /** 友好错误文案(经 friendlyError 包装已知模式)。 */
  error?: string | null;
  /** 底层错误原文:「技术详情」展开内容(未知模式为 null,不重复展示)。 */
  errorDetail?: string | null;
  /** 时长策略提示(后端 duration_notice:网格精确裁切/分段续写时的人话说明,muted 一行)。 */
  notice?: string | null;
  /** 后端作业寻址键(裁切链终产物轮询用;提交时快照)。 */
  promptId?: string;
  /** 时长后处理进行中(trim/extend):paths 为未裁原片,结果区显示「精确裁切中」,
   *  轮询到 post_status 清零后自动替换终产物。 */
  postProcessing?: boolean;
  /** RES-2026-08-18:融合超分目标档(720p/1080p/2k/4k;提交时快照)。
   *  有值且 postProcessing 时,后处理文案显示「超分中」而非「精确裁切中」
   *  (超分链与时长链共用 post_status,前端按是否挂链区分文案)。 */
  upscaleTarget?: string;
  /** 目标尺寸(提交时快照):生成中骨架按此宽高比渲染,避免与目标尺寸不符。 */
  width?: number;
  height?: number;
  createdAt: number;
}

const STATUS_META: Record<HistoryEntry["status"], { tone: "run" | "ok" | "err" | "neutral"; label: string }> = {
  running: { tone: "run", label: "生成中" },
  done: { tone: "ok", label: "完成" },
  error: { tone: "err", label: "失败" },
  cancelled: { tone: "neutral", label: "已取消" },
};

/** 音频产物扩展名:结果路径以此结尾时渲染 <audio> 播放器(而非 img/video)。 */
const AUDIO_PATH_RE = /\.(mp3|wav|flac|ogg)$/i;

/** 媒体加载失败占位(签名 URL 过期/代理 404 时兜底,不给用户看浏览器破图);
 *  带「重新加载」动作(2026-08-30:签名过期不必整页刷新)。 */
function MediaFailPlaceholder({
  kind,
  onReload,
}: {
  kind: "video" | "image" | "audio";
  onReload?: () => void;
}) {
  return (
    <div className="media-fail" role="status">
      <Icon name={kind === "audio" ? "audio" : kind === "video" ? "video" : "image"} size={28} />
      <span>{kind === "audio" ? "音频加载失败" : "内容加载失败"}</span>
      <span className="media-fail-hint">链接可能已过期,可重新加载</span>
      {onReload && (
        <Button
          variant="secondary"
          size="sm"
          icon={<Icon name="refresh" size={13} />}
          onClick={onReload}
        >
          重新加载
        </Button>
      )}
    </div>
  );
}

function MediaView({ entry, className }: { entry: HistoryEntry; className?: string }) {
  const [failed, setFailed] = useState<Set<string>>(new Set());
  /** 重载计数:>0 时给 URL 追加 _r 参数强制浏览器重取(绕过签名过期缓存)。 */
  const [reloadNonce, setReloadNonce] = useState(0);
  const srcOf = (p: string): string => {
    const url = imageUrl(p);
    return reloadNonce > 0 ? `${url}${url.includes("?") ? "&" : "?"}_r=${reloadNonce}` : url;
  };
  /** 重新加载指定产物:清失败标记 +  bump nonce 强刷 URL。 */
  const reload = (p: string) => {
    setFailed((prev) => {
      const next = new Set(prev);
      next.delete(p);
      return next;
    });
    setReloadNonce((n) => n + 1);
  };
  const first = entry.paths[0];
  if (!first) return null;
  if (AUDIO_PATH_RE.test(first)) {
    return (
      <>
        {entry.paths.map((p) =>
          failed.has(p) ? (
            <MediaFailPlaceholder key={p} kind="audio" onReload={() => reload(p)} />
          ) : (
            <audio
              key={p}
              src={srcOf(p)}
              controls
              preload="metadata"
              className="media-audio"
              onError={() => setFailed((prev) => new Set(prev).add(p))}
            />
          ),
        )}
      </>
    );
  }
  if (entry.kind === "video") {
    if (failed.has(first)) return <MediaFailPlaceholder kind="video" onReload={() => reload(first)} />;
    return (
      <video
        src={srcOf(first)}
        controls
        playsInline
        preload="metadata"
        className={className}
        onError={() => setFailed((prev) => new Set(prev).add(first))}
      />
    );
  }
  return (
    <>
      {entry.paths.map((p) =>
        failed.has(p) ? (
          <MediaFailPlaceholder key={p} kind="image" onReload={() => reload(p)} />
        ) : (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            key={p}
            src={srcOf(p)}
            alt={entry.prompt}
            className={className}
            /* CLS 防护:优先用提交时快照的真实目标尺寸;缺省回退 1:1 设计基准
               (CSS 侧 max-width/max-height + object-fit:contain 保持实际纵横比,见 stage.css .media-main) */
            width={entry.width ?? 1024}
            height={entry.height ?? 1024}
            loading="lazy"
            decoding="async"
            onError={() => setFailed((prev) => new Set(prev).add(p))}
          />
        ),
      )}
    </>
  );
}

/** 胶片条缩略图占位图标(按状态/内容类型)。 */
function thumbIcon(e: HistoryEntry): "loading" | "error" | "audio" | "video" | "image" {
  if (e.status === "running") return "loading";
  if (e.status === "error") return "error";
  if (e.kind === "audio" || (e.paths[0] ? AUDIO_PATH_RE.test(e.paths[0]) : false)) return "audio";
  return e.kind === "video" ? "video" : "image";
}

interface ResultPanelProps {
  entries: HistoryEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 进行中的实时进度(来自 useGeneration;仅作用在 status==="running" 的条目)。 */
  liveProgress: { value: number; max: number };
  /** 质量评估警告(LTX 视频 done 前若 total < 0.65 后端推 quality_warning;诊断卡展示)。 */
  qualityWarning?: QualityWarning | null;
  /** 诊断卡「应用建议提示词」:预填到当前引擎正向框。 */
  onApplyPrompt?: (text: string) => void;
  onCancel: () => void;
  /** 失败条目重试(沿用该条目的引擎/提示词/参数快照);不传则不渲染重试按钮。 */
  onRetry?: (entry: HistoryEntry) => void;
  /** 空态「快速开始」卡(T3):当前板块 kind(决定渲染哪组策划卡)。 */
  kind?: EngineKind;
  /** 快速开始卡可用性数据源(当前 kind 全部引擎;null=加载中,卡区不渲染)。 */
  quickStartEngines?: EngineInfo[] | null;
  /** 点击快速开始卡:选中引擎 + 聚焦提示词框(GenerateView 承载);不传则空态不渲染卡区。 */
  onQuickStart?: (engineId: string) => void;
}

/** 质量维度条:label + 横向条 + 百分比,颜色按值分段(对齐后端评估语义)。 */
function QualityBar({ label, value }: { label: string; value: number }) {
  const pct = Math.round(Math.min(1, Math.max(0, value)) * 100);
  const tone = value > 0.6 ? "ok" : value >= 0.4 ? "warn" : "err";
  return (
    <div className="quality-bar">
      <span className="quality-bar-label">{label}</span>
      <span className="quality-bar-track">
        <span className={`quality-bar-fill is-${tone}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="quality-bar-val">{pct}</span>
    </div>
  );
}

/** 产物下载文件名(2026-08-30):优先取 /api/images?filename= 参数;裸路径取末段;兜底按 kind 给扩展名。 */
function downloadName(path: string, kind: EngineKind): string {
  const m = /[?&]filename=([^&]+)/.exec(path);
  if (m) {
    try {
      return decodeURIComponent(m[1]);
    } catch {
      return m[1];
    }
  }
  const tail = path.split("?")[0].split("/").pop() ?? "";
  if (tail.includes(".")) return tail;
  return `toiv-${Date.now()}.${kind === "video" ? "mp4" : kind === "audio" ? "mp3" : "png"}`;
}

/** 下载条目全部产物(同源相对路径 + token 已由 imageUrl 注入;多产物间隔触发防浏览器拦截)。 */
function downloadEntry(entry: HistoryEntry): void {
  entry.paths.forEach((p, i) => {
    const a = document.createElement("a");
    a.href = imageUrl(p);
    a.download = downloadName(p, entry.kind);
    a.rel = "noopener";
    setTimeout(() => a.click(), i * 300);
  });
}

/** 生成已耗时(active 时每秒跳动):长作业等待期给「没卡死」的时间感知。 */
function useElapsed(active: boolean, since: number | undefined): string {
  const [, tick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [active]);
  if (!since) return "";
  const s = Math.max(0, Math.floor((Date.now() - since) / 1000));
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m} 分 ${s % 60} 秒` : `${Math.floor(m / 60)} 时 ${m % 60} 分`;
}

/**
 * 结果区(WS2 剧场化):全出血暗舞台 —— 选中作品居中 contain 展示(带轻微暗角),
 * 状态/引擎/取消/A/B 对比开关合并为左上玻璃胶囊行(浮板锚右上,避免遮挡);
 * 底部胶片条(filmstrip)横排缩略图,点击切换选中(←/→ 键由 .generate-results 容器承载);
 * A/B 两栏对比模式完整保留(各栏任选一条已完成记录);
 * 失败态为舞台中央错误卡:友好说明 + 可折叠技术详情(底层原文)+ 重试。
 * 全部样式在 app/styles/stage.css;生成中骨架用全局 skeleton-shimmer(WS5 motion.css)。
 */
export function ResultPanel({ entries, selectedId, onSelect, liveProgress, qualityWarning, onApplyPrompt, onCancel, onRetry, kind, quickStartEngines, onQuickStart }: ResultPanelProps) {
  const [compare, setCompare] = useState(false);
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

  const doneEntries = useMemo(() => entries.filter((e) => e.status === "done"), [entries]);
  const current = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;
  // 当前条目生成已耗时(running 态每秒跳动;长作业「没卡死」的时间感知)
  const elapsed = useElapsed(current?.status === "running", current?.createdAt);
  const entryA = doneEntries.find((e) => e.id === compareA) ?? doneEntries[0] ?? null;
  const entryB =
    doneEntries.find((e) => e.id === compareB) ?? doneEntries.find((e) => e.id !== entryA?.id) ?? null;

  if (entries.length === 0) {
    // tabIndex=0:空态容器 overflow-y:auto 可滚动,axe scrollable-region-focusable 要求键盘可达
    return (
      <div className="result-panel result-panel-empty" tabIndex={0}>
        {/* Film Atelier 空态(P0-3):拉丁 kicker + Fraunces 展示标题;
            引导步骤卡升级为 .at-card 发夹线语言(去灰框),编号走 Fraunces 衬线(stage.css) */}
        <div className="empty-editorial">
          <span className="at-empty-kicker">PROMPT ATELIER</span>
          <h2 className="empty-display">你的作品
            <br />
            将在这里呈现
          </h2>
          <div className="empty-tips">
            <div className="empty-tip at-card at-card--lift">
              <span className="empty-tip-num">01</span>
              <span className="empty-tip-title">选择引擎</span>
              <span className="empty-tip-desc">左侧挑选图片 / 视频 / 音频引擎与模型</span>
            </div>
            <div className="empty-tip at-card at-card--lift">
              <span className="empty-tip-num">02</span>
              <span className="empty-tip-title">描述画面</span>
              <span className="empty-tip-desc">填写提示词,可用「优化」让 AI 二次润色</span>
            </div>
            <div className="empty-tip at-card at-card--lift">
              <span className="empty-tip-num">03</span>
              <span className="empty-tip-title">生成与对比</span>
              <span className="empty-tip-desc">点击生成,完成后可开启 A/B 对比</span>
            </div>
          </div>
          {/* T3 快速开始:推荐起点卡,点击 = 选引擎 + 聚焦提示词(engines 为 null 时不渲染) */}
          {onQuickStart && (
            <QuickStartGrid
              kind={kind ?? "video"}
              engines={quickStartEngines ?? null}
              onPick={onQuickStart}
            />
          )}
        </div>
      </div>
    );
  }

  // A/B 对比开关:并入左上状态胶囊行(原浮右上,被右上参数浮板完全遮挡点不到)
  const compareSwitch = (
    <Switch
      checked={compare}
      onChange={setCompare}
      label="A/B 对比"
      disabled={doneEntries.length < 2}
      ariaLabel="A/B 对比模式"
    />
  );

  return (
    <div className="result-panel">
      {compare ? (
        <>
          <div className="stage-status">{compareSwitch}</div>
          <div className="result-compare">
          <div className="compare-grid">
            {([["A", entryA, setCompareA], ["B", entryB, setCompareB]] as const).map(([tag, entry, setter]) => (
              <Card key={tag} className="compare-col">
                <div className="compare-head">
                  <Badge tone="accent" dot={false}>{tag}</Badge>
                  <Select value={entry?.id ?? ""} onChange={(e) => setter(e.target.value)} aria-label={`对比栏 ${tag}`}>
                    {doneEntries.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.engineLabel} · {d.prompt.slice(0, 24) || "(无提示词)"}
                      </option>
                    ))}
                  </Select>
                </div>
                {entry && (
                  <div className="compare-media">
                    <MediaView entry={entry} className="media-main" />
                  </div>
                )}
              </Card>
            ))}
          </div>
          </div>
        </>
      ) : (
        current && (
          <>
            <div className="stage-main">
              <div className="stage-status">
                <Badge tone={STATUS_META[current.status].tone}>{STATUS_META[current.status].label}</Badge>
                <span className="stage-engine">{current.engineLabel}</span>
                {current.status === "running" && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="close" size={13} />}
                    onClick={onCancel}
                    title="中止后端作业并停止本页跟踪"
                  >
                    停止
                  </Button>
                )}
                {/* 下载(2026-08-30):完成且有产物时显示;多产物逐一下载 */}
                {current.status === "done" && !current.postProcessing && current.paths.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    icon={<Icon name="download" size={13} />}
                    onClick={() => downloadEntry(current)}
                    title={current.paths.length > 1 ? `下载全部 ${current.paths.length} 个产物` : "下载产物"}
                    aria-label="下载当前产物"
                  >
                    下载
                  </Button>
                )}
                {compareSwitch}
              </div>

              {qualityWarning && (current.status === "running" || current.status === "done") && (
                <div className="stage-quality" role="status">
                  <div className="stage-quality-head">
                    <Icon name="warning" size={15} />
                    <span className="stage-quality-title">质量诊断</span>
                    <span className="stage-quality-score">{qualityWarning.quality_score}/100</span>
                  </div>
                  <div className="stage-quality-bars">
                    <QualityBar label="美学" value={qualityWarning.aesthetic} />
                    <QualityBar label="技术" value={qualityWarning.technical} />
                    <QualityBar label="对齐" value={qualityWarning.prompt_alignment} />
                  </div>
                  {qualityWarning.issues.length > 0 && (
                    <ul className="stage-quality-issues">
                      {qualityWarning.issues.map((issue, i) => (
                        <li key={i}>{issue}</li>
                      ))}
                    </ul>
                  )}
                  {qualityWarning.suggested_prompt && onApplyPrompt && (
                    <Button
                      variant="secondary"
                      size="sm"
                      icon={<Icon name="sparkles" size={13} />}
                      onClick={() => onApplyPrompt(qualityWarning.suggested_prompt as string)}
                    >
                      应用建议提示词
                    </Button>
                  )}
                  {qualityWarning.degraded && (
                    <span className="stage-quality-degraded">评估降级(模型未能完全分析)</span>
                  )}
                </div>
              )}

              {current.status === "running" && (
                <div className="stage-loading">
                  <div
                    className="stage-skeleton skeleton-shimmer"
                    style={
                      current.width && current.height
                        ? {
                            aspectRatio: `${current.width} / ${current.height}`,
                            maxHeight: "100%",
                            // 竖版目标(高>宽):限高反推宽,避免撑出舞台
                            ...(current.height > current.width
                              ? { width: "auto", height: "min(420px, 100%)" }
                              : {}),
                          }
                        : undefined
                    }
                  />
                  <div className="stage-skeleton-lines" aria-hidden="true">
                    <span className="stage-skeleton-line skeleton-shimmer" />
                    <span className="stage-skeleton-line is-short skeleton-shimmer" />
                  </div>
                  <div className="stage-progress">
                    <div className="gen-progress" role="progressbar"
                      aria-valuenow={liveProgress.max > 0 ? Math.round((liveProgress.value / liveProgress.max) * 100) : undefined}
                      aria-valuemin={0} aria-valuemax={100}>
                      <div
                        className={`gen-progress-fill${liveProgress.max > 0 ? "" : " is-indeterminate"}`}
                        style={liveProgress.max > 0 ? { width: `${Math.min(100, Math.round((liveProgress.value / liveProgress.max) * 100))}%` } : undefined}
                      />
                    </div>
                    <span className="stage-progress-text">
                      {liveProgress.max > 0
                        ? `采样 ${liveProgress.value}/${liveProgress.max}`
                        : "排队中…"}
                      {elapsed && <span className="stage-elapsed">已用时 {elapsed}</span>}
                    </span>
                  </div>
                </div>
              )}
              {current.status === "error" && (
                <div className="stage-error-card" role="alert">
                  <div className="stage-error-head">
                    <Icon name="error" size={16} />
                    <span className="stage-error-title">生成失败</span>
                  </div>
                  <p className="stage-error-desc">
                    {current.error ??
                      "生成连接中断或引擎执行异常,你的输入已保留,可直接重试。"}
                  </p>
                  {current.errorDetail && (
                    <details className="stage-error-details">
                      <summary>技术详情</summary>
                      <pre className="stage-error-raw">{current.errorDetail}</pre>
                    </details>
                  )}
                  {onRetry && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Icon name="refresh" size={13} />}
                      onClick={() => onRetry(current)}
                    >
                      重试
                    </Button>
                  )}
                </div>
              )}
              {current.status === "cancelled" && (
                <p className="stage-message">已中止该作业。</p>
              )}
              {current.status === "done" && current.postProcessing && (
                <div className="stage-loading" role="status" aria-live="polite">
                  <div className="stage-progress">
                    <div className="gen-progress">
                      <div className="gen-progress-fill is-indeterminate" />
                    </div>
                    <span className="stage-progress-text">
                      {current.upscaleTarget ? `超分中(${current.upscaleTarget.toUpperCase()})…` : "精确裁切中…"}
                    </span>
                  </div>
                  <p className="stage-message">
                    {current.upscaleTarget
                      ? `已完成原生生成,正在经超分集群二次放大至 ${current.upscaleTarget.toUpperCase()},完成后自动替换终产物。`
                      : "时长后处理进行中,完成后自动替换为终产物。"}
                  </p>
                </div>
              )}
              {current.status === "done" && !current.postProcessing && current.paths.length > 0 && (
                <div className={`stage-media-wrap${current.paths.length > 1 ? " is-multi" : ""}`}>
                  <MediaView entry={current} className="media-main" />
                </div>
              )}
              {/* done 但零产物(配后端 Wave-1「完成无产物标 error」的历史/边界兜底):
                  显示失败占位而非空白舞台;可一键重试 */}
              {current.status === "done" && !current.postProcessing && current.paths.length === 0 && (
                <div className="stage-error-card" role="alert">
                  <div className="stage-error-head">
                    <Icon name="error" size={16} />
                    <span className="stage-error-title">未返回产物</span>
                  </div>
                  <p className="stage-error-desc">
                    作业已完成但未返回产物,请到作品库核对;也可直接重试。
                  </p>
                  {onRetry && (
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Icon name="refresh" size={13} />}
                      onClick={() => onRetry(current)}
                    >
                      重试
                    </Button>
                  )}
                </div>
              )}

              <p className="stage-caption" title={current.prompt}>{current.prompt}</p>
              {current.notice && (
                <p className="stage-message" role="status">{current.notice}</p>
              )}
            </div>

            <div className="filmstrip" role="listbox" aria-label="会话历史">
              {entries.map((e) => (
                <button
                  key={e.id}
                  type="button"
                  role="option"
                  aria-selected={e.id === current.id}
                  className={`filmstrip-item${e.id === current.id ? " is-active" : ""}`}
                  onClick={() => onSelect(e.id)}
                  aria-label={`${e.engineLabel}:${e.prompt.slice(0, 30)}`}
                  title={e.prompt || "(无提示词)"}
                >
                  {e.status === "done" && e.paths[0] && !AUDIO_PATH_RE.test(e.paths[0]) ? (
                    e.kind === "video" ? (
                      // P1-14:胶片条视频缩略图懒加载,进视口/悬停才拉首帧
                      <LazyVideo src={imageUrl(e.paths[0])} muted className="filmstrip-thumb" />
                    ) : (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={imageUrl(e.paths[0])}
                        alt=""
                        className="filmstrip-thumb"
                        loading="lazy"
                        decoding="async"
                      />
                    )
                  ) : (
                    <span className="filmstrip-placeholder">
                      <Icon name={thumbIcon(e)} size={20} />
                    </span>
                  )}
                  <span className={`filmstrip-dot is-${e.status}`} aria-hidden="true" />
                </button>
              ))}
            </div>
          </>
        )
      )}
    </div>
  );
}
