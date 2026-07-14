"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";

import { CreateView } from "@/components/create/CreateView";
import { NsfwVideoView } from "@/components/nsfw/NsfwVideoView";
import { Icon } from "@/components/ui/Icon";
import {
  fetchMe,
  getToken,
  setToken,
  setNsfwIntent,
  getNsfwRecommendations,
  getNasStatus,
  nasDownload,
  getNasDownloadStatus,
  type NasStatus,
  type NasDownloadStatus,
} from "@/lib/api";
import type { NsfwRecommendation } from "@/lib/types";

type AuthState = "loading" | "in" | "out";
type NsfwTab = "image" | "video";

/**
 * NSFW 专区(/nsfw 入口)。
 * - 仅通过地址栏输入 /nsfw 直达,无导航入口,无 R18 开关
 * - 进入即设置 X-NSFW 放行标记,卸载时还原
 * - 复用 CreateView 的完整生成能力,模型列表自动走 R18 通道
 * - 顶部 18+ 警告条;底部 NSFW 推荐模型清单(可折叠,支持下载到 NAS)
 */
export function NsfwView() {
  const router = useRouter();
  const [auth, setAuth] = useState<AuthState>("loading");

  // ── 鉴权初始化 ──
  useEffect(() => {
    let cancelled = false;
    // 进入专区即放行,确保 listModels 返回 R18 模型
    setNsfwIntent(true);
    if (!getToken()) {
      setAuth("out");
      return;
    }
    fetchMe()
      .then(() => {
        if (cancelled) return;
        setAuth("in");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        const msg = err instanceof Error ? err.message : String(err);
        const isAuth = msg.includes("会话已过期") || msg.includes("401");
        if (isAuth) setToken(null);
        setAuth("out");
      });
    return () => {
      cancelled = true;
      setNsfwIntent(false);
    };
  }, []);

  if (auth === "loading") {
    return (
      <div className="nsfw-splash">
        <div className="hero-orb" aria-hidden="true" />
        <style jsx>{`
          .nsfw-splash {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-sunken);
          }
        `}</style>
      </div>
    );
  }

  if (auth === "out") {
    return (
      <div className="nsfw-gate">
        <div className="nsfw-gate-card">
          <div className="nsfw-gate-icon">
            <Icon name="lock" size={40} />
          </div>
          <h1 className="nsfw-gate-title">需要登录</h1>
          <p className="nsfw-gate-desc">此专区仅限已登录用户访问</p>
          <button
            className="btn btn-primary"
            onClick={() => router.push("/login?next=/nsfw")}
          >
            前往登录
          </button>
        </div>
        <style jsx>{`
          .nsfw-gate {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-sunken);
            padding: var(--space-5);
          }
          .nsfw-gate-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--space-3);
            padding: var(--space-6);
            background: var(--bg-1);
            border: 1px solid var(--hairline);
            border-radius: var(--radius-lg);
            text-align: center;
            max-width: 360px;
          }
          .nsfw-gate-icon {
            color: var(--ink-faint);
          }
          .nsfw-gate-title {
            font-size: 1.25rem;
            font-weight: 600;
            color: var(--ink);
            margin: 0;
          }
          .nsfw-gate-desc {
            font-size: 0.875rem;
            color: var(--ink-soft);
            margin: 0;
          }
        `}</style>
      </div>
    );
  }

  // 鉴权通过,渲染专区主体
  return <NsfwViewBody />;
}

/**
 * NSFW 专区主体:推荐清单 / tab 切换 / NAS 下载。
 */
function NsfwViewBody() {
  const [recs, setRecs] = useState<NsfwRecommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  const [recsOpen, setRecsOpen] = useState(true);
  const [tab, setTab] = useState<NsfwTab>("image");

  // ── NAS 下载状态 ──
  const [nasStatus, setNasStatus] = useState<NasStatus>({ enabled: false });
  const [downloadJobs, setDownloadJobs] = useState<Record<string, NasDownloadStatus>>({});
  const pollRefs = useRef<Record<string, ReturnType<typeof setInterval>>>({});

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
      // 清理所有轮询
      for (const id of Object.keys(pollRefs.current)) {
        clearInterval(pollRefs.current[id]);
      }
    };
  }, []);

  // 从 civitai_url 提取模型 ID
  const extractCivitaiId = useCallback((url: string): string | null => {
    const m = url.match(/models\/(\d+)/);
    return m ? m[1] : null;
  }, []);

  // 启动 NAS 下载
  const handleDownload = useCallback(async (rec: NsfwRecommendation) => {
    const civitaiId = extractCivitaiId(rec.civitai_url);
    if (!civitaiId) return;
    const modelType = rec.type === "lora" ? "lora" : "checkpoint";
    try {
      const { job_id } = await nasDownload({
        source: "civitai",
        id: civitaiId,
        name: rec.name,
        type: modelType,
        filename: undefined,
      });
      // 初始化下载状态
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
      // 启动轮询
      const poll = async () => {
        try {
          const st = await getNasDownloadStatus(job_id);
          setDownloadJobs((prev) => ({ ...prev, [rec.name]: st }));
          if (st.status === "done" || st.status === "error") {
            if (pollRefs.current[rec.name]) {
              clearInterval(pollRefs.current[rec.name]);
              delete pollRefs.current[rec.name];
            }
          }
        } catch {
          /* 轮询失败静默,下次重试 */
        }
      };
      pollRefs.current[rec.name] = setInterval(poll, 3000);
      poll(); // 立即查一次
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
    <div className="nsfw-view">
      {/* ── 顶部警告条 ── */}
      <header className="nsfw-banner" role="banner">
        <div className="nsfw-banner-left">
          <span className="nsfw-badge" aria-label="18+ 内容">
            <Icon name="warning" size={14} />
            <span>18+</span>
          </span>
          <div className="nsfw-banner-text">
            <div className="nsfw-banner-title">R18 创作专区</div>
            <div className="nsfw-banner-sub">
              模型自行搭配,内容仅你可见,请遵守当地法规
            </div>
          </div>
        </div>
      </header>

      {/* ── 主创作区:图像 / 视频 tab 切换 ── */}
      <main className="nsfw-main">
        <div className="nsfw-tabs" role="tablist" aria-label="创作模式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "image"}
            className={`nsfw-tab${tab === "image" ? " is-active" : ""}`}
            onClick={() => setTab("image")}
          >
            <Icon name="image" size={16} />
            <span>图像</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "video"}
            className={`nsfw-tab${tab === "video" ? " is-active" : ""}`}
            onClick={() => setTab("video")}
          >
            <Icon name="video" size={16} />
            <span>视频</span>
          </button>
        </div>
        <div className="nsfw-tab-panel">
          {tab === "image" ? <CreateView nsfw /> : <NsfwVideoView />}
        </div>
      </main>

      {/* ── NSFW 推荐模型清单(可折叠)── */}
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
      </section>

      <style jsx>{`
        .nsfw-view {
          display: flex;
          flex-direction: column;
          min-height: 100vh;
          background: var(--bg-sunken);
        }
        /* ── 顶部 banner ── */
        .nsfw-banner {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-5);
          background: linear-gradient(
            90deg,
            color-mix(in oklch, var(--danger) 12%, var(--bg-1)),
            var(--bg-1)
          );
          border-bottom: 1px solid var(--hairline);
        }
        .nsfw-banner-left {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          min-width: 0;
        }
        .nsfw-badge {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          padding: 3px 8px;
          background: var(--danger);
          color: var(--on-accent);
          border-radius: var(--radius-full);
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }
        .nsfw-banner-text {
          min-width: 0;
        }
        .nsfw-banner-title {
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.3;
        }
        .nsfw-banner-sub {
          font-size: 0.78rem;
          color: var(--ink-soft);
          line-height: 1.4;
        }
        /* ── 主创作区 ── */
        .nsfw-main {
          flex: 1;
          min-height: 0;
          background: var(--bg-0);
          display: flex;
          flex-direction: column;
        }
        /* ── 图像 / 视频 tab ── */
        .nsfw-tabs {
          display: flex;
          gap: 0;
          padding: 0 var(--space-5);
          background: var(--bg-1);
          border-bottom: 1px solid var(--hairline);
          flex-shrink: 0;
        }
        .nsfw-tab {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: var(--space-3) var(--space-4);
          background: transparent;
          border: none;
          border-bottom: 2px solid transparent;
          color: var(--ink-soft);
          font-size: 0.88rem;
          font-weight: 500;
          cursor: pointer;
          transition: color var(--dur) var(--ease),
            border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
        }
        .nsfw-tab:hover {
          color: var(--ink);
          background: var(--bg-2);
        }
        .nsfw-tab.is-active {
          color: var(--ink);
          border-bottom-color: var(--accent);
        }
        .nsfw-tab-panel {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        /* ── 推荐模型 ── */
        .nsfw-recs {
          border-top: 1px solid var(--hairline);
          background: var(--bg-1);
          padding: 0 var(--space-5);
        }
        .nsfw-recs-toggle {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          width: 100%;
          padding: var(--space-3) 0;
          background: transparent;
          border: none;
          color: var(--ink-soft);
          font-size: 0.88rem;
          font-weight: 500;
          cursor: pointer;
          text-align: left;
        }
        .nsfw-recs-toggle:hover {
          color: var(--ink);
        }
        .nsfw-recs-count {
          margin-left: auto;
          color: var(--ink-faint);
          font-size: 0.8rem;
          font-weight: 400;
        }
        .nsfw-recs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: var(--space-3);
          padding-bottom: var(--space-5);
        }
        .nsfw-rec-card {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: var(--space-3);
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          color: inherit;
          text-decoration: none;
          transition: border-color 0.18s var(--ease), transform 0.18s var(--ease);
        }
        .nsfw-rec-card:hover {
          border-color: var(--accent);
          transform: translateY(-2px);
        }
        .nsfw-rec-head {
          display: flex;
          align-items: center;
          gap: 6px;
          flex-wrap: wrap;
        }
        .nsfw-rec-type,
        .nsfw-rec-cat {
          font-size: 0.68rem;
          padding: 2px 6px;
          border-radius: var(--radius-xs);
          font-weight: 500;
        }
        .nsfw-rec-type {
          background: var(--accent-quiet);
          color: var(--accent-soft);
        }
        .nsfw-rec-cat {
          background: var(--bg-3);
          color: var(--ink-soft);
        }
        .nsfw-rec-name {
          font-size: 0.88rem;
          font-weight: 600;
          color: var(--ink);
          word-break: break-word;
        }
        .nsfw-rec-base,
        .nsfw-rec-size {
          font-size: 0.74rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
        }
        .nsfw-rec-desc {
          font-size: 0.78rem;
          color: var(--ink-soft);
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .nsfw-recs-empty {
          grid-column: 1 / -1;
          padding: var(--space-5);
        }
        /* ── 已下载卡片态 ── */
        .nsfw-rec-card.is-done {
          border-color: color-mix(in oklch, var(--accent) 50%, var(--hairline));
        }
        .nsfw-rec-badge-done {
          display: inline-flex;
          align-items: center;
          gap: 3px;
          margin-left: auto;
          padding: 2px 7px;
          background: var(--accent-quiet);
          color: var(--accent-soft);
          border-radius: var(--radius-full);
          font-size: 0.66rem;
          font-weight: 600;
          white-space: nowrap;
        }
        /* ── 下载操作区 ── */
        .nsfw-rec-foot {
          margin-top: auto;
          padding-top: var(--space-2);
          display: flex;
          flex-direction: column;
          gap: 6px;
        }
        .nsfw-rec-link {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          align-self: flex-start;
          font-size: 0.78rem;
          color: var(--ink-soft);
          text-decoration: none;
          border: 1px solid var(--hairline);
          border-radius: var(--radius-xs);
          padding: 5px 10px;
          transition: all 0.18s var(--ease);
        }
        .nsfw-rec-link:hover {
          border-color: var(--accent);
          color: var(--accent-soft);
        }
        .nsfw-dl-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 5px;
          align-self: stretch;
          padding: 7px 12px;
          background: var(--accent);
          color: var(--on-accent);
          border: none;
          border-radius: var(--radius-xs);
          font-size: 0.8rem;
          font-weight: 500;
          cursor: pointer;
          transition: all 0.18s var(--ease);
        }
        .nsfw-dl-btn:hover:not(:disabled) {
          background: color-mix(in oklch, var(--accent) 88%, white);
        }
        .nsfw-dl-btn:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }
        /* ── 下载进度 ── */
        .nsfw-dl-progress {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .nsfw-dl-bar {
          height: 6px;
          background: var(--bg-3);
          border-radius: var(--radius-full);
          overflow: hidden;
        }
        .nsfw-dl-bar-fill {
          height: 100%;
          background: linear-gradient(90deg, var(--accent), var(--accent-soft));
          border-radius: var(--radius-full);
          transition: width 0.3s var(--ease);
        }
        .nsfw-dl-meta {
          display: flex;
          align-items: center;
          gap: 8px;
          font-size: 0.72rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
        }
        .nsfw-dl-stage {
          color: var(--ink-soft);
        }
        .nsfw-dl-pct {
          margin-left: auto;
          color: var(--accent-soft);
          font-weight: 600;
        }
        .nsfw-dl-mb {
          color: var(--ink-faint);
        }
        /* ── 下载错误 ── */
        .nsfw-dl-error {
          display: flex;
          align-items: center;
          gap: 6px;
          padding: 6px 8px;
          background: color-mix(in oklch, var(--danger) 10%, var(--bg-3));
          border: 1px solid color-mix(in oklch, var(--danger) 30%, transparent);
          border-radius: var(--radius-xs);
          font-size: 0.74rem;
          color: var(--danger);
        }
        .nsfw-dl-err-msg {
          flex: 1;
          min-width: 0;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .nsfw-dl-retry {
          padding: 3px 9px;
          background: var(--danger);
          color: var(--on-accent);
          border: none;
          border-radius: var(--radius-xs);
          font-size: 0.72rem;
          cursor: pointer;
          white-space: nowrap;
        }
        .nsfw-dl-retry:hover {
          background: color-mix(in oklch, var(--danger) 85%, white);
        }
        /* ── 响应式 ── */
        @media (max-width: 640px) {
          .nsfw-banner {
            padding: var(--space-3);
          }
          .nsfw-banner-sub {
            display: none;
          }
          .nsfw-recs {
            padding: 0 var(--space-3);
          }
          .nsfw-recs-grid {
            grid-template-columns: 1fr;
          }
        }
      `}</style>
    </div>
  );
}
