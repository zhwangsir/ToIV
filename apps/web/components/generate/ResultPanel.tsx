"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { LazyVideo } from "@/components/ui/LazyVideo";
import { Select } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { imageUrl } from "@/lib/api";
import type { EngineKind } from "@/lib/engines";
import type { QualityWarning } from "@/lib/trackJob";

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

function MediaView({ entry, className }: { entry: HistoryEntry; className?: string }) {
  const first = entry.paths[0];
  if (!first) return null;
  if (AUDIO_PATH_RE.test(first)) {
    return (
      <>
        {entry.paths.map((p) => (
          <audio key={p} src={imageUrl(p)} controls preload="metadata" className="media-audio" />
        ))}
      </>
    );
  }
  const url = imageUrl(first);
  if (entry.kind === "video") {
    return <video src={url} controls className={className} />;
  }
  return (
    <>
      {entry.paths.map((p) => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={p}
          src={imageUrl(p)}
          alt={entry.prompt}
          className={className}
          loading="lazy"
          decoding="async"
        />
      ))}
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

/**
 * 结果区(WS2 剧场化):全出血暗舞台 —— 选中作品居中 contain 展示(带轻微暗角),
 * 状态/引擎/取消/A/B 对比开关合并为左上玻璃胶囊行(浮板锚右上,避免遮挡);
 * 底部胶片条(filmstrip)横排缩略图,点击切换选中(←/→ 键由 .generate-results 容器承载);
 * A/B 两栏对比模式完整保留(各栏任选一条已完成记录);
 * 失败态为舞台中央错误卡:友好说明 + 可折叠技术详情(底层原文)+ 重试。
 * 全部样式在 app/styles/stage.css;生成中骨架用全局 skeleton-shimmer(WS5 motion.css)。
 */
export function ResultPanel({ entries, selectedId, onSelect, liveProgress, qualityWarning, onApplyPrompt, onCancel, onRetry }: ResultPanelProps) {
  const [compare, setCompare] = useState(false);
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

  const doneEntries = useMemo(() => entries.filter((e) => e.status === "done"), [entries]);
  const current = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;
  const entryA = doneEntries.find((e) => e.id === compareA) ?? doneEntries[0] ?? null;
  const entryB =
    doneEntries.find((e) => e.id === compareB) ?? doneEntries.find((e) => e.id !== entryA?.id) ?? null;

  if (entries.length === 0) {
    // tabIndex=0:空态容器 overflow-y:auto 可滚动,axe scrollable-region-focusable 要求键盘可达
    return (
      <div className="result-panel result-panel-empty" tabIndex={0}>
        <div className="empty-editorial">
          <span className="empty-kicker">工作台</span>
          <h2 className="empty-display">你的作品
            <br />
            将在这里呈现
          </h2>
          <span className="empty-rule" aria-hidden="true" />
          <div className="empty-tips">
            <div className="empty-tip">
              <span className="empty-tip-num">01</span>
              <span className="empty-tip-title">选择引擎</span>
              <span className="empty-tip-desc">左侧挑选图片 / 视频 / 音频引擎与模型</span>
            </div>
            <div className="empty-tip">
              <span className="empty-tip-num">02</span>
              <span className="empty-tip-title">描述画面</span>
              <span className="empty-tip-desc">填写提示词,可用「优化」让 AI 二次润色</span>
            </div>
            <div className="empty-tip">
              <span className="empty-tip-num">03</span>
              <span className="empty-tip-title">生成与对比</span>
              <span className="empty-tip-desc">点击生成,完成后可开启 A/B 对比</span>
            </div>
          </div>
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
                  <Button variant="ghost" size="sm" icon={<Icon name="close" size={13} />} onClick={onCancel}>
                    取消
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
                      {liveProgress.max > 0 ? `采样 ${liveProgress.value}/${liveProgress.max}` : "排队中…"}
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
                <p className="stage-message">已停止前端跟踪;后端作业完成后仍可在作品库查看。</p>
              )}
              {current.status === "done" && (
                <div className="stage-media-wrap">
                  <MediaView entry={current} className="media-main" />
                </div>
              )}

              <p className="stage-caption" title={current.prompt}>{current.prompt}</p>
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
