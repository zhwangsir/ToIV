"use client";

/**
 * useAutoResize —— textarea 自动增高(全站输入框去高度限制,2026-08-16 Team B)。
 *
 * 用法(受控):
 *   const taRef = useRef<HTMLTextAreaElement | null>(null);
 *   useAutoResize(taRef, value);                 // 无上限,随内容增高
 *   useAutoResize(taRef, value, { maxVh: 40 });  // 视口高 40% 宽松封顶,超出内滚
 *   <textarea ref={taRef} value={value} rows={2} ... />
 *
 * 非受控(defaultValue + onBlur 提交)同样可用:value 传 defaultValue(仅作初始
 * 撑开依据),后续键入由 hook 内置的 input 事件监听兜底重算。
 *
 * 行为:
 * - 两段式重算(复用 PromptBar 原方案):先 height=auto 收回,再按 scrollHeight 撑开;
 * - cap 默认 Infinity(不封顶);传 maxVh 时按 window.innerHeight 换算 px 封顶;
 * - 内容未超 cap 时 overflow-y:hidden(不出滚动条),超 cap 时 auto(内滚);
 * - scrollHeight 为 0(元素未布局,如 closed <details> 内)时不写样式,保留 rows 初始高度;
 * - SSR/无 DOM 安全:effect 服务端本就不执行;window 缺失时 cap 退化为不封顶(node 单测可跑)。
 *
 * rows/min-height 仍作初始/下限高度,本 hook 只管「随内容增高 + 宽松封顶内滚」。
 */
import { useEffect, type RefObject } from "react";

export interface AutoResizeOpts {
  /** 视口高度百分比上限(如 40 = 40vh);缺省/非法值 = 不封顶。 */
  maxVh?: number;
}

/** maxVh → px 上限换算(纯函数,可单测);非法输入返回 Infinity(不封顶)。 */
export function capFromVh(maxVh: number | undefined, viewportHeight: number): number {
  if (maxVh === undefined || !Number.isFinite(maxVh) || maxVh <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  if (!Number.isFinite(viewportHeight) || viewportHeight <= 0) {
    return Number.POSITIVE_INFINITY;
  }
  return (viewportHeight * maxVh) / 100;
}

/** 目标高度:scrollHeight 与 cap 取小(纯函数,可单测)。 */
export function computeAutoHeight(scrollHeight: number, capPx: number): number {
  if (!Number.isFinite(capPx) || capPx <= 0) return scrollHeight;
  return Math.min(scrollHeight, capPx);
}

/**
 * 把两段式重算落到元素上(纯 DOM 操作,node 下可用假元素单测)。
 * scrollHeight <= 0(元素未布局)时不动样式,避免把隐藏态 textarea 压成 0 高。
 */
export function applyAutoHeight(
  el: Pick<HTMLTextAreaElement, "style" | "scrollHeight">,
  capPx: number,
): void {
  if (!el || !Number.isFinite(el.scrollHeight) || el.scrollHeight <= 0) return;
  el.style.height = "auto";
  el.style.height = `${computeAutoHeight(el.scrollHeight, capPx)}px`;
  el.style.overflowY = el.scrollHeight > capPx ? "auto" : "hidden";
}

/** 当前视口高(无 window 环境返回 0 → capFromVh 退化为不封顶)。 */
function viewportH(): number {
  return typeof window === "undefined" ? 0 : window.innerHeight;
}

export function useAutoResize(
  ref: RefObject<HTMLTextAreaElement | null>,
  value: string,
  opts?: AutoResizeOpts,
): void {
  const maxVh = opts?.maxVh;

  // 受控值变化时重算(粘贴/程序化赋值/外部回写均覆盖)
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    applyAutoHeight(el, capFromVh(maxVh, viewportH()));
  }, [ref, value, maxVh]);

  // input 事件兜底:非受控键入(defaultValue 场景)也即时增高
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof el.addEventListener !== "function") return;
    const onInput = () => applyAutoHeight(el, capFromVh(maxVh, viewportH()));
    el.addEventListener("input", onInput);
    return () => el.removeEventListener("input", onInput);
  }, [ref, maxVh]);
}
