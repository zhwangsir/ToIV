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
  /** error = 失败态气泡(不进历史、不回传后端) */
  kind?: "error";
}

// 后端无对话持久化接口(仅 /api/agent/chat),会话按天存 localStorage 做轻量持久化
const CONV_STORAGE_KEY = (() => {
  const d = new Date();
  const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `toiv_av_convs_${day}`;
})();

// 等待首个响应块的超时;超时按「服务不可用」处理并允许重试
const FIRST_CHUNK_TIMEOUT_MS = 30000;

function loadStoredConversations(): Conversation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(CONV_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
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
  // pending = 已发送、等待首个响应块(打字指示器),出错即替换为错误气泡
  const [pending, setPending] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>(loadStoredConversations);
  const [activeConvId, setActiveConvId] = useState<string | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [contextOpen, setContextOpen] = useState(false);
  const [textareaRows, setTextareaRows] = useState(1);
  const [modelName, setModelName] = useState("L1 对话模型");
  const [isMobile, setIsMobile] = useState(false);
  const abortRef = useRef<boolean>(false);
  const abortControllerRef = useRef<AbortController | null>(null);
  const activeConvIdRef = useRef<string | null>(null);
  const userStoppedRef = useRef<boolean>(false);
  const gotFirstChunkRef = useRef<boolean>(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const isEmpty = messages.length === 0;

  // 移动端断点:placeholder 文案按端适配(移动端无 Enter 键)
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 768px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener("change", update);
    return () => mq.removeEventListener("change", update);
  }, []);

  // 会话列表变更即写入 localStorage(按天)
  useEffect(() => {
    try {
      localStorage.setItem(CONV_STORAGE_KEY, JSON.stringify(conversations));
    } catch {
      /* 存储满/隐私模式下静默忽略 */
    }
  }, [conversations]);

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
    activeConvIdRef.current = null;
    setInput("");
    setTextareaRows(1);
  }, []);

  // activeConvId 同步到 ref,供流式回调结束时拿到最新会话 id
  useEffect(() => {
    activeConvIdRef.current = activeConvId;
  }, [activeConvId]);

  const saveToHistory = useCallback((msgs: ChatMessage[], convId: string | null) => {
    // 错误气泡不进历史(本地兜底态,非真实对话内容)
    const cleaned = msgs.filter((m) => m.kind !== "error");
    if (cleaned.length === 0) return;
    const userMsg = cleaned.find((m) => m.role === "user");
    const title = userMsg ? getPreview(userMsg.content, 20) : "新对话";
    const now = Date.now();

    // id 在 updater 外生成,保证 StrictMode 双调用幂等
    let id = convId;
    if (!id) {
      id = genId();
      setActiveConvId(id);
      activeConvIdRef.current = id;
    }
    const finalId = id;
    setConversations((prev) => {
      const exists = prev.some((c) => c.id === finalId);
      if (exists) {
        return prev.map((c) =>
          c.id === finalId ? { ...c, messages: cleaned, title, updatedAt: now } : c
        );
      }
      const newConv: Conversation = {
        id: finalId,
        title,
        messages: cleaned,
        createdAt: now,
        updatedAt: now,
      };
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

  // 发起一次对话请求:立即进入 pending(打字指示器),30s 无首个响应块按失败处理,
  // 失败/超时 → 错误气泡 + 重试;成功/失败均写入历史
  const requestReply = useCallback(
    async (baseMsgs: ChatMessage[]) => {
      setBusy(true);
      setPending(true);
      abortRef.current = false;
      userStoppedRef.current = false;
      gotFirstChunkRef.current = false;

      const controller = new AbortController();
      abortControllerRef.current = controller;

      const timeoutId = window.setTimeout(() => {
        if (!gotFirstChunkRef.current) controller.abort();
      }, FIRST_CHUNK_TIMEOUT_MS);

      let failed = false;
      // 后端以 SSE msg 事件下发 {type:"error"}(如「主模型暂不可用」),HTTP 仍 200,
      // 必须显式识别为失败;同理,流正常结束但零内容也按失败处理
      let streamError = false;
      try {
        const apiMessages = baseMsgs
          .filter(
            (m) =>
              (m.role === "user" || m.role === "assistant") && m.kind !== "error"
          )
          .map((m) => ({ role: m.role, content: m.content }));

        let assistantMsg: ChatMessage | null = null;

        await agentChat(
          apiMessages,
          (ev: AgentEvent) => {
            if (controller.signal.aborted) return;
            if (!gotFirstChunkRef.current) {
              gotFirstChunkRef.current = true;
              window.clearTimeout(timeoutId);
              setPending(false);
            }
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
            } else if (ev.type === "error") {
              streamError = true;
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
      } catch {
        failed = true;
      } finally {
        window.clearTimeout(timeoutId);
        setBusy(false);
        setPending(false);
        abortRef.current = false;
        abortControllerRef.current = null;
      }

      // 流内错误或零内容空响应,统一按失败处理
      if (streamError || !gotFirstChunkRef.current) failed = true;

      // 用户主动停止:不补错误气泡,也不重写历史(保留已流出的内容)
      if (failed && userStoppedRef.current) return;

      if (failed) {
        const errMsg: ChatMessage = {
          id: genId(),
          role: "assistant",
          content: "回复失败:服务暂时不可用",
          timestamp: Date.now(),
          kind: "error",
        };
        setMessages((prev) => {
          const next = [...prev, errMsg];
          saveToHistory(next, activeConvIdRef.current);
          return next;
        });
      } else {
        setMessages((prev) => {
          saveToHistory(prev, activeConvIdRef.current);
          return prev;
        });
      }
    },
    [saveToHistory],
  );

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
      await requestReply(newMsgs);
    },
    [input, busy, messages, requestReply],
  );

  // 重试:摘掉末尾错误气泡,重发上一条用户消息所在的对话
  const retry = useCallback(() => {
    if (busy) return;
    const base =
      messages[messages.length - 1]?.kind === "error"
        ? messages.slice(0, -1)
        : messages;
    setMessages(base);
    void requestReply(base);
  }, [busy, messages, requestReply]);

  const onStop = useCallback(() => {
    userStoppedRef.current = true;
    abortRef.current = true;
    abortControllerRef.current?.abort();
    setBusy(false);
    setPending(false);
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
            <div className="av-empty-title">今天想创作什么?</div>
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
                  <div className={`av-msg-bubble${msg.kind === "error" ? " av-msg-bubble--error" : ""}`}>
                    {msg.kind === "error" ? (
                      <>
                        <span className="av-msg-error-text">{msg.content}</span>
                        <button
                          type="button"
                          className="av-msg-retry"
                          onClick={retry}
                          disabled={busy}
                          title="重发上一条消息"
                        >
                          <Icon name="refresh" size={12} strokeWidth={1.8} />
                          <span>重试</span>
                        </button>
                      </>
                    ) : msg.content || msg.media?.length ? (
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
            {pending && (
              <div className="av-msg is-assistant" aria-live="polite">
                <div className="av-msg-avatar">
                  <Icon name="braincircuit" size={13} strokeWidth={1.8} />
                </div>
                <div className="av-msg-body">
                  <div className="av-msg-bubble">
                    <span className="av-typing">
                      <span className="av-typing-dot" />
                      <span className="av-typing-dot" />
                      <span className="av-typing-dot" />
                    </span>
                  </div>
                </div>
              </div>
            )}
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
              <button
                type="button"
                className="av-composer-btn av-composer-btn-ghost av-composer-tool"
                title="工具菜单（开发中）"
                onClick={() => toast.info("附件与工具菜单即将上线")}
              >
                <Icon name="plus" size={14} strokeWidth={1.8} />
              </button>
            )}
          </div>
          <textarea
            ref={textareaRef}
            className="av-composer-input"
            placeholder={isMobile ? "输入你的创作需求…" : "输入你的创作需求…（Enter 发送 / Shift+Enter 换行）"}
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
                        {conv.messages.length} 条消息 · {formatTime(conv.updatedAt)}
                      </span>
                    </div>
                  </button>
                  <button
                    type="button"
                    className="av-conv-delete"
                    onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                    title="删除对话"
                  >
                    <Icon name="delete" size={11} strokeWidth={1.8} />
                  </button>
                </div>
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
          background: var(--bg-canvas);
          overflow: hidden;
        }

        /* ───── 顶部工具栏 ───── */
        .av-toolbar {
          flex-shrink: 0;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--space-3);
          padding: var(--space-2) var(--space-3);
          background: var(--bg-surface-1);
          border-bottom: 1px solid var(--border-subtle);
          z-index: 5;
        }
        .av-tb-left,
        .av-tb-right {
          display: flex;
          align-items: center;
          gap: var(--space-2);
        }
        .av-tb-center {
          display: flex;
          align-items: center;
          gap: var(--space-2);
          min-width: 0;
        }

        .av-tb-btn {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          height: 28px;
          padding: 0 var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-control);
          color: var(--text-secondary);
          font-size: var(--text-aux);
          font-weight: 500;
          font-family: var(--font-sans);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-tb-btn:hover:not(:disabled) {
          color: var(--text-primary);
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
        }
        .av-tb-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
          pointer-events: none;
        }
        .av-tb-btn.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
          color: var(--accent);
        }
        .av-tb-btn-ghost {
          background: transparent;
        }

        .av-model-pill {
          display: inline-flex;
          align-items: center;
          gap: var(--space-2);
          height: 26px;
          padding: 0 var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-full);
          color: var(--text-secondary);
          font-size: var(--text-label);
          font-weight: 500;
          font-family: var(--font-mono);
          letter-spacing: 0.02em;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .av-model-pill--sm {
          height: 22px;
          padding: 0 var(--space-2);
        }
        .av-model-dot {
          flex-shrink: 0;
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--ok);
          box-shadow: 0 0 6px color-mix(in oklab, var(--ok) 60%, transparent);
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
          background: var(--bg-canvas);
        }
        .av-chat-wrap::-webkit-scrollbar {
          width: 6px;
        }
        .av-chat-wrap::-webkit-scrollbar-track {
          background: transparent;
        }
        .av-chat-wrap::-webkit-scrollbar-thumb {
          background: var(--bg-surface-3);
          border-radius: 3px;
        }

        /* 点阵网格背景(极弱,仅作画布质感) */
        .av-dot-grid {
          position: absolute;
          inset: 0;
          background-image: radial-gradient(circle, var(--border-strong) 1px, transparent 1px);
          background-size: 20px 20px;
          background-position: 0 0;
          opacity: 0.5;
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
          gap: var(--space-3);
          padding: var(--space-12) var(--space-8) var(--space-8);
          min-height: 100%;
          text-align: center;
        }
        .av-empty-title {
          font-size: 32px;
          font-weight: 650;
          color: var(--text-primary);
          letter-spacing: -0.02em;
        }
        .av-empty-desc {
          font-size: var(--text-body);
          color: var(--text-muted);
          line-height: 1.6;
          max-width: 400px;
          margin-bottom: var(--space-4);
        }
        .av-quick-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: var(--space-2);
          width: 100%;
          max-width: 480px;
        }
        .av-quick-card {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-1);
          padding: var(--space-3) var(--space-4);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          cursor: pointer;
          text-align: left;
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-quick-card:hover {
          background: var(--bg-surface-2);
          border-color: var(--border-strong);
        }
        .av-quick-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 26px;
          height: 26px;
          border-radius: var(--radius-control);
          background: var(--accent-soft);
          color: var(--accent);
          margin-bottom: var(--space-1);
        }
        .av-quick-label {
          font-size: var(--text-body);
          font-weight: 600;
          color: var(--text-primary);
        }
        .av-quick-desc {
          font-size: var(--text-aux);
          /* AA 对比度:text-muted 在 surface-1 卡片上仅 ~3.4:1,用 secondary(≥4.5:1) */
          color: var(--text-secondary);
          line-height: 1.45;
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
          gap: var(--space-5);
          /* 顶部让位灵动岛,首条气泡不贴岛 */
          padding: var(--space-12) var(--space-6) var(--space-6);
          max-width: 760px;
          margin: 0 auto;
        }
        .av-msg {
          display: flex;
          gap: var(--space-3);
          align-items: flex-start;
        }
        .av-msg.is-user {
          flex-direction: row-reverse;
        }
        .av-msg-avatar {
          flex-shrink: 0;
          width: 28px;
          height: 28px;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          color: var(--text-secondary);
        }
        .av-msg.is-user .av-msg-avatar {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
          color: var(--accent);
        }
        .av-msg-body {
          display: flex;
          flex-direction: column;
          gap: var(--space-1);
          max-width: calc(100% - 44px);
          min-width: 0;
        }
        .av-msg.is-user .av-msg-body {
          align-items: flex-end;
        }
        .av-msg-bubble {
          padding: var(--space-3) var(--space-4);
          background: var(--bg-surface-1);
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          font-size: var(--text-body);
          color: var(--text-primary);
          line-height: 1.6;
          word-break: break-word;
          white-space: pre-wrap;
        }
        .av-msg.is-user .av-msg-bubble {
          background: var(--accent);
          border-color: transparent;
          color: var(--text-on-accent);
        }
        .av-msg-time {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
          padding: 0 var(--space-1);
        }

        /* 失败态错误气泡(替换打字指示器) */
        .av-msg-bubble--error {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: var(--space-2);
          background: var(--err-soft);
          border-color: color-mix(in oklab, var(--err) 45%, transparent);
        }
        .av-msg-error-text {
          color: var(--err);
          font-size: var(--text-body);
        }
        .av-msg-retry {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          height: 26px;
          padding: 0 var(--space-3);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-strong);
          border-radius: var(--radius-control);
          color: var(--text-primary);
          font-size: var(--text-aux);
          font-weight: 500;
          font-family: var(--font-sans);
          cursor: pointer;
          transition: color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-msg-retry:hover:not(:disabled) {
          color: var(--accent);
          border-color: var(--accent-glow);
          background: var(--bg-surface-3);
        }
        .av-msg-retry:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }

        /* 媒体产物 */
        .av-media {
          margin-top: var(--space-2);
          max-width: 100%;
        }
        .av-media-img,
        .av-media-video,
        .av-media-audio {
          display: block;
          max-width: 100%;
          border-radius: var(--radius-control);
          border: 1px solid var(--border-subtle);
          background: var(--bg-canvas);
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
          gap: var(--space-1);
          padding: var(--space-2) var(--space-3);
          border-radius: var(--radius-control);
          background: var(--bg-surface-2);
          border: 1px solid var(--border-subtle);
          color: var(--accent);
          font-size: var(--text-aux);
          text-decoration: none;
          transition: border-color var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard);
        }
        .av-media-link:hover {
          border-color: var(--border-strong);
          background: var(--bg-surface-3);
        }

        /* 打字指示器(运行态,用 --run) */
        .av-typing {
          display: inline-flex;
          align-items: center;
          gap: var(--space-1);
          padding: var(--space-1) 0;
        }
        .av-typing-dot {
          width: 5px;
          height: 5px;
          border-radius: 50%;
          background: var(--run);
          animation: av-typing-pulse 1.2s ease-in-out infinite;
        }
        .av-typing-dot:nth-child(2) { animation-delay: 0.15s; }
        .av-typing-dot:nth-child(3) { animation-delay: 0.3s; }
        @keyframes av-typing-pulse {
          0%, 60%, 100% { opacity: 0.25; }
          30% { opacity: 1; }
        }

        /* ───── 输入区(composer) ───── */
        .av-composer {
          flex-shrink: 0;
          padding: var(--space-3) var(--space-4) var(--space-4);
          background: linear-gradient(180deg, transparent 0%, var(--bg-surface-1) 18%);
          border-top: 1px solid var(--border-subtle);
          z-index: 5;
        }
        .av-composer-box {
          position: relative;
          display: flex;
          align-items: flex-end;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
          background: linear-gradient(145deg, var(--bg-surface-2), var(--bg-surface-3));
          border: 1px solid var(--border-subtle);
          border-radius: var(--radius-panel);
          box-shadow:
            inset 0 1px 1px color-mix(in oklab, var(--text-primary) 4%, transparent),
            0 1px 2px color-mix(in oklab, var(--bg-canvas) 20%, transparent);
          transition: border-color var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard);
          overflow: hidden;
        }
        .av-composer-box::before {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: inherit;
          padding: 1px;
          background: linear-gradient(160deg, color-mix(in oklab, var(--accent) 10%, transparent), transparent 60%);
          -webkit-mask: linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0);
          -webkit-mask-composite: xor;
          mask-composite: exclude;
          opacity: 0;
          transition: opacity var(--duration-fast) var(--ease-standard);
          pointer-events: none;
        }
        .av-composer-box:hover {
          border-color: var(--border-strong);
          transform: translateY(-1px);
          box-shadow:
            inset 0 1px 1px color-mix(in oklab, var(--text-primary) 5%, transparent),
            0 4px 12px color-mix(in oklab, var(--bg-canvas) 25%, transparent);
        }
        .av-composer-box:hover::before {
          opacity: 1;
        }
        .av-composer-box:focus-within {
          border-color: var(--accent-glow);
          box-shadow:
            0 0 0 1px var(--accent-glow),
            0 0 24px color-mix(in oklab, var(--accent) 18%, transparent),
            inset 0 1px 1px color-mix(in oklab, var(--text-primary) 5%, transparent);
        }
        .av-composer-box:focus-within::after {
          content: "";
          position: absolute;
          left: 50%;
          top: 50%;
          width: 12px;
          height: 12px;
          transform: translate(-50%, -50%);
          border-radius: 50%;
          background: color-mix(in oklab, var(--accent) 25%, transparent);
          animation: av-composer-ripple 0.9s var(--ease-standard) forwards;
          pointer-events: none;
          z-index: 0;
        }
        @keyframes av-composer-ripple {
          0% { width: 12px; height: 12px; opacity: 0.5; }
          100% { width: 120%; height: 120%; opacity: 0; }
        }
        .av-composer-actions {
          position: relative;
          z-index: 1;
          display: flex;
          align-items: center;
          gap: var(--space-1);
          padding-bottom: 2px;
        }
        .av-composer-actions--left {
          margin-right: auto;
        }
        .av-composer-btn {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: 50%;
          background: transparent;
          border: none;
          color: var(--text-muted);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard),
            transform var(--duration-fast) var(--ease-standard),
            box-shadow var(--duration-fast) var(--ease-standard);
        }
        .av-composer-btn:hover:not(:disabled) {
          background: var(--bg-surface-2);
          color: var(--text-primary);
          transform: scale(1.08);
        }
        .av-composer-btn:active:not(:disabled) {
          transform: scale(0.94);
        }
        .av-composer-btn:disabled {
          opacity: 0.4;
          cursor: not-allowed;
        }
        /* 发送:primary(accent),运行中由 stop 按钮接管 */
        .av-composer-send {
          background: var(--accent);
          color: var(--text-on-accent);
          box-shadow: 0 2px 8px color-mix(in oklab, var(--accent) 30%, transparent);
        }
        .av-composer-send:hover:not(:disabled) {
          background: var(--accent-hover);
          color: var(--text-on-accent);
          transform: scale(1.08);
          box-shadow: 0 4px 14px color-mix(in oklab, var(--accent) 45%, transparent);
        }
        .av-composer-send:active:not(:disabled) {
          transform: scale(0.96);
        }
        .av-composer-send:disabled {
          background: var(--bg-surface-2);
          color: var(--text-muted);
          box-shadow: none;
        }
        /* 停止:运行态专用 --run */
        .av-composer-stop {
          background: var(--run-soft);
          color: var(--run);
          animation: av-stop-breathe 2s ease-in-out infinite;
        }
        @keyframes av-stop-breathe {
          0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--run) 25%, transparent); }
          50% { box-shadow: 0 0 0 6px color-mix(in oklab, var(--run) 0%, transparent); }
        }
        .av-composer-stop:hover {
          background: var(--run);
          color: var(--text-on-accent);
          transform: scale(1.08);
        }
        .av-composer-stop:active {
          transform: scale(0.94);
        }
        .av-composer-tool {
          position: relative;
        }
        .av-composer-tool::after {
          content: "";
          position: absolute;
          inset: 0;
          border-radius: 50%;
          border: 1px dashed var(--border-strong);
          opacity: 0.5;
          animation: av-tool-rotate 12s linear infinite;
        }
        @keyframes av-tool-rotate {
          0% { transform: rotate(0deg); }
          100% { transform: rotate(360deg); }
        }
        .av-composer-input {
          position: relative;
          z-index: 1;
          flex: 1;
          min-width: 0;
          resize: none;
          border: none;
          background: transparent;
          color: var(--text-primary);
          font-size: var(--text-body);
          font-family: var(--font-sans);
          line-height: 1.55;
          padding: calc(var(--space-1) + 2px) var(--space-2) calc(var(--space-1) + 2px) 0;
          outline: none;
          max-height: 176px;
        }
        .av-composer-input::placeholder {
          color: var(--text-muted);
          animation: av-placeholder-breathe 3s ease-in-out infinite;
        }
        @keyframes av-placeholder-breathe {
          0%, 100% { opacity: 0.7; }
          50% { opacity: 0.95; }
        }
        .av-composer-input:disabled {
          opacity: 0.5;
        }
        .av-composer-hint {
          display: flex;
          justify-content: center;
          margin-top: var(--space-2);
        }
        .av-composer-hint span {
          font-size: var(--text-label);
          color: var(--text-muted);
        }

        /* ───── 侧边面板(历史 / 模型设置) ───── */
        .av-panel {
          position: absolute;
          top: 0;
          bottom: 0;
          width: 280px;
          display: flex;
          flex-direction: column;
          background: var(--bg-surface-1);
          z-index: 15;
          transition: transform var(--duration-base) var(--ease-standard);
          box-shadow: var(--shadow-xl);
        }
        .av-panel--left {
          left: 0;
          border-right: 1px solid var(--border-subtle);
          transform: translateX(-100%);
        }
        .av-panel--right {
          right: 0;
          border-left: 1px solid var(--border-subtle);
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
          padding: var(--space-3) var(--space-4);
          border-bottom: 1px solid var(--border-subtle);
        }
        .av-panel-title {
          font-size: var(--text-label);
          font-weight: 500;
          color: var(--text-secondary);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .av-panel-close {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 24px;
          height: 24px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          cursor: pointer;
          transition: background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .av-panel-close:hover {
          background: var(--bg-surface-2);
          color: var(--text-primary);
        }
        .av-panel-body {
          flex: 1;
          overflow-y: auto;
          padding: var(--space-3);
        }
        .av-panel-empty {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--space-2);
          padding: var(--space-8) var(--space-4);
          color: var(--text-muted);
          font-size: var(--text-aux);
        }

        /* 对话列表 */
        .av-conv-list {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .av-conv-item {
          display: flex;
          align-items: flex-start;
          gap: var(--space-2);
          padding: var(--space-2) var(--space-3);
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-control);
          transition: background-color var(--duration-fast) var(--ease-standard),
            border-color var(--duration-fast) var(--ease-standard);
        }
        .av-conv-main {
          flex: 1;
          min-width: 0;
          display: flex;
          background: transparent;
          border: none;
          padding: 0;
          text-align: left;
          cursor: pointer;
          border-radius: var(--radius-control);
        }
        .av-conv-item:hover {
          background: var(--bg-surface-2);
          border-color: var(--border-subtle);
        }
        .av-conv-item.is-active {
          background: var(--accent-soft);
          border-color: var(--accent-glow);
        }
        .av-conv-info {
          flex: 1;
          min-width: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .av-conv-title {
          font-size: var(--text-aux);
          font-weight: 500;
          color: var(--text-primary);
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }
        .av-conv-item.is-active .av-conv-title {
          color: var(--accent);
        }
        .av-conv-meta {
          font-size: var(--text-label);
          color: var(--text-muted);
          font-family: var(--font-mono);
        }
        .av-conv-delete {
          flex-shrink: 0;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          width: 20px;
          height: 20px;
          border-radius: var(--radius-sm);
          color: var(--text-muted);
          opacity: 0;
          transition: opacity var(--duration-fast) var(--ease-standard),
            background-color var(--duration-fast) var(--ease-standard),
            color var(--duration-fast) var(--ease-standard);
        }
        .av-conv-item:hover .av-conv-delete,
        .av-conv-delete:focus-visible {
          opacity: 1;
        }
        .av-conv-delete:hover {
          background: var(--err-soft);
          color: var(--err);
        }

        /* 属性组 */
        .av-prop-group {
          display: flex;
          flex-direction: column;
          gap: var(--space-2);
          padding: var(--space-3) 0;
          border-bottom: 1px solid var(--border-subtle);
        }
        .av-prop-group:last-child {
          border-bottom: none;
        }
        .av-prop-label {
          font-size: var(--text-label);
          font-weight: 500;
          color: var(--text-muted);
          text-transform: uppercase;
          letter-spacing: 0.04em;
        }
        .av-prop-value {
          font-size: var(--text-aux);
          color: var(--text-primary);
        }
        .av-prop-desc {
          margin: 0;
          font-size: var(--text-aux);
          color: var(--text-secondary);
          line-height: 1.55;
        }
        .av-stats-row {
          display: flex;
          gap: var(--space-4);
        }
        .av-stat {
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .av-stat-value {
          font-size: var(--text-title);
          font-weight: 600;
          color: var(--text-primary);
          font-family: var(--font-mono);
          font-variant-numeric: tabular-nums;
        }
        .av-stat-label {
          font-size: var(--text-label);
          color: var(--text-muted);
        }

        /* 遮罩 */
        .av-panel-overlay {
          position: absolute;
          inset: 0;
          background: var(--overlay-light);
          backdrop-filter: blur(2px);
          z-index: 10;
          animation: av-overlay-in var(--duration-fast) var(--ease-standard);
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
            gap: var(--space-1);
            padding: var(--space-2);
          }
          .av-tb-btn span {
            display: none;
          }
          .av-msg-list {
            padding: var(--space-8) var(--space-4) var(--space-4);
          }
          .av-quick-grid {
            grid-template-columns: 1fr;
          }
          .av-panel {
            width: 85vw;
            max-width: 300px;
          }
          .av-composer {
            padding: var(--space-2) var(--space-3) var(--space-3);
          }
        }
      `}</style>
    </div>
  );
}
