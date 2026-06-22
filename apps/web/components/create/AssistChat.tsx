"use client";

import { useCallback, useRef, useState } from "react";

import { agentChat, type AgentEvent } from "@/lib/api";

interface ChatMsg {
  role: "user" | "assistant";
  content: string;
}

interface AssistChatProps {
  /** 当前提示词,作为"帮我配"上下文。 */
  context: string;
  /** 把 AI 回复中的提示词建议一键填回输入框。 */
  onApplyPrompt: (text: string) => void;
}

const QUICK_ASKS = [
  "帮我把想法写成专业提示词",
  "steps 和 cfg 该怎么调?",
  "推荐适合这个画面的模型",
];

/** 内联可折叠 AI 助手:问 AI / 帮我配,基于现有 agentChat 流式对话。 */
export function AssistChat({ context, onApplyPrompt }: AssistChatProps) {
  const [open, setOpen] = useState(false);
  const [input, setInput] = useState("");
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ask = useCallback(
    async (raw: string) => {
      const text = raw.trim();
      if (!text || streaming) return;
      setInput("");
      const seeded = context.trim()
        ? `${text}\n\n(当前提示词:${context.trim()})`
        : text;
      const next: ChatMsg[] = [...msgs, { role: "user", content: text }];
      setMsgs([...next, { role: "assistant", content: "" }]);
      setStreaming(true);
      const ac = new AbortController();
      abortRef.current = ac;
      try {
        await agentChat(
          [...msgs, { role: "user", content: seeded }],
          (ev: AgentEvent) => {
            if (ev.type === "text" && ev.content) {
              setMsgs((cur) => {
                const copy = cur.slice();
                const last = copy[copy.length - 1];
                if (last && last.role === "assistant") {
                  copy[copy.length - 1] = { ...last, content: last.content + ev.content };
                }
                return copy;
              });
            }
          },
          null,
          ac.signal,
        );
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setMsgs((cur) => [...cur, { role: "assistant", content: `出错:${(e as Error).message}` }]);
        }
      } finally {
        setStreaming(false);
      }
    },
    [context, msgs, streaming],
  );

  if (!open) {
    return (
      <button type="button" className="assist-toggle" onClick={() => setOpen(true)}>
        <span className="assist-dot" aria-hidden="true" />
        问 AI · 帮我配
      </button>
    );
  }

  return (
    <section className="assist-panel" aria-label="AI 创作助手">
      <header className="assist-head">
        <span>
          <span className="assist-dot" aria-hidden="true" /> AI 助手
        </span>
        <button type="button" className="assist-close" onClick={() => setOpen(false)} aria-label="收起助手">
          收起
        </button>
      </header>

      <div className="assist-scroll">
        {msgs.length === 0 ? (
          <div className="assist-quick">
            <p className="muted">让 AI 解释参数、建议设置或优化提示词。</p>
            {QUICK_ASKS.map((q) => (
              <button key={q} type="button" onClick={() => ask(q)}>
                {q}
              </button>
            ))}
          </div>
        ) : (
          msgs.map((m, i) => (
            <div key={i} className={`assist-msg ${m.role}`}>
              {m.content || (streaming && i === msgs.length - 1 ? "思考中…" : "")}
              {m.role === "assistant" && m.content && (
                <button
                  type="button"
                  className="assist-apply"
                  onClick={() => onApplyPrompt(m.content)}
                  title="把这段填进提示词"
                >
                  填入提示词
                </button>
              )}
            </div>
          ))
        )}
      </div>

      <form
        className="assist-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask(input);
        }}
      >
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="问点什么…"
          disabled={streaming}
        />
        <button type="submit" disabled={streaming || !input.trim()}>
          发送
        </button>
      </form>
    </section>
  );
}
