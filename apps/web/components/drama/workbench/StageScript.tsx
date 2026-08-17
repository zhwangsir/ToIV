"use client";

/**
 * LibTV 式短剧工作台 —— 阶段①剧本(Team B,契约见 ./types.ts StageStubProps)。
 *
 * 三栏:
 *   左  AI 编剧对话窗(复用 dp.refineScript;指令与结果作为消息流呈现,
 *       结果卡带「采纳」——采纳只写入编辑器草稿态并提示再保存,不直接
 *       覆盖原文,沿用旧 DramaDetail 的润色交互语义);
 *   中  剧本正文等宽编辑区(透明 textarea + 高亮衬底层:「第X场」场次
 *       标题整行高亮、【动作】【台词】等标记内联高亮;字数统计);
 *   右  分场大纲卡(正则提取场次标题/场景行,点击定位滚动到中栏对应行)。
 * 底部恒显:字数/场次统计 + 「有未保存修改」提示 + 保存剧本 + 确认门
 * 「确认剧本 →」(props.onConfirmScript,确认后容器推进到资产阶段)。
 * 空态:无剧本时中栏给引导文案 + 诛仙式仙侠短剧一句话示例。
 */
import { useEffect, useMemo, useRef, useState } from "react";

import { Icon } from "@/components/ui/Icon";
import { useToast } from "@/components/ui/Toast";
import type { StageStubProps } from "./types";

// 场次标题行:第X场/幕/章节、【场景】、场景:/场次:、内外景、ACT/SCENE N
const SCENE_RE =
  /^(第\s*[0-9０-９一二三四五六七八九十百千万零两]+\s*[场幕章节]|[【\[]?场景[】\]]?\s*\d*\s*[:：]?|场次\s*[:：]|【?(?:外景|内景)|ACT\s+\d+|SCENE\s+\d+)/i;
// 内联标记:【动作】【台词】【旁白】等
const TAG_RE = /(【[^】]{1,16}】)/g;

/** 诛仙式仙侠短剧一句话示例 + 可填入的开局样例(演示场次/标记格式) */
const EXAMPLE_PREMISE = "张小凡夜闯镇魔古洞救碧瑶,正邪一念间。";
const EXAMPLE_SCRIPT = `第一场 镇魔古洞·夜
【场景】青云门后山,镇魔古洞外,月色凄冷,松涛如泣。
【动作】张小凡踉跄跌入洞口,怀中烧火棍泛起幽幽青光。
【台词】张小凡(低语):「碧瑶,我一定带你出去。」

第二场 古洞深处
【场景】洞内石壁渗血,古老的封印在黑暗中若隐若现。
【动作】黑气翻涌,鬼王宗伏兵四起,退路尽断。
【台词】鬼王:「把烧火棍留下,饶你不死。」`;

interface ChatMsg {
  id: number;
  role: "user" | "ai";
  text: string;
  /** AI 润色结果稿(非空即结果卡,带采纳按钮) */
  refined?: string;
  adopted?: boolean;
  failed?: boolean;
}

const QUICK_PROMPTS = ["润色关键场景", "加强戏剧冲突", "压缩场次节奏"];

export function StageScript(props: StageStubProps) {
  const { dp, confirmedScript, onConfirmScript } = props;
  const { show: showToast } = useToast();

  const savedScript = dp.current?.script ?? "";
  const [draft, setDraft] = useState(savedScript);
  const [saving, setSaving] = useState(false);

  // AI 编剧对话状态
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const msgIdRef = useRef(0);

  // 切换项目/剧本外部更新时同步草稿并清空对话(与旧 DramaDetail 语义一致:
  // 保存后 savedScript===draft,setDraft 为同值无操作,不会覆盖正在输入的内容)
  useEffect(() => {
    setDraft(savedScript);
    setMessages([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dp.current?.id, savedScript]);

  // ── 高亮衬底层与 textarea 滚动同步 ──
  const taRef = useRef<HTMLTextAreaElement>(null);
  const hlRef = useRef<HTMLDivElement>(null);
  const msgListRef = useRef<HTMLDivElement>(null);

  const syncHighlightScroll = () => {
    const ta = taRef.current;
    const hl = hlRef.current;
    if (!ta || !hl) return;
    hl.scrollTop = ta.scrollTop;
    hl.scrollLeft = ta.scrollLeft;
  };
  // 内容变化时同样对齐一次(行数变化会改变滚动上限)
  useEffect(syncHighlightScroll, [draft]);

  // 对话流到底
  useEffect(() => {
    const el = msgListRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, chatBusy]);

  const dirty = draft !== savedScript;
  const wordCount = useMemo(() => draft.replace(/\s/g, "").length, [draft]);

  // ── 分场大纲提取 ──
  const outline = useMemo(() => {
    const lines = draft.split("\n");
    const items: { line: number; title: string; preview: string }[] = [];
    lines.forEach((raw, i) => {
      const t = raw.trim();
      if (!t || !SCENE_RE.test(t)) return;
      let preview = "";
      for (let j = i + 1; j < lines.length; j++) {
        const p = lines[j].trim();
        if (p) {
          preview = p;
          break;
        }
      }
      items.push({
        line: i,
        title: t.length > 40 ? `${t.slice(0, 40)}…` : t,
        preview: preview.length > 48 ? `${preview.slice(0, 48)}…` : preview,
      });
    });
    return items;
  }, [draft]);

  // ── 高亮衬底层内容(逐行:场次标题整行高亮;【…】标记内联高亮)──
  const highlightLines = useMemo(
    () =>
      draft.split("\n").map((line, i) => {
        const isScene = SCENE_RE.test(line.trim());
        const parts = line.split(TAG_RE);
        return (
          <div
            key={i}
            className={`wb-script-hl-line${isScene ? " is-scene" : ""}`}
          >
            {parts.map((p, j) =>
              j % 2 === 1 ? (
                <span key={j} className="wb-script-hl-tag">
                  {p}
                </span>
              ) : (
                <span key={j}>{p}</span>
              ),
            )}
            {"​"}
          </div>
        );
      }),
    [draft],
  );

  // ── 大纲点击定位:滚动 + 光标落到对应行首 ──
  const jumpToLine = (line: number) => {
    const ta = taRef.current;
    if (!ta) return;
    const lines = draft.split("\n");
    let offset = 0;
    for (let i = 0; i < line && i < lines.length; i++) {
      offset += lines[i].length + 1;
    }
    const lineHeight = parseFloat(getComputedStyle(ta).lineHeight) || 22;
    ta.focus();
    ta.setSelectionRange(offset, offset);
    ta.scrollTop = Math.max(0, (line - 2) * lineHeight);
    syncHighlightScroll();
  };

  // ── 保存剧本 ──
  const saveScript = async () => {
    if (saving || !dirty) return;
    setSaving(true);
    try {
      await dp.patchProject({ script: draft });
      showToast("success", "剧本已保存");
    } catch (err) {
      showToast("error", err instanceof Error ? err.message : "保存剧本失败");
    } finally {
      setSaving(false);
    }
  };

  // ── AI 编剧对话:指令 → refineScript → 结果卡(采纳写草稿态,不覆盖原文)──
  const sendInstruction = async (raw: string) => {
    const instruction = raw.trim();
    if (!instruction || chatBusy) return;
    const text = draft.trim();
    if (!text) {
      showToast("info", "请先在中栏编写剧本内容");
      return;
    }
    msgIdRef.current += 1;
    const userId = msgIdRef.current;
    setMessages((prev) => [
      ...prev,
      { id: userId, role: "user", text: instruction },
    ]);
    setInput("");
    setChatBusy(true);
    try {
      const r = await dp.refineScript(text, instruction);
      msgIdRef.current += 1;
      setMessages((prev) => [
        ...prev,
        {
          id: msgIdRef.current,
          role: "ai",
          text: "已按指令生成润色稿(未保存):",
          refined: r.refined,
        },
      ]);
    } catch (err) {
      msgIdRef.current += 1;
      setMessages((prev) => [
        ...prev,
        {
          id: msgIdRef.current,
          role: "ai",
          text: err instanceof Error ? err.message : "AI 润色失败",
          failed: true,
        },
      ]);
    } finally {
      setChatBusy(false);
    }
  };

  const adoptRefined = (msg: ChatMsg) => {
    if (!msg.refined || msg.adopted) return;
    setDraft(msg.refined);
    setMessages((prev) =>
      prev.map((m) => (m.id === msg.id ? { ...m, adopted: true } : m)),
    );
    showToast("info", "已写入编辑器草稿,请点击「保存剧本」生效");
  };

  if (!dp.current) {
    return <div className="wb-script-loading">项目加载中…</div>;
  }

  return (
    <div className="wb-script">
      <div className="wb-script-cols">
        {/* ── 左栏:AI 编剧对话窗 ── */}
        <section className="wb-script-col wb-script-chat" aria-label="AI 编剧">
          <header className="wb-script-col-head">
            <Icon name="sparkles" size={13} />
            AI 编剧
          </header>
          <div className="wb-script-msgs" ref={msgListRef}>
            {messages.length === 0 && !chatBusy && (
              <div className="wb-script-msgs-empty">
                对当前剧本下达改写/润色指令,结果以卡片呈现,采纳后写入草稿。
              </div>
            )}
            {messages.map((m) => (
              <div
                key={m.id}
                className={`wb-script-msg is-${m.role}${m.failed ? " is-failed" : ""}`}
              >
                <div className="wb-script-msg-text">{m.text}</div>
                {m.refined && (
                  <div className="wb-script-msg-refined">
                    <pre className="wb-script-msg-pre">{m.refined}</pre>
                    <div className="wb-script-msg-ops">
                      {m.adopted ? (
                        <span className="wb-script-msg-adopted">
                          <Icon name="check" size={12} />
                          已采纳到草稿
                        </span>
                      ) : (
                        <button
                          type="button"
                          className="btn btn-primary btn-sm"
                          onClick={() => adoptRefined(m)}
                        >
                          <Icon name="check" size={13} />
                          采纳
                        </button>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
            {chatBusy && (
              <div className="wb-script-msg is-ai">
                <div className="wb-script-msg-text">
                  <Icon name="loading" size={13} /> 润色中…
                </div>
              </div>
            )}
          </div>
          <div className="wb-script-quick">
            {QUICK_PROMPTS.map((q) => (
              <button
                key={q}
                type="button"
                className="wb-script-chip"
                disabled={chatBusy}
                onClick={() => void sendInstruction(q)}
              >
                {q}
              </button>
            ))}
          </div>
          <form
            className="wb-script-chatbox"
            onSubmit={(e) => {
              e.preventDefault();
              void sendInstruction(input);
            }}
          >
            <input
              className="wb-input"
              placeholder="如:把第二场冲突写得更狠"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              maxLength={200}
              aria-label="润色指令"
            />
            <button
              type="submit"
              className="btn btn-primary btn-sm"
              disabled={chatBusy || !input.trim()}
              aria-label="发送指令"
            >
              <Icon name="send" size={14} />
            </button>
          </form>
        </section>

        {/* ── 中栏:剧本正文编辑区 ── */}
        <section className="wb-script-col" aria-label="剧本正文">
          <header className="wb-script-col-head">
            <Icon name="file" size={13} />
            剧本正文
            <span className="wb-script-col-meta">{wordCount} 字</span>
          </header>
          <div className="wb-script-editor">
            <div className="wb-script-hl" ref={hlRef} aria-hidden="true">
              {highlightLines}
            </div>
            <textarea
              ref={taRef}
              className="wb-script-input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onScroll={syncHighlightScroll}
              placeholder="在此编写剧本。用「第X场」或【场景】标记场次,【动作】【台词】标记内容。"
              aria-label="剧本正文编辑区"
              spellCheck={false}
            />
            {draft.trim() === "" && (
              <div className="wb-script-empty">
                <Icon name="clapperboard" size={22} strokeWidth={1.2} />
                <p className="wb-script-empty-title">从一句话创意开始</p>
                <p className="wb-script-empty-desc">
                  示例:「{EXAMPLE_PREMISE}」——
                  写下你的故事,或填入仙侠短剧开局样例,再让 AI 编剧润色。
                </p>
                <button
                  type="button"
                  className="btn btn-sm"
                  onClick={() => setDraft(EXAMPLE_SCRIPT)}
                >
                  <Icon name="wand" size={13} />
                  填入仙侠短剧示例
                </button>
              </div>
            )}
          </div>
        </section>

        {/* ── 右栏:分场大纲 ── */}
        <section className="wb-script-col" aria-label="分场大纲">
          <header className="wb-script-col-head">
            <Icon name="list-ordered" size={13} />
            分场大纲
            <span className="wb-script-col-meta">{outline.length} 场</span>
          </header>
          <div className="wb-script-outline">
            {outline.length === 0 && (
              <div className="wb-script-outline-empty">
                暂无场次。用「第X场」或【场景】标记场次后,大纲自动出现在这里。
              </div>
            )}
            {outline.map((o, i) => (
              <button
                key={`${o.line}-${i}`}
                type="button"
                className="wb-script-scene"
                title="点击定位到剧本对应位置"
                onClick={() => jumpToLine(o.line)}
              >
                <span className="wb-script-scene-idx">{i + 1}</span>
                <span className="wb-script-scene-body">
                  <span className="wb-script-scene-title">{o.title}</span>
                  {o.preview && (
                    <span className="wb-script-scene-preview">{o.preview}</span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>

      {/* ── 底部恒显:统计 + 保存 + 确认门 ── */}
      <footer className="wb-script-bar">
        <span className="wb-script-bar-stat">
          {wordCount} 字 · {outline.length} 场
        </span>
        {dirty && (
          <span className="wb-script-bar-dirty">
            <Icon name="alert" size={12} />
            有未保存修改
          </span>
        )}
        <span className="wb-script-bar-spacer" />
        <button
          type="button"
          className="btn"
          disabled={!dirty || saving}
          onClick={() => void saveScript()}
        >
          <Icon name="save" size={14} />
          {saving ? "保存中…" : "保存剧本"}
        </button>
        <button
          type="button"
          className="btn btn-primary"
          disabled={confirmedScript || savedScript.trim() === ""}
          title={
            savedScript.trim() === ""
              ? "请先编写并保存剧本"
              : dirty
                ? "有未保存修改,确认的是已保存版本"
                : "确认剧本,进入资产阶段"
          }
          onClick={onConfirmScript}
        >
          <Icon name="check" size={14} />
          {confirmedScript ? "剧本已确认" : "确认剧本 →"}
        </button>
      </footer>
    </div>
  );
}
