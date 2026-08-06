"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

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

export function CanvasView() {
  const [status, setStatus] = useState<Status>({ phase: "probing" });
  const [retryTick, setRetryTick] = useState(0);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [iframeKey, setIframeKey] = useState(0);
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
  };

  const clearCustomAndRetry = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    retry();
  };

  if (status.phase === "ready") {
    const httpsBlock =
      typeof window !== "undefined" &&
      window.location.protocol === "https:" &&
      status.src.startsWith("http://");
    if (httpsBlock) {
      // HTTPS 页面嵌 HTTP iframe 会被浏览器混合内容拦截,直接给指引而不是白屏
      return (
        <div className="canvas-view">
          <div className="canvas-fallback">
            <h2>画布需要通过局域网 HTTP 访问</h2>
            <p>
              当前页面为 HTTPS,浏览器会拦截 HTTP 的 ComfyUI
              页面(混合内容)。请改用局域网地址访问:
            </p>
            <p className="canvas-fallback-url">http://192.168.71.47:3100/?view=canvas</p>
          </div>
          <style jsx>{fallbackStyles}</style>
        </div>
      );
    }
    return (
      <div className="canvas-view">
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
            <p className="canvas-load-text">画布加载中…</p>
          </div>
        )}
        <style jsx>{`
          .canvas-view {
            position: relative;
            width: 100%;
            height: 100%;
            overflow: hidden;
            background: var(--bg-canvas);
          }
          .canvas-iframe {
            width: 100%;
            height: 100%;
            border: none;
            display: block;
            background: var(--bg-canvas);
          }
          .canvas-load-overlay {
            position: absolute;
            inset: 0;
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            gap: var(--space-4);
            background: color-mix(in srgb, var(--bg-canvas) 88%, transparent);
            opacity: 1;
            transition: opacity 0.4s ease;
            z-index: 1;
          }
          .canvas-load-overlay--hidden {
            opacity: 0;
            pointer-events: none;
          }
          .canvas-spinner {
            width: 32px;
            height: 32px;
            border-radius: var(--radius-full);
            border: 3px solid var(--border-subtle);
            border-top-color: var(--accent);
            animation: canvas-spin 0.9s linear infinite;
          }
          .canvas-load-text {
            color: var(--text-secondary);
            font-size: var(--text-body);
          }
          .canvas-error-card {
            max-width: 420px;
            padding: var(--space-8);
            display: flex;
            flex-direction: column;
            align-items: center;
            text-align: center;
            background: var(--bg-surface-1);
            border: 1px solid var(--border-subtle);
            border-radius: var(--radius-panel);
          }
          .canvas-error-icon {
            width: 40px;
            height: 40px;
            color: var(--err);
            margin-bottom: var(--space-4);
          }
          .canvas-error-card h2 {
            font-size: var(--text-title);
            color: var(--text-primary);
            margin-bottom: var(--space-3);
          }
          .canvas-error-card p {
            color: var(--text-secondary);
            font-size: var(--text-body);
            line-height: var(--leading-md);
            margin-bottom: var(--space-5);
          }
          .canvas-error-retry {
            padding: var(--space-2) var(--space-6);
            border-radius: var(--radius-control);
            border: none;
            background: var(--accent);
            color: var(--text-on-accent);
            cursor: pointer;
            font-size: var(--text-body);
          }
          .canvas-error-retry:hover {
            background: var(--accent-hover);
          }
          @keyframes canvas-spin {
            to {
              transform: rotate(360deg);
            }
          }
        `}</style>
      </div>
    );
  }

  return (
    <div className="canvas-view">
      {status.phase === "probing" ? (
        <div className="canvas-fallback">
          <p className="canvas-fallback-dim">正在连接 ComfyUI …</p>
        </div>
      ) : (
        <div className="canvas-fallback">
          <h2>ComfyUI 连接失败</h2>
          <p>以下地址均未连通:</p>
          <ul>
            {status.tried.map((u) => (
              <li key={u}>
                <code>{u}</code>
              </li>
            ))}
          </ul>
          {status.httpsBlock && (
            <p>
              注意:当前页面为 HTTPS,HTTP 的 ComfyUI 会被浏览器混合内容拦截,请改用局域网
              HTTP 访问。
            </p>
          )}
          <div className="canvas-fallback-actions">
            <button type="button" onClick={retry}>
              重试
            </button>
            <button type="button" onClick={clearCustomAndRetry}>
              清除自定义地址并重试
            </button>
          </div>
        </div>
      )}
      <style jsx>{fallbackStyles}</style>
    </div>
  );
}

const fallbackStyles = `
  .canvas-view {
    width: 100%;
    height: 100%;
    overflow: auto;
    background: var(--bg-canvas);
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .canvas-fallback {
    max-width: 520px;
    padding: var(--space-6);
    color: var(--text-primary);
    text-align: center;
  }
  .canvas-fallback h2 {
    font-size: var(--text-title);
    margin-bottom: var(--space-3);
  }
  .canvas-fallback p {
    color: var(--text-secondary);
    font-size: var(--text-body);
    line-height: var(--leading-md);
    margin-bottom: var(--space-3);
  }
  .canvas-fallback ul {
    list-style: none;
    padding: 0;
    margin: 0 0 var(--space-3);
    color: var(--text-muted);
    font-size: var(--text-aux);
  }
  .canvas-fallback-url {
    color: var(--accent);
    font-weight: 600;
  }
  .canvas-fallback-dim {
    color: var(--text-muted);
  }
  .canvas-fallback-actions {
    display: flex;
    gap: var(--space-3);
    justify-content: center;
    margin-top: var(--space-4);
  }
  .canvas-fallback-actions button {
    padding: var(--space-2) var(--space-4);
    border-radius: var(--radius-control);
    border: 1px solid var(--border-subtle);
    background: var(--bg-surface-2);
    color: var(--text-primary);
    cursor: pointer;
    font-size: var(--text-body);
  }
  .canvas-fallback-actions button:hover {
    border-color: var(--accent);
  }
`;
