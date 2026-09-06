/**
 * 主题系统 v9(2026-09-07):预设主题 + 明暗模式 + 自定义强调色三维度。
 * - 预设主题:minimal(缺省,极简白)/ cinema(影院,荧光绿暗基底)/ paper(纸墨,亮基底)/
 *   graphite(石墨,深化暗基底);html[data-theme] 承载(minimal 不写属性),
 *   持久化 localStorage["toiv_theme"];色值唯一事实源 globals.css 各主题块。
 * - 模式:light(默认)/ dark(data-mode="dark"),仅对亮基底主题(minimal/paper)生效;
 *   持久化 localStorage["toiv_mode"]。
 * - 纯黑子档:仅亮基底主题暗档生效;与旧「自定义」同 key(toiv_theme_custom,
 *   仅存 {pureBlack:true};旧 accent 字段读取时迁移到 toiv_accent_custom)。
 * - 自定义强调色:localStorage["toiv_accent_custom"](hex6),经内联 --accent-user +
 *   [data-accent-custom] 块 color-mix 派生覆盖任意主题;清除回主题默认。
 * - layout.tsx 内联脚本首帧前读全部 key 写 dataset/内联 var 防 FOUC。
 */

export type Mode = "light" | "dark";

export const MODE_STORAGE_KEY = "toiv_mode";
export const CUSTOM_STORAGE_KEY = "toiv_theme_custom";
export const THEME_STORAGE_KEY = "toiv_theme";
export const ACCENT_STORAGE_KEY = "toiv_accent_custom";

/** 预设主题;minimal 为缺省(不落 data-theme 属性) */
export type ThemePreset = "minimal" | "cinema" | "paper" | "graphite";

export interface ThemePresetMeta {
  id: ThemePreset;
  name: string;
  /** 暗基底主题:明暗切换/纯黑子档不生效(ThemePicker 据此隐藏模式行) */
  darkBased: boolean;
  /** 缩略色卡:底色 + accent 点(预览即主题定义本身,非装饰色,豁免硬编码纪律) */
  swatchBg: string;
  swatchAccent: string;
}

export const THEME_PRESETS: readonly ThemePresetMeta[] = [
  { id: "minimal", name: "极简白", darkBased: false, swatchBg: "#FAFAF9", swatchAccent: "#17181A" },
  { id: "cinema", name: "影院", darkBased: true, swatchBg: "#0B0D10", swatchAccent: "#C9F24F" },
  { id: "paper", name: "纸墨", darkBased: false, swatchBg: "#F5EFE3", swatchAccent: "#2B2318" },
  { id: "graphite", name: "石墨", darkBased: true, swatchBg: "#0A0B0D", swatchAccent: "#FFFFFF" },
];

const THEME_PRESET_IDS = new Set<string>(THEME_PRESETS.map((p) => p.id));

/** 同页多实例同步总线:apply* 广播本事件,其余实例订阅刷新选中态。 */
export const THEME_CHANGED_EVENT = "toiv:theme-changed";

export interface ThemeChangedDetail {
  mode?: Mode;
  custom?: ThemeCustom;
  theme?: ThemePreset;
  /** string = 新自定义色;null = 清除回主题默认 */
  accent?: string | null;
}

function broadcastThemeChanged(detail: ThemeChangedDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  window.dispatchEvent(new CustomEvent(THEME_CHANGED_EVENT, { detail }));
}

/** 同步 <meta name="theme-color"> 为当前画布色(--bg-canvas 计算值);meta 缺失时创建 */
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

const ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

/** 自定义 accent 上的文字色:按感知亮度取近黑/白(与 layout.tsx FOUC 脚本同公式) */
export function accentOnColor(hex: string): "#17181A" | "#FFFFFF" {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return l > 0.55 ? "#17181A" : "#FFFFFF";
}

/** 旧版残留清理(幂等):旧自定义里的 accent 字段迁移到 toiv_accent_custom 后剥离
   (toiv_theme_custom 只剩 pureBlack);toiv_theme 的非法值(如 v7 旧色板名)在
   getCurrentTheme 读取时校验清除,此处不动。 */
function migrateLegacyKeys(): void {
  try {
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (raw) {
      const o = JSON.parse(raw) as Record<string, unknown> | null;
      if (o && "accent" in o) {
        const { accent, ...rest } = o;
        // v7 自定义 accent → v9 toiv_accent_custom(新键缺省时才迁移,不覆盖用户新设置)
        if (
          typeof accent === "string" &&
          ACCENT_HEX_RE.test(accent) &&
          !window.localStorage.getItem(ACCENT_STORAGE_KEY)
        ) {
          window.localStorage.setItem(ACCENT_STORAGE_KEY, accent);
        }
        if (rest.pureBlack === true) {
          window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify({ pureBlack: true }));
        } else {
          window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
        }
      }
    }
  } catch {
    /* localStorage 不可用时跳过 */
  }
}

/** 读取当前模式(SSR 安全,服务端回落 light) */
export function getCurrentMode(): Mode {
  if (typeof window === "undefined") return "light";
  try {
    migrateLegacyKeys();
    return window.localStorage.getItem(MODE_STORAGE_KEY) === "dark" ? "dark" : "light";
  } catch {
    return "light";
  }
}

/** 读取当前预设主题(SSR 安全;非法值——含 v7 旧色板名——读取时清除并回落 minimal) */
export function getCurrentTheme(): ThemePreset {
  if (typeof window === "undefined") return "minimal";
  try {
    migrateLegacyKeys();
    const raw = window.localStorage.getItem(THEME_STORAGE_KEY);
    if (!raw) return "minimal";
    if (THEME_PRESET_IDS.has(raw)) return raw as ThemePreset;
    window.localStorage.removeItem(THEME_STORAGE_KEY);
    return "minimal";
  } catch {
    return "minimal";
  }
}

/** 自定义子档:只剩 pureBlack(旧 accent 字段读取时迁移剥离) */
export interface ThemeCustom {
  pureBlack?: boolean;
}

/** 读取纯黑子档(SSR 安全;损坏 JSON 回落 {}) */
export function getCustom(): ThemeCustom {
  if (typeof window === "undefined") return {};
  try {
    migrateLegacyKeys();
    const raw = window.localStorage.getItem(CUSTOM_STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw) as Partial<ThemeCustom> | null;
    return o && o.pureBlack === true ? { pureBlack: true } : {};
  } catch {
    return {};
  }
}

/** 读取自定义强调色(SSR 安全;非法值清除并回落 null = 主题默认 accent) */
export function getCustomAccent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    migrateLegacyKeys();
    const raw = window.localStorage.getItem(ACCENT_STORAGE_KEY);
    if (!raw) return null;
    if (ACCENT_HEX_RE.test(raw)) return raw;
    window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    return null;
  } catch {
    return null;
  }
}

/** 把模式写到 documentElement.dataset.mode(不写 localStorage;跨页同步时复用) */
export function applyModeDataset(mode: Mode): void {
  if (mode === "dark") {
    document.documentElement.dataset.mode = "dark";
  } else {
    delete document.documentElement.dataset.mode;
  }
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

/** 把预设主题写到 dataset.theme(minimal 不写属性),不写 localStorage(跨页同步复用) */
export function applyThemeDataset(theme: ThemePreset): void {
  if (theme === "minimal") {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
  syncThemeColorMeta();
}

/** 应用预设主题:写 localStorage(minimal 移除 key)+ dataset,无刷新即时生效 */
export function applyTheme(theme: ThemePreset): void {
  try {
    if (theme === "minimal") {
      window.localStorage.removeItem(THEME_STORAGE_KEY);
    } else {
      window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    }
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyThemeDataset(theme);
  broadcastThemeChanged({ theme });
}

/** 纯黑子档写 DOM(dataset.pureBlack),不写 localStorage(跨页同步复用) */
export function applyCustomDom(c: ThemeCustom): void {
  if (c.pureBlack) {
    document.documentElement.dataset.pureBlack = "1";
  } else {
    delete document.documentElement.dataset.pureBlack;
  }
  syncThemeColorMeta();
}

/** 应用纯黑子档:写 localStorage(关闭则移除 key)→ 写 DOM */
export function applyCustom(c: ThemeCustom): void {
  try {
    if (c.pureBlack) {
      window.localStorage.setItem(CUSTOM_STORAGE_KEY, JSON.stringify({ pureBlack: true }));
    } else {
      window.localStorage.removeItem(CUSTOM_STORAGE_KEY);
    }
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyCustomDom(c);
  broadcastThemeChanged({ custom: c });
}

/** 自定义 accent 写 DOM(dataset.accentCustom + 内联 --accent-user/--accent-user-on),
   不写 localStorage(跨页同步复用);null = 清除回主题默认 */
export function applyAccentDom(hex: string | null): void {
  const el = document.documentElement;
  if (hex && ACCENT_HEX_RE.test(hex)) {
    el.dataset.accentCustom = "1";
    el.style?.setProperty("--accent-user", hex);
    el.style?.setProperty("--accent-user-on", accentOnColor(hex));
  } else {
    delete el.dataset.accentCustom;
    el.style?.removeProperty("--accent-user");
    el.style?.removeProperty("--accent-user-on");
  }
  syncThemeColorMeta();
}

/** 应用自定义强调色:写 localStorage(null 移除 key)→ 写 DOM,无刷新即时生效 */
export function applyAccent(hex: string | null): void {
  const valid = hex && ACCENT_HEX_RE.test(hex) ? hex : null;
  try {
    if (valid) {
      window.localStorage.setItem(ACCENT_STORAGE_KEY, valid);
    } else {
      window.localStorage.removeItem(ACCENT_STORAGE_KEY);
    }
  } catch {
    /* localStorage 不可用时仅内存态生效 */
  }
  applyAccentDom(valid);
  broadcastThemeChanged({ accent: valid });
}
