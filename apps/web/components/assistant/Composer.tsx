"use client";

/**
 * 助手输入区模块(2026-09-22 A3 组件工程化):
 * 自 AssistantView.tsx 拆出——composer(附件 chips/@主体引用预览/@ 技能·主体面板/
 * popup 会话抽屉挂载位/发送·中止·工具行),门户 C 位与会话底部两处复用。
 * 行为零变化:JSX/类名/文案逐字保留,仅闭包变量改为同名 props。
 */
import {
  type Dispatch,
  type KeyboardEvent,
  type RefObject,
  type SetStateAction,
} from "react";
import { Icon } from "@/components/ui/Icon";
import { EntityRefsPreview } from "@/components/ui/PromptWithEntities";
import { docKindIcon, type DocItem } from "@/lib/docs";
import {
  entityKindLabel,
  entityThumbUrl,
  resolveEntityIds,
  type EntityInfo,
} from "@/lib/entities";
import { SessionDrawer } from "./SessionDrawer";
import type { PortalEntry } from "./PortalEmpty";
import type { AgentConversationStore, Conversation } from "./AssistantView";

export interface ComposerProps {
  /** portal=true:门户 C 位档(褪去底部固定档的渐变底与内边距) */
  portal: boolean;
  popup: boolean;
  busy: boolean;
  input: string;
  setInput: Dispatch<SetStateAction<string>>;
  /** 输入再变化时重新允许 @ 面板弹出 */
  setSkillDismissed: Dispatch<SetStateAction<boolean>>;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 移动端断点:placeholder 文案按端适配(移动端无 Enter 键) */
  isMobileMq: boolean;
  onKeyDown: (e: KeyboardEvent<HTMLTextAreaElement>) => void;
  onStop: () => void;
  send: (presetPrompt?: string) => void | Promise<void>;
  onNewChat: () => void;
  docsOpen: boolean;
  setDocsOpen: Dispatch<SetStateAction<boolean>>;
  historyOpen: boolean;
  setHistoryOpen: Dispatch<SetStateAction<boolean>>;
  attachedDocs: DocItem[];
  removeAttachedDoc: (id: string) => void;
  subjectEntities: EntityInfo[];
  skillPanelVisible: boolean;
  skillEntries: PortalEntry[];
  entityEntries: EntityInfo[];
  onPickSkill: (view: string) => void;
  onPickEntity: (ent: EntityInfo) => void;
  // ── popup 会话抽屉(锚于输入框上方,与 @ 技能面板同位) ──
  convDrawerRef: RefObject<HTMLDivElement | null>;
  convStore: AgentConversationStore;
  activeConvId: string | null;
  loadConversation: (conv: Conversation) => void | Promise<void>;
  forkConversation: (conv: Conversation) => void;
  setConfirmDeleteConv: Dispatch<SetStateAction<Conversation | null>>;
}

export function Composer({
  portal,
  popup,
  busy,
  input,
  setInput,
  setSkillDismissed,
  textareaRef,
  isMobileMq,
  onKeyDown,
  onStop,
  send,
  onNewChat,
  docsOpen,
  setDocsOpen,
  historyOpen,
  setHistoryOpen,
  attachedDocs,
  removeAttachedDoc,
  subjectEntities,
  skillPanelVisible,
  skillEntries,
  entityEntries,
  onPickSkill,
  onPickEntity,
  convDrawerRef,
  convStore,
  activeConvId,
  loadConversation,
  forkConversation,
  setConfirmDeleteConv,
}: ComposerProps) {
  return (
    <div className={`av-composer${portal ? " av-composer--portal" : ""}`}>
      {attachedDocs.length > 0 && (
        <div className="doc-chips doc-chips--composer">
          {attachedDocs.map((d) => (
            <span key={d.id} className="doc-chip doc-chip--removable">
              <Icon name={docKindIcon(d.kind)} size={11} strokeWidth={1.8} />
              {d.filename}
              <button
                type="button"
                className="doc-chip-x"
                onClick={() => removeAttachedDoc(d.id)}
                aria-label={`移除文档 ${d.filename}`}
                title="移除"
              >
                <Icon name="close" size={10} strokeWidth={2} />
              </button>
            </span>
          ))}
        </div>
      )}
      {/* @主体引用预览:输入中的 @实体名 实时显示绑定 chip(图N);
          × 移除引用;实体库为空/未加载时自动隐藏,纯文本输入零影响 */}
      <EntityRefsPreview value={input} entities={subjectEntities} onChange={setInput} />
      <div className="av-composer-anchor">
        {/* popup 会话抽屉(锚于输入框上方,与 @ 技能面板同位):
            列表/切换/新建/删除全复用页形态逻辑;Esc/点外部关闭 */}
        {popup && (
          <SessionDrawer
            historyOpen={historyOpen}
            setHistoryOpen={setHistoryOpen}
            onNewChat={onNewChat}
            convDrawerRef={convDrawerRef}
            convStore={convStore}
            activeConvId={activeConvId}
            loadConversation={loadConversation}
            forkConversation={forkConversation}
            setConfirmDeleteConv={setConfirmDeleteConv}
          />
        )}
        {/* @ 技能面板(一期 = 工作台快捷入口;视觉与 at-card 同构)。
            2026-08-26 起并入第二分组「主体」(@主体引用):选定插入 @实体名 文本引用,
            不跳转;发送时解析为 entity_ids 传给后端 */}
        {skillPanelVisible && (
          <div className="av-skill-panel at-card" role="menu" aria-label="技能、工作台与主体库快捷入口">
            {skillEntries.length > 0 && (
              <div className="av-skill-panel-head">
                <span className="av-skill-panel-title">技能 / 工作台</span>
                <span className="av-skill-panel-hint">Enter 选定首项 · Esc 关闭</span>
              </div>
            )}
            {skillEntries.map((entry) => (
              <button
                key={entry.view}
                type="button"
                role="menuitem"
                className="av-skill-item"
                onClick={() => onPickSkill(entry.view)}
              >
                <span className="av-skill-item-icon">
                  <Icon name={entry.icon} size={14} strokeWidth={1.8} />
                </span>
                <span className="av-skill-item-main">
                  <span className="av-skill-item-label">{entry.label}</span>
                  <span className="av-skill-item-desc">{entry.desc}</span>
                </span>
              </button>
            ))}
            {entityEntries.length > 0 && (
              <div className="av-skill-panel-head">
                <span className="av-skill-panel-title">主体</span>
                <span className="av-skill-panel-hint">选定后插入 @名字 引用</span>
              </div>
            )}
            {entityEntries.map((ent) => (
              <button
                key={ent.id}
                type="button"
                role="menuitem"
                className="av-skill-item"
                onClick={() => onPickEntity(ent)}
              >
                <span className="av-skill-item-icon">
                  {entityThumbUrl(ent) ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img className="av-skill-item-thumb" src={entityThumbUrl(ent)} alt="" aria-hidden="true" />
                  ) : (
                    <Icon name="user" size={14} strokeWidth={1.8} />
                  )}
                </span>
                <span className="av-skill-item-main">
                  <span className="av-skill-item-label">@{ent.name}</span>
                  <span className="av-skill-item-desc">
                    {entityKindLabel(ent.kind)} · 引用为 图片{resolveEntityIds(input, subjectEntities).length + 1}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
        <div className="av-composer-box">
          <div className="av-composer-actions av-composer-actions--left">
            {busy ? (
              <button type="button" className="av-composer-btn av-composer-stop" onClick={onStop} title="停止本轮回复并中止已提交的生成作业">
                <Icon name="minus" size={12} strokeWidth={2.2} />
              </button>
            ) : !popup ? (
              <>
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool av-composer-docs${docsOpen || attachedDocs.length ? " is-active" : ""}`}
                title="文档(上传/挂载,供长文本理解)"
                aria-label="文档"
                onClick={() => setDocsOpen((v) => !v)}
              >
                <Icon name="plus" size={14} strokeWidth={1.8} />
              </button>
              {/* Studio Console v1:历史/新对话从已退役页头收进输入框工具行 */}
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool${historyOpen ? " is-active" : ""}`}
                title="对话历史"
                aria-label="对话历史"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <Icon name="history" size={14} strokeWidth={1.8} />
              </button>
              <button
                type="button"
                className="av-composer-btn av-composer-btn-ghost av-composer-tool"
                title="新对话"
                aria-label="新对话"
                onClick={onNewChat}
              >
                <Icon name="create" size={14} strokeWidth={1.8} />
              </button>
              </>
            ) : (
              /* popup:文档入口让位于「会话」按钮(历史/新建/删除抽屉) */
              <button
                type="button"
                className={`av-composer-btn av-composer-btn-ghost av-composer-tool av-pop-conv-toggle${historyOpen ? " is-active" : ""}`}
                title="会话(历史/新建/删除)"
                aria-label="会话管理"
                onClick={() => setHistoryOpen((v) => !v)}
              >
                <Icon name="history" size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className="av-composer-input"
            placeholder={isMobileMq ? "说出你的创意,或输入 @ 调用技能/引用主体…" : "说出你的创意,或输入 @ 调用技能/引用主体…（Enter 发送 / Shift+Enter 换行）"}
            value={input}
            onChange={(e) => {
              setInput(e.target.value);
              setSkillDismissed(false); // 输入变化时重新允许 @ 面板弹出
            }}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
          />
          <div className="av-composer-actions">
            <button
              type="button"
              className="av-composer-btn av-composer-send"
              onClick={() => send()}
              disabled={!input.trim() || busy}
              title="发送"
            >
              <Icon name="send" size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </div>
      <div className="av-composer-hint">
        <span>内容由 AI 生成，请注意甄别</span>
      </div>
    </div>
  );
}
