"use client";

import { useEffect, useMemo, useState } from "react";

const DEFAULT_COMFYUI_URL =
  process.env.NEXT_PUBLIC_COMFYUI_WEB_URL || "http://192.168.71.127:8188";
const STORAGE_KEY = "toiv_comfyui_web_url";
const PROBE_TIMEOUT_MS = 4000;

type Status =
  | { phase: "probing" }
  | { phase: "ready"; src: string }
  | { phase: "failed"; tried: string[]; httpsBlock: boolean };

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

export function CanvasView() {
  const [status, setStatus] = useState<Status>({ phase: "probing" });
  const [retryTick, setRetryTick] = useState(0);

  const candidates = useMemo(() => {
    if (typeof window === "undefined") return [DEFAULT_COMFYUI_URL];
    const custom = window.localStorage.getItem(STORAGE_KEY);
    const list = custom && custom !== DEFAULT_COMFYUI_URL
      ? [custom, DEFAULT_COMFYUI_URL]
      : [DEFAULT_COMFYUI_URL];
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

  const clearCustomAndRetry = () => {
    window.localStorage.removeItem(STORAGE_KEY);
    setRetryTick((t) => t + 1);
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
          src={status.src}
          title="ComfyUI"
          className="canvas-iframe"
          allow="clipboard-read; clipboard-write"
          sandbox="allow-scripts allow-same-origin allow-popups allow-forms allow-downloads allow-modals"
        />
        <style jsx>{`
          .canvas-view {
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
            <button type="button" onClick={() => setRetryTick((t) => t + 1)}>
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
