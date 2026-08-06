"use client";

import { useMemo, useState } from "react";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { Icon } from "@/components/ui/Icon";
import { Select } from "@/components/ui/Input";
import { Switch } from "@/components/ui/Switch";
import { imageUrl } from "@/lib/api";
import type { EngineKind } from "@/lib/engines";

/** 会话内生成历史条目(不落库,刷新即清空)。 */
export interface HistoryEntry {
  id: string;
  engineId: string;
  engineLabel: string;
  kind: EngineKind;
  prompt: string;
  status: "running" | "done" | "error" | "cancelled";
  paths: string[];
  error?: string | null;
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
        <img key={p} src={imageUrl(p)} alt={entry.prompt} className={className} />
      ))}
    </>
  );
}

interface ResultPanelProps {
  entries: HistoryEntry[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  /** 进行中的实时进度(来自 useGeneration;仅作用在 status==="running" 的条目)。 */
  liveProgress: { value: number; max: number };
  onCancel: () => void;
}

/**
 * 右侧结果区:当前任务大卡(进度条/状态 Badge/产物展示)+ 会话历史网格,
 * 支持 A/B 两栏对比模式(各栏任选一条已完成记录)。
 */
export function ResultPanel({ entries, selectedId, onSelect, liveProgress, onCancel }: ResultPanelProps) {
  const [compare, setCompare] = useState(false);
  const [compareA, setCompareA] = useState<string>("");
  const [compareB, setCompareB] = useState<string>("");

  const doneEntries = useMemo(() => entries.filter((e) => e.status === "done"), [entries]);
  const current = entries.find((e) => e.id === selectedId) ?? entries[0] ?? null;
  const entryA = doneEntries.find((e) => e.id === compareA) ?? doneEntries[0] ?? null;
  const entryB =
    doneEntries.find((e) => e.id === compareB) ?? doneEntries.find((e) => e.id !== entryA?.id) ?? null;

  if (entries.length === 0) {
    return (
      <div className="result-panel result-panel-empty">
        <div className="empty-editorial">
          <span className="empty-kicker">工作台</span>
          <h2 className="empty-display">你的作品
            <br />
            将在这里呈现
          </h2>
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
        <style jsx>{panelStyles}</style>
      </div>
    );
  }

  return (
    <div className="result-panel">
      <div className="result-panel-toolbar">
        <span className="result-panel-title">结果</span>
        <Switch
          checked={compare}
          onChange={setCompare}
          label="A/B 对比"
          disabled={doneEntries.length < 2}
          ariaLabel="A/B 对比模式"
        />
      </div>

      {compare ? (
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
      ) : (
        current && (
          <Card className="current-card">
            <div className="current-head">
              <Badge tone={STATUS_META[current.status].tone}>{STATUS_META[current.status].label}</Badge>
              <span className="current-engine">{current.engineLabel}</span>
              {current.status === "running" && (
                <Button variant="ghost" size="sm" icon={<Icon name="close" size={13} />} onClick={onCancel}>
                  取消
                </Button>
              )}
            </div>
            {current.status === "running" && (
              <div className="current-progress">
                <div className="gen-progress" role="progressbar"
                  aria-valuenow={liveProgress.max > 0 ? Math.round((liveProgress.value / liveProgress.max) * 100) : undefined}
                  aria-valuemin={0} aria-valuemax={100}>
                  <div
                    className={`gen-progress-fill${liveProgress.max > 0 ? "" : " is-indeterminate"}`}
                    style={liveProgress.max > 0 ? { width: `${Math.min(100, Math.round((liveProgress.value / liveProgress.max) * 100))}%` } : undefined}
                  />
                </div>
                <span className="current-progress-text">
                  {liveProgress.max > 0 ? `采样 ${liveProgress.value}/${liveProgress.max}` : "排队中…"}
                </span>
              </div>
            )}
            {current.status === "error" && <p className="current-error">{current.error ?? "生成失败"}</p>}
            {current.status === "cancelled" && (
              <p className="current-note">已停止前端跟踪;后端作业完成后仍可在作品库查看。</p>
            )}
            {current.status === "done" && (
              <div className="current-media">
                <MediaView entry={current} className="media-main" />
              </div>
            )}
            <p className="current-prompt" title={current.prompt}>{current.prompt}</p>
          </Card>
        )
      )}

      <div className="history-section">
        <span className="history-title">会话历史({entries.length},不落库)</span>
        <div className="history-grid">
          {entries.map((e) => (
            <button
              key={e.id}
              type="button"
              className={`history-card${e.id === current?.id && !compare ? " is-active" : ""}`}
              onClick={() => onSelect(e.id)}
              aria-label={`${e.engineLabel}:${e.prompt.slice(0, 30)}`}
            >
              <span className="history-thumb">
                {e.status === "done" && e.paths[0] && !AUDIO_PATH_RE.test(e.paths[0]) ? (
                  e.kind === "video" ? (
                    <video src={imageUrl(e.paths[0])} muted preload="metadata" className="history-media" />
                  ) : (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={imageUrl(e.paths[0])} alt="" className="history-media" />
                  )
                ) : (
                  <span className="history-thumb-placeholder">
                    <Icon
                      name={
                        e.status === "running"
                          ? "loading"
                          : e.status === "error"
                            ? "error"
                            : e.kind === "audio" || (e.paths[0] ? AUDIO_PATH_RE.test(e.paths[0]) : false)
                              ? "audio"
                              : e.kind === "video"
                                ? "video"
                                : "image"
                      }
                      size={20}
                    />
                  </span>
                )}
              </span>
              <span className="history-meta">
                <Badge tone={STATUS_META[e.status].tone}>{STATUS_META[e.status].label}</Badge>
                <span className="history-prompt">{e.prompt || "(无提示词)"}</span>
              </span>
            </button>
          ))}
        </div>
      </div>

      <style jsx>{panelStyles}</style>
    </div>
  );
}

const panelStyles = `
  .result-panel {
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
    min-height: 0;
  }
  .result-panel-empty {
    height: 100%;
    align-items: center;
    justify-content: center;
  }
  .empty-editorial {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-5);
    max-width: 640px;
    padding: var(--space-6);
  }
  .empty-kicker {
    font-size: var(--text-label);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--accent);
  }
  .empty-display {
    font-size: 40px;
    font-weight: 650;
    line-height: 1.15;
    letter-spacing: -0.02em;
    color: var(--text-primary);
    margin: 0;
  }
  .empty-tips {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: var(--space-3);
    width: 100%;
  }
  .empty-tip {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3);
    background: var(--bg-surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control);
  }
  .empty-tip-num {
    font-size: var(--text-label);
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    color: var(--accent);
  }
  .empty-tip-title {
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text-primary);
  }
  .empty-tip-desc {
    font-size: var(--text-aux);
    color: var(--text-muted);
    line-height: 1.5;
  }
  @media (max-width: 720px) {
    .empty-tips {
      grid-template-columns: 1fr;
    }
    .empty-display {
      font-size: 30px;
    }
  }
  .result-panel-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .result-panel-title {
    font-size: var(--text-section);
    font-weight: 600;
    color: var(--text-primary);
  }
  .current-card {
    padding: var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
  }
  .current-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .current-head :global(.btn) {
    margin-left: auto;
  }
  .current-engine {
    font-size: var(--text-aux);
    color: var(--text-muted);
  }
  .current-progress {
    display: flex;
    align-items: center;
    gap: var(--space-3);
  }
  .gen-progress {
    flex: 1;
    height: 4px;
    background: var(--bg-surface-3);
    border-radius: var(--radius-full);
    overflow: hidden;
  }
  .gen-progress-fill {
    height: 100%;
    background: var(--run);
    border-radius: var(--radius-full);
    transition: width var(--duration-fast) var(--ease-standard);
  }
  .gen-progress-fill.is-indeterminate {
    width: 30%;
    animation: gen-progress-slide 1.2s var(--ease-standard) infinite;
  }
  @keyframes gen-progress-slide {
    0% { transform: translateX(-100%); }
    100% { transform: translateX(400%); }
  }
  .current-progress-text {
    font-size: var(--text-aux);
    color: var(--text-secondary);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .current-error {
    font-size: var(--text-sm);
    color: var(--err);
  }
  .current-note {
    font-size: var(--text-aux);
    color: var(--text-muted);
  }
  .current-media, .compare-media {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    justify-content: center;
    background: var(--bg-canvas);
    border-radius: var(--radius-control);
    overflow: hidden;
  }
  .current-media :global(.media-main), .compare-media :global(.media-main) {
    max-width: 100%;
    max-height: 52vh;
    object-fit: contain;
    display: block;
  }
  .current-media :global(.media-audio), .compare-media :global(.media-audio) {
    width: 100%;
    display: block;
  }
  .current-prompt {
    font-size: var(--text-aux);
    color: var(--text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .history-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .history-title {
    font-size: var(--text-label);
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }
  .history-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
    gap: var(--space-2);
  }
  .history-card {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: var(--space-1);
    background: var(--bg-surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control);
    cursor: pointer;
    text-align: left;
    transition: border-color var(--duration-fast) var(--ease-standard),
                background-color var(--duration-fast) var(--ease-standard);
  }
  .history-card:hover {
    background: var(--bg-surface-2);
    border-color: var(--border-strong);
  }
  .history-card.is-active {
    border-color: var(--accent);
    box-shadow: inset 0 0 0 1px var(--accent);
  }
  .history-thumb {
    width: 100%;
    aspect-ratio: 1;
    border-radius: var(--radius-sm);
    overflow: hidden;
    background: var(--bg-surface-3);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .history-media {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .history-thumb-placeholder {
    color: var(--text-muted);
    display: flex;
  }
  .history-meta {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    padding: 0 var(--space-1) var(--space-1);
  }
  .history-prompt {
    font-size: var(--text-aux);
    color: var(--text-secondary);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .compare-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }
  .compare-col {
    padding: var(--space-3);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .compare-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .compare-head :global(.input) {
    flex: 1;
    min-width: 0;
  }
  @media (max-width: 860px) {
    .compare-grid {
      grid-template-columns: 1fr;
    }
  }
`;
