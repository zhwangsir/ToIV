"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import {
  type DeployResult,
  type WorkflowTemplate,
  deployWorkflowTemplate,
  listWorkflowTemplates,
} from "@/lib/workflows";

// ComfyUI 第一个 worker 地址(支持环境变量覆盖;兜底 localhost 避免泄露内网拓扑)
const COMFYUI_URL = process.env.NEXT_PUBLIC_COMFYUI_URL ?? "http://127.0.0.1:8188";

// 加载阶段阈值:15s 提示加载缓慢(非错误);25s 判定超时失败
// 之所以分两档,是因为 ComfyUI 首次启动需要加载模型,15s 内白屏属正常,
// 但超过 15s 应给用户心理预期,超过 25s 才视为真失败
const LOAD_SLOW_MS = 15_000;
const LOAD_TIMEOUT_MS = 25_000;
// iframe onError 自动重连最大次数:超过则停止自动重试,改由用户介入
// 限制次数是为了避免 worker 宕机时无限重连浪费资源
const MAX_RETRIES = 3;

// 错误文案集中管理,便于后续国际化或统一调整
const ERR_TIMEOUT = "连接超时,请检查 Worker 是否在线或网络是否通畅";
const ERR_OFFLINE = "网络已断开,无法连接到 ComfyUI Worker,网络恢复后将自动重连";
const ERR_RETRY_EXHAUSTED =
  "已连续重试 3 次仍无法连接,请刷新页面或检查 ComfyUI Worker 状态";

export function CanvasView() {
  // iframe 加载状态
  const [loading, setLoading] = useState(true);
  // 加载耗时(展示友好提示,帮助用户判断 worker 性能)
  const [loadMs, setLoadMs] = useState<number | null>(null);
  // 加载缓慢提示(15s 未完成 → 非错误,仅提示)
  const [slowLoad, setSlowLoad] = useState(false);
  // 错误信息(null 表示无错误;非 null 时展示错误卡片)
  const [error, setError] = useState<string | null>(null);
  // 自动重连次数(展示在副标题,让用户知道在重试)
  const [retryCount, setRetryCount] = useState(0);
  // 浏览器离线状态(offline 事件触发,优先级高于 loading/error)
  const [isOffline, setIsOffline] = useState(false);
  // 用于强制刷新 iframe(改变 src key 触发重载,比直接改 src 更可靠)
  const [reloadKey, setReloadKey] = useState(0);
  // 当前 iframe 加载的基准 URL:默认首页,部署模板后切换到模板 load_url
  const [activeUrl, setActiveUrl] = useState(COMFYUI_URL);
  // 工作流模板库
  const [templates, setTemplates] = useState<WorkflowTemplate[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [deployingId, setDeployingId] = useState<string | null>(null);
  const [deployedInfo, setDeployedInfo] = useState<DeployResult | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  const loadStartRef = useRef<number | null>(null);
  const slowTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // 自动重连计数器:用 ref 而非 state,避免连续 onError 时 setState 异步导致计数失真
  const autoRetryRef = useRef(0);
  // 记录上一次离线状态,用于网络恢复时触发自动重连
  const prevOfflineRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (slowTimerRef.current) {
      clearTimeout(slowTimerRef.current);
      slowTimerRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startLoad = useCallback(() => {
    setLoading(true);
    setSlowLoad(false);
    setError(null);
    setLoadMs(null);
    loadStartRef.current = performance.now();
    clearTimers();
    // 15s 仍未加载完成 → 提示加载缓慢(不报错,给用户心理预期)
    slowTimerRef.current = setTimeout(() => setSlowLoad(true), LOAD_SLOW_MS);
    // 25s 仍未加载完成 → 判定超时错误(展示错误卡片)
    timeoutRef.current = setTimeout(() => {
      setError(ERR_TIMEOUT);
      setLoading(false);
    }, LOAD_TIMEOUT_MS);
  }, [clearTimers]);

  // 安全地向 iframe 发送 postMessage:跨域 / iframe 已销毁 / targetOrigin 不匹配
  // 等情况会抛错,用 try/catch 兜底,避免单条消息失败影响整个组件渲染
  const safePostMessage = useCallback(
    (iframe: HTMLIFrameElement | null, message: unknown, targetOrigin: string) => {
      if (!iframe?.contentWindow) return;
      try {
        iframe.contentWindow.postMessage(message, targetOrigin);
      } catch (err) {
        // 跨域或 iframe 已销毁 → 静默降级,不阻塞主流程
        console.warn("[CanvasView] postMessage 失败:", err);
      }
    },
    []
  );

  const handleLoaded = useCallback(
    (e: React.SyntheticEvent<HTMLIFrameElement>) => {
      if (loadStartRef.current != null) {
        setLoadMs(Math.round(performance.now() - loadStartRef.current));
      }
      setLoading(false);
      setSlowLoad(false);
      setError(null);
      // 成功加载 → 重置自动重连计数,后续失败重新计数
      autoRetryRef.current = 0;
      setRetryCount(0);
      clearTimers();
      // 加载完成后向 ComfyUI 同步主题信息(若 ComfyUI 不识别则忽略,不影响主流程)
      // 这是 postMessage 错误恢复模式的实际使用场景
      safePostMessage(
        e.currentTarget,
        { type: "toiv:theme", theme: "indigo-atelier" },
        COMFYUI_URL
      );
    },
    [clearTimers, safePostMessage]
  );

  // iframe 加载失败(浏览器层面,如同源拒绝 / 连接被重置)→ 自动重连
  // 注意:跨域 iframe 的 onError 不一定可靠,25s 超时是最终兜底
  const handleIframeError = useCallback(() => {
    autoRetryRef.current += 1;
    setRetryCount(autoRetryRef.current);
    if (autoRetryRef.current > MAX_RETRIES) {
      setError(ERR_RETRY_EXHAUSTED);
      setLoading(false);
      setSlowLoad(false);
      clearTimers();
      return;
    }
    // 自动重连:递增 reloadKey 触发 iframe 重载,并重启加载计时
    setReloadKey((k) => k + 1);
    startLoad();
  }, [clearTimers, startLoad]);

  // 用户手动点击"重连 / 重试"按钮:重置自动计数,给用户重新尝试的空间
  const handleManualReconnect = useCallback(() => {
    autoRetryRef.current = 0;
    setRetryCount(0);
    setError(null);
    setReloadKey((k) => k + 1);
    startLoad();
  }, [startLoad]);

  // 工具栏"刷新"按钮:与手动重连等价,但语义上是主动刷新而非故障恢复
  const handleRefresh = useCallback(() => {
    autoRetryRef.current = 0;
    setRetryCount(0);
    setReloadKey((k) => k + 1);
    startLoad();
  }, [startLoad]);

  const handleOpenExternal = useCallback(() => {
    if (typeof window !== "undefined") {
      window.open(activeUrl, "_blank", "noopener,noreferrer");
    }
  }, [activeUrl]);

  // 加载模板列表
  const loadTemplates = useCallback(async () => {
    setTemplatesLoading(true);
    setTemplatesError(null);
    try {
      const items = await listWorkflowTemplates();
      setTemplates(items);
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "加载失败");
    } finally {
      setTemplatesLoading(false);
    }
  }, []);

  // 点击模板:部署到 ComfyUI worker,然后让 iframe 加载该工作流
  const handleDeployTemplate = useCallback(async (template: WorkflowTemplate) => {
    setDeployingId(template.id);
    setDeployedInfo(null);
    try {
      const result = await deployWorkflowTemplate(template.id);
      setDeployedInfo(result);
      // 切换 iframe 到工作流加载 URL 并触发重载
      setActiveUrl(result.load_url);
      setReloadKey((k) => k + 1);
      startLoad();
    } catch (err) {
      setTemplatesError(err instanceof Error ? err.message : "部署失败");
    } finally {
      setDeployingId(null);
    }
  }, [startLoad]);

  // 回到 ComfyUI 首页
  const handleResetHome = useCallback(() => {
    setActiveUrl(COMFYUI_URL);
    setDeployedInfo(null);
    setReloadKey((k) => k + 1);
    startLoad();
  }, [startLoad]);

  // 挂载时启动首次加载计时,并监听浏览器在线/离线
  useEffect(() => {
    startLoad();
    loadTemplates();
    // 监听网络状态:断网时直接展示离线遮罩,避免长时间白屏等待超时
    const onOffline = () => setIsOffline(true);
    const onOnline = () => setIsOffline(false);
    if (typeof window !== "undefined") {
      window.addEventListener("offline", onOffline);
      window.addEventListener("online", onOnline);
      // 初始化:若挂载时已离线(如 PWA 离线启动),直接进入离线态
      setIsOffline(!navigator.onLine);
    }
    return () => {
      clearTimers();
      if (typeof window !== "undefined") {
        window.removeEventListener("offline", onOffline);
        window.removeEventListener("online", onOnline);
      }
    };
  }, [startLoad, clearTimers, loadTemplates]);

  // 网络从离线恢复到在线 → 主动重载 iframe(否则 iframe 会停留在失败态)
  useEffect(() => {
    if (prevOfflineRef.current && !isOffline) {
      setReloadKey((k) => k + 1);
      startLoad();
    }
    prevOfflineRef.current = isOffline;
  }, [isOffline, startLoad]);

  // 完整 iframe src(带 reloadKey 作为查询参数,确保 src 变化触发重载)
  const iframeSrc = useMemo(() => {
    const sep = activeUrl.includes("?") ? "&" : "?";
    return reloadKey > 0 ? `${activeUrl}${sep}_r=${reloadKey}` : activeUrl;
  }, [reloadKey, activeUrl]);

  // 端点 host:从 activeUrl 动态派生,避免与变量不同步(解析失败回退原 URL)
  const endpointHost = useMemo(() => {
    try {
      return new URL(activeUrl).origin;
    } catch {
      return activeUrl;
    }
  }, [activeUrl]);

  // 渲染优先级:离线 > 错误 > 加载中 > 就绪
  // 离线是根因,优先展示;错误次之;加载中再次;就绪展示 iframe
  const showOffline = isOffline;
  const showError = !showOffline && error != null;
  const showLoading = !showOffline && !showError && loading;

  return (
    <div className={`single-view canvas-view ${sidebarOpen ? "" : "cv-sidebar-closed"}`}>
      {/* ── 侧边栏:工作流模板库 ── */}
      <aside className="cv-sidebar">
        <div className="cv-sidebar-header">
          <h2 className="cv-sidebar-title">
            <Icon name="library" size={16} strokeWidth={1.8} />
            工作流模板
          </h2>
          <button
            type="button"
            className="cv-sidebar-close"
            onClick={() => setSidebarOpen(false)}
            title="收起模板库"
            aria-label="收起模板库"
          >
            <Icon name="close" size={14} strokeWidth={1.8} />
          </button>
        </div>
        <div className="cv-sidebar-body">
          {templatesLoading && (
            <div className="cv-sidebar-empty">
              <Icon name="loading" size={20} strokeWidth={2} className="cv-spin" />
              <span>加载模板中…</span>
            </div>
          )}
          {templatesError && !templatesLoading && (
            <div className="cv-sidebar-empty cv-sidebar-error">
              <Icon name="error" size={20} strokeWidth={1.8} />
              <span>{templatesError}</span>
              <button type="button" className="btn btn-sm cv-btn" onClick={loadTemplates}>
                重试
              </button>
            </div>
          )}
          {!templatesLoading && !templatesError && templates.length === 0 && (
            <div className="cv-sidebar-empty">暂无可用模板</div>
          )}
          {!templatesLoading &&
            templates.map((t) => (
              <div key={t.id} className="cv-template-card">
                <div className="cv-template-header">
                  <span className="cv-template-name" title={t.name}>
                    {t.name}
                  </span>
                  <span className="cv-template-nodes">{t.node_count} 节点</span>
                </div>
                <div className="cv-template-tags">
                  {t.tags.map((tag) => (
                    <span key={tag} className="cv-template-tag">
                      {tag}
                    </span>
                  ))}
                </div>
                <p className="cv-template-desc" title={t.description}>
                  {t.description}
                </p>
                <button
                  type="button"
                  className="btn btn-sm cv-btn cv-btn-primary cv-template-load"
                  onClick={() => handleDeployTemplate(t)}
                  disabled={deployingId === t.id || loading}
                  title="部署并加载到 ComfyUI"
                >
                  {deployingId === t.id ? (
                    <>
                      <Icon name="loading" size={12} strokeWidth={2} className="cv-spin" />
                      <span>部署中…</span>
                    </>
                  ) : (
                    <>
                      <Icon name="playing" size={12} strokeWidth={1.8} />
                      <span>在 ComfyUI 打开</span>
                    </>
                  )}
                </button>
              </div>
            ))}
        </div>
      </aside>

      {/* 侧边栏收起时显示的展开按钮 */}
      {!sidebarOpen && (
        <button
          type="button"
          className="cv-sidebar-fab"
          onClick={() => setSidebarOpen(true)}
          title="展开工作流模板库"
          aria-label="展开工作流模板库"
        >
          <Icon name="library" size={16} strokeWidth={1.8} />
        </button>
      )}

      {/* ── 主区域 ── */}
      <div className="cv-main">
        {/* ── 顶部:标题 + 工具栏 ── */}
        <header className="cv-header">
          <div className="cv-titles">
            <h1 className="cv-title">
              <span className="cv-title-mark" aria-hidden="true">
                <Icon name="canvas" size={18} strokeWidth={1.8} />
              </span>
              ComfyUI
            </h1>
            <span className="cv-subtitle">
              节点工作流编辑器 · Worker #1
              {retryCount > 0 && !showError && (
                <span className="cv-retry-badge" aria-live="polite">
                  重连中 #{retryCount}
                </span>
              )}
              {deployedInfo && !showError && (
                <span className="cv-workflow-badge" aria-live="polite">
                  {deployedInfo.workflow_name}
                </span>
              )}
            </span>
          </div>

          <div className="cv-toolbar">
            {deployedInfo && (
              <button
                type="button"
                className="btn btn-sm cv-btn"
                onClick={handleResetHome}
                title="返回 ComfyUI 首页"
              >
                <Icon name="refresh" size={14} strokeWidth={1.9} />
                <span>回首页</span>
              </button>
            )}
            <a
              className="cv-endpoint"
              href={activeUrl}
              target="_blank"
              rel="noopener noreferrer"
              title={activeUrl}
            >
              <Icon name="link" size={12} strokeWidth={1.8} />
              <span className="cv-endpoint-host">{endpointHost}</span>
            </a>

            <button
              type="button"
              className="btn btn-sm cv-btn"
              onClick={handleOpenExternal}
              title="在新窗口打开"
            >
              <Icon name="link" size={14} strokeWidth={1.9} />
              <span>新窗口</span>
            </button>

            <button
              type="button"
              className="btn btn-sm cv-btn cv-btn-primary"
              onClick={handleRefresh}
              // 加载中且无错误时禁用,避免重复触发;错误态允许点击以重试
              disabled={loading && !showError}
              title="重新加载 ComfyUI"
            >
              <Icon
                name="refresh"
                size={14}
                strokeWidth={1.9}
                className={loading && !showError ? "cv-spin" : undefined}
              />
              <span>刷新</span>
            </button>
          </div>
        </header>

        {/* ── 主体:iframe + 加载层 ── */}
        <div className="cv-frame-wrap">
          {/* 左上角状态指示 */}
          <div
            className="cv-status-pill"
            data-state={
              showError
                ? "error"
                : showOffline
                  ? "offline"
                  : loading
                    ? "loading"
                    : "ready"
            }
          >
            <span className="cv-status-dot" />
            <span className="cv-status-text">
              {showError
                ? "连接失败"
                : showOffline
                  ? "离线"
                  : loading
                    ? slowLoad
                      ? "加载缓慢"
                      : "加载中"
                    : "就绪"}
              {loadMs != null && !showError && !showOffline && !loading && (
                <span className="cv-status-ms"> · {loadMs}ms</span>
              )}
            </span>
          </div>

          {/* iframe:仅在致命错误时卸载,其余状态保留 DOM 以便重连复用 */}
          {!showError && (
            <iframe
              key={reloadKey}
              src={iframeSrc}
              // a11y:title 描述用途,aria-label 补充语义,屏幕阅读器可识别
              title="ComfyUI 节点工作流编辑器"
              aria-label="ComfyUI 节点工作流编辑器 iframe,用于拖拽节点构建图像与视频生成工作流"
              className="cv-iframe"
              onLoad={handleLoaded}
              onError={handleIframeError}
              allow="clipboard-read; clipboard-write; fullscreen"
              sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-downloads allow-modals"
            />
          )}

          {/* 加载遮罩(含 15s 缓慢提示) */}
          {showLoading && (
            <div className="cv-overlay" role="status" aria-live="polite">
              <div className="cv-spinner">
                <Icon name="loading" size={28} strokeWidth={2} className="cv-spin" />
              </div>
              <div className="cv-overlay-title">
                {slowLoad ? "加载时间较长,请稍候" : "正在连接 ComfyUI"}
              </div>
              <div className="cv-overlay-desc">
                {slowLoad
                  ? "Worker 可能正在初始化模型,请耐心等待…"
                  : "加载节点工作流编辑器,首次加载可能需要数秒…"}
              </div>
              <div className="cv-overlay-endpoint">{activeUrl}</div>
              {/* 缓慢态提供主动重载入口,避免用户被动等待 25s 超时 */}
              {slowLoad && (
                <button
                  type="button"
                  className="btn btn-sm cv-btn"
                  onClick={handleRefresh}
                >
                  <Icon name="refresh" size={14} strokeWidth={1.9} />
                  <span>重新加载</span>
                </button>
              )}
            </div>
          )}

          {/* 离线遮罩:断网时展示,网络恢复后自动消失并重连 */}
          {showOffline && (
            <div className="cv-overlay cv-overlay-warning" role="alert">
              <div className="cv-warning-icon">
                <Icon name="warning" size={36} strokeWidth={1.4} />
              </div>
              <div className="cv-overlay-title">连接断开</div>
              <div className="cv-overlay-desc">{ERR_OFFLINE}</div>
              <button
                type="button"
                className="btn btn-sm cv-btn cv-btn-primary"
                onClick={handleManualReconnect}
              >
                <Icon name="refresh" size={14} strokeWidth={1.9} />
                <span>点此重连</span>
              </button>
            </div>
          )}

          {/* 错误卡片:深色卡片 + danger 边框 + 圆角(Indigo Atelier 风格) */}
          {showError && (
            <div className="cv-overlay cv-overlay-error" role="alert">
              <div className="cv-error-card">
                <div className="cv-error-icon">
                  <Icon name="warning" size={32} strokeWidth={1.6} />
                </div>
                <div className="cv-error-body">
                  <div className="cv-overlay-title">无法连接到 ComfyUI</div>
                  <div className="cv-overlay-desc">{error}</div>
                  <div className="cv-overlay-endpoint">{activeUrl}</div>
                </div>
                <div className="cv-error-actions">
                  <button
                    type="button"
                    className="btn btn-sm cv-btn cv-btn-primary"
                    onClick={handleManualReconnect}
                  >
                    <Icon name="refresh" size={14} strokeWidth={1.9} />
                    <span>重试连接</span>
                  </button>
                  <button
                    type="button"
                    className="btn btn-sm cv-btn"
                    onClick={handleOpenExternal}
                  >
                    <Icon name="link" size={14} strokeWidth={1.9} />
                    <span>在新窗口打开</span>
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* ── 底部小提示 ── */}
        <footer className="cv-footer">
          <span className="cv-footer-dot" aria-hidden="true" />
          <span className="cv-footer-text">ComfyUI 节点工作流编辑器</span>
          <span className="cv-footer-sep" aria-hidden="true">·</span>
          <span className="cv-footer-hint">
            拖拽节点构建图像 / 视频生成工作流
          </span>
        </footer>
      </div>

      <style jsx>{`
        .canvas-view {
          display: flex;
          flex-direction: row;
          gap: 0;
          height: 100%;
          min-height: 0;
          position: relative;
        }

        /* ── 侧边栏 ── */
        .cv-sidebar {
          display: flex;
          flex-direction: column;
          width: 280px;
          flex-shrink: 0;
          background: var(--bg-1);
          border-right: 1px solid var(--hairline);
          transition: width var(--dur-2) var(--ease),
            opacity var(--dur-2) var(--ease);
          overflow: hidden;
        }
        .cv-sidebar-closed .cv-sidebar {
          width: 0;
          opacity: 0;
        }
        .cv-sidebar-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--hairline);
        }
        .cv-sidebar-title {
          display: inline-flex;
          align-items: center;
          gap: 0.45rem;
          margin: 0;
          font-family: var(--font-display);
          font-size: 0.95rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: -0.01em;
        }
        .cv-sidebar-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: var(--radius-sm);
          color: var(--ink-soft);
          background: transparent;
          border: 1px solid transparent;
          cursor: pointer;
          transition: background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .cv-sidebar-close:hover {
          background: var(--bg-2);
          border-color: var(--hairline);
        }
        .cv-sidebar-body {
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: var(--space-3);
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
        }
        .cv-sidebar-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.6rem;
          padding: var(--space-5) var(--space-3);
          text-align: center;
          font-size: 0.78rem;
          color: var(--ink-faint);
          border: 1px dashed var(--hairline);
          border-radius: var(--radius);
        }
        .cv-sidebar-error {
          color: var(--danger);
          border-color: color-mix(in oklch, var(--danger) 35%, transparent);
          background: color-mix(in oklch, var(--danger) 8%, transparent);
        }

        /* 模板卡片 */
        .cv-template-card {
          display: flex;
          flex-direction: column;
          gap: 0.55rem;
          padding: var(--space-3);
          background: var(--bg-0);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          transition: border-color var(--dur) var(--ease),
            transform var(--dur) var(--ease),
            box-shadow var(--dur) var(--ease);
        }
        .cv-template-card:hover {
          border-color: var(--accent-line);
          transform: translateY(-1px);
          box-shadow: 0 8px 22px -8px oklch(0% 0 0 / 0.2);
        }
        .cv-template-header {
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 0.5rem;
        }
        .cv-template-name {
          font-size: 0.84rem;
          font-weight: 600;
          color: var(--ink);
          line-height: 1.3;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
        }
        .cv-template-nodes {
          flex-shrink: 0;
          font-size: 0.65rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          padding: 0.1rem 0.4rem;
          background: var(--bg-2);
          border-radius: var(--radius-full);
          white-space: nowrap;
        }
        .cv-template-tags {
          display: flex;
          flex-wrap: wrap;
          gap: 0.35rem;
        }
        .cv-template-tag {
          font-size: 0.65rem;
          color: var(--accent-soft);
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius-full);
          padding: 0.1rem 0.45rem;
          white-space: nowrap;
        }
        .cv-template-desc {
          margin: 0;
          font-size: 0.72rem;
          color: var(--ink-faint);
          line-height: 1.45;
          overflow: hidden;
          text-overflow: ellipsis;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
        }
        .cv-template-load {
          justify-content: center;
          margin-top: 0.1rem;
        }

        /* 侧边栏展开按钮 */
        .cv-sidebar-fab {
          position: absolute;
          top: 0.8rem;
          left: 0.8rem;
          z-index: 4;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: var(--radius);
          color: var(--ink-soft);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          box-shadow: 0 4px 14px -4px oklch(0% 0 0 / 0.18);
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .cv-sidebar-fab:hover {
          border-color: var(--accent-line);
          color: var(--accent-soft);
          background: var(--accent-quiet);
        }

        /* ── 主区域 ── */
        .cv-main {
          display: flex;
          flex-direction: column;
          gap: var(--space-3);
          flex: 1;
          min-width: 0;
          min-height: 0;
          padding: var(--space-3);
          position: relative;
        }

        /* ── 顶部 ── */
        .cv-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-4);
          flex-wrap: wrap;
          padding-bottom: var(--space-3);
          border-bottom: 1px solid var(--hairline);
        }
        .cv-titles {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          min-width: 0;
        }
        .cv-title {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          margin: 0;
          font-family: var(--font-display);
          font-size: 1.5rem;
          font-weight: 600;
          letter-spacing: -0.02em;
          color: var(--ink);
          line-height: 1.2;
        }
        .cv-title-mark {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 8px;
          color: var(--bg-0);
          background: linear-gradient(135deg, var(--accent), var(--accent-deep));
          box-shadow: 0 4px 14px -4px
              color-mix(in oklch, var(--accent) 55%, transparent),
            inset 0 1px 0 oklch(100% 0 0 / 0.18);
        }
        .cv-subtitle {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          font-size: 0.74rem;
          color: var(--ink-faint);
          line-height: 1.3;
          padding-left: 36px;
        }
        .cv-retry-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.1rem 0.45rem;
          background: var(--warn-quiet);
          border: 1px solid color-mix(in oklch, var(--warn) 40%, transparent);
          border-radius: var(--radius-full);
          color: var(--warn);
          font-family: var(--font-mono);
          font-size: 0.66rem;
          letter-spacing: 0.02em;
        }
        .cv-workflow-badge {
          display: inline-flex;
          align-items: center;
          padding: 0.1rem 0.45rem;
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius-full);
          color: var(--accent-soft);
          font-family: var(--font-mono);
          font-size: 0.66rem;
          letter-spacing: 0.02em;
          max-width: 160px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* 工具栏 */
        .cv-toolbar {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          flex-wrap: wrap;
        }
        .cv-endpoint {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.3rem 0.6rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-full);
          font-size: 0.7rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          letter-spacing: 0.01em;
          text-decoration: none;
          transition: border-color var(--dur) var(--ease),
            color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .cv-endpoint:hover {
          border-color: var(--accent-line);
          color: var(--accent-soft);
          background: var(--accent-quiet);
        }
        .cv-endpoint-host {
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        .cv-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.35rem 0.7rem;
          border-radius: var(--radius-sm);
          font-size: 0.78rem;
          color: var(--ink-soft);
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          cursor: pointer;
          transition: border-color var(--dur) var(--ease),
            color var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            transform var(--dur) var(--ease);
        }
        .cv-btn:hover:not(:disabled) {
          border-color: var(--accent-line);
          color: var(--ink);
          background: var(--bg-3);
        }
        .cv-btn:active:not(:disabled) {
          transform: translateY(1px);
        }
        .cv-btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 2px;
        }
        .cv-btn:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .cv-btn-primary {
          color: var(--bg-0);
          background: linear-gradient(135deg, var(--accent), var(--accent-deep));
          border-color: transparent;
          box-shadow: 0 8px 24px -8px
            color-mix(in oklch, var(--accent) 50%, transparent);
        }
        .cv-btn-primary:hover:not(:disabled) {
          color: var(--bg-0);
          background: linear-gradient(135deg, var(--accent-hover), var(--accent));
          border-color: transparent;
          box-shadow: 0 8px 24px -8px
            color-mix(in oklch, var(--accent) 65%, transparent);
        }

        /* ── 主体:iframe 容器 ── */
        .cv-frame-wrap {
          position: relative;
          flex: 1;
          min-height: 0;
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          overflow: hidden;
          box-shadow: 0 1px 0 oklch(0% 0 0 / 0.02);
        }
        .cv-iframe {
          display: block;
          width: 100%;
          height: 100%;
          border: 0;
          background: var(--bg-sunken);
        }

        /* 状态指示(左上角浮层) */
        .cv-status-pill {
          position: absolute;
          top: 0.6rem;
          left: 0.6rem;
          z-index: 3;
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.25rem 0.6rem;
          background: color-mix(in oklch, var(--bg-0) 70%, transparent);
          backdrop-filter: blur(8px);
          -webkit-backdrop-filter: blur(8px);
          border: 1px solid oklch(100% 0 0 / 0.08);
          border-radius: var(--radius-full);
          font-size: 0.68rem;
          color: var(--ink-soft);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          pointer-events: none;
          opacity: 0;
          transition: opacity var(--dur-2) var(--ease);
        }
        .cv-frame-wrap:hover .cv-status-pill {
          opacity: 1;
        }
        .cv-status-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .cv-status-pill[data-state="ready"] .cv-status-dot {
          background: var(--success);
          box-shadow: 0 0 6px
            color-mix(in oklch, var(--success) 80%, transparent);
        }
        .cv-status-pill[data-state="loading"] .cv-status-dot {
          background: var(--accent);
          animation: cv-pulse 1.2s var(--ease) infinite;
        }
        .cv-status-pill[data-state="error"] .cv-status-dot {
          background: var(--danger);
        }
        .cv-status-pill[data-state="offline"] .cv-status-dot {
          background: var(--warn);
        }
        .cv-status-pill[data-state="ready"] {
          color: var(--success);
        }
        .cv-status-pill[data-state="loading"] {
          color: var(--accent-soft);
        }
        .cv-status-pill[data-state="error"] {
          color: var(--danger);
        }
        .cv-status-pill[data-state="offline"] {
          color: var(--warn);
        }
        .cv-status-ms {
          opacity: 0.65;
        }
        @keyframes cv-pulse {
          0%,
          100% {
            opacity: 1;
            transform: scale(1);
          }
          50% {
            opacity: 0.5;
            transform: scale(0.7);
          }
        }

        /* 加载 / 错误遮罩层 */
        .cv-overlay {
          position: absolute;
          inset: 0;
          z-index: 2;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.7rem;
          padding: var(--space-5);
          text-align: center;
          background: radial-gradient(
              circle at 50% 35%,
              oklch(55% 0.2 265 / 0.18),
              transparent 60%
            ),
            var(--bg-1);
          animation: cv-fade-in var(--dur-2) var(--ease);
        }
        .cv-overlay-warning {
          background: radial-gradient(
              circle at 50% 35%,
              oklch(75% 0.15 85 / 0.16),
              transparent 60%
            ),
            var(--bg-1);
        }
        .cv-overlay-error {
          background: radial-gradient(
              circle at 50% 35%,
              oklch(60% 0.2 25 / 0.16),
              transparent 60%
            ),
            var(--bg-1);
        }
        @keyframes cv-fade-in {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
        .cv-spinner {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          color: var(--accent);
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          box-shadow: 0 0 24px -4px oklch(55% 0.2 265 / 0.45);
        }
        .cv-warning-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          color: var(--warn);
          background: var(--warn-quiet);
          border: 1px solid color-mix(in oklch, var(--warn) 40%, transparent);
        }
        .cv-error-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 56px;
          height: 56px;
          border-radius: 50%;
          color: var(--danger);
          background: color-mix(in oklch, var(--danger) 14%, transparent);
          border: 1px solid color-mix(in oklch, var(--danger) 40%, transparent);
        }
        .cv-overlay-title {
          font-family: var(--font-display);
          font-size: 1.05rem;
          font-weight: 600;
          color: var(--ink);
          letter-spacing: -0.01em;
        }
        .cv-overlay-desc {
          font-size: 0.8rem;
          color: var(--ink-faint);
          line-height: 1.5;
          max-width: 380px;
        }
        .cv-overlay-endpoint {
          font-size: 0.7rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          padding: 0.15rem 0.55rem;
          background: var(--bg-3);
          border-radius: var(--radius-full);
          border: 1px solid var(--hairline);
        }

        /* 错误卡片:深色卡片 + danger 边框 + 圆角 */
        .cv-error-card {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.85rem;
          padding: var(--space-5);
          background: var(--bg-1);
          border: 1px solid color-mix(in oklch, var(--danger) 45%, transparent);
          border-radius: var(--radius-lg);
          box-shadow: 0 12px 40px -8px oklch(0% 0 0 / 0.6),
            inset 0 1px 0 oklch(100% 0 0 / 0.04);
          max-width: 440px;
          animation: cv-card-in var(--dur-2) var(--ease);
        }
        @keyframes cv-card-in {
          from {
            opacity: 0;
            transform: translateY(8px) scale(0.98);
          }
          to {
            opacity: 1;
            transform: translateY(0) scale(1);
          }
        }
        .cv-error-body {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
        }
        .cv-error-actions {
          display: inline-flex;
          align-items: center;
          gap: 0.5rem;
          flex-wrap: wrap;
          justify-content: center;
          margin-top: 0.2rem;
        }

        /* ── 底部 ── */
        .cv-footer {
          display: flex;
          align-items: center;
          gap: 0.45rem;
          padding-top: 0.1rem;
          font-size: 0.72rem;
          color: var(--ink-faint);
          line-height: 1.4;
          flex-wrap: wrap;
        }
        .cv-footer-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--accent);
          box-shadow: 0 0 6px color-mix(in oklch, var(--accent) 60%, transparent);
          flex-shrink: 0;
        }
        .cv-footer-text {
          color: var(--ink-soft);
          font-weight: 500;
        }
        .cv-footer-sep {
          opacity: 0.4;
        }
        .cv-footer-hint {
          opacity: 1;
        }

        /* ── 旋转动画 ── */
        .cv-spin {
          animation: cv-spin 1s linear infinite;
        }
        @keyframes cv-spin {
          to {
            transform: rotate(360deg);
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .cv-spin,
          .cv-spinner,
          .cv-status-pill[data-state="loading"] .cv-status-dot,
          .cv-overlay,
          .cv-error-card {
            animation: none;
          }
        }

        /* ── 响应式:小屏 iframe 高度自适应,大屏固定高度(flex:1) ── */
        @media (max-width: 768px) {
          .cv-sidebar {
            position: absolute;
            top: 0;
            left: 0;
            bottom: 0;
            z-index: 5;
            width: 260px;
            box-shadow: 4px 0 24px -4px oklch(0% 0 0 / 0.35);
          }
          .cv-sidebar-closed .cv-sidebar {
            width: 0;
          }
          .cv-main {
            padding: var(--space-3);
          }
          .cv-header {
            flex-direction: column;
            align-items: stretch;
            gap: var(--space-3);
          }
          .cv-toolbar {
            justify-content: flex-end;
          }
          .cv-endpoint-host {
            max-width: 120px;
          }
          .cv-subtitle {
            padding-left: 0;
          }
          /* 小屏:flex 高度可能塌陷(父容器无明确高度时),兜底视口高度 */
          .cv-frame-wrap {
            min-height: 70vh;
          }
        }
      `}</style>
    </div>
  );
}
