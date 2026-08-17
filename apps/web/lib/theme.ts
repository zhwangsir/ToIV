/**
 * 主题系统 v7(2026-08-16):模式(亮/暗)× 色板(5 套)双维度 + 自定义覆盖。
 * - 色板:默认「素白」由 :root 承载,不写 data-theme;其余 4 套用
 *   document.documentElement.dataset.theme 切换;持久化 localStorage["toiv_theme"]。
 * - 模式:data-mode="dark" 第二维度(默认 light,不写属性即亮色);
 *   持久化 localStorage["toiv_mode"]。
 * - 自定义:localStorage["toiv_theme_custom"] JSON {accent?, pureBlack?};
 *   accent 经 deriveAccentVars 派生 hover/soft/glow 后 inline setProperty 覆盖
 *   (inline 优先级天然最高);pureBlack 写 dataset.pureBlack,仅暗色下 CSS 生效。
 * - layout.tsx 内联脚本首帧前读取三 key 写 dataset/inline 防 FOUC。
 * swatch/预设色值仅用于切换器色块示意与派生输入,与 globals.css token 同源。
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

// 导出供跨标签页同步(lib/crossTab.ts)订阅:他页切换主题时本页跟随
export const THEME_STORAGE_KEY = "toiv_theme";

/** 同页多实例同步总线(2026-08-16):设置页/底部 sheet/CornerNav 三处 ThemePicker 并存,
 *  storage 事件只管跨标签页,同页另一实例感知不到;apply* 三处广播本事件,实例订阅刷新。
 *  与跨页同步并存,互不替代。 */
export const THEME_CHANGED_EVENT = "toiv:theme-changed";

export interface ThemeChangedDetail {
  mode?: Mode;
  theme?: ThemeId;
  custom?: ThemeCustom;
}

/** 同页广播(仅 apply* 调用;测试环境的假 window 无 dispatchEvent 时静默跳过)。 */
function broadcastThemeChanged(detail: ThemeChangedDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail }));
}

/** 读取当前主题(SSR 安全,服务端回落默认 paper) */
export function getCurrentTheme(): ThemeId {
  if (typeof window === "undefined") return "paper";
  try {
    const t = window.localStorage.getItem(THEME_STORAGE_KEY);
    const hit = THEMES.find((x) => x.id === t);
    return hit ? hit.id : "paper";
  } catch {
    return "paper";
  }
}

/** 同步 <meta name="theme-color"> 为当前画布色(--bg-canvas 计算值,随模式/纯黑自动变化);meta 缺失时创建 */
function syncThemeColorMeta(): void {
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue("--bg-canvas")
    .trim();
  if (!value) return;
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement("meta");
    meta.name = "theme-color";
    document.head.appendChild(meta);
  }
  if (meta.content !== value) meta.content = value;
}

/** 把主题写到 documentElement.dataset.theme(不写 localStorage;跨页同步时复用) */
export function applyThemeDataset(id: ThemeId): void {
  const def = THEMES.find((x) => x.id === id) ?? THEMES[0];
  if (def.dataset) {
    document.documentElement.dataset.theme = def.dataset;
  } else {
    delete document.documentElement.dataset.theme;
  }
  // 色板切换改变画布计算色:自定义 accent 的 soft 需对新画布重派生(无自定义时为空操作)
  refreshCustomAccentInline();
  syncThemeColorMeta();
}

/** 应用主题:写 localStorage + documentElement.dataset.theme,无刷新即时生效 */
export function applyTheme(id: ThemeId): void {
  const def = THEMES.find((x) => x.id === id) ?? THEMES[0];
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, def.id);
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyThemeDataset(def.id);
  broadcastThemeChanged({ theme: def.id });
}

/* ══════════════════════════════════════════════════════════════
   明暗模式 + 自定义覆盖(2026-08-16 v7)
   ══════════════════════════════════════════════════════════════ */

export type Mode = "light" | "dark";

export const MODE_STORAGE_KEY = "toiv_mode";
export const CUSTOM_STORAGE_KEY = "toiv_theme_custom";

/** 自定义覆盖:pureBlack 仅暗色生效;accent 为 #rrggbb,非法值落库前被剥离 */
export interface ThemeCustom {
  accent?: string;
  pureBlack?: boolean;
}

/** deriveAccentVars 的输出组(inline 注入的 5 个 token) */
export interface DerivedAccentVars {
  accent: string;
  accentHover: string;
  accentSoft: string;
  accentGlow: string;
  textOnAccent: string;
}

/** 自定义强调色预设丸(hex 仅允许存活于本文件,见 ui_lint 白名单;中亮度,亮暗双模式可读) */
export const CUSTOM_ACCENT_PRESETS: { name: string; color: string }[] = [
  { name: "蓝", color: "#4C86D9" },
  { name: "薄荷", color: "#0FA37C" },
  { name: "杏", color: "#C77B3F" },
  { name: "朱", color: "#C8534A" },
  { name: "青", color: "#2E8FA3" },
];

const HEX6 = /^#[0-9a-fA-F]{6}$/;

function hexToRgb(hex: string): [number, number, number] | null {
  if (!HEX6.test(hex)) return null;
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

function rgbToHex([r, g, b]: [number, number, number]): string {
  const p = (v: number) => Math.round(v).toString(16).padStart(2, "0");
  return `#${p(r)}${p(g)}${p(b)}`;
}

/**
 * 自定义 accent 派生(纯函数,RGB 空间 mix;与 layout.tsx 内联脚本同算法,改则同步):
 * - hover:亮色向黑混 10% / 暗色向白混 12%(hover 永远向「更强」方向走);
 * - soft:accent 11% + bg 89%(bg 传当前 --bg-canvas 计算色;缺省按模式画布
 *   暗 #101114 / 亮 #FAFAF9);
 * - glow:accent 30% alpha;
 * - text-on-accent:朴素加权亮度 (0.2126R+0.7152G+0.0722B)/255 > 0.5 压深字,否则白字。
 * 非法 hex 返回 null(调用方按「无自定义」处理)。
 */
export function deriveAccentVars(
  accent: string,
  mode: Mode = "light",
  bg?: string,
): DerivedAccentVars | null {
  const rgb = hexToRgb(accent);
  if (!rgb) return null;
  const [r, g, b] = rgb;
  const dark = mode === "dark";
  const bgRgb = (bg ? hexToRgb(bg) : null) ?? (dark ? [16, 17, 20] : [250, 250, 249]);
  const target: [number, number, number] = dark ? [255, 255, 255] : [0, 0, 0];
  const hp = dark ? 0.12 : 0.1;
  const hover = rgbToHex([
    r + (target[0] - r) * hp,
    g + (target[1] - g) * hp,
    b + (target[2] - b) * hp,
  ]);
  const soft = rgbToHex([
    r * 0.11 + bgRgb[0] * 0.89,
    g * 0.11 + bgRgb[1] * 0.89,
    b * 0.11 + bgRgb[2] * 0.89,
  ]);
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return {
    accent,
    accentHover: hover,
    accentSoft: soft,
    accentGlow: `rgba(${r}, ${g}, ${b}, 0.30)`,
    textOnAccent: luma > 0.5 ? "#17181A" : "#FFFFFF",
  };
}

/** 读取当前模式(SSR 安全,服务端回落 light) */
export function getCurrentMode(): Mode {
  if (typeof window === "undefined") return "light";
  try {
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 读取自定义覆盖(SSR 安全;损坏 JSON/非法字段逐项剥离,回落 {}) */
export function getCustom(): ThemeCustom {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Partial<ThemeCustom> | null;
    const out: ThemeCustom = {};
    if (o && typeof o.accent === "string" && HEX6.test(o.accent)) out.accent = o.accent;
    if (o && o.pureBlack === true) out.pureBlack = true;
    return out;
  } catch {
    return {};
  }
}

const ACCENT_VAR_KEYS = [
  "--accent",
  "--accent-hover",
  "--accent-soft",
  "--accent-glow",
  "--text-on-accent",
] as const;

/**
 * 自定义 accent 的 inline 注入/清除(inline 优先级天然最高,压过全部 CSS 块)。
 * 须在 dataset(theme/mode) 变更之后调用:soft 依赖当时的画布计算色重派生。
 * accent 缺省读 localStorage;无自定义/非法值时移除全部 inline 覆盖。
 */
function refreshCustomAccentInline(accent?: string): void {
  const style = document.documentElement.style;
  const value = accent ?? getCustom().accent;
  const derived = value
    ? deriveAccentVars(
        value,
        document.documentElement.dataset.mode === "dark" ? "dark" : "light",
        getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim() ||
          undefined,
      )
    : null;
  if (!derived) {
    for (const k of ACCENT_VAR_KEYS) style.removeProperty(k);
    return;
  }
  style.setProperty("--accent", derived.accent);
  style.setProperty("--accent-hover", derived.accentHover);
  style.setProperty("--accent-soft", derived.accentSoft);
  style.setProperty("--accent-glow", derived.accentGlow);
  style.setProperty("--text-on-accent", derived.textOnAccent);
}

/** 把模式写到 documentElement.dataset.mode(不写 localStorage;跨页同步时复用) */
export function applyModeDataset(mode: Mode): void {
  if (mode === "dark") {
    document.documentElement.dataset.mode = "dark";
  } else {
    delete document.documentElement.dataset.mode;
  }
  // 模式切换改变画布计算色:自定义 accent 的 hover/soft 需按新模式重派生
  refreshCustomAccentInline();
  syncThemeColorMeta();
}

/** 应用模式:写 localStorage + documentElement.dataset.mode,无刷新即时生效 */
export function applyMode(mode: Mode): void {
  try {
    window.localStorage.setItem(MODE_STORAGE_KEY, mode);
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyModeDataset(mode);
  broadcastThemeChanged({ mode });
}

/** 自定义覆盖写 DOM(dataset.pureBlack + inline accent 系),不写 localStorage(跨页同步复用) */
export function applyCustomDom(c: ThemeCustom): void {
  if (c.pureBlack) {
    document.documentElement.dataset.pureBlack = "1";
  } else {
    delete document.documentElement.dataset.pureBlack;
  }
  refreshCustomAccentInline(c.accent);
  syncThemeColorMeta();
}

/** 应用自定义覆盖:清洗非法字段 → 写 localStorage(空对象则移除 key)→ 写 DOM */
export function applyCustom(c: ThemeCustom): void {
  const clean: ThemeCustom = {};
  if (c.accent && HEX6.test(c.accent)) clean.accent = c.accent;
  if (c.pureBlack === true) clean.pureBlack = true;
  try {
    if (clean.accent || clean.pureBlack) {
      window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify(clean));
    } else {
      window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
    }
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyCustomDom(clean);
  broadcastThemeChanged({ custom: clean });
}
