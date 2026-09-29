/**
 * 新旧界面开关(2026-09-29 v3 P1)。
 * - localStorage["toiv_ui"] === "v3" 时 <html data-ui="v3">,否则旧界面(缺省)。
 * - URL 带 ?ui=v3 / ?ui=classic 可一次性切换并持久化(便于分享预览)。
 * - layout.tsx 内联脚本首帧前读取,防闪烁。
 */
export type UiVersion = "classic" | "v3";
export const UI_STORAGE_KEY = "toiv_ui";
export const UI_CHANGED_EVENT = "toiv:ui-changed";

export function readUiVersion(): UiVersion {
  if (typeof window === "undefined") return "classic";
  try {
    return window.localStorage.getItem(UI_STORAGE_KEY) === "v3" ? "v3" : "classic";
  } catch {
    return "classic";
  }
}

export function applyUiVersion(v: UiVersion): void {
  if (typeof document === "undefined") return;
  const d = document.documentElement;
  if (v === "v3") d.dataset.ui = "v3";
  else delete d.dataset.ui;
  try {
    if (v === "v3") window.localStorage.setItem(UI_STORAGE_KEY, "v3");
    else window.localStorage.removeItem(UI_STORAGE_KEY);
  } catch {
    /* 隐私模式:仅本页生效 */
  }
  window.dispatchEvent(new CustomEvent(UI_CHANGED_EVENT, { detail: v }));
}
