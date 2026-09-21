"use client";

/**
 * 助手会话管理模块(2026-09-22 A3 组件工程化):
 * 自 AssistantView.tsx 拆出——会话列表(页形态历史面板 / popup 会话抽屉共用)、
 * popup 会话抽屉、删除确认弹窗组(对话/文档)。
 * 行为零变化:JSX/类名/文案逐字保留,仅闭包变量改为同名 props。
 */
import { lazy, Suspense, type Dispatch, type RefObject, type SetStateAction } from "react";
import { Icon } from "@/components/ui/Icon";
import { Button } from "@/components/ui/Button";
import { LoadingBlock } from "@/components/ui/LoadingBlock";
import type { DocItem } from "@/lib/docs";
import { formatTime } from "./MessageList";
import type { AgentConversationStore, Conversation } from "./AssistantView";

// Modal 走 lazy(同 ResourcesView 懒加载范式):node:test 直接 import 模块链(AssistantView
// → 本文件)但不渲染视图,lazy 可避开链接期触达 ui/Modal → hooks/useFocusTrap(.ts 不经
// 测试 loader 转译,其 `RefObject` 值导入在 node ESM type-stripping 下会抛 named export 错);
// 生产端 chunk 随视图挂载即预热,打开确认弹窗无感知
const Modal = lazy(() =>
  import("@/components/ui/Modal").then((m) => ({ default: m.Modal })),
);

export interface ConvListProps {
  convStore: AgentConversationStore;
  activeConvId: string | null;
  loadConversation: (conv: Conversation) => void | Promise<void>;
  forkConversation: (conv: Conversation) => void;
  setConfirmDeleteConv: Dispatch<SetStateAction<Conversation | null>>;
}

/* 会话列表(页形态历史面板 / popup 会话抽屉共用):加载态/空态/列表三分支,
   点击切换走 loadConversation(复用服务端回放),删除走二次确认 Modal */
export function ConvList({
  convStore,
  activeConvId,
  loadConversation,
  forkConversation,
  setConfirmDeleteConv,
}: ConvListProps) {
  const conversations = convStore.conversations;
  return convStore.serverMode === null ? (
    <LoadingBlock variant="line" count={4} />
  ) : conversations.length === 0 ? (
    <div className="av-panel-empty">
      <Icon name="chat" size={20} strokeWidth={1.4} />
      <span>暂无历史对话</span>
    </div>
  ) : (
    <div className="av-conv-list">
      {conversations.map((conv) => (
        <div
          key={conv.id}
          className={`av-conv-item${activeConvId === conv.id ? " is-active" : ""}`}
        >
          <button
            type="button"
            className="av-conv-main"
            onClick={() => loadConversation(conv)}
          >
            <div className="av-conv-info">
              <span className="av-conv-title">{conv.title}</span>
              <span className="av-conv-meta">
                {conv.messageCount ?? conv.messages.length} 条消息 · {formatTime(conv.updatedAt)}
              </span>
            </div>
          </button>
          <button
            type="button"
            className="av-conv-fork"
            onClick={(e) => { e.stopPropagation(); forkConversation(conv); }}
            title="分叉对话(复制为新会话)"
            aria-label={`分叉对话 ${conv.title}`}
          >
            <Icon name="fork" size={11} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className="av-conv-delete"
            onClick={(e) => { e.stopPropagation(); setConfirmDeleteConv(conv); }}
            title="删除对话"
            aria-label={`删除对话 ${conv.title}`}
          >
            <Icon name="delete" size={11} strokeWidth={1.8} />
          </button>
        </div>
      ))}
    </div>
  );
}

export interface SessionDrawerProps extends ConvListProps {
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  onNewChat: () => void;
  /** popup 会话抽屉根节点(主壳点外部关闭判定用) */
  convDrawerRef: RefObject<HTMLDivElement | null>;
}

/* popup 会话抽屉(锚于输入框上方,与 @ 技能面板同位):
   列表/切换/新建/删除全复用页形态逻辑;Esc/点外部关闭(主壳 effect) */
export function SessionDrawer({
  historyOpen,
  setHistoryOpen,
  onNewChat,
  convDrawerRef,
  ...convListProps
}: SessionDrawerProps) {
  return (
    <div
      ref={convDrawerRef}
      className={`av-pop-conv${historyOpen ? " is-open" : ""}`}
      role="menu"
      aria-label="会话管理"
      aria-hidden={!historyOpen}
    >
      <div className="av-pop-conv-head">
        <span className="av-pop-conv-title">会话</span>
        <button
          type="button"
          className="av-tb-btn av-pop-conv-new"
          onClick={() => {
            onNewChat();
            setHistoryOpen(false);
          }}
          title="新会话"
          aria-label="新会话"
        >
          <Icon name="create" size={13} strokeWidth={1.8} />
          <span>新会话</span>
        </button>
      </div>
      <div className="av-pop-conv-body">
        <ConvList {...convListProps} />
      </div>
    </div>
  );
}

export interface DeleteConfirmModalsProps {
  confirmDeleteConv: Conversation | null;
  setConfirmDeleteConv: Dispatch<SetStateAction<Conversation | null>>;
  deleteConversation: (id: string) => void;
  confirmDeleteDoc: DocItem | null;
  setConfirmDeleteDoc: Dispatch<SetStateAction<DocItem | null>>;
  docDeleting: boolean;
  onDeleteDoc: (doc: DocItem) => void | Promise<void>;
}

/* 删除确认弹窗组(P0-2,lazy Modal 需 Suspense 边界;fallback null 不影响布局):
   会话/文档删除均不可逆,统一走 Modal 确认后执行 */
export function DeleteConfirmModals({
  confirmDeleteConv,
  setConfirmDeleteConv,
  deleteConversation,
  confirmDeleteDoc,
  setConfirmDeleteDoc,
  docDeleting,
  onDeleteDoc,
}: DeleteConfirmModalsProps) {
  return (
    <Suspense fallback={null}>
      {/* 删除对话二次确认(Modal 基座,对齐作品库删除确认模式) */}
      <Modal
        open={!!confirmDeleteConv}
        onClose={() => setConfirmDeleteConv(null)}
        title="删除对话"
        danger
        footer={
          <>
            <Button variant="secondary" onClick={() => setConfirmDeleteConv(null)}>
              取消
            </Button>
            <Button
              variant="danger"
              icon={<Icon name="delete" size={14} />}
              onClick={() => {
                if (confirmDeleteConv) deleteConversation(confirmDeleteConv.id);
                setConfirmDeleteConv(null);
              }}
            >
              确认删除
            </Button>
          </>
        }
      >
        <div className="av-confirm-warn">
          确定删除这条对话{confirmDeleteConv?.title ? `「${confirmDeleteConv.title}」` : ""}?此操作不可撤销,全部消息记录将被永久移除。
        </div>
      </Modal>

      {/* 删除文档二次确认(删除中阻止关闭,失败保留弹窗可重试) */}
      <Modal
        open={!!confirmDeleteDoc}
        onClose={() => setConfirmDeleteDoc(null)}
        title="删除文档"
        danger
        preventClose={docDeleting}
        footer={
          <>
            <Button
              variant="secondary"
              disabled={docDeleting}
              onClick={() => setConfirmDeleteDoc(null)}
            >
              取消
            </Button>
            <Button
              variant="danger"
              loading={docDeleting}
              icon={<Icon name="delete" size={14} />}
              onClick={() => confirmDeleteDoc && onDeleteDoc(confirmDeleteDoc)}
            >
              {docDeleting ? "删除中…" : "确认删除"}
            </Button>
          </>
        }
      >
        <div className="av-confirm-warn">
          确定删除文档{confirmDeleteDoc ? `「${confirmDeleteDoc.filename}」` : ""}?此操作不可撤销,文档及其索引将被永久移除。
        </div>
      </Modal>
    </Suspense>
  );
}
