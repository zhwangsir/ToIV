/**
 * 助手回答呈现的纯函数层(2026-09-28 助手 UI 重做,参考 ChatGPT / Claude):
 * ① parseMarkdownBlocks:手写块级 markdown 解析(项目约定不引第三方 md 库),
 *    覆盖段落/标题/有序无序列表/代码块/引用/分隔线/简单表格;流式半截代码块按到末尾处理。
 * ② splitInline:行内 `code` / [链接](url) / **粗** / *斜* 切片(渲染层映射为节点)。
 * ③ 思考轮次 upsert + 过程块摘要(已思考 N 秒 · 调用了 K 个工具)。
 * ④ revealStep:逐字显现的自适应步长(剩余文本约 0.7 秒内显完)。
 * 全部无 DOM 依赖,node:test 直测。
 */

export type MdBlock =
  | { type: "p"; text: string }
  | { type: "h"; level: 1 | 2 | 3; text: string }
  | { type: "ul"; items: string[] }
  | { type: "ol"; start: number; items: string[] }
  | { type: "code"; lang: string; code: string; open: boolean }
  | { type: "quote"; text: string }
  | { type: "hr" }
  | { type: "table"; head: string[]; rows: string[][] };

const FENCE_RE = /^\s*(```|~~~)\s*([\w+#.-]*)\s*$/;
const H_RE = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/;
const UL_RE = /^\s{0,3}[-*+•]\s+(.*)$/;
const OL_RE = /^\s{0,3}(\d{1,3})(?:[.)]\s+|、\s*)(.*)$/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>\s?(.*)$/;
const TABLE_SEP_RE = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  return s.split("|").map((c) => c.trim());
}

function isTableStart(lines: string[], i: number): boolean {
  const a = lines[i];
  const b = lines[i + 1];
  return !!a && !!b && a.includes("|") && TABLE_SEP_RE.test(b) && b.includes("-");
}

/** 块级解析。空行分段;列表项的缩进续行并入上一项。 */
export function parseMarkdownBlocks(src: string): MdBlock[] {
  const lines = (src || "").replace(/\r\n?/g, "\n").split("\n");
  const out: MdBlock[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) out.push({ type: "p", text: para.join("\n") });
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = FENCE_RE.exec(line);
    if (fence) {
      flushPara();
      const marker = fence[1];
      const body: string[] = [];
      i += 1;
      let closed = false;
      while (i < lines.length) {
        if (lines[i].trim().startsWith(marker) && lines[i].trim().replace(marker, "").trim() === "") {
          closed = true;
          i += 1;
          break;
        }
        body.push(lines[i]);
        i += 1;
      }
      out.push({ type: "code", lang: fence[2] || "", code: body.join("\n"), open: !closed });
      continue;
    }
    if (!line.trim()) {
      flushPara();
      i += 1;
      continue;
    }
    if (HR_RE.test(line)) {
      flushPara();
      out.push({ type: "hr" });
      i += 1;
      continue;
    }
    const h = H_RE.exec(line);
    if (h) {
      flushPara();
      const level = Math.min(3, h[1].length) as 1 | 2 | 3;
      out.push({ type: "h", level, text: h[2] });
      i += 1;
      continue;
    }
    if (isTableStart(lines, i)) {
      flushPara();
      const head = splitRow(lines[i]);
      const rows: string[][] = [];
      i += 2;
      while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
        rows.push(splitRow(lines[i]));
        i += 1;
      }
      out.push({ type: "table", head, rows });
      continue;
    }
    if (QUOTE_RE.test(line)) {
      flushPara();
      const body: string[] = [];
      while (i < lines.length && QUOTE_RE.test(lines[i])) {
        body.push((QUOTE_RE.exec(lines[i]) as RegExpExecArray)[1]);
        i += 1;
      }
      out.push({ type: "quote", text: body.join("\n") });
      continue;
    }
    const ul = UL_RE.exec(line);
    const ol = OL_RE.exec(line);
    if (ul || ol) {
      flushPara();
      const ordered = !ul;
      const items: string[] = [];
      const start = ol ? Number(ol[1]) : 1;
      while (i < lines.length) {
        const cur = lines[i];
        const mu = UL_RE.exec(cur);
        const mo = OL_RE.exec(cur);
        if (ordered ? mo : mu) {
          items.push(((ordered ? mo : mu) as RegExpExecArray)[ordered ? 2 : 1]);
          i += 1;
          continue;
        }
        // 缩进续行 / 嵌套项:并入上一项(嵌套项转为「· 」前缀的软换行)
        if (items.length && /^\s{2,}\S/.test(cur)) {
          const sub = UL_RE.exec(cur.trimStart()) || OL_RE.exec(cur.trimStart());
          const text = sub ? `· ${sub[sub.length - 1]}` : cur.trim();
          items[items.length - 1] += `\n${text}`;
          i += 1;
          continue;
        }
        break;
      }
      out.push(ordered ? { type: "ol", start, items } : { type: "ul", items });
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return out;
}

export type InlineSeg =
  | { t: "text"; v: string }
  | { t: "code"; v: string }
  | { t: "link"; v: string; href: string }
  | { t: "strong"; v: string }
  | { t: "em"; v: string };

const INLINE_RE =
  /`([^`\n]+)`|\[([^\]\n]+)\]\(((?:https?:\/\/|\/)[^\s)]+)\)|\*\*(?=\S)([\s\S]*?\S)\*\*|\*(?=\S)([^*\n]*?\S)\*/g;

/** 行内切片:代码优先(代码内不再解析粗斜体),链接只放行 http(s) 与站内绝对路径。 */
export function splitInline(text: string): InlineSeg[] {
  const out: InlineSeg[] = [];
  let last = 0;
  for (const m of (text || "").matchAll(INLINE_RE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push({ t: "text", v: text.slice(last, idx) });
    if (m[1] !== undefined) out.push({ t: "code", v: m[1] });
    else if (m[2] !== undefined) out.push({ t: "link", v: m[2], href: m[3] });
    else if (m[4] !== undefined) out.push({ t: "strong", v: m[4] });
    else out.push({ t: "em", v: m[5] });
    last = idx + m[0].length;
  }
  if (last < (text || "").length) out.push({ t: "text", v: text.slice(last) });
  return out;
}

// ───── 思考轮次 ─────

export interface ThinkingRound {
  round: number;
  status: "start" | "done";
  startedAt: number;
  elapsedMs?: number;
  content?: string;
}

export interface ThinkingEventLike {
  status?: string;
  round?: number;
  elapsed_ms?: number;
  content?: string;
}

/** 同 round upsert:start 建条(已 done 不回退),done 写耗时与思考正文。 */
export function upsertThinkingRound(
  rounds: readonly ThinkingRound[] | undefined,
  ev: ThinkingEventLike,
  now: number,
): ThinkingRound[] {
  const list = [...(rounds ?? [])];
  const round = typeof ev.round === "number" ? ev.round : list.length ? list[list.length - 1].round : 0;
  const idx = list.findIndex((r) => r.round === round);
  if (ev.status === "done") {
    const base = idx >= 0 ? list[idx] : { round, status: "start" as const, startedAt: now };
    const elapsed = typeof ev.elapsed_ms === "number" ? ev.elapsed_ms : Math.max(0, now - base.startedAt);
    const next: ThinkingRound = {
      ...base,
      status: "done",
      elapsedMs: elapsed,
      content: (ev.content || "").trim() || base.content,
    };
    if (idx >= 0) list[idx] = next;
    else list.push(next);
    return list;
  }
  if (idx >= 0) return list;
  list.push({ round, status: "start", startedAt: now });
  return list;
}

/** 流结束/被停止:未收尾的轮次按已过时长收尾,避免「思考中」残留转圈。 */
export function settleThinking(rounds: readonly ThinkingRound[] | undefined, now: number): ThinkingRound[] | undefined {
  if (!rounds?.length) return rounds ? [...rounds] : undefined;
  return rounds.map((r) =>
    r.status === "done" ? r : { ...r, status: "done", elapsedMs: Math.max(0, now - r.startedAt) },
  );
}

export function totalThinkingSeconds(rounds: readonly ThinkingRound[] | undefined): number {
  const ms = (rounds ?? []).reduce((s, r) => s + (r.elapsedMs ?? 0), 0);
  return Math.max(1, Math.round(ms / 1000));
}

export function hasThinkingText(rounds: readonly ThinkingRound[] | undefined): boolean {
  return (rounds ?? []).some((r) => !!r.content?.trim());
}

/** 过程块折叠后的标题:「已思考 12 秒 · 调用了 3 个工具」;无思考计时只报工具数。 */
export function processSummaryLabel(rounds: readonly ThinkingRound[] | undefined, toolCount: number): string {
  const parts: string[] = [];
  const timed = (rounds ?? []).some((r) => typeof r.elapsedMs === "number");
  if (timed) parts.push(`已思考 ${totalThinkingSeconds(rounds)} 秒`);
  if (toolCount > 0) parts.push(`调用了 ${toolCount} 个工具`);
  return parts.join(" · ") || "已思考";
}

/** 逐字显现步长:剩余文本约 0.7s(≈42 帧)显完,最少每帧 2 字,整段一次到达也不会拖沓。 */
export function revealStep(shown: number, target: number): number {
  const remain = target - shown;
  if (remain <= 0) return target;
  return Math.min(target, shown + Math.max(2, Math.ceil(remain / 42)));
}
