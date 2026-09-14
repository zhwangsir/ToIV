/**
 * 设计 Token —— MiniProgram 视觉事实源（P4 2026-09-07 对齐 web 主题系统 v9）
 * - 四套预设：minimal / cinema / paper / graphite（与 apps/web/lib/theme.ts + globals.css 同口径）
 * - 亮基底（minimal/paper）有 light/dark；暗基底（cinema/graphite）恒暗，mode 切换不改色
 * - 颜色只允许引用本文件（或经 useAppTheme 注入的 CSS 变量），组件禁裸写装饰 hex
 * - 尺寸单位：cssVarsFromPalette 统一 ×2 换算（4pt 网格 → 8rpx 起步）
 */

export const spacing = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  5: 20,
  6: 24,
  8: 32,
  10: 40,
  12: 48,
} as const;

export const radius = {
  sm: 6,
  md: 10,
  lg: 16,
  xl: 24,
  full: 999,
} as const;

export const typography = {
  display: { fontSize: 32, lineHeight: 40 },
  title: { fontSize: 24, lineHeight: 32, letterSpacing: -0.48 },
  heading: { fontSize: 18, lineHeight: 26 },
  body: { fontSize: 16, lineHeight: 24 },
  caption: { fontSize: 13, lineHeight: 18 },
  mono: { fontSize: 14, lineHeight: 20 },
} as const;

export type ThemePresetId = 'minimal' | 'cinema' | 'paper' | 'graphite';

export interface Palette {
  bg: string;
  surface: string;
  border: string;
  text: string;
  textSecondary: string;
  accent: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
}

export interface ThemePresetEntry {
  id: ThemePresetId;
  name: string;
  /** 暗基底：明暗切换不生效（与 web ThemePicker darkBased 同语义） */
  darkBased: boolean;
  /** 缩略色卡：底色 + accent 点（预览即主题定义本身） */
  swatchBg: string;
  swatchAccent: string;
  light: Palette;
  dark: Palette;
}

/** @deprecated 用 ThemePresetEntry；保留别名避免旧 import 断裂 */
export type PaletteEntry = ThemePresetEntry;

const STATUS_LIGHT = {
  success: '#0C6B34',
  warning: '#8A4A06',
  danger: '#B41919',
} as const;

const STATUS_DARK = {
  success: '#46BE7E',
  warning: '#E5A34B',
  danger: '#F58484',
} as const;

const STATUS_PAPER = {
  success: '#0A5C2D',
  warning: '#7A3F05',
  danger: '#A31515',
} as const;

/** 四套预设 —— 色值对齐 apps/web/app/globals.css 主题块 */
export const THEME_PRESETS: ThemePresetEntry[] = [
  {
    id: 'minimal',
    name: '极简白',
    darkBased: false,
    swatchBg: '#FAFAF9',
    swatchAccent: '#17181A',
    light: {
      bg: '#FAFAF9',
      surface: '#FAFAFA',
      border: '#E8E8E9',
      text: '#17181A',
      textSecondary: '#54565C',
      accent: '#17181A',
      accentSoft: '#ECECED',
      ...STATUS_LIGHT,
    },
    dark: {
      bg: '#101114',
      surface: '#16181C',
      border: '#2A2C31',
      text: '#F4F4F3',
      textSecondary: '#A9ACB2',
      accent: '#F5F5F4',
      accentSoft: '#2A2C30',
      ...STATUS_DARK,
    },
  },
  {
    id: 'cinema',
    name: '影院',
    darkBased: true,
    swatchBg: '#0B0D10',
    swatchAccent: '#C9F24F',
    light: {
      bg: '#0B0D10',
      surface: '#14171C',
      border: '#262B33',
      text: '#F2F4F6',
      textSecondary: '#B9C0C9',
      accent: '#C9F24F',
      accentSoft: '#2A3218',
      ...STATUS_DARK,
    },
    dark: {
      bg: '#0B0D10',
      surface: '#14171C',
      border: '#262B33',
      text: '#F2F4F6',
      textSecondary: '#B9C0C9',
      accent: '#C9F24F',
      accentSoft: '#2A3218',
      ...STATUS_DARK,
    },
  },
  {
    id: 'paper',
    name: '纸墨',
    darkBased: false,
    swatchBg: '#F5EFE3',
    swatchAccent: '#2B2318',
    light: {
      bg: '#F5EFE3',
      surface: '#FBF7ED',
      border: '#E7DCC6',
      text: '#2B2318',
      textSecondary: '#5C5142',
      accent: '#2B2318',
      accentSoft: '#EDE6D8',
      ...STATUS_PAPER,
    },
    // paper 暗档与 minimal 暗档同轨（web: data-mode=dark 压过 paper）
    dark: {
      bg: '#101114',
      surface: '#16181C',
      border: '#2A2C31',
      text: '#F4F4F3',
      textSecondary: '#A9ACB2',
      accent: '#F5F5F4',
      accentSoft: '#2A2C30',
      ...STATUS_DARK,
    },
  },
  {
    id: 'graphite',
    name: '石墨',
    darkBased: true,
    swatchBg: '#0A0B0D',
    swatchAccent: '#FFFFFF',
    light: {
      bg: '#0A0B0D',
      surface: '#101214',
      border: '#2A2C31',
      text: '#F4F4F3',
      textSecondary: '#A9ACB2',
      accent: '#FFFFFF',
      accentSoft: '#2A2C30',
      ...STATUS_DARK,
    },
    dark: {
      bg: '#0A0B0D',
      surface: '#101214',
      border: '#2A2C31',
      text: '#F4F4F3',
      textSecondary: '#A9ACB2',
      accent: '#FFFFFF',
      accentSoft: '#2A2C30',
      ...STATUS_DARK,
    },
  },
];

/** 兼容旧名：与 THEME_PRESETS 同一引用 */
export const palettes = THEME_PRESETS;

export const DEFAULT_THEME_ID: ThemePresetId = 'minimal';
/** @deprecated 用 DEFAULT_THEME_ID */
export const DEFAULT_PALETTE_ID = DEFAULT_THEME_ID;

const PRESET_IDS = new Set<string>(THEME_PRESETS.map((p) => p.id));

/** 旧五色板 / 实验 id → v9 预设 */
const LEGACY_THEME_MAP: Record<string, ThemePresetId> = {
  'palette-01': 'minimal',
  'palette-02': 'minimal',
  'palette-03': 'minimal',
  'palette-04': 'graphite',
  'palette-05': 'paper',
  atelier: 'minimal',
};

export function normalizeThemeId(id: string | null | undefined): ThemePresetId {
  if (!id) return DEFAULT_THEME_ID;
  if (PRESET_IDS.has(id)) return id as ThemePresetId;
  return LEGACY_THEME_MAP[id] ?? DEFAULT_THEME_ID;
}

export function getThemePreset(id: string): ThemePresetEntry {
  const nid = normalizeThemeId(id);
  return THEME_PRESETS.find((p) => p.id === nid) ?? THEME_PRESETS[0];
}

/**
 * 解析色板。暗基底主题忽略 mode（恒用 dark 轨，与 web 同）。
 */
export function getPalette(id: string, mode: 'light' | 'dark'): Palette {
  const entry = getThemePreset(id);
  if (entry.darkBased) return entry.dark;
  return entry[mode];
}

const ACCENT_HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isAccentHex(hex: string | null | undefined): hex is string {
  return typeof hex === 'string' && ACCENT_HEX_RE.test(hex);
}

/** 自定义 accent 上的文字色：按感知亮度取近黑/白（与 web accentOnColor 同公式） */
export function accentOnColor(hex: string): '#17181A' | '#FFFFFF' {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const l = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return l > 0.55 ? '#17181A' : '#FFFFFF';
}

/** 在 hex 上叠一层近似 soft 底（小程序 CSS 变量用不透明 hex 更稳） */
export function accentSoftFrom(hex: string, onDark: boolean): string {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  const alpha = onDark ? 0.14 : 0.1;
  const base = onDark ? 22 : 250;
  const mix = (c: number) => Math.round(base * (1 - alpha) + c * alpha);
  const to = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to(mix(r))}${to(mix(g))}${to(mix(b))}`;
}

/** 快捷强调色（与 web ThemePicker ACCENT_SWATCHES 对齐） */
export const ACCENT_SWATCHES = [
  '#C9F24F',
  '#8B5CF6',
  '#3B82F6',
  '#F59E0B',
  '#EF4444',
  '#17181A',
] as const;

/** pt → rpx（iPhone 6 基准 1pt ≈ 2rpx），小程序端尺寸统一走这里 */
export function toRpx(pt: number): string {
  return `${pt * 2}rpx`;
}
