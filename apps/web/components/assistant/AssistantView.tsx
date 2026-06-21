"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { ModelViewer } from "@/components/ui/ModelViewer";
import { agentChat, imageUrl, uploadImage } from "@/lib/api";
import type { AgentEvent, AgentImageRef } from "@/lib/api";

type ItemKind = "user" | "assistant" | "tool" | "image" | "video" | "model3d" | "audio" | "error";

interface ChatItem {
  id: string;
  kind: ItemKind;
  text?: string;
  urls?: string[];
}

const TOOL_LABEL: Record<string, string> = {
  generate_image: "正在生成图片…",
  generate_video: "正在生成视频…(约 1-2 分钟,请稍候)",
  generate_music: "正在作曲…",
  edit_image: "正在重绘图片…",
  generate_3d: "正在生成 3D 模型…(约 1-3 分钟,请稍候)",
  list_models: "正在查询模型…",
  search_knowledge: "正在查阅知识库…",
  run_workflow: "正在运行自定义工作流…",
};

const SUGGESTIONS = [
  "画一只赛博朋克风格的猫,霓虹灯,电影感",
  "生成一段 3 秒的樱花飘落短视频",
  "做一个柴犬手办的 3D 模型",
  "生成一段 lofi 学习背景音乐",
];

let _seq = 0;
const nextId = () => `it-${_seq++}`;

interface Attachment {
  ref: AgentImageRef;
  preview: string;
}

export function AssistantView() {
  const [items, setItems] = useState<ChatItem[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  const add = (item: Omit<ChatItem, "id">) =>
    setItems((prev) => [...prev, { ...item, id: nextId() }]);

  const onPickImage = useCallback(async (file: File | null) => {
    if (!file) return;
    setUploading(true);
    try {
      const up = await uploadImage(file, "img2img");
      setAttachment({ ref: { filename: up.filename, worker: up.worker }, preview: URL.createObjectURL(file) });
    } catch (e) {
      add({ kind: "error", text: `图片上传失败: ${(e as Error).message}` });
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }, []);

  const send = useCallback(
    async (text: string) => {
      const q = text.trim();
      if ((!q && !attachment) || busy) return;
      setInput("");
      setBusy(true);
      const att = attachment;
      setAttachment(null);

      // 发给后端的对话历史:仅 user / assistant 文本
      const history = items
        .filter((i) => i.kind === "user" || i.kind === "assistant")
        .map((i) => ({ role: i.kind === "user" ? "user" : "assistant", content: i.text ?? "" }));
      history.push({ role: "user", content: q || "(已上传图片)" });
      add({ kind: "user", text: q, urls: att ? [att.preview] : undefined });

      const onEvent = (ev: AgentEvent) => {
        if (ev.type === "text" && ev.content) add({ kind: "assistant", text: ev.content });
        else if (ev.type === "tool") add({ kind: "tool", text: TOOL_LABEL[ev.name ?? ""] ?? "处理中…" });
        else if (ev.type === "image" && ev.urls) add({ kind: "image", urls: ev.urls.map(imageUrl) });
        else if (ev.type === "video" && ev.urls) add({ kind: "video", urls: ev.urls.map(imageUrl) });
        else if (ev.type === "model3d" && ev.urls) add({ kind: "model3d", urls: ev.urls.map(imageUrl) });
        else if (ev.type === "audio" && ev.urls) add({ kind: "audio", urls: ev.urls.map(imageUrl) });
        else if (ev.type === "error") add({ kind: "error", text: ev.content });
      };

      try {
        await agentChat(history, onEvent, att?.ref ?? null);
      } catch (e) {
        add({ kind: "error", text: (e as Error).message });
      } finally {
        setBusy(false);
      }
    },
    [items, busy, attachment],
  );

  return (
    <div className="assistant">
      <div className="chat-scroll" ref={scrollRef}>
        {items.length === 0 ? (
          <div className="chat-empty">
            <div className="hero-orb" aria-hidden="true" />
            <h2>我是 ToIV 助手</h2>
            <p>用一句话告诉我你想要什么,我直接帮你生成。上传图片还能重绘或转 3D。</p>
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
        {attachment && (
          <div className="chat-attach" title="已附带图片">
            <img src={attachment.preview} alt="待处理图片" />
            <button type="button" onClick={() => setAttachment(null)} aria-label="移除图片">
              ✕
            </button>
          </div>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => onPickImage(e.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          className="chat-attach-btn"
          onClick={() => fileRef.current?.click()}
          disabled={busy || uploading}
          title="上传图片(重绘 / 转 3D)"
          aria-label="上传图片"
        >
          {uploading ? "…" : "＋图"}
        </button>
        <input
          type="text"
          placeholder="描述需求,或上传图片让我重绘 / 转 3D…"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          disabled={busy}
        />
        <button type="submit" className="generate-btn" disabled={busy || (!input.trim() && !attachment)}>
          {busy ? "…" : "发送"}
        </button>
      </form>
    </div>
  );
}

function ChatBubble({ item }: { item: ChatItem }) {
  if (item.kind === "user")
    return (
      <div className="bubble user">
        {item.urls?.[0] && <img className="bubble-attach" src={item.urls[0]} alt="上传图片" />}
        {item.text}
      </div>
    );
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
  if (item.kind === "video")
    return (
      <div className="bubble media">
        <div className="chat-images">
          {item.urls?.map((u) => <img key={u} src={u} alt="生成视频" loading="lazy" />)}
        </div>
        <span className="media-tag">▶ 动态视频</span>
      </div>
    );
  if (item.kind === "model3d")
    return (
      <div className="bubble media">
        <div className="chat-model3d">{item.urls?.[0] && <ModelViewer src={item.urls[0]} />}</div>
        <span className="media-tag">⬢ 可旋转 3D 模型(GLB)</span>
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
