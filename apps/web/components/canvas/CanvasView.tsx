"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ErrorBar } from "@/components/ui/ErrorBar";
import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import { PageHeader } from "@/components/ui/PageHeader";

/** ComfyUI 画布地址:改地址只动这里(或设 NEXT_PUBLIC_COMFYUI_WEB_URL) */
const COMFYUI_URL =
  process.env.NEXT_PUBLIC_COMFYUI_WEB_URL || "http://192.168.71.127:8188";
const STORAGE_KEY = "toiv_comfyui_web_url";
const PROBE_TIMEOUT_MS = 4000;
/** iframe 渲染后的加载兜底时限:超时未完成加载视为失败 */
const IFRAME_LOAD_TIMEOUT_MS = 15000;
/** 用于检测静态资源服务是否正常的固定文件(与 /assets/* 同一静态处理器) */
const STATIC_PROBE_PATH = "/materialdesignicons.min.css";

type Status =
  | { phase: "probing" }
  | { phase: "ready"; src: string }
  | { phase: "failed"; tried: string[]; httpsBlock: boolean };

/** iframe 内部加载状态:onLoad 与后续探测都通过才算 loaded */
type LoadState = "loading" | "loaded" | "error";

/** no-cors 探测:任意 HTTP 响应(含 4xx)都算在线,只有网络层失败才 reject */
async function reachable(url: string): Promise<boolean> {
  try {
    await fetch(`${url.replace(/\/$/, "")}/system_stats`, {
      mode: "no-cors",
      cache: "no-store",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * 静态资源探测:跨域无法读响应状态,但 <script> 标签的 onload/onerror
 * 能区分 HTTP 成功与 4xx/网络失败,可感知 /assets/* 403 导致的 splash 卡死。
 */
function probeStaticAsset(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const el = document.createElement("script");
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      el.onload = null;
      el.onerror = null;
      el.remove();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), PROBE_TIMEOUT_MS);
    el.onload = () => done(true);
    el.onerror = () => done(false);
    el.src = `${url.replace(/\/$/, "")}${STATIC_PROBE_PATH}?probe=${Date.now()}`;
    document.head.appendChild(el);
  });
}

/**
 * 画布视图(内嵌 ComfyUI iframe)。
 * P1-2 收编记录:
 * - 页头走共享 PageHeader;失败态不再自写头部错误徽章,错误文案由页头下方 ErrorBar 承载;
 * - 服务探测(probing)加载块收编为 LoadingBlock(原自写 spinner+纯文字);
 * - 豁免:iframe 就绪遮罩(全出血剧院式加载幕布,含 spinner)与失败/混合内容全屏 fallback 卡
 *   为设计态容器,不换成 LoadingBlock/ErrorBar(同 ResultPanel 条目级徽章豁免原则)。
 */
export function CanvasView() {
  const [status, setStatus] = useState<Status>({ phase: "probing" });
  const [retryTick, setRetryTick] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [iframeKey, setIframeKey] = useState(0);
  // 页头 ErrorBar 关闭态(受控;重试时复位重新展示)
  const [headerErrClosed, setHeaderErrClosed] = useState(false);
  // 每轮加载一代:防止过期的 onLoad 探测结果覆盖新一轮状态
  const loadGenRef = useRef(0);

  const candidates = useMemo(() => {
    if (typeof window === "undefined") return [COMFYUI_URL];
    const custom = window.localStorage.getItem(STORAGE_KEY);
    const list = custom && custom !== COMFYUI_URL
      ? [custom, COMFYUI_URL]
      : [COMFYUI_URL];
    return list;
  }, [retryTick]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setStatus({ phase: "probing" });
    const httpsBlock =
      window.location.protocol === "https:" &&
      candidates.every((u) => u.startsWith("http://"));
    (async () => {
      const tried: string[] = [];
      for (const url of candidates) {
        tried.push(url);
        if (await reachable(url)) {
          if (!cancelled) setStatus({ phase: "ready", src: url });
          return;
        }
      }
      if (!cancelled) setStatus({ phase: "failed", tried, httpsBlock });
    })();
    return () => {
      cancelled = true;
    };
  }, [candidates]);

  // 进入 ready 后开启新一轮加载:重置状态,并启动兜底计时(超时 → 错误态)
  useEffect(() => {
    if (status.phase !== "ready") return;
    loadGenRef.current += 1;
    setLoadState("loading");
  }, [status]);

  useEffect(() => {
    if (status.phase !== "ready" || loadState !== "loading") return;
    const gen = loadGenRef.current;
    const timer = setTimeout(() => {
      if (loadGenRef.current === gen) setLoadState("error");
    }, IFRAME_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [status, loadState, iframeKey]);

  /** iframe onLoad 后再探测一次:服务在线且静态资源正常才解除遮罩 */
  const handleIframeLoad = useCallback(() => {
    if (status.phase !== "ready") return;
    const src = status.src;
    const gen = loadGenRef.current;
    (async () => {
      const [serviceOk, staticOk] = await Promise.all([
        reachable(src),
        probeStaticAsset(src),
      ]);
      if (loadGenRef.current === gen) {
        setLoadState(serviceOk && staticOk ? "loaded" : "error");
      }
    })();
  }, [status]);

  const retry = () => {
    loadGenRef.current += 1;
    setLoadState("loading");
    setIframeKey((k) => k + 1);
    setRetryTick((t) => t + 1);
    setHeaderErrClosed(false);
  };

  const clearCustomAndRetry = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    retry();
  };

  /** 统一页头(共享 PageHeader):大标题 + 辅助描述 + 右侧状态徽章/操作区;
      失败态错误文案不入头部徽章,由页头下方 ErrorBar 承载(P1-2) */
  const renderHeader = (phase: "probing" | "ready" | "failed", src?: string) => (
    <PageHeader
      className="canvas-header"
      title="画布"
      desc="内嵌 ComfyUI 节点画布,拖拽编排与调试生成工作流"
      actions={
        phase === "ready" && src ? (
          <>
            <span className="canvas-status canvas-status--ok" title={src}>
              <span className="canvas-status-dot" aria-hidden="true" />
              已连接 · {src.replace(/^https?:\/\//, "")}
            </span>
            <a
              className="canvas-open-external"
              href={src}
              target="_blank"
              rel="noreferrer"
            >
              新窗口打开
            </a>
          </>
        ) : phase === "probing" ? (
          <span className="canvas-status">
            <span className="canvas-status-dot" aria-hidden="true" />
            正在连接…
          </span>
        ) : undefined
      }
    />
  );

  /** 页头下方错误条(P1-2:原头部自写错误徽章收编为共享 ErrorBar,可关闭,重试复位)。 */
  const renderHeaderError = (message: string) => (
    <div className="canvas-header-error">
      <ErrorBar message={headerErrClosed ? null : message} onClose={() => setHeaderErrClosed(true)} />
    </div>
  );

  if (status.phase === "ready") {
    const httpsBlock =
      typeof window !== "undefined" &&
      window.location.protocol === "https:" &&
      status.src.startsWith("http://");
    if (httpsBlock) {
      // HTTPS 页面嵌 HTTP iframe 会被浏览器混合内容拦截,直接给指引而不是白屏
      return (
        <div className="canvas-view">
          {renderHeader("failed")}
          {renderHeaderError("当前页面为 HTTPS,浏览器已拦截 HTTP 画布(混合内容),请改用局域网 HTTP 访问")}
          <div className="canvas-stage canvas-stage--center">
            <div className="canvas-fallback">
              <div className="canvas-fallback-badge canvas-fallback-badge--warn">
                <svg
                  className="canvas-fallback-icon"
                  viewBox="0 0 24 24"
                  fill="none"
                  aria-hidden="true"
                >
                  <path
                    d="M12 3 2.5 20h19L12 3Z"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinejoin="round"
                  />
                  <path
                    d="M12 9.5v4.5"
                    stroke="currentColor"
                    strokeWidth="1.6"
                    strokeLinecap="round"
                  />
                  <circle cx="12" cy="16.8" r="0.9" fill="currentColor" />
                </svg>
              </div>
              <h2>画布需要通过局域网 HTTP 访问</h2>
              <p>
                当前页面为 HTTPS,浏览器会拦截 HTTP 的 ComfyUI
                页面(混合内容)。请改用局域网地址访问:
              </p>
              <p className="canvas-fallback-url">http://192.168.71.47:3100/?view=canvas</p>
            </div>
          </div>
          <style jsx>{styles}</style>
        </div>
      );
    }
    return (
      <div className="canvas-view">
        {renderHeader("ready", status.src)}
        {/* 移动端兜底:画布为桌面导向,窄屏给提示条而非硬渲染不可用料 */}
        <div className="canvas-mobile-note" role="status">
          <Icon name="info" size={14} />
          画布建议桌面端操作,移动端仅支持预览
        </div>
        <div className="canvas-stage">
          <div className="canvas-frame">
            <iframe
              key={iframeKey}
              src={status.src}
              title="ComfyUI"
              className="canvas-iframe"
              onLoad={handleIframeLoad}
              allow="clipboard-read; clipboard-write"
              sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads allow-modals"
            />
            {loadState === "error" ? (
              <div className="canvas-load-overlay">
                <div className="canvas-error-card">
                  <div className="canvas-error-badge">
                    <svg
                      className="canvas-error-icon"
                      viewBox="0 0 24 24"
                      fill="none"
                      aria-hidden="true"
                    >
                      <path
                        d="M12 3 2.5 20h19L12 3Z"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinejoin="round"
                      />
                      <path
                        d="M12 9.5v4.5"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        strokeLinecap="round"
                      />
                      <circle cx="12" cy="16.8" r="0.9" fill="currentColor" />
                    </svg>
                  </div>
                  <h2>画布服务加载失败</h2>
                  <p>
                    ComfyUI 页面资源加载异常,可能是静态资源被拦截或服务正在重启。
                    请确认画布服务状态后重试。
                  </p>
                  <button type="button" className="canvas-error-retry" onClick={retry}>
                    重试
                  </button>
                </div>
              </div>
            ) : (
              <div
                className={`canvas-load-overlay${
                  loadState === "loaded" ? " canvas-load-overlay--hidden" : ""
                }`}
              >
                <div className="canvas-spinner" aria-hidden="true" />
                <p className="canvas-load-title">正在进入画布</p>
                <p className="canvas-load-text">
                  ComfyUI 页面资源加载中,首次进入可能需要几秒钟
                </p>
              </div>
            )}
          </div>
        </div>
        <style jsx>{styles}</style>
      </div>
    );
  }

  return (
    <div className="canvas-view">
      {renderHeader(status.phase === "probing" ? "probing" : "failed")}
      {status.phase === "failed" &&
        renderHeaderError("ComfyUI 连接失败:以下地址均未连通,请确认画布服务状态后重试")}
      <div className="canvas-stage canvas-stage--center">
        {status.phase === "probing" ? (
          <div className="canvas-fallback canvas-fallback--plain">
            {/* P1-2 收编:探测加载块走共享 LoadingBlock(原自写 spinner+纯文字) */}
            <div className="canvas-probe-loading">
              <LoadingBlock variant="line" count={2} />
            </div>
            <p className="canvas-load-title">正在连接 ComfyUI</p>
            <p className="canvas-fallback-dim">正在探测画布服务地址…</p>
          </div>
        ) : (
          <div className="canvas-fallback">
            <div className="canvas-fallback-badge">
              <svg
                className="canvas-fallback-icon"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M12 3 2.5 20h19L12 3Z"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinejoin="round"
                />
                <path
                  d="M12 9.5v4.5"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
                <circle cx="12" cy="16.8" r="0.9" fill="currentColor" />
              </svg>
            </div>
            <h2>ComfyUI 连接失败</h2>
            <p className="canvas-fallback-label">以下地址均未连通:</p>
            <ul>
              {status.tried.map((u) => (
                <li key={u}>
                  <code>{u}</code>
                </li>
              ))}
            </ul>
            {status.httpsBlock && (
              <p className="canvas-fallback-note">
                注意:当前页面为 HTTPS,HTTP 的 ComfyUI 会被浏览器混合内容拦截,请改用局域网
                HTTP 访问。
              </p>
            )}
            <div className="canvas-fallback-actions">
              <button
                type="button"
                className="canvas-fallback-primary"
                onClick={retry}
              >
                重试
              </button>
              <button type="button" onClick={clearCustomAndRetry}>
                清除自定义地址并重试
              </button>
            </div>
          </div>
        )}
      </div>
      <style jsx>{styles}</style>
    </div>
  );
}

const styles = `
  /* ── 视图骨架:页头 + 画布舞台(纵向 flex,iframe 不再铺满全屏) ── */
  .canvas-view {
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg-canvas);
    display: flex;
    flex-direction: column;
  }
  .canvas-header {
    flex: none;
  }
  /* 页头下方错误条容器(P1-2,ErrorBar 本体样式见 effects.css) */
  .canvas-header-error {
    flex: none;
    margin: calc(-1 * var(--space-2)) var(--space-6) var(--space-4);
  }
  /* 探测加载块(P1-2,LoadingBlock 骨架行宽约束) */
  .canvas-probe-loading {
    width: min(340px, 72vw);
  }

  /* ── 移动端兜底提示条(默认隐藏,≤767px 显示) ── */
  .canvas-mobile-note {
    display: none;
  }

  /* ── 画布舞台:四周留白,iframe 收进圆角面板(卡片化) ── */
  .canvas-stage {
    flex: 1;
    min-height: 0;
    position: relative;
    padding: 0 var(--space-6) var(--space-6);
  }
  .canvas-stage--center {
    overflow: auto;
    display: flex;
    padding: var(--space-6);
  }
  .canvas-frame {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
    background: var(--bg-surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-panel);
    box-shadow: var(--shadow-md);
  }
  .canvas-iframe {
    width: 100%;
    height: 100%;
    border: none;
    display: block;
    background: var(--bg-canvas);
  }

  /* ── 页头右侧:连接状态徽章 + 新窗口打开 ── */
  .canvas-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    max-width: 280px;
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-full);
    background: var(--bg-surface-2);
    color: var(--text-secondary);
    font-size: var(--text-aux);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .canvas-status-dot {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: var(--radius-full);
    background: var(--text-muted);
  }
  .canvas-status--ok {
    background: var(--ok-soft);
    color: var(--ok);
  }
  .canvas-status--ok .canvas-status-dot {
    background: var(--ok);
  }
  .canvas-status--err {
    background: var(--err-soft);
    color: var(--err);
  }
  .canvas-status--err .canvas-status-dot {
    background: var(--err);
  }
  .canvas-open-external {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-height: 36px;
    padding: var(--space-1) var(--space-4);
    border-radius: var(--radius-control);
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface-1);
    color: var(--text-primary);
    font-size: var(--text-body);
    font-weight: var(--font-medium);
    text-decoration: none;
    cursor: pointer;
    transition:
      border-color var(--duration-fast) var(--ease-standard),
      background var(--duration-fast) var(--ease-standard);
  }
  .canvas-open-external:hover {
    border-color: var(--accent);
    background: var(--accent-soft);
  }
  .canvas-open-external:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ── 加载遮罩:标题/辅助两层文案,层级拉开 ── */
  .canvas-load-overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: color-mix(in srgb, var(--bg-canvas) 88%, transparent);
    opacity: 1;
    transition: opacity var(--duration-slow) ease;
    z-index: 1;
  }
  .canvas-load-overlay--hidden {
    opacity: 0;
    pointer-events: none;
  }
  .canvas-spinner {
    width: 44px;
    height: 44px;
    border-radius: var(--radius-full);
    border: 3px solid var(--border-subtle);
    border-top-color: var(--accent);
    animation: canvas-spin var(--duration-loop) linear infinite;
  }
  .canvas-load-title {
    margin: var(--space-2) 0 0;
    font-size: var(--text-section);
    font-weight: var(--font-semibold);
    color: var(--text-primary);
  }
  .canvas-load-text {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-aux);
  }

  /* ── 错误/失败卡片:大留白 + 图标徽章 + hover 升浮 ── */
  .canvas-error-card {
    max-width: 440px;
    margin: 0 var(--space-4);
    padding: var(--space-10);
    display: flex;
    flex-direction: column;
    align-items: center;
    text-align: center;
    background: var(--bg-surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-panel);
    box-shadow: var(--shadow-pop);
    transition:
      transform var(--duration-base) var(--ease-standard),
      box-shadow var(--duration-base) var(--ease-standard);
  }
  .canvas-error-card:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-lift);
  }
  .canvas-error-badge {
    width: 64px;
    height: 64px;
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--err-soft);
    color: var(--err);
    margin-bottom: var(--space-5);
  }
  .canvas-error-icon {
    width: 28px;
    height: 28px;
  }
  .canvas-error-card h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-title);
    font-weight: var(--font-bold);
    color: var(--text-primary);
  }
  .canvas-error-card p {
    margin: 0 0 var(--space-6);
    color: var(--text-secondary);
    font-size: var(--text-body);
    line-height: var(--leading-md);
  }
  .canvas-error-retry {
    min-height: 44px;
    padding: var(--space-2) var(--space-8);
    border-radius: var(--radius-control);
    border: none;
    background: var(--accent);
    color: var(--text-on-accent);
    cursor: pointer;
    font-size: var(--text-body);
    font-weight: var(--font-medium);
    transition: background var(--duration-fast) var(--ease-standard);
  }
  .canvas-error-retry:hover {
    background: var(--accent-hover);
  }
  .canvas-error-retry:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }

  /* ── 兜底卡片(连接失败/混合内容指引):margin:auto 配合 flex 居中,内容高于视口时顶部不被裁切 ── */
  .canvas-fallback {
    margin: auto;
    width: 100%;
    max-width: 520px;
    padding: var(--space-10);
    color: var(--text-primary);
    text-align: center;
    background: var(--bg-surface-1);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-panel);
    box-shadow: var(--shadow-md);
    transition:
      transform var(--duration-base) var(--ease-standard),
      box-shadow var(--duration-base) var(--ease-standard);
  }
  .canvas-fallback:hover {
    transform: translateY(-2px);
    box-shadow: var(--shadow-lift);
  }
  .canvas-fallback--plain {
    width: auto;
    padding: 0;
    background: transparent;
    border: none;
    box-shadow: none;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }
  .canvas-fallback--plain:hover {
    transform: none;
    box-shadow: none;
  }
  .canvas-fallback-badge {
    width: 64px;
    height: 64px;
    border-radius: var(--radius-full);
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0 auto var(--space-5);
    background: var(--err-soft);
    color: var(--err);
  }
  .canvas-fallback-badge--warn {
    background: var(--warn-soft);
    color: var(--warn);
  }
  .canvas-fallback-icon {
    width: 28px;
    height: 28px;
  }
  .canvas-fallback h2 {
    margin: 0 0 var(--space-3);
    font-size: var(--text-title);
    font-weight: var(--font-bold);
  }
  .canvas-fallback p {
    margin: 0 0 var(--space-3);
    color: var(--text-secondary);
    font-size: var(--text-body);
    line-height: var(--leading-md);
  }
  .canvas-fallback-label {
    font-size: var(--text-aux);
    color: var(--text-muted);
  }
  .canvas-fallback ul {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-4);
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .canvas-fallback li code {
    display: block;
    max-width: 100%;
    padding: var(--space-2) var(--space-3);
    text-align: left;
    background: var(--bg-surface-2);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-control);
    color: var(--text-muted);
    font-size: var(--text-aux);
    line-height: var(--leading-md);
    word-break: break-all;
  }
  .canvas-fallback-url {
    display: inline-block;
    max-width: 100%;
    padding: var(--space-2) var(--space-3);
    background: var(--accent-soft);
    border-radius: var(--radius-control);
    color: var(--accent);
    font-weight: var(--font-semibold);
    word-break: break-all;
  }
  .canvas-fallback-note {
    padding: var(--space-3);
    background: var(--warn-soft);
    border-radius: var(--radius-control);
    color: var(--warn);
    font-size: var(--text-aux);
  }
  .canvas-fallback-dim {
    margin: 0;
    color: var(--text-muted);
    font-size: var(--text-aux);
  }
  .canvas-fallback-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    justify-content: center;
    margin-top: var(--space-5);
  }
  .canvas-fallback-actions button {
    min-height: 44px;
    padding: var(--space-2) var(--space-5);
    border-radius: var(--radius-control);
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface-2);
    color: var(--text-primary);
    cursor: pointer;
    font-size: var(--text-body);
    font-weight: var(--font-medium);
    transition:
      background var(--duration-fast) var(--ease-standard),
      border-color var(--duration-fast) var(--ease-standard);
  }
  .canvas-fallback-actions button:hover {
    border-color: var(--accent);
  }
  .canvas-fallback-actions button:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: 2px;
  }
  .canvas-fallback-actions .canvas-fallback-primary {
    border-color: transparent;
    background: var(--accent);
    color: var(--text-on-accent);
  }
  .canvas-fallback-actions .canvas-fallback-primary:hover {
    border-color: transparent;
    background: var(--accent-hover);
  }

  /* ── <1024px:舞台留白收敛 ── */
  @media (max-width: 1023px) {
    .canvas-stage {
      padding: 0 var(--space-4) var(--space-4);
    }
    .canvas-stage--center {
      padding: var(--space-4);
    }
  }
  /* ── <768px:隐藏页头描述给画布让位;触控目标 ≥44px;显示移动端提示条 ── */
  @media (max-width: 767px) {
    .canvas-header :global(.page-header-desc) {
      display: none;
    }
    .canvas-header-error {
      margin: calc(-1 * var(--space-2)) var(--space-4) var(--space-3);
    }
    .canvas-mobile-note {
      display: flex;
      align-items: center;
      gap: var(--space-2);
      margin: 0 var(--space-4) var(--space-3);
      padding: var(--space-2) var(--space-3);
      background: var(--warn-soft);
      color: var(--warn);
      border: 1px solid var(--border-subtle);
      border-radius: var(--radius-control);
      font-size: var(--text-aux);
    }
    .canvas-stage {
      padding: 0 var(--space-3) var(--space-3);
    }
    .canvas-stage--center {
      padding: var(--space-3);
    }
    .canvas-open-external {
      min-height: 44px;
    }
    .canvas-error-card,
    .canvas-fallback {
      padding: var(--space-6);
    }
    .canvas-fallback-actions {
      flex-direction: column;
    }
    .canvas-fallback-actions button {
      width: 100%;
    }
  }
  @keyframes canvas-spin {
    to {
      transform: rotate(360deg);
    }
  }
`;
