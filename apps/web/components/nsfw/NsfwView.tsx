"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

import { GenerateView, type GenerateDraft } from "@/components/generate/GenerateView";
import { LibraryView } from "@/components/library/LibraryView";
import { NsfwDramaView } from "@/components/nsfw/NsfwDramaView";
import { Icon } from "@/components/ui/Icon";
import { usePoll } from "@/hooks/usePoll";
import { consumeEngineDraft } from "@/lib/engine";
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
type NsfwTab = "image" | "video" | "drama" | "library";

// 年龄确认持久化 key:首访 /nsfw 弹出 18+ 声明,确认后写入不再弹
const AGE_CONFIRM_KEY = "toiv_nsfw_age_confirmed";

/**
 * NSFW 专区(/nsfw 入口)。
 * - 仅通过地址栏输入 /nsfw 直达,无导航入口,无 R18 开关
 * - 首次进入弹 18+ 年龄确认,确认后写 localStorage 不再弹
 * - 进入即设置 X-NSFW 放行标记,卸载时还原
 * - 图像/视频 tab 内嵌统一生成工作台(GenerateView onlyNsfw,只展示 R18 引擎)
 * - 短剧 tab 内嵌 NsfwDramaView(drama 管线 scoped 工作台,产物 nsfw 打标隔离)
 * - 作品库 tab 内嵌 LibraryView onlyNsfw(只展示 R18 作品):查看/删除/复用提示词,
 *   复用在专区内切 tab 回填草稿,不跳主站
 * - 顶部 18+ 警告条;底部 NSFW 推荐模型清单(可折叠,支持下载到 NAS)
 */
export function NsfwView() {
  const router = useRouter();
  const [auth, setAuth] = useState<AuthState>("loading");
  // 年龄确认:null=尚未读取 localStorage(避免 SSR/首帧闪烁)
  const [ageConfirmed, setAgeConfirmed] = useState<boolean | null>(null);

  // 读取年龄确认记录(仅客户端)
  useEffect(() => {
    setAgeConfirmed(window.localStorage.getItem(AGE_CONFIRM_KEY) === "1");
  }, []);

  // 确认已满 18 岁:落 localStorage 后放行
  const confirmAge = useCallback(() => {
    window.localStorage.setItem(AGE_CONFIRM_KEY, "1");
    setAgeConfirmed(true);
  }, []);

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

  if (auth === "loading" || (auth === "in" && ageConfirmed === null)) {
    return (
      <div className="nsfw-splash">
        <div className="hero-orb" aria-hidden="true" />
        <style jsx>{`
          .nsfw-splash {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-canvas);
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
            background: var(--bg-canvas);
            padding: var(--space-5);
          }
          .nsfw-gate-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--space-3);
            padding: var(--space-8) var(--space-6);
            background: var(--bg-surface-1);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-panel);
            box-shadow: var(--shadow-md);
            text-align: center;
            max-width: 360px;
            width: 100%;
          }
          .nsfw-gate-icon {
            color: var(--text-muted);
          }
          .nsfw-gate-title {
            font-size: var(--text-title);
            font-weight: 700;
            color: var(--text-primary);
            margin: 0;
          }
          .nsfw-gate-desc {
            font-size: var(--text-body);
            color: var(--text-secondary);
            margin: 0;
          }
          .nsfw-gate-card .btn {
            width: 100%;
            min-height: 44px; /* 触控目标 ≥44px */
            margin-top: var(--space-2);
          }
        `}</style>
      </div>
    );
  }

  if (ageConfirmed === false) {
    // 首访年龄确认门:确认前不渲染任何专区内容;确认写 localStorage,后续直达
    return (
      <div className="nsfw-age-gate">
        <div className="nsfw-age-gate-card">
          <div className="nsfw-age-gate-icon">
            <Icon name="warning" size={40} />
          </div>
          <h1 className="nsfw-age-gate-title">年龄确认</h1>
          <p className="nsfw-age-gate-desc">
            本专区包含成人向(18+)创作内容。继续访问即表示你确认已年满
            18 岁,并承诺遵守所在地法律法规。
          </p>
          <div className="nsfw-age-gate-actions">
            <button className="btn btn-primary" onClick={confirmAge}>
              我已年满 18 岁,进入专区
            </button>
            <button className="btn btn-ghost" onClick={() => router.push("/")}>
              离开
            </button>
          </div>
        </div>
        <style jsx>{`
          .nsfw-age-gate {
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            background: var(--bg-canvas);
            padding: var(--space-5);
          }
          .nsfw-age-gate-card {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: var(--space-3);
            padding: var(--space-8) var(--space-6);
            background: var(--bg-surface-1);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-panel);
            box-shadow: var(--shadow-md);
            text-align: center;
            max-width: 400px;
            width: 100%;
          }
          .nsfw-age-gate-icon {
            color: var(--err);
          }
          .nsfw-age-gate-title {
            font-size: var(--text-title);
            font-weight: 700;
            color: var(--text-primary);
            margin: 0;
          }
          .nsfw-age-gate-desc {
            font-size: var(--text-body);
            color: var(--text-secondary);
            margin: 0;
            line-height: 1.6;
          }
          .nsfw-age-gate-actions {
            display: flex;
            flex-direction: column;
            gap: var(--space-2);
            width: 100%;
            margin-top: var(--space-2);
          }
          .nsfw-age-gate-actions .btn {
            min-height: 44px; /* 触控目标 ≥44px */
          }
        `}</style>
      </div>
    );
  }

  // 鉴权 + 年龄确认通过,渲染专区主体
  return <NsfwViewBody />;
}

/**
 * NSFW 专区主体:推荐清单 / tab 切换 / NAS 下载。
 */
function NsfwViewBody() {
  const [recs, setRecs] = useState<NsfwRecommendation[]>([]);
  const [recsLoading, setRecsLoading] = useState(false);
  // 默认折叠:减少视觉噪音,让用户聚焦主创作区;点击 .nsfw-recs-toggle 展开
  const [recsOpen, setRecsOpen] = useState(false);
  const [tab, setTab] = useState<NsfwTab>("image");
  // 作品库「复用提示词」回填:draftSeq 变 → GenerateView 重挂载消费 initialDraft;
  // 手动切 tab 清空,避免过期草稿反复回填
  const [pendingDraft, setPendingDraft] = useState<GenerateDraft | null>(null);
  const [draftSeq, setDraftSeq] = useState(0);

  // 手动 tab 切换:清掉一次性回填草稿
  const switchTab = useCallback((t: NsfwTab) => {
    setPendingDraft(null);
    setTab(t);
  }, []);

  // 作品库「复用提示词」:LibraryView 已写引擎草稿(localStorage),
  // 这里立即消费并转为 GenerateView initialDraft,留在专区内切 tab,不跳主站
  const handleLibraryNavigate = useCallback((target: string) => {
    const draft = consumeEngineDraft(target);
    if (draft) {
      setPendingDraft(draft);
      setDraftSeq((s) => s + 1);
    }
    setTab(target === "video" ? "video" : "image");
  }, []);

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
    <div className="nsfw-view">
      {/* ── 统一页头:大标题 + 辅助描述 + 右侧 NAS 状态操作区 ── */}
      <header className="page-header nsfw-header" role="banner">
        <div className="nsfw-header-main">
          <span className="nsfw-badge" aria-label="18+ 内容">
            <Icon name="warning" size={14} />
            <span>18+</span>
          </span>
          <div className="nsfw-header-text">
            <h1 className="page-header-title">R18 创作专区</h1>
            <p className="page-header-desc">
              模型自行搭配,内容仅你可见,请遵守当地法规
            </p>
          </div>
        </div>
        <div className="page-header-actions">
          <span
            className={`nsfw-nas-chip${nasStatus.enabled ? " is-on" : ""}`}
            title={
              nasStatus.enabled
                ? "NAS 下载通道可用,推荐模型可一键下载"
                : "NAS 未启用,推荐模型仅提供 Civitai 链接"
            }
          >
            <Icon name="database" size={12} />
            <span>{nasStatus.enabled ? "NAS 已连接" : "NAS 未启用"}</span>
          </span>
        </div>
      </header>

      {/* ── 主创作区:图像 / 视频 / 作品库 tab 切换 ── */}
      <main className="nsfw-main">
        <div className="nsfw-tabs-wrap">
          <div className="nsfw-tabs" role="tablist" aria-label="创作模式">
          <button
            type="button"
            role="tab"
            aria-selected={tab === "image"}
            className={`nsfw-tab${tab === "image" ? " is-active" : ""}`}
            onClick={() => switchTab("image")}
          >
            <Icon name="image" size={16} />
            <span>图像</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "video"}
            className={`nsfw-tab${tab === "video" ? " is-active" : ""}`}
            onClick={() => switchTab("video")}
          >
            <Icon name="video" size={16} />
            <span>视频</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "drama"}
            className={`nsfw-tab${tab === "drama" ? " is-active" : ""}`}
            onClick={() => switchTab("drama")}
          >
            <Icon name="clapperboard" size={16} />
            <span>短剧</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "library"}
            className={`nsfw-tab${tab === "library" ? " is-active" : ""}`}
            onClick={() => switchTab("library")}
          >
            <Icon name="library" size={16} />
            <span>作品库</span>
          </button>
          </div>
        </div>
        <div className="nsfw-tab-panel">
          {/* 统一生成工作台:onlyNsfw 只展示 R18 引擎;initialDraft 默认 null 不消费
              主站引擎草稿,仅作品库「复用提示词」回填时注入一次性草稿(draftSeq 强制重挂载)。
              包一层 .nsfw-workbench(stage.css):/nsfw 高度链是 min-height 非定高,
              GenerateView 的 height:100% 无法解析,改用 flex stretch 撑满。
              短剧 tab 内嵌 NsfwDramaView(drama 管线 scoped 工作台,nsfw:true 打标产物);
              作品库 tab 复用 LibraryView(onlyNsfw 只看 R18 作品),查看/删除/复用提示词 */}
          {tab === "library" ? (
            <div className="nsfw-library">
              <LibraryView onlyNsfw onNavigate={handleLibraryNavigate} />
            </div>
          ) : tab === "drama" ? (
            <NsfwDramaView />
          ) : tab === "image" ? (
            <div className="nsfw-workbench">
              <GenerateView
                key={`image-${draftSeq}`}
                lockedKind="image"
                onlyNsfw
                initialDraft={
                  pendingDraft && pendingDraft.target === "image" ? pendingDraft : null
                }
              />
            </div>
          ) : (
            <div className="nsfw-workbench">
              <GenerateView
                key={`video-${draftSeq}`}
                lockedKind="video"
                onlyNsfw
                initialDraft={
                  pendingDraft && pendingDraft.target === "video" ? pendingDraft : null
                }
              />
            </div>
          )}
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
          background: var(--bg-canvas);
        }
        /* ── 统一页头(.page-header* 为全局类;此处为 NSFW 定制与兜底)── */
        .nsfw-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-4);
          padding: var(--space-6) var(--space-8); /* 壳层 app-main padding-top:56px 已垂直让开 CornerNav 触发器,左右对称 */
          background: linear-gradient(
            90deg,
            color-mix(in oklch, var(--err) 10%, var(--bg-surface-1)),
            var(--bg-surface-1) 60%
          );
          border-bottom: 1px solid var(--border-subtle);
        }
        .nsfw-header-main {
          display: flex;
          align-items: center;
          gap: var(--space-3);
          min-width: 0;
        }
        .nsfw-header-text {
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
        }
        /* 全局类缺失时的兜底,与全局页头排版档一致 */
        .nsfw-header .page-header-title {
          margin: 0;
          font-size: var(--text-title);
          font-weight: 700;
          color: var(--text-primary);
          line-height: 1.3;
        }
        .nsfw-header .page-header-desc {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.5;
        }
        .nsfw-header .page-header-actions {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          flex-shrink: 0;
        }
        .nsfw-nas-chip {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-3);
          background: var(--bg-surface-2);
          color: var(--text-muted);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          font-size: var(--text-label);
          font-weight: 500;
          white-space: nowrap;
        }
        .nsfw-nas-chip.is-on {
          background: var(--accent-soft);
          color: var(--accent);
          border-color: color-mix(in oklch, var(--accent) 35%, transparent);
        }
        .nsfw-badge {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) var(--space-2);
          background: var(--err);
          color: var(--text-on-accent);
          border-radius: var(--radius-full);
          font-size: var(--text-aux);
          font-weight: 600;
          letter-spacing: 0.04em;
          flex-shrink: 0;
        }
        /* ── 主创作区 ── */
        .nsfw-main {
          flex: 1;
          min-height: 0;
          background: var(--bg-canvas);
          display: flex;
          flex-direction: column;
        }
        /* ── 图像 / 视频 tab:悬浮式分段控件(脱离整栏分隔线,改为胶囊组)── */
        .nsfw-tabs-wrap {
          padding: var(--space-4) var(--space-8) 0;
          background: var(--bg-canvas);
          flex-shrink: 0;
        }
        .nsfw-tabs {
          display: inline-flex;
          gap: var(--space-1);
          padding: var(--space-1);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          box-shadow: var(--shadow-sm);
          max-width: 100%;
          overflow-x: auto; /* 窄屏 4 个 tab 可横滑,不挤压破版 */
          scrollbar-width: none;
        }
        .nsfw-tabs::-webkit-scrollbar {
          display: none;
        }
        .nsfw-tab {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: var(--space-2);
          min-height: 44px; /* 触控目标 ≥44px */
          padding: var(--space-2) var(--space-5);
          background: transparent;
          border: none;
          border-radius: var(--radius-full);
          color: var(--text-secondary);
          font-size: var(--text-body);
          font-weight: 500;
          white-space: nowrap;
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .nsfw-tab:hover {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .nsfw-tab:active {
          background: var(--bg-surface-3);
        }
        .nsfw-tab.is-active {
          background: var(--accent-soft);
          color: var(--accent);
          font-weight: 600;
        }
        .nsfw-tab-panel {
          flex: 1;
          min-height: 0;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        /* ── 推荐模型:独立区块,拉开与主创作区的节奏 ── */
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
          font-weight: 600;
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
          font-weight: 500;
        }
        .nsfw-recs-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
          gap: var(--space-5);
          padding: var(--space-2) 0 var(--space-6);
        }
        .nsfw-rec-card {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-5);
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
          font-weight: 500;
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
          font-weight: 600;
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
          font-weight: 600;
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
          font-weight: 500;
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
          font-weight: 600;
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
          .nsfw-header {
            padding: var(--space-5) var(--space-6);
          }
          .nsfw-tabs-wrap {
            padding: var(--space-4) var(--space-6) 0;
          }
          .nsfw-recs {
            padding: var(--space-2) var(--space-6) var(--space-4);
          }
        }
        @media (max-width: 767px) {
          .nsfw-header {
            padding: var(--space-4);
            flex-wrap: wrap;
          }
          .nsfw-header .page-header-desc {
            display: none;
          }
          .nsfw-tabs-wrap {
            padding: var(--space-3) var(--space-3) 0;
          }
          .nsfw-tab {
            padding: var(--space-2) var(--space-3);
          }
          .nsfw-recs {
            padding: var(--space-2) var(--space-3) var(--space-3);
          }
          .nsfw-recs-grid {
            grid-template-columns: 1fr;
            gap: var(--space-3);
          }
          /* 移动端触控目标 ≥44px */
          .nsfw-rec-link,
          .nsfw-dl-btn,
          .nsfw-dl-retry {
            min-height: 44px;
          }
          .nsfw-dl-retry {
            display: inline-flex;
            align-items: center;
          }
        }
      `}</style>
    </div>
  );
}
