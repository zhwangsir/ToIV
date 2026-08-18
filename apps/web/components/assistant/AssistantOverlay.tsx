"use client";

import { Suspense, lazy, useEffect, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { LoadingBlock } from "@/components/ui/LoadingBlock";

interface AssistantOverlayProps {
  /** 浮层显隐(Cmd/Ctrl+K 切换;开启前由 page.tsx 先播霓虹边缘动画)。 */
  open: boolean;
  onClose: () => void;
  /** 视图跳转:先关浮层再切视图(page.tsx 承接,带预热/过渡)。 */
  onNavigate: (view: string) => void;
}

// 懒加载:2400 行组件不进首屏 bundle;保持挂载后 chunk 已缓存,二次打开零等待
const AssistantView = lazy(() =>
  import("@/components/assistant/AssistantView").then((m) => ({ default: m.AssistantView })),
);

/**
 * AI 助手全局浮层(2026-08-17 底层化):助手不再作为一级视图占据导航,
 * 由 Cmd/Ctrl+K 随时唤起,任意视图之上对话。
 *
 * 2026-08-18 弹窗化(variant="popup"):界面仅保留对话显示区与输入框——
 * 页头/历史/设置/文档面板与门户空态全部隐藏,空态为极简品牌提示;
 * 面板右上角保留一个最小关闭按钮(弹窗 chrome,Esc/遮罩点击同效)。
 *
 * 挂载策略:首次打开后保持挂载(关闭仅视觉隐藏)——对话 messages/会话状态
 * 全在 AssistantView 内,卸载即丢;常驻 DOM 让「关掉再开,对话还在」,
 * 符合底层常驻助手的心智。空闲期无轮询(engines/作品流仅在挂载首拉),
 * 常驻成本可忽略。
 *
 * 交互:Esc / 遮罩点击关闭;助手内的视图跳转先关浮层再切视图。
 */
export function AssistantOverlay({ open, onClose, onNavigate }: AssistantOverlayProps) {
  // 常驻挂载标记:打开过一次即 true,此后仅切换可见性
  const [mounted, setMounted] = useState(false);
  // 首开动画:挂载同时展开,避免闪现
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);

  // Esc 关闭(capture 优先于浮层内面板自身的 Esc 处理,一次按键直接收起浮层)
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, onClose]);

  // 打开时锁 body 滚动(浮层内对话流自滚动)
  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  if (!mounted) return null;

  return (
    <div
      className={`av-overlay${open ? " is-open" : ""}`}
      role="dialog"
      aria-modal="true"
      aria-label="AI 助手"
      aria-hidden={!open}
      {...(open ? {} : { inert: "" as unknown as boolean })}
    >
      <div className="av-overlay-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="av-overlay-panel">
        {/* 最小关闭按钮(popup 形态无页头,关闭 affordance 由浮层 chrome 承担) */}
        <button
          type="button"
          className="av-overlay-close"
          onClick={onClose}
          aria-label="关闭 AI 助手"
          title="关闭 (Esc)"
        >
          <Icon name="close" size={14} strokeWidth={1.8} />
        </button>
        <Suspense
          fallback={
            <div className="av-overlay-loading">
              <LoadingBlock variant="line" count={4} />
            </div>
          }
        >
          <AssistantView
            variant="popup"
            onNavigate={(v) => {
              onClose();
              onNavigate(v);
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
