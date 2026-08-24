"use client";

import { useCallback, useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { usePoll } from "@/hooks/usePoll";
import {
  getNsfwRecommendations,
  getNasStatus,
  nasDownload,
  getNasDownloadStatus,
  type NasStatus,
  type NasDownloadStatus,
} from "@/lib/api";
import type { NsfwRecommendation } from "@/lib/types";

/**
 * NSFW 推荐模型清单面板(M9:NSFW 整合主站,自 /nsfw 专区 NsfwView recs 区块
 * 抽取为自包含组件)。
 *
 * 供 ModelsView「R18 推荐」tab 使用(仅 R18 模式渲染,门控在调用方);
 * 自带推荐清单加载/默认折叠、NAS 可用性检测、下载任务启动与合并轮询进度跟踪;
 * NAS 未启用时兜底展示 Civitai 外链。
 */
export function NsfwRecsPanel() {
  const [recs, setRecs] = useState<NsfwRecommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  // 默认折叠:减少视觉噪音,让用户聚焦主创作区;点击 .nsfw-recs-toggle 展开
  const [recsOpen, setRecsOpen] = useState(false);

  // ── NAS 下载状态 ──
  const [nasStatus, setNasStatus] = useState<NasStatus>({ enabled: false });
  const [downloadJobs, setDownloadJobs] = useState<Record<string, NasDownloadStatus>>({});

  // ── 推荐清单 + NAS 状态 ──
  useEffect(() => {
    let cancelled = false;
    setRecsLoading(true);
    getNsfwRecommendations()
      .then((items) => {
        if (!cancelled) setRecs(items);
      })
      .catch(() => {
        /* 推荐清单失败不影响主功能 */
      })
      .finally(() => {
        if (!cancelled) setRecsLoading(false);
      });
    // 检测 NAS 是否可用
    getNasStatus().then((s) => {
      if (!cancelled) setNasStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // 合并轮询:单个 usePoll 批量查询所有进行中的下载任务(原为每任务各起一个
  // 3s interval,任务多时请求雪崩);全部失败时抛错交 backoff 容错,单任务瞬断跳过。
  const hasRunningDownload = Object.values(downloadJobs).some(
    (j) => j.status === "running",
  );
  usePoll(
    async () => {
      const running = Object.entries(downloadJobs).filter(
        ([, j]) => j.status === "running" && j.id,
      );
      if (running.length === 0) return;
      const results = await Promise.all(
        running.map(([name, job]) =>
          getNasDownloadStatus(job.id)
            .then((st) => ({ name, st }))
            .catch(() => null),
        ),
      );
      const ok = results.filter(
        (r): r is { name: string; st: NasDownloadStatus } => r !== null,
      );
      if (ok.length === 0) throw new Error("下载状态查询失败"); // 全部失败 → 触发 backoff
      const updates: Record<string, NasDownloadStatus> = {};
      for (const { name, st } of ok) {
        updates[name] = st;
      }
      setDownloadJobs((prev) => ({ ...prev, ...updates }));
    },
    { intervalMs: 3000, enabled: hasRunningDownload, backoff: true },
  );

  // 从 civitai_url 提取模型 ID
  const extractCivitaiId = useCallback((url: string): string | null => {
    const m = url.match(/models\/(\d+)/);
    return m ? m[1] : null;
  }, []);

  // 启动 NAS 下载(状态由上方合并轮询统一跟踪)
  const handleDownload = useCallback(async (rec: NsfwRecommendation) => {
    const civitaiId = extractCivitaiId(rec.civitai_url);
    if (!civitaiId) return;
    // 推荐模型类型映射:unet/diffusion_model 落到 diffusion_models,不自动切图像底模;
    // H3 LoRA(category=h3)落 NAS h3/loras(H3 worker 专用,与图像 LoRA 隔离)
    const modelType =
      rec.type === "lora" ? (rec.category === "h3" ? "h3_lora" : "lora") : "unet";
    try {
      const { job_id } = await nasDownload({
        source: "civitai",
        id: civitaiId,
        name: rec.name,
        version_id: rec.version_id,
        type: modelType,
        filename: undefined,
      });
      // 初始化下载状态(后续由合并轮询批量刷新)
      setDownloadJobs((prev) => ({
        ...prev,
        [rec.name]: {
          id: job_id,
          status: "running",
          stage: "排队",
          progress: 0,
          downloaded_mb: 0,
          remote: null,
          error: null,
          filename: "",
          type: modelType,
          elapsed: 0,
        },
      }));
    } catch (e) {
      setDownloadJobs((prev) => ({
        ...prev,
        [rec.name]: {
          id: "",
          status: "error",
          stage: "",
          progress: 0,
          downloaded_mb: 0,
          remote: null,
          error: e instanceof Error ? e.message : "下载启动失败",
          filename: "",
          type: modelType,
          elapsed: 0,
        },
      }));
    }
  }, [extractCivitaiId]);

  return (
    <section className="nsfw-recs">
      <button
        type="button"
        className="nsfw-recs-toggle"
        onClick={() => setRecsOpen((v) => !v)}
        aria-expanded={recsOpen}
      >
        <Icon name={recsOpen ? "chevron-down" : "chevron-right"} size={16} />
        <span>NSFW 推荐模型</span>
        <span className="nsfw-recs-count">
          {recsLoading ? "加载中…" : `${recs.length} 个`}
        </span>
      </button>
      {recsOpen && (
        <div className="nsfw-recs-grid">
          {recs.length === 0 && !recsLoading && (
            <div className="empty-state nsfw-recs-empty">
              <div className="empty-state-icon">
                <Icon name="models" size={48} strokeWidth={1.1} />
              </div>
              <div className="empty-state-title">暂无推荐</div>
              <div className="empty-state-desc">
                后端未返回推荐清单,请自行搭配本地模型
              </div>
            </div>
          )}
          {recs.map((r) => {
            const job = downloadJobs[r.name];
            const isDone = job?.status === "done";
            const isError = job?.status === "error";
            const isRunning = job?.status === "running";
            const pct = isRunning && job?.progress != null
              ? Math.min(100, Math.max(0, Math.round(job.progress)))
              : 0;
            const nasEnabled = nasStatus.enabled;
            const civitaiId = extractCivitaiId(r.civitai_url);
            return (
              <div
                key={r.name}
                className={`nsfw-rec-card${isDone ? " is-done" : ""}`}
                title={r.desc}
              >
                <div className="nsfw-rec-head">
                  <span className="nsfw-rec-type">{r.type}</span>
                  {r.category && (
                    <span className="nsfw-rec-cat">{r.category}</span>
                  )}
                  {isDone && (
                    <span className="nsfw-rec-badge-done" translate="no">
                      <Icon name="check" size={11} /> 已下载
                    </span>
                  )}
                </div>
                <div className="nsfw-rec-name" translate="no">{r.name}</div>
                {r.base && (
                  <div className="nsfw-rec-base" translate="no">底模:{r.base}</div>
                )}
                {r.size && (
                  <div className="nsfw-rec-size">{r.size}</div>
                )}
                {r.desc && (
                  <div className="nsfw-rec-desc">{r.desc}</div>
                )}

                {/* ── 下载操作区 ── */}
                <div className="nsfw-rec-foot">
                  {!nasEnabled && (
                    <a
                      className="nsfw-rec-link"
                      href={r.civitai_url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      <Icon name="link" size={13} /> Civitai
                    </a>
                  )}

                  {nasEnabled && !isRunning && !isDone && (
                    <button
                      type="button"
                      className="nsfw-dl-btn"
                      onClick={() => handleDownload(r)}
                      disabled={!civitaiId}
                      title={civitaiId ? "下载到 NAS 模型目录" : "无法解析 civitai 模型 ID"}
                    >
                      <Icon name="download" size={13} /> 下载到 NAS
                    </button>
                  )}

                  {isRunning && (
                    <div className="nsfw-dl-progress">
                      <div className="nsfw-dl-bar">
                        <div className="nsfw-dl-bar-fill" style={{ width: `${pct}%` }} />
                      </div>
                      <div className="nsfw-dl-meta">
                        <span className="nsfw-dl-stage">{job?.stage || "下载中"}</span>
                        <span className="nsfw-dl-pct">{pct}%</span>
                        {job?.downloaded_mb != null && job.downloaded_mb > 0 && (
                          <span className="nsfw-dl-mb">{job.downloaded_mb.toFixed(1)} MB</span>
                        )}
                      </div>
                    </div>
                  )}

                  {isError && (
                    <div className="nsfw-dl-error">
                      <Icon name="error" size={13} />
                      <span className="nsfw-dl-err-msg">
                        {job?.error || "下载失败"}
                      </span>
                      <button
                        type="button"
                        className="nsfw-dl-retry"
                        onClick={() => handleDownload(r)}
                      >
                        重试
                      </button>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <style jsx>{`
        /* ── 推荐模型:独立区块,样式类名与交互自 /nsfw 专区原样保留 ── */
        .nsfw-recs {
          border-top: 1px solid var(--border-subtle);
          background: var(--bg-surface-1);
          padding: var(--space-2) var(--space-8) var(--space-4);
        }
        .nsfw-recs-toggle {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          width: calc(100% + 2 * var(--space-2));
          min-height: 52px;
          padding: var(--space-3) var(--space-2);
          margin: 0 calc(-1 * var(--space-2));
          background: transparent;
          border: none;
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-section); /* 区块标题档 */
          font-weight: var(--font-semibold);
          cursor: pointer;
          text-align: left;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-recs-toggle:hover {
          background: var(--bg-surface-2);
        }
        .nsfw-recs-toggle:active {
          background: var(--bg-surface-3);
        }
        .nsfw-recs-count {
          margin-left: auto;
          padding: var(--space-1) var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          color: var(--text-muted);
          font-size: var(--text-label);
          font-weight: var(--font-medium);
        }
        .nsfw-recs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: var(--section-gap);
          padding: var(--space-2) 0 var(--space-4);
        }
        .nsfw-rec-card {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-4);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel); /* 卡片与面板圆角一致 */
          color: inherit;
          text-decoration: none;
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard);
        }
        .nsfw-rec-card:hover {
          border-color: var(--border-strong);
          box-shadow: var(--shadow-md);
          transform: translateY(-2px); /* hover 升浮反馈 */
        }
        .nsfw-rec-head {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          flex-wrap: wrap;
        }
        .nsfw-rec-type,
        .nsfw-rec-cat {
          font-size: var(--text-label);
          padding: 2px var(--space-2);
          border-radius: var(--radius-badge);
          font-weight: var(--font-medium);
        }
        .nsfw-rec-type {
          background: var(--accent-soft);
          color: var(--accent);
        }
        .nsfw-rec-cat {
          background: var(--bg-surface-3);
          color: var(--text-secondary);
        }
        .nsfw-rec-name {
          font-size: var(--text-section);
          font-weight: var(--font-semibold);
          color: var(--text-primary);
          line-height: 1.4;
          word-break: break-word;
        }
        .nsfw-rec-base,
        .nsfw-rec-size {
          font-size: var(--text-aux);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .nsfw-rec-desc {
          font-size: var(--text-aux);
          color: var(--text-muted);
          line-height: 1.55;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .nsfw-recs-empty {
          grid-column: 1 / -1;
          padding: var(--space-8) var(--space-5);
        }
        /* ── 已下载卡片态 ── */
        .nsfw-rec-card.is-done {
          border-color: color-mix(in oklch, var(--accent) 50%, var(--border-subtle));
        }
        .nsfw-rec-badge-done {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          margin-left: auto;
          padding: 2px var(--space-2);
          background: var(--accent-soft);
          color: var(--accent);
          border-radius: var(--radius-full);
          font-size: var(--text-label);
          font-weight: var(--font-semibold);
          white-space: nowrap;
        }
        /* ── 下载操作区 ── */
        .nsfw-rec-foot {
          margin-top: auto;
          padding-top: var(--space-2);
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
        }
        .nsfw-rec-link {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          align-self: flex-start;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          text-decoration: none;
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-badge);
          padding: var(--space-1) var(--space-3);
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-rec-link:hover {
          border-color: var(--border-strong);
          background: var(--bg-surface-2);
        }
        .nsfw-rec-link:active {
          background: var(--bg-surface-3);
        }
        .nsfw-dl-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-1);
          align-self: stretch;
          min-height: 36px;
          padding: var(--space-2) var(--space-3);
          background: var(--accent);
          color: var(--text-on-accent);
          border: none;
          border-radius: var(--radius-control);
          font-size: var(--text-aux);
          font-weight: var(--font-medium);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-dl-btn:hover:not(:disabled) {
          background: var(--accent-hover);
        }
        .nsfw-dl-btn:active:not(:disabled) {
          background: color-mix(in oklch, var(--accent) 88%, var(--bg-canvas));
        }
        .nsfw-dl-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        /* ── 下载进度 ── */
        .nsfw-dl-progress {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        .nsfw-dl-bar {
          height: 6px;
          background: var(--bg-surface-3);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .nsfw-dl-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--accent-soft));
          border-radius: var(--radius-full);
          transition: width var(--duration-base) var(--ease-standard);
        }
        .nsfw-dl-meta {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          font-size: var(--text-aux);
          color: var(--text-secondary);
        }
        .nsfw-dl-stage {
          color: var(--text-secondary);
        }
        .nsfw-dl-pct {
          margin-left: auto;
          color: var(--accent);
          font-weight: var(--font-semibold);
          font-family: var(--font-mono); /* 等宽只用于数字,中文 stage 保持正文字体 */
        }
        .nsfw-dl-mb {
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        /* ── 下载错误 ── */
        .nsfw-dl-error {
          display: flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-2);
          background: color-mix(in oklch, var(--err) 10%, var(--bg-surface-3));
          border: 1px solid color-mix(in oklch, var(--err) 30%, transparent);
          border-radius: var(--radius-badge);
          font-size: var(--text-aux);
          color: var(--err);
        }
        .nsfw-dl-err-msg {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-dl-retry {
          padding: var(--space-1) var(--space-2);
          background: var(--err);
          color: var(--text-on-accent);
          border: none;
          border-radius: var(--radius-badge);
          font-size: var(--text-aux);
          cursor: pointer;
          white-space: nowrap;
          transition: background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-dl-retry:hover {
          background: color-mix(in oklch, var(--err) 85%, var(--text-on-accent));
        }
        .nsfw-dl-retry:active {
          background: color-mix(in oklch, var(--err) 85%, var(--bg-canvas));
        }
        /* ── 响应式 ── */
        @media (max-width: 1023px) {
          .nsfw-recs {
            padding: var(--space-2) var(--space-6) var(--space-4);
          }
        }
        @media (max-width: 767px) {
          .nsfw-recs {
            padding: var(--space-2) var(--space-3) var(--space-3);
          }
          .nsfw-recs-grid {
            grid-template-columns: 1fr;
            gap: var(--space-3);
          }
          /* 移动端触控目标 */
          .nsfw-rec-link,
          .nsfw-dl-btn,
          .nsfw-dl-retry {
            min-height: var(--touch-target);
          }
          .nsfw-dl-retry {
            display: inline-flex;
            align-items: center;
          }
        }
      `}</style>
    </section>
  );
}
