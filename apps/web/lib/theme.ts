/**
 * 浅色五色板主题系统(2026-08-07,见 docs/2026-08-07-light-theme-system.md)
 * - 默认主题「素白」由 :root 承载,不写 data-theme;
 * - 其余 4 套用 document.documentElement.dataset.theme 切换;
 * - 选择持久化 localStorage["toiv_theme"],layout.tsx 内联脚本首帧前读取防 FOUC。
 * swatch 色值仅用于切换器色块示意(accent + surface 双色),与 globals.css token 同源。
 */

export type ThemeId = "paper" | "wood" | "mono" | "mint" | "apricot";

export interface ThemeDef {
  id: ThemeId;
  /** 中文名 */
  name: string;
  /** data-theme 属性值;默认主题 paper 为 null(回落 :root) */
  dataset: string | null;
  /** 色块示意:accent 主色 */
  accent: string;
  /** 色块示意:面板底色 */
  surface: string;
}

export const THEMES: ThemeDef[] = [
  { id: "paper", name: "素白", dataset: null, accent: "#17181A", surface: "#FAFAFA" },
  { id: "wood", name: "浅木", dataset: "wood", accent: "#2F63B4", surface: "#F7F2EA" },
  { id: "mono", name: "中性", dataset: "mono", accent: "#111111", surface: "#FFFFFF" },
  { id: "mint", name: "薄荷", dataset: "mint", accent: "#0A7158", surface: "#F4FAF7" },
  { id: "apricot", name: "奶杏", dataset: "apricot", accent: "#8A5429", surface: "#FAF3E8" },
];

const STORAGE_KEY = "toiv_theme";

/** 读取当前主题(SSR 安全,服务端回落默认 paper) */
export function getCurrentTheme(): ThemeId {
  if (typeof window === "undefined") return "paper";
  try {
    const t = window.localStorage.getItem(STORAGE_KEY);
    const hit = THEMES.find((x) => x.id === t);
    return hit ? hit.id : "paper";
  } catch {
    return "paper";
  }
}

/** 应用主题:写 localStorage + documentElement.dataset.theme,无刷新即时生效 */
export function applyTheme(id: ThemeId): void {
  const def = THEMES.find((x) => x.id === id) ?? THEMES[0];
  try {
    window.localStorage.setItem(STORAGE_KEY, def.id);
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  if (def.dataset) {
    document.documentElement.dataset.theme = def.dataset;
  } else {
    delete document.documentElement.dataset.theme;
  }
}
