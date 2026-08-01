"use client";

import { useState, useRef, useEffect, useCallback } from "react";
import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import { agentChat, AgentEvent, getLlmModel } from "@/lib/api";
import { genId } from "@/lib/id";

// 模型名从 /api/system/llm 动态读取(display_model),不再硬编码;desc 为通用说明
const MODEL_DESC = "本地 L1 快速对话模型，适合灵感捕获、提示词润色、简单问答";

interface Conversation {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
  media?: { type: string; urls: string[] }[];
}

const QUICK_ACTIONS = [
  { icon: "sparkles" as const, label: "文生图提示词", prompt: "帮我写一段高质量的文生图提示词，主题是：赛博朋克风格的未来城市夜景，要求细节丰富、光影逼真" },
  { icon: "file" as const, label: "剧本大纲", prompt: "帮我生成一个1分钟短剧的剧本大纲，主题：职场逆袭，要求有反转" },
  { icon: "image" as const, label: "图生图参考", prompt: "我想做图生图，请告诉我需要准备什么，以及如何写参考图的描述提示词" },
  { icon: "clapperboard" as const, label: "分镜脚本", prompt: "帮我写一个产品广告的分镜脚本，要求5-8个镜头，节奏紧凑" },
];

function getPreview(text: string, max = 28) {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}


export function AssistantView() {
  const toast = useToast();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [textareaRows, setTextareaRows] = useState(1);
  const [modelName, setModelName] = useState("L1 对话模型");
  const abortRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isEmpty = messages.length === 0;

  // 顶栏/设置面板的模型名跟随后端真实配置,避免显示与实际调用不一致
  useEffect(() => {
    const ac = new AbortController();
    getLlmModel(ac.signal).then((info) => {
      if (info?.display_model) setModelName(info.display_model);
    });
    return () => ac.abort();
  }, []);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, busy]);

  useEffect(() => {
    if (textareaRef.current) {
      const lineCount = input.split("\n").length;
      const newRows = Math.min(Math.max(lineCount, 1), 8);
      setTextareaRows(newRows);
      textareaRef.current.style.height = "auto";
      textareaRef.current.style.height = Math.min(newRows * 22, 176) + "px";
    }
  }, [input]);

  const onNewChat = useCallback(() => {
    setMessages([]);
    setActiveConvId(null);
    setInput("");
    setTextareaRows(1);
  }, []);

  const saveToHistory = useCallback((msgs: ChatMessage[], convId: string | null) => {
    if (msgs.length === 0) return;
    const userMsg = msgs.find((m) => m.role === "user");
    const title = userMsg ? getPreview(userMsg.content, 20) : "新对话";
    const now = Date.now();

    setConversations((prev) => {
      if (convId) {
        return prev.map((c) =>
          c.id === convId ? { ...c, messages: msgs, title, updatedAt: now } : c
        );
      }
      const newConv: Conversation = {
        id: genId(),
        title,
        messages: msgs,
        createdAt: now,
        updatedAt: now,
      };
      setActiveConvId(newConv.id);
      return [newConv, ...prev];
    });
  }, []);

  const loadConversation = useCallback((conv: Conversation) => {
    setMessages(conv.messages);
    setActiveConvId(conv.id);
    setInput("");
    setTextareaRows(1);
    setHistoryOpen(false);
  }, []);

  const deleteConversation = useCallback((id: string) => {
    setConversations((prev) => prev.filter((c) => c.id !== id));
    if (activeConvId === id) {
      onNewChat();
    }
  }, [activeConvId, onNewChat]);

  const typeResponse = useCallback(async (text: string) => {
    const assistantMsg: ChatMessage = {
      id: genId(),
      role: "assistant",
      content: "",
      timestamp: Date.now(),
    };
    setMessages((prev) => [...prev, assistantMsg]);

    for (let i = 0; i < text.length; i++) {
      if (abortRef.current) break;
      await new Promise((r) => setTimeout(r, 15 + Math.random() * 25));
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === "assistant") {
          return [...prev.slice(0, -1), { ...last, content: last.content + text[i] }];
        }
        return prev;
      });
    }

    setMessages((prev) => {
      saveToHistory(prev, activeConvId);
      return prev;
    });
  }, [activeConvId, saveToHistory]);

  const send = useCallback(
    async (presetPrompt?: string) => {
      const text = (presetPrompt ?? input).trim();
      if (!text || busy) return;

      const userMsg: ChatMessage = {
        id: genId(),
        role: "user",
        content: text,
        timestamp: Date.now(),
      };
      const newMsgs = [...messages, userMsg];
      setMessages(newMsgs);
      if (!presetPrompt) {
        setInput("");
        setTextareaRows(1);
      }
      setBusy(true);
      abortRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      try {
        const apiMessages = newMsgs
          .filter((m) => m.role === "user" || m.role === "assistant")
          .map((m) => ({ role: m.role, content: m.content }));

        let assistantMsg: ChatMessage | null = null;

        await agentChat(
          apiMessages,
          (ev: AgentEvent) => {
            if (controller.signal.aborted) return;
            if (ev.type === "text") {
              const delta = ev.content || "";
              if (!assistantMsg) {
                assistantMsg = {
                  id: genId(),
                  role: "assistant",
                  content: delta,
                  timestamp: Date.now(),
                };
                setMessages((prev) => [...prev, assistantMsg!]);
              } else {
                setMessages((prev) => {
                  const last = prev[prev.length - 1];
                  if (last && last.id === assistantMsg!.id) {
                    return [
                      ...prev.slice(0, -1),
                      { ...last, content: last.content + delta },
                    ];
                  }
                  return prev;
                });
              }
            } else if (
              ["image", "video", "audio", "model3d"].includes(ev.type)
            ) {
              setMessages((prev) => {
                const last = prev[prev.length - 1];
                if (!last || last.role !== "assistant") return prev;
                const media = [
                  ...(last.media || []),
                  { type: ev.type, urls: ev.urls || [] },
                ];
                return [...prev.slice(0, -1), { ...last, media }];
              });
            }
          },
          null,
          controller.signal,
        );
      } catch (err) {
        toast.error("对话请求失败，请检查模型服务状态");
      } finally {
        setBusy(false);
        abortRef.current = false;
        abortControllerRef.current = null;
      }
    },
    [input, busy, messages, toast],
  );

  const onStop = useCallback(() => {
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setBusy(false);
  }, []);

  const onKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      send();
    }
  }, [send]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  };

  return (
    <div className="av-view">
      <h1 className="sr-only">对话流</h1>
      <header className="av-toolbar">
        <div className="av-tb-left">
          <button
            type="button"
            className={`av-tb-btn${historyOpen ? " is-active" : ""}`}
            onClick={() => setHistoryOpen((v) => !v)}
            title="对话历史"
            aria-label="对话历史"
          >
            <Icon name="history" size={14} strokeWidth={1.8} />
            <span>历史</span>
          </button>
          <button
            type="button"
            className="av-tb-btn av-tb-btn-ghost"
            onClick={onNewChat}
            title="新对话"
            aria-label="新对话"
          >
            <Icon name="create" size={14} strokeWidth={1.8} />
            <span>新建</span>
          </button>
        </div>

        <div className="av-tb-center">
          <div className="av-model-pill">
            <span className="av-model-dot" />
            <Icon name="braincircuit" size={12} strokeWidth={1.8} />
            {modelName}
          </div>
        </div>

        <div className="av-tb-right">
          <button
            type="button"
            className={`av-tb-btn${contextOpen ? " is-active" : ""}`}
            onClick={() => setContextOpen((v) => !v)}
            title="上下文设置"
            aria-label="上下文设置"
          >
            <Icon name="admin" size={14} strokeWidth={1.8} />
            <span>设置</span>
          </button>
        </div>
      </header>

      <div className="av-chat-wrap" ref={scrollRef}>
        <div className="av-dot-grid" aria-hidden="true" />

        {isEmpty ? (
          <div className="av-empty">
            <div className="av-empty-icon">
              <Icon name="chat" size={48} strokeWidth={1.1} />
            </div>
            <div className="av-empty-title">ToIV 对话助手</div>
            <div className="av-empty-desc">{MODEL_DESC}</div>
            <div className="av-quick-grid">
              {QUICK_ACTIONS.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  className="av-quick-card"
                  onClick={() => send(a.prompt)}
                >
                  <span className="av-quick-icon">
                    <Icon name={a.icon} size={14} strokeWidth={1.8} />
                  </span>
                  <span className="av-quick-label">{a.label}</span>
                  <span className="av-quick-desc">{getPreview(a.prompt, 36)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="av-msg-list">
            {messages.map((msg) => (
              <div
                key={msg.id}
                className={`av-msg${msg.role === "user" ? " is-user" : " is-assistant"}`}
              >
                <div className="av-msg-avatar">
                  <Icon name={msg.role === "user" ? "user" : "braincircuit"} size={13} strokeWidth={1.8} />
                </div>
                <div className="av-msg-body">
                  <div className="av-msg-bubble">
                    {msg.content || msg.media?.length ? (
                      <>
                        {msg.content}
                        {msg.media?.map((m, idx) => (
                          <div key={idx} className="av-media">
                            {m.type === "image" && m.urls[0] && (
                              <img
                                src={m.urls[0]}
                                alt="生成结果"
                                className="av-media-img"
                                loading="lazy"
                              />
                            )}
                            {m.type === "video" && m.urls[0] && (
                              <video
                                src={m.urls[0]}
                                controls
                                className="av-media-video"
                              />
                            )}
                            {m.type === "audio" && m.urls[0] && (
                              <audio
                                src={m.urls[0]}
                                controls
                                className="av-media-audio"
                              />
                            )}
                            {m.type === "model3d" && m.urls[0] && (
                              <a
                                href={m.urls[0]}
                                target="_blank"
                                rel="noreferrer"
                                className="av-media-link"
                              >
                                <Icon name="box" size={14} strokeWidth={1.8} />
                                3D 模型
                              </a>
                            )}
                          </div>
                        ))}
                      </>
                    ) : (
                      <span className="av-typing">
                        <span className="av-typing-dot" />
                        <span className="av-typing-dot" />
                        <span className="av-typing-dot" />
                      </span>
                    )}
                  </div>
                  <span className="av-msg-time">{formatTime(msg.timestamp)}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="av-composer">
        <div className="av-composer-box">
          <div className="av-composer-actions av-composer-actions--left">
            {busy ? (
              <button type="button" className="av-composer-btn av-composer-stop" onClick={onStop} title="停止生成">
                <Icon name="minus" size={12} strokeWidth={2.2} />
              </button>
            ) : (
              <button type="button" className="av-composer-btn av-composer-btn-ghost" title="附件（开发中）" disabled>
                <Icon name="plus" size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className="av-composer-input"
            placeholder="输入你的创作需求…（Enter 发送 / Shift+Enter 换行）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={textareaRows}
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
        <div className="av-composer-hint">
          <span>内容由 AI 生成，请注意甄别</span>
        </div>
      </div>

      <div className={`av-panel av-panel--left${historyOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <span className="av-panel-title">对话历史</span>
          <button type="button" className="av-panel-close" onClick={() => setHistoryOpen(false)} aria-label="关闭对话历史面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body">
          {conversations.length === 0 ? (
            <div className="av-panel-empty">
              <Icon name="chat" size={20} strokeWidth={1.4} />
              <span>暂无历史对话</span>
            </div>
          ) : (
            <div className="av-conv-list">
              {conversations.map((conv) => (
                <button
                  key={conv.id}
                  type="button"
                  className={`av-conv-item${activeConvId === conv.id ? " is-active" : ""}`}
                  onClick={() => loadConversation(conv)}
                >
                  <div className="av-conv-info">
                    <span className="av-conv-title">{conv.title}</span>
                    <span className="av-conv-meta">
                      {conv.messages.length} 条消息 · {formatTime(conv.updatedAt)}
                    </span>
                  </div>
                  <button
                    type="button"
                    className="av-conv-delete"
                    onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                    title="删除对话"
                  >
                    <Icon name="delete" size={11} strokeWidth={1.8} />
                  </button>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className={`av-panel av-panel--right${contextOpen ? " is-open" : ""}`}>
        <div className="av-panel-head">
          <span className="av-panel-title">模型设置</span>
          <button type="button" className="av-panel-close" onClick={() => setContextOpen(false)} aria-label="关闭模型设置面板" title="关闭">
            <Icon name="close" size={12} strokeWidth={1.8} />
          </button>
        </div>
        <div className="av-panel-body" tabIndex={0}>
          <div className="av-prop-group">
            <div className="av-prop-label">当前模型</div>
            <div className="av-prop-value">
              <div className="av-model-pill av-model-pill--sm">
                <span className="av-model-dot" />
                {modelName}
              </div>
            </div>
          </div>
          <div className="av-prop-group">
            <div className="av-prop-label">模型说明</div>
            <p className="av-prop-desc">{MODEL_DESC}</p>
          </div>
          <div className="av-prop-group">
            <div className="av-prop-label">对话统计</div>
            <div className="av-stats-row">
              <div className="av-stat">
                <span className="av-stat-value">{messages.length}</span>
                <span className="av-stat-label">消息</span>
              </div>
              <div className="av-stat">
                <span className="av-stat-value">{conversations.length}</span>
                <span className="av-stat-label">会话</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      {(historyOpen || contextOpen) && (
        <div
          className="av-panel-overlay"
          onClick={() => { setHistoryOpen(false); setContextOpen(false); }}
        />
      )}

      <style jsx global>{`
        .av-view {
          position: absolute;
          inset: 0;
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-0);
          overflow: hidden;
        }

        /* ───── 顶部工具栏（对齐 cv-toolbar）───── */
        .av-toolbar {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: 0.5rem 0.75rem;
          background: var(--bg-1);
          border-bottom: 1px solid var(--hairline);
          z-index: 5;
        }
        .av-tb-left,
        .av-tb-right {
          display: flex;
          align-items: center;
          gap: 0.4rem;
        }
        .av-tb-center {
          display: flex;
          align-items: center;
          gap: 0.5rem;
        }

        .av-tb-btn {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.32rem 0.6rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-xs);
          color: var(--ink-soft);
          font-size: 0.75rem;
          font-weight: 500;
          font-family: var(--font-sans);
          cursor: pointer;
          transition: color var(--dur) var(--ease),
            background-color var(--dur) var(--ease),
            border-color var(--dur) var(--ease);
        }
        .av-tb-btn:hover:not(:disabled) {
          color: var(--ink);
          border-color: var(--hairline-strong);
          background: var(--bg-3);
        }
        .av-tb-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        .av-tb-btn:focus-visible {
          outline: 2px solid var(--accent);
          outline-offset: 1px;
        }
        .av-tb-btn.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .av-tb-btn-ghost {
          background: transparent;
        }

        .av-model-pill {
          display: inline-flex;
          align-items: center;
          gap: 0.4rem;
          padding: 0.28rem 0.65rem;
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-full);
          color: var(--ink-soft);
          font-size: 0.72rem;
          font-weight: 500;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
        }
        .av-model-pill--sm {
          font-size: 0.7rem;
          padding: 0.22rem 0.5rem;
        }
        .av-model-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--success, #22c55e);
          box-shadow: 0 0 6px color-mix(in oklab, var(--success, #22c55e) 60%, transparent);
          animation: av-dot-pulse 2s ease-in-out infinite;
        }
        @keyframes av-dot-pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }

        /* ───── 聊天主区域 ───── */
        .av-chat-wrap {
          position: relative;
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          overflow-x: hidden;
          background: var(--bg-0);
        }
        .av-chat-wrap::-webkit-scrollbar {
          width: 6px;
        }
        .av-chat-wrap::-webkit-scrollbar-track {
          background: transparent;
        }
        .av-chat-wrap::-webkit-scrollbar-thumb {
          background: var(--hairline-strong);
          border-radius: 3px;
          opacity: 0.5;
        }

        /* 点阵网格背景（对齐 Canvas Dots Background） */
        .av-dot-grid {
          position: absolute;
          inset: 0;
          background-image: radial-gradient(circle, var(--hairline-strong) 1px, transparent 1px);
          background-size: 18px 18px;
          background-position: 0 0;
          opacity: 0.35;
          pointer-events: none;
          z-index: 0;
        }

        /* ───── 空态 ───── */
        .av-empty {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.8rem;
          padding: 3rem 2rem 2rem;
          min-height: 100%;
          text-align: center;
        }
        .av-empty-icon {
          color: var(--ink-faint);
          opacity: 0.5;
          margin-bottom: 0.4rem;
        }
        .av-empty-title {
          font-family: var(--font-display);
          font-size: 1.2rem;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.01em;
        }
        .av-empty-desc {
          font-size: 0.8rem;
          color: var(--ink-faint);
          line-height: 1.6;
          max-width: 380px;
          margin-bottom: 1rem;
        }
        .av-quick-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 0.5rem;
          width: 100%;
          max-width: 480px;
        }
        .av-quick-card {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 0.25rem;
          padding: 0.7rem 0.8rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          cursor: pointer;
          text-align: left;
          transition: all var(--dur) var(--ease);
        }
        .av-quick-card:hover {
          background: var(--bg-2);
          border-color: var(--hairline-strong);
          transform: translateY(-1px);
          box-shadow: var(--shadow-md);
        }
        .av-quick-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: var(--radius-xs);
          background: var(--accent-quiet);
          color: var(--accent-soft);
          margin-bottom: 0.15rem;
        }
        .av-quick-label {
          font-size: 0.78rem;
          font-weight: 600;
          color: var(--ink);
        }
        .av-quick-desc {
          font-size: 0.68rem;
          color: var(--ink-faint);
          line-height: 1.4;
          display: -webkit-box;
          -webkit-line-clamp: 2;
          -webkit-box-orient: vertical;
          overflow: hidden;
        }

        /* ───── 消息列表 ───── */
        .av-msg-list {
          position: relative;
          z-index: 1;
          display: flex;
          flex-direction: column;
          gap: 1rem;
          padding: 1.5rem;
          max-width: 760px;
          margin: 0 auto;
        }
        .av-msg {
          display: flex;
          gap: 0.6rem;
          align-items: flex-start;
        }
        .av-msg.is-user {
          flex-direction: row-reverse;
        }
        .av-msg-avatar {
          flex-shrink: 0;
          width: 26px;
          height: 26px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--radius-xs);
          background: var(--bg-2);
          border: 1px solid var(--hairline-2);
          color: var(--ink-soft);
        }
        .av-msg.is-user .av-msg-avatar {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
          color: var(--accent-soft);
        }
        .av-msg-body {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
          max-width: calc(100% - 44px);
          min-width: 0;
        }
        .av-msg.is-user .av-msg-body {
          align-items: flex-end;
        }
        .av-msg-bubble {
          padding: 0.55rem 0.75rem;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          font-size: 0.82rem;
          color: var(--ink);
          line-height: 1.65;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .av-msg.is-user .av-msg-bubble {
          background: var(--accent);
          border-color: transparent;
          color: var(--accent-ink);
        }
        .av-msg-time {
          font-size: 0.65rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
          padding: 0 0.2rem;
        }

        /* 媒体产物 */
        .av-media {
          margin-top: 0.5rem;
          max-width: 100%;
        }
        .av-media-img,
        .av-media-video,
        .av-media-audio {
          display: block;
          max-width: 100%;
          border-radius: var(--radius-xs);
          border: 1px solid var(--hairline);
          background: var(--bg-0);
        }
        .av-media-img {
          max-height: 320px;
          object-fit: contain;
        }
        .av-media-video {
          max-height: 240px;
        }
        .av-media-link {
          display: inline-flex;
          align-items: center;
          gap: 0.35rem;
          padding: 0.4rem 0.6rem;
          border-radius: var(--radius-xs);
          background: var(--bg-2);
          border: 1px solid var(--hairline);
          color: var(--accent-soft);
          font-size: 0.75rem;
          text-decoration: none;
        }

        /* 打字指示器 */
        .av-typing {
          display: inline-flex;
          align-items: center;
          gap: 0.25rem;
          padding: 0.15rem 0;
        }
        .av-typing-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--ink-faint);
          animation: av-typing-bounce 1.2s ease-in-out infinite;
        }
        .av-typing-dot:nth-child(2) { animation-delay: 0.15s; }
        .av-typing-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes av-typing-bounce {
          0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
          30% { transform: translateY(-4px); opacity: 1; }
        }

        /* ───── 输入区（composer）───── */
        .av-composer {
          flex-shrink: 0;
          padding: 0.75rem 1rem 1rem;
          background: var(--bg-1);
          border-top: 1px solid var(--hairline);
          z-index: 5;
        }
        .av-composer-box {
          display: flex;
          align-items: flex-end;
          gap: 0.5rem;
          padding: 0.5rem;
          background: var(--bg-0);
          border: 1px solid var(--hairline-2);
          border-radius: var(--radius-sm);
          transition: border-color var(--dur) var(--ease),
            box-shadow var(--dur) var(--ease);
        }
        .av-composer-box:focus-within {
          border-color: var(--accent-line);
          box-shadow: 0 0 0 2px var(--accent-quiet);
        }
        .av-composer-actions {
          display: flex;
          align-items: center;
          gap: 0.25rem;
          padding-bottom: 0.15rem;
        }
        .av-composer-actions--left {
          margin-right: auto;
        }
        .av-composer-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: var(--radius-xs);
          background: transparent;
          border: none;
          color: var(--ink-faint);
          cursor: pointer;
          transition: all var(--dur) var(--ease);
        }
        .av-composer-btn:hover:not(:disabled) {
          background: var(--bg-2);
          color: var(--ink-soft);
        }
        .av-composer-btn:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .av-composer-btn-ghost {
          opacity: 0.6;
        }
        .av-composer-send {
          background: var(--accent-quiet) !important;
          color: var(--accent-soft) !important;
        }
        .av-composer-send:hover:not(:disabled) {
          background: linear-gradient(135deg, var(--accent), var(--accent-deep)) !important;
          color: var(--accent-ink) !important;
        }
        .av-composer-send:disabled {
          opacity: 0.3 !important;
          background: var(--bg-2) !important;
          color: var(--ink-faint) !important;
        }
        .av-composer-stop {
          background: var(--warn-quiet, rgba(217,119,6,0.08)) !important;
          color: var(--warn, #d97706) !important;
        }
        .av-composer-stop:hover {
          background: var(--warn, #d97706) !important;
          color: white !important;
        }
        .av-composer-input {
          flex: 1;
          min-width: 0;
          resize: none;
          border: none;
          background: transparent;
          color: var(--ink);
          font-size: 0.82rem;
          font-family: var(--font-sans);
          line-height: 1.55;
          padding: 0.2rem 0.3rem;
          outline: none;
          max-height: 176px;
        }
        .av-composer-input::placeholder {
          color: var(--ink-faint);
        }
        .av-composer-input:disabled {
          opacity: 0.5;
        }
        .av-composer-hint {
          display: flex;
          justify-content: center;
          margin-top: 0.4rem;
        }
        .av-composer-hint span {
          font-size: 0.66rem;
          color: var(--ink-faint);
        }

        /* ───── 侧边面板（对齐 cv-add-popover 风格）───── */
        .av-panel {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 260px;
          display: flex;
          flex-direction: column;
          background: var(--bg-1);
          z-index: 15;
          transition: transform var(--dur-2) var(--ease),
            opacity var(--dur-2) var(--ease);
          box-shadow: var(--shadow-lg);
        }
        .av-panel--left {
          left: 0;
          border-right: 1px solid var(--hairline-2);
          transform: translateX(-100%);
        }
        .av-panel--right {
          right: 0;
          border-left: 1px solid var(--hairline-2);
          transform: translateX(100%);
        }
        .av-panel.is-open {
          transform: translateX(0);
        }
        .av-panel-head {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 0.6rem 0.75rem;
          border-bottom: 1px solid var(--hairline);
        }
        .av-panel-title {
          font-size: 0.75rem;
          font-weight: 600;
          color: var(--ink);
          text-transform: uppercase;
          letter-spacing: 0.05em;
        }
        .av-panel-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 22px;
          height: 22px;
          border-radius: var(--radius-xs);
          color: var(--ink-faint);
          cursor: pointer;
          transition: all var(--dur) var(--ease);
        }
        .av-panel-close:hover {
          background: var(--bg-2);
          color: var(--ink-soft);
        }
        .av-panel-body {
          flex: 1;
          overflow-y: auto;
          padding: 0.6rem;
        }
        .av-panel-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: 0.5rem;
          padding: 2rem 1rem;
          color: var(--ink-faint);
          font-size: 0.75rem;
        }

        /* 对话列表 */
        .av-conv-list {
          display: flex;
          flex-direction: column;
          gap: 0.2rem;
        }
        .av-conv-item {
          display: flex;
          align-items: flex-start;
          gap: 0.4rem;
          padding: 0.5rem 0.55rem;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-xs);
          cursor: pointer;
          text-align: left;
          transition: all var(--dur) var(--ease);
        }
        .av-conv-item:hover {
          background: var(--bg-2);
          border-color: var(--hairline);
        }
        .av-conv-item.is-active {
          background: var(--accent-quiet);
          border-color: var(--accent-line);
        }
        .av-conv-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
        }
        .av-conv-title {
          font-size: 0.78rem;
          font-weight: 500;
          color: var(--ink);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .av-conv-item.is-active .av-conv-title {
          color: var(--accent-soft);
        }
        .av-conv-meta {
          font-size: 0.65rem;
          color: var(--ink-faint);
          font-family: var(--font-mono);
        }
        .av-conv-delete {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border-radius: 3px;
          color: var(--ink-faint);
          opacity: 0;
          transition: all var(--dur) var(--ease);
        }
        .av-conv-item:hover .av-conv-delete {
          opacity: 1;
        }
        .av-conv-delete:hover {
          background: var(--danger-quiet, rgba(220,38,38,0.08));
          color: var(--danger, #dc2626);
        }

        /* 属性组 */
        .av-prop-group {
          display: flex;
          flex-direction: column;
          gap: 0.3rem;
          padding: 0.6rem 0;
          border-bottom: 1px solid var(--hairline);
        }
        .av-prop-group:last-child {
          border-bottom: none;
        }
        .av-prop-label {
          font-size: 0.65rem;
          font-weight: 600;
          color: var(--ink-faint);
          text-transform: uppercase;
          letter-spacing: 0.06em;
        }
        .av-prop-value {
          font-size: 0.78rem;
          color: var(--ink);
        }
        .av-prop-desc {
          margin: 0;
          font-size: 0.75rem;
          color: var(--ink-soft);
          line-height: 1.55;
        }
        .av-stats-row {
          display: flex;
          gap: 0.75rem;
        }
        .av-stat {
          display: flex;
          flex-direction: column;
          gap: 0.1rem;
        }
        .av-stat-value {
          font-size: 1.1rem;
          font-weight: 600;
          color: var(--ink);
          font-family: var(--font-mono);
        }
        .av-stat-label {
          font-size: 0.65rem;
          color: var(--ink-faint);
        }

        /* 遮罩 */
        .av-panel-overlay {
          position: absolute;
          inset: 0;
          background: color-mix(in oklch, var(--bg-0) 60%, transparent);
          backdrop-filter: blur(2px);
          z-index: 10;
          animation: av-overlay-in var(--dur) var(--ease);
        }
        @keyframes av-overlay-in {
          from { opacity: 0; }
          to { opacity: 1; }
        }

        @media (prefers-reduced-motion: reduce) {
          .av-model-dot { animation: none; }
          .av-typing-dot { animation: none; }
          .av-panel-overlay { animation: none; }
        }

        /* 移动端 */
        @media (max-width: 768px) {
          .av-toolbar {
            flex-wrap: wrap;
            gap: 0.3rem;
            padding: 0.4rem 0.5rem;
          }
          .av-tb-btn span {
            display: none;
          }
          .av-msg-list {
            padding: 1rem;
          }
          .av-quick-grid {
            grid-template-columns: 1fr;
          }
          .av-panel {
            width: 85vw;
            max-width: 300px;
          }
          .av-composer {
            padding: 0.5rem 0.75rem 0.75rem;
          }
        }
      `}</style>
    </div>
  );
}
