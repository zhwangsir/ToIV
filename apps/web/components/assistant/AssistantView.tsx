"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { agentChat, imageUrl } from "@/lib/api";
import type { AgentEvent } from "@/lib/api";

type ItemKind = "user" | "assistant" | "tool" | "image" | "audio" | "error";

interface ChatItem {
  id: string;
  kind: ItemKind;
  text?: string;
  urls?: string[];
}

const TOOL_LABEL: Record<string, string> = {
  generate_image: "正在生成图片…",
  generate_music: "正在作曲…",
  list_models: "正在查询模型…",
};

const SUGGESTIONS = [
  "画一只赛博朋克风格的猫,霓虹灯,电影感",
  "生成一段 lofi 学习背景音乐",
  "有哪些可用的模型?",
  "做 3 张不同风格的山水画",
];

let _seq = 0;
const nextId = () => `it-${_seq++}`;

export function AssistantView() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  const add = (item: Omit<ChatItem, "id">) =>
    setItems((prev) => [...prev, { ...item, id: nextId() }]);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if (!q || busy) return;
      setInput("");
      setBusy(true);

      // 发给后端的对话历史:仅 user / assistant 文本
      const history = items
        .filter((i) => i.kind === "user" || i.kind === "assistant")
        .map((i) => ({ role: i.kind === "user" ? "user" : "assistant", content: i.text ?? "" }));
      history.push({ role: "user", content: q });
      add({ kind: "user", text: q });

      const onEvent = (ev: AgentEvent) => {
        if (ev.type === "text" && ev.content) add({ kind: "assistant", text: ev.content });
        else if (ev.type === "tool") add({ kind: "tool", text: TOOL_LABEL[ev.name ?? ""] ?? "处理中…" });
        else if (ev.type === "image" && ev.urls) add({ kind: "image", urls: ev.urls.map(imageUrl) });
        else if (ev.type === "audio" && ev.urls) add({ kind: "audio", urls: ev.urls.map(imageUrl) });
        else if (ev.type === "error") add({ kind: "error", text: ev.content });
      };

      try {
        await agentChat(history, onEvent);
      } catch (e) {
        add({ kind: "error", text: (e as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [items, busy],
  );

  return (
    <div className="assistant">
      <div className="chat-scroll" ref={scrollRef}>
        {items.length === 0 ? (
          <div className="chat-empty">
            <div className="hero-orb" aria-hidden="true" />
            <h2>我是 ToIV 助手</h2>
            <p>用一句话告诉我你想要什么,我直接帮你生成。</p>
            <div className="chat-suggest">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" onClick={() => send(s)}>
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          items.map((it) => <ChatBubble key={it.id} item={it} />)
        )}
        {busy && <div className="chat-typing">助手思考中…</div>}
      </div>

      <form
        className="chat-input"
        onSubmit={(e) => {
          e.preventDefault();
          send(input);
        }}
      >
        <input
          type="text"
          placeholder="描述你想要的图片 / 音乐,或随便问问…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="generate-btn" disabled={busy || !input.trim()}>
          {busy ? "…" : "发送"}
        </button>
      </form>
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "user") return <div className="bubble user">{item.text}</div>;
  if (item.kind === "assistant") return <div className="bubble assistant">{item.text}</div>;
  if (item.kind === "tool") return <div className="bubble tool">{item.text}</div>;
  if (item.kind === "error") return <div className="bubble error">⚠ {item.text}</div>;
  if (item.kind === "image")
    return (
      <div className="bubble media">
        <div className="chat-images">
          {item.urls?.map((u) => <img key={u} src={u} alt="生成结果" loading="lazy" />)}
        </div>
      </div>
    );
  if (item.kind === "audio")
    return (
      <div className="bubble media">
        {item.urls?.map((u) => <audio key={u} controls preload="none" src={u} />)}
      </div>
    );
  return null;
}
