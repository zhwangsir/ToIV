"use client";

/** M2:ComfyUI 模板库 —— 工具栏触发按钮 + 弹出面板。
 *
 * 打开面板时懒加载模板列表(GET /api/workflows/templates),
 * 点击模板卡片调用 importWorkflow 把模板解析为画布子图;
 * 新增节点经 SSE node_added 自动落到画布(store 已订阅)。
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useReactFlow } from "@xyflow/react";
import { Icon, type IconName } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import {
  importWorkflow,
  listWorkflowTemplates,
  type WorkflowTemplate,
} from "@/lib/canvas/api";

// ---------- kind_hint → 图标 / 中文标签(图标底层统一 lucide-react) ----------
const KIND_ICON: Record<string, IconName> = {
  image: "image",
  video: "video",
  audio: "audio",
  music: "audio",
  model3d: "model3d",
  "3d": "model3d",
  text: "file",
  llm: "chat",
};
const KIND_LABEL: Record<string, string> = {
  image: "图像",
  video: "视频",
  audio: "音频",
  music: "音频",
  model3d: "3D",
  "3d": "3D",
  text: "文本",
  llm: "LLM",
};

function kindIcon(kindHint: string): IconName {
  return KIND_ICON[kindHint.toLowerCase()] ?? "canvas";
}
function kindLabel(kindHint: string): string {
  return KIND_LABEL[kindHint.toLowerCase()] ?? kindHint;
}

interface WorkflowLibraryProps {
  canvasId: string | null;
}

export function WorkflowLibrary({ canvasId }: WorkflowLibraryProps) {
  const toast = useToast();
  const rf = useReactFlow();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<WorkflowTemplate[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [importingId, setImportingId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setItems(await listWorkflowTemplates());
    } catch (e) {
      setItems(null);
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  // 每次打开面板都刷新模板列表(与后端保持一致)
  useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // 点击外部 / Esc 关闭面板
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const handleImport = useCallback(
    async (tpl: WorkflowTemplate) => {
      if (!canvasId || importingId) return;
      setImportingId(tpl.id);
      try {
        const res = await importWorkflow(canvasId, { template_id: tpl.id });
        toast.success(`已导入「${tpl.name}」(${res.count} 个节点)`);
        setOpen(false);
        // 新节点落在 (0,0) 附近,可能不在当前视口;SSE 落库后自动 fitView 让节点可见
        window.setTimeout(() => {
          void rf.fitView({ padding: 0.2, duration: 400 });
        }, 200);
      } catch (e) {
        toast.error((e as Error).message);
      } finally {
        setImportingId(null);
      }
    },
    [canvasId, importingId, toast, rf],
  );

  return (
    <div className="cv-wf-menu" ref={rootRef}>
      {/* 触发按钮(工具栏) */}
      <button
        type="button"
        className="cv-wf-trigger"
        onClick={() => setOpen((v) => !v)}
        disabled={!canvasId}
        title="ComfyUI 模板库"
        aria-label="模板库"
        aria-haspopup="dialog"
        aria-expanded={open}
      >
        <Icon name="library" size={14} strokeWidth={1.8} />
        <span>模板</span>
      </button>

      {open && (
        <div
          className="cv-workflow-library"
          role="dialog"
          aria-label="ComfyUI 模板库"
        >
          <div className="cv-wf-head">
            <span className="cv-wf-title">ComfyUI 模板库</span>
            <div className="cv-wf-head-actions">
              <button
                type="button"
                className="cv-wf-icon-btn"
                onClick={() => void load()}
                disabled={loading}
                title="刷新模板列表"
                aria-label="刷新模板列表"
              >
                <Icon name="refresh" size={12} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="cv-wf-icon-btn"
                onClick={() => setOpen(false)}
                title="关闭模板库"
                aria-label="关闭模板库"
              >
                <Icon name="close" size={12} strokeWidth={1.8} />
              </button>
            </div>
          </div>

          {/* 加载态:骨架卡片(避免低端转圈) */}
          {loading && (
            <div aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <div className="cv-wf-skel" key={i}>
                  <div className="cv-wf-skel-icon" />
                  <div className="cv-wf-skel-lines">
                    <div className="cv-wf-skel-line" />
                    <div className="cv-wf-skel-line short" />
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* 错误态 */}
          {!loading && error && (
            <div className="cv-wf-state" role="alert">
              <span className="cv-wf-state-icon is-error">
                <Icon name="error" size={20} strokeWidth={1.6} />
              </span>
              <div className="cv-wf-state-text">{error}</div>
              <button
                type="button"
                className="cv-wf-retry"
                onClick={() => void load()}
              >
                <Icon name="refresh" size={12} strokeWidth={1.8} />
                <span>重试</span>
              </button>
            </div>
          )}

          {/* 空态 */}
          {!loading && !error && items !== null && items.length === 0 && (
            <div className="cv-wf-state">
              <span className="cv-wf-state-icon">
                <Icon name="canvas" size={20} strokeWidth={1.6} />
              </span>
              <div className="cv-wf-state-text">暂无可用模板</div>
            </div>
          )}

          {/* 模板列表 */}
          {!loading && !error && items !== null && items.length > 0 && (
            <div className="cv-wf-list">
              {items.map((tpl) => (
                <button
                  key={tpl.id}
                  type="button"
                  className="cv-workflow-item"
                  onClick={() => void handleImport(tpl)}
                  disabled={importingId !== null}
                >
                  <span className="cv-wf-item-icon">
                    <Icon
                      name={kindIcon(tpl.kind_hint)}
                      size={13}
                      strokeWidth={1.8}
                    />
                  </span>
                  <span className="cv-wf-item-main">
                    <span className="cv-wf-item-name">{tpl.name}</span>
                    {tpl.description && (
                      <span className="cv-wf-item-desc">{tpl.description}</span>
                    )}
                  </span>
                  <span className="cv-wf-item-badge">
                    {importingId === tpl.id
                      ? "导入中…"
                      : kindLabel(tpl.kind_hint)}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      <style jsx>{`
        .cv-wf-menu {
          position: relative;
        }

        /* 触发按钮:对齐工具栏 cv-tb-btn 视觉(局部复刻,避免跨组件样式依赖) */
        .cv-wf-trigger {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.32rem 0.6rem;
          background: transparent;
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          font-size: 0.75rem;
          font-weight: 500;
          font-family: var(--font-sans);
          cursor: pointer;
          transition:
            color var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .cv-wf-trigger:hover:not(:disabled) {
          color: var(--ink);
          border-color: var(--hairline-strong);
          background: var(--bg-3);
        }
        .cv-wf-trigger:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .cv-wf-trigger:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }

        /* 弹出面板:风格对齐 .cv-add-popover */
        .cv-workflow-library {
          position: absolute;
          top: calc(100% + 4px);
          right: 0;
          width: 320px;
          max-width: calc(100vw - 2rem);
          padding: 0.4rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-sm);
          box-shadow: var(--shadow-lg);
          z-index: 20;
          display: flex;
          flex-direction: column;
          gap: 0.25rem;
          animation: cv-wf-in var(--dur) var(--ease);
        }
        @keyframes cv-wf-in {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .cv-wf-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.15rem 0.2rem 0.35rem;
        }
        .cv-wf-title {
          font-size: 0.72rem;
          font-weight: 600;
          letter-spacing: 0.04em;
          color: var(--ink-faint);
        }
        .cv-wf-head-actions {
          display: flex;
          align-items: center;
          gap: 0.15rem;
        }
        .cv-wf-icon-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          background: transparent;
          border: none;
          border-radius: 4px;
          color: var(--ink-faint);
          cursor: pointer;
          transition:
            color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .cv-wf-icon-btn:hover:not(:disabled) {
          color: var(--ink);
          background: var(--bg-3);
        }
        .cv-wf-icon-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        .cv-wf-list {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          max-height: min(400px, 60vh);
          overflow-y: auto;
        }

        /* 模板卡片 */
        .cv-workflow-item {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 0.5rem;
          background: transparent;
          border: none;
          border-radius: var(--radius-xs);
          text-align: left;
          font-family: var(--font-sans);
          cursor: pointer;
          transition: background-color var(--dur) var(--ease);
        }
        .cv-workflow-item:hover:not(:disabled) {
          background: var(--accent-quiet);
        }
        .cv-workflow-item:disabled {
          opacity: 0.55;
          cursor: not-allowed;
        }
        .cv-wf-item-icon {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          background: var(--bg-1);
          color: var(--ink-faint);
        }
        .cv-workflow-item:hover:not(:disabled) .cv-wf-item-icon {
          color: var(--accent-soft);
        }
        .cv-wf-item-main {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
        }
        .cv-wf-item-name {
          font-size: 0.8rem;
          font-weight: 500;
          color: var(--ink);
        }
        .cv-wf-item-desc {
          font-size: 0.72rem;
          color: var(--ink-faint);
          line-height: 1.45;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }
        .cv-wf-item-badge {
          flex-shrink: 0;
          align-self: center;
          padding: 0.12rem 0.4rem;
          border-radius: var(--radius-full);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          font-size: 0.66rem;
          color: var(--ink-faint);
          white-space: nowrap;
        }
        .cv-workflow-item:hover:not(:disabled) .cv-wf-item-badge {
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }

        /* 错误 / 空态 */
        .cv-wf-state {
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: 0.5rem;
          padding: 1rem 0.6rem;
          text-align: center;
        }
        .cv-wf-state-icon {
          display: inline-flex;
          color: var(--ink-faint);
          opacity: 0.7;
        }
        .cv-wf-state-icon.is-error {
          color: var(--danger);
          opacity: 0.85;
        }
        .cv-wf-state-text {
          font-size: 0.76rem;
          color: var(--ink-faint);
          line-height: 1.5;
          word-break: break-word;
        }
        .cv-wf-retry {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.28rem 0.6rem;
          background: var(--accent-quiet);
          border: 1px solid var(--accent-line);
          border-radius: var(--radius-xs);
          color: var(--accent-soft);
          font-size: 0.72rem;
          font-weight: 500;
          font-family: var(--font-sans);
          cursor: pointer;
          transition:
            color var(--dur) var(--ease),
            background-color var(--dur) var(--ease);
        }
        .cv-wf-retry:hover {
          background: var(--accent);
          color: var(--accent-ink);
        }

        /* 加载骨架(柔和呼吸,非旋转) */
        .cv-wf-skel {
          display: flex;
          align-items: flex-start;
          gap: 0.5rem;
          padding: 0.5rem;
          animation: cv-wf-pulse 1.6s ease-in-out infinite;
        }
        .cv-wf-skel-icon {
          flex-shrink: 0;
          width: 26px;
          height: 26px;
          border-radius: 6px;
          background: var(--bg-3);
        }
        .cv-wf-skel-lines {
          flex: 1;
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          padding-top: 0.2rem;
        }
        .cv-wf-skel-line {
          height: 8px;
          border-radius: 4px;
          background: var(--bg-3);
        }
        .cv-wf-skel-line.short {
          width: 55%;
        }
        @keyframes cv-wf-pulse {
          0%,
          100% {
            opacity: 0.45;
          }
          50% {
            opacity: 0.85;
          }
        }

        @media (prefers-reduced-motion: reduce) {
          .cv-workflow-library {
            animation: none;
          }
          .cv-wf-skel {
            animation: none;
          }
        }
      `}</style>
    </div>
  );
}
