"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { agentChat, imageUrl, type AgentEvent } from "@/lib/api";
import { Icon } from "@/components/ui/Icon";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  /** 工具调用结果(图片等) */
  toolResults?: { name?: string; urls?: string[] }[];
  /** 流式生成中 */
  streaming?: boolean;
  /** 错误标记 */
  error?: boolean;
}

const SUGGESTIONS = [
  { icon: "create" as const, title: "画一张图", prompt: "画一张赛博朋克风格的城市夜景，霓虹灯光，雨天反射" },
  { icon: "video" as const, title: "生成视频", prompt: "帮我生成一段 3 秒的视频：一只猫在窗台上看雨景" },
  { icon: "audio" as const, title: "创作音乐", prompt: "创作一段 30 秒的轻钢琴曲，温暖的早晨感觉" },
  { icon: "model3d" as const, title: "生成 3D", prompt: "把一只可爱的卡通猫转成 3D 模型" },
];

export function AssistantView() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // 自动滚动到底部
  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
    });
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, scrollToBottom]);

  // 组件卸载时中止请求
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = useCallback(async (text?: string) => {
    const prompt = (text ?? input).trim();
    if (!prompt || busy) return;

    setInput("");
    setBusy(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: prompt,
    };
    const aiMsgId = crypto.randomUUID();
    const aiMsg: ChatMessage = {
      id: aiMsgId,
      role: "assistant",
      content: "",
      streaming: true,
      toolResults: [],
    };
    setMessages((prev) => [...prev, userMsg, aiMsg]);

    const history = [...messages, userMsg].map((m) => ({
      role: m.role,
      content: m.content,
    }));

    abortRef.current = new AbortController();

    try {
      await agentChat(
        history,
        (ev: AgentEvent) => {
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== aiMsgId) return m;
              const updated = { ...m };
              if (ev.type === "token" && ev.content) {
                updated.content += ev.content;
              } else if (ev.type === "tool_call") {
                updated.content += ev.content
                  ? ev.content
                  : `> 正在调用 ${ev.name ?? "工具"}...\n`;
              } else if (ev.type === "tool_result") {
                if (ev.urls && ev.urls.length > 0) {
                  updated.toolResults = [
                    ...(updated.toolResults ?? []),
                    { name: ev.name, urls: ev.urls },
                  ];
                }
                if (ev.content) {
                  updated.content += ev.content;
                }
              } else if (ev.type === "error") {
                updated.error = true;
                updated.content = ev.content ?? "对话出错";
              }
              return updated;
            }),
          );
          scrollToBottom();
        },
        null,
        abortRef.current.signal,
      );
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === aiMsgId
            ? { ...m, error: true, content: m.content || (err instanceof Error ? err.message : "对话失败") }
            : m,
        ),
      );
    } finally {
      setMessages((prev) =>
        prev.map((m) => (m.id === aiMsgId ? { ...m, streaming: false } : m)),
      );
      setBusy(false);
      abortRef.current = null;
    }
  }, [input, busy, messages, scrollToBottom]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  const onStop = () => {
    abortRef.current?.abort();
    setBusy(false);
  };

  const isEmpty = messages.length === 0;

  return (
    <div className="assistant-shell">
      <div className="assistant-messages" ref={scrollRef}>
        {isEmpty ? (
          <div className="assistant-welcome">
            <div className="assistant-welcome-orb" aria-hidden="true" />
            <h2 className="assistant-welcome-title">ToIV AI 助手</h2>
            <p className="assistant-welcome-desc">
              对话式创作 · 一句话启动图像 / 视频 / 3D / 音频生成
            </p>
            <div className="assistant-suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s.title}
                  className="assistant-suggestion"
                  onClick={() => send(s.prompt)}
                >
                  <span className="assistant-suggestion-icon">
                    <Icon name={s.icon} size={18} />
                  </span>
                  <span className="assistant-suggestion-body">
                    <span className="assistant-suggestion-title">{s.title}</span>
                    <span className="assistant-suggestion-prompt">{s.prompt}</span>
                  </span>
                </button>
              ))}
            </div>
          </div>
        ) : (
          <div className="assistant-message-list">
            {messages.map((msg) => (
              <MessageBubble key={msg.id} msg={msg} />
            ))}
            {busy && messages[messages.length - 1]?.streaming && (
              <div className="assistant-typing">
                <span /><span /><span />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="assistant-composer">
        <div className="assistant-composer-inner">
          <textarea
            className="assistant-input"
            placeholder="输入你的创作需求…  (Enter 发送 / Shift+Enter 换行)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
          />
          {busy ? (
            <button className="assistant-stop" onClick={onStop} aria-label="停止生成">
              <Icon name="close" size={16} />
            </button>
          ) : (
            <button
              className="assistant-send"
              onClick={() => send()}
              disabled={!input.trim()}
              aria-label="发送"
            >
              <Icon name="send" size={18} />
            </button>
          )}
        </div>
        <div className="assistant-composer-hint">
          GLM-5.2 · 工具自动调用 · 生成结果内联展示
        </div>
      </div>

      <style jsx>{`
        .assistant-shell {
          display: flex;
          flex-direction: column;
          height: 100%;
          background: var(--bg-0);
        }
        .assistant-messages {
          flex: 1;
          overflow-y: auto;
          overflow-x: hidden;
          scroll-behavior: smooth;
        }

        /* ── 空态欢迎 ── */
        .assistant-welcome {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          min-height: 100%;
          padding: var(--space-6) var(--space-4);
          text-align: center;
        }
        .assistant-welcome-orb {
          width: 56px;
          height: 56px;
          border-radius: 50%;
          background: radial-gradient(circle at 35% 35%, var(--accent-hover), var(--accent-deep) 60%, transparent 75%);
          filter: blur(6px);
          opacity: 0.8;
          margin-bottom: var(--space-4);
          animation: orb-pulse 2.8s ease-in-out infinite;
        }
        .assistant-welcome-title {
          margin: 0 0 0.4rem;
          font-family: var(--font-display);
          font-size: 1.6rem;
          font-weight: 500;
          color: var(--ink);
          letter-spacing: -0.03em;
        }
        .assistant-welcome-desc {
          margin: 0 0 var(--space-6);
          font-size: 0.88rem;
          color: var(--ink-faint);
        }
        .assistant-suggestions {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
          gap: var(--space-3);
          max-width: 720px;
          width: 100%;
        }
        .assistant-suggestion {
          display: flex;
          align-items: flex-start;
          gap: 0.7rem;
          padding: var(--space-3) var(--space-4);
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          cursor: pointer;
          text-align: left;
          transition: border-color var(--dur) var(--ease), background-color var(--dur) var(--ease);
        }
        .assistant-suggestion:hover {
          border-color: var(--accent-line);
          background: var(--bg-2);
        }
        .assistant-suggestion-icon {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 32px;
          height: 32px;
          border-radius: var(--radius-sm);
          background: var(--accent-quiet);
          color: var(--accent-soft);
          flex-shrink: 0;
        }
        .assistant-suggestion-body {
          display: flex;
          flex-direction: column;
          gap: 0.15rem;
          min-width: 0;
        }
        .assistant-suggestion-title {
          font-size: 0.88rem;
          font-weight: 500;
          color: var(--ink);
        }
        .assistant-suggestion-prompt {
          font-size: 0.78rem;
          color: var(--ink-faint);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }

        /* ── 消息列表 ── */
        .assistant-message-list {
          max-width: 800px;
          margin: 0 auto;
          padding: var(--space-5) var(--space-4) var(--space-4);
          display: flex;
          flex-direction: column;
          gap: var(--space-4);
        }

        /* ── 打字动画 ── */
        .assistant-typing {
          display: flex;
          gap: 4px;
          padding: 0 var(--space-4);
        }
        .assistant-typing span {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--accent);
          animation: typing-bounce 1.2s ease-in-out infinite;
        }
        .assistant-typing span:nth-child(2) { animation-delay: 0.15s; }
        .assistant-typing span:nth-child(3) { animation-delay: 0.3s; }
        @keyframes typing-bounce {
          0%, 60%, 100% { opacity: 0.3; transform: translateY(0); }
          30% { opacity: 1; transform: translateY(-4px); }
        }

        /* ── 输入区 ── */
        .assistant-composer {
          border-top: 1px solid var(--hairline);
          background: var(--bg-0);
          padding: var(--space-3) var(--space-4) var(--space-3);
        }
        .assistant-composer-inner {
          display: flex;
          align-items: flex-end;
          gap: var(--space-2);
          max-width: 800px;
          margin: 0 auto;
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          border-radius: var(--radius);
          padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
          transition: border-color var(--dur) var(--ease);
        }
        .assistant-composer-inner:focus-within {
          border-color: var(--accent);
        }
        .assistant-input {
          flex: 1;
          background: transparent;
          border: none;
          outline: none;
          color: var(--ink);
          font-size: 0.92rem;
          line-height: 1.5;
          resize: none;
          max-height: 160px;
          font-family: inherit;
        }
        .assistant-input::placeholder {
          color: var(--ink-faint);
        }
        .assistant-send, .assistant-stop {
          display: flex;
          align-items: center;
          justify-content: center;
          width: 34px;
          height: 34px;
          border: none;
          border-radius: var(--radius-sm);
          cursor: pointer;
          flex-shrink: 0;
          transition: background-color var(--dur) var(--ease), opacity var(--dur) var(--ease);
        }
        .assistant-send {
          background: var(--accent);
          color: var(--accent-ink);
        }
        .assistant-send:hover {
          background: var(--accent-hover);
        }
        .assistant-send:disabled {
          opacity: 0.3;
          cursor: not-allowed;
        }
        .assistant-stop {
          background: var(--danger);
          color: white;
        }
        .assistant-stop:hover {
          opacity: 0.85;
        }
        .assistant-composer-hint {
          max-width: 800px;
          margin: var(--space-2) auto 0;
          font-size: 0.72rem;
          color: var(--ink-faint);
          text-align: center;
        }

        /* ── 响应式 ── */
        @media (max-width: 768px) {
          .assistant-message-list {
            padding: var(--space-4) var(--space-3);
          }
          .assistant-suggestions {
            grid-template-columns: 1fr;
          }
        }
        @media (prefers-reduced-motion: reduce) {
          .assistant-welcome-orb { animation: none; }
          .assistant-typing span { animation: none; opacity: 0.5; }
        }
      `}</style>
    </div>
  );
}

/** 单条消息气泡 */
function MessageBubble({ msg }: { msg: ChatMessage }) {
  const isUser = msg.role === "user";

  return (
    <div className={`msg-bubble ${isUser ? "msg-user" : "msg-ai"}`}>
      {!isUser && (
        <div className="msg-avatar">
          <span className="msg-avatar-dot" />
        </div>
      )}
      <div className="msg-body">
        {msg.content && (
          <div className={`msg-text ${msg.error ? "msg-error" : ""}`}>
            {msg.content}
            {msg.streaming && <span className="msg-cursor" />}
          </div>
        )}
        {msg.toolResults?.map((tr, i) => (
          <ToolResult key={i} name={tr.name} urls={tr.urls} />
        ))}
      </div>

      <style jsx>{`
        .msg-bubble {
          display: flex;
          gap: 0.7rem;
          max-width: 100%;
        }
        .msg-user {
          flex-direction: row-reverse;
        }
        .msg-avatar {
          display: flex;
          align-items: flex-start;
          justify-content: center;
          width: 28px;
          height: 28px;
          border-radius: 50%;
          background: var(--accent-quiet);
          flex-shrink: 0;
          margin-top: 2px;
        }
        .msg-avatar-dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          background: var(--accent);
          margin-top: 10px;
          box-shadow: 0 0 6px var(--accent);
        }
        .msg-body {
          min-width: 0;
          max-width: calc(100% - 40px);
        }
        .msg-user .msg-body {
          display: flex;
          flex-direction: column;
          align-items: flex-end;
        }
        .msg-text {
          padding: 0.6rem 0.9rem;
          border-radius: var(--radius);
          font-size: 0.9rem;
          line-height: 1.6;
          white-space: pre-wrap;
          word-break: break-word;
        }
        .msg-user .msg-text {
          background: var(--accent);
          color: var(--accent-ink);
          border-bottom-right-radius: 2px;
        }
        .msg-ai .msg-text {
          background: var(--bg-1);
          border: 1px solid var(--hairline);
          color: var(--ink);
          border-bottom-left-radius: 2px;
        }
        .msg-error {
          background: var(--danger-quiet) !important;
          border-color: var(--danger) !important;
          color: var(--danger) !important;
        }
        .msg-cursor {
          display: inline-block;
          width: 2px;
          height: 1.1em;
          background: var(--accent);
          margin-left: 2px;
          vertical-align: text-bottom;
          animation: cursor-blink 1s step-end infinite;
        }
        @keyframes cursor-blink {
          0%, 50% { opacity: 1; }
          51%, 100% { opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .msg-cursor { animation: none; }
        }
      `}</style>
    </div>
  );
}

/** 工具调用结果(图片等) */
function ToolResult({ name, urls }: { name?: string; urls?: string[] }) {
  if (!urls || urls.length === 0) return null;

  return (
    <div className="tool-result">
      {name && (
        <div className="tool-result-header">
          <Icon name="create" size={14} />
          <span>{name}</span>
        </div>
      )}
      <div className="tool-result-grid">
        {urls.map((url, i) => {
          const fullUrl = imageUrl(url);
          const isVideo = url.match(/\.(mp4|webm|mov)$/i);
          return (
            <a
              key={i}
              href={fullUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="tool-result-item"
            >
              {isVideo ? (
                <video src={fullUrl} controls preload="metadata" />
              ) : (
                <img src={fullUrl} alt={`结果 ${i + 1}`} loading="lazy" />
              )}
            </a>
          );
        })}
      </div>

      <style jsx>{`
        .tool-result {
          margin-top: 0.5rem;
          width: 100%;
        }
        .tool-result-header {
          display: inline-flex;
          align-items: center;
          gap: 0.3rem;
          padding: 0.2rem 0.5rem;
          background: var(--accent-quiet);
          border-radius: var(--radius-xs);
          font-size: 0.72rem;
          color: var(--accent-soft);
          font-family: var(--font-mono);
          margin-bottom: 0.4rem;
        }
        .tool-result-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
          gap: 0.4rem;
        }
        .tool-result-item {
          display: block;
          border: 1px solid var(--hairline);
          border-radius: var(--radius-sm);
          overflow: hidden;
          transition: border-color var(--dur) var(--ease);
        }
        .tool-result-item:hover {
          border-color: var(--accent-line);
        }
        .tool-result-item img,
        .tool-result-item video {
          width: 100%;
          aspect-ratio: 1;
          object-fit: cover;
          display: block;
        }
      `}</style>
    </div>
  );
}
