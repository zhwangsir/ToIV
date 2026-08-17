/**
 * 设计 Token —— 全端唯一视觉事实源（docs/ui-ux-design-guidelines.md 第三节）
 * 规则：
 * - 颜色只允许引用本文件，禁止在组件中裸写 hex（开发规范禁令 2）
 * - 5 套色板 × light/dark 双变体；默认 palette-01 浅色（浅色优先原则）
 * - 每套色板固定 10 个语义角色，保证换肤零改动组件
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

/** 阴影：浅色主题仅细腻浮起；深色主题以边框替代（指南 3.4） */
export const elevation = {
  lift: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 2,
  },
  float: {
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.1,
    shadowRadius: 24,
    elevation: 6,
  },
} as const;

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

export interface PaletteEntry {
  id: string;
  name: string;
  light: Palette;
  dark: Palette;
}

export const palettes: PaletteEntry[] = [
  {
    id: 'palette-01',
    name: '胶片米白',
    light: {
      bg: '#FAF9F7',
      surface: '#FFFFFF',
      border: '#E8E6E1',
      text: '#1C1B1A',
      textSecondary: '#6B6660',
      accent: '#B4532A',
      accentSoft: '#F3E5DD',
      success: '#2E7D4F',
      warning: '#B7791F',
      danger: '#C03A2B',
    },
    dark: {
      bg: '#141312',
      surface: '#1E1C1A',
      border: '#322E2A',
      text: '#F2EFEA',
      textSecondary: '#A39D94',
      accent: '#D98C5F',
      accentSoft: '#3A2A20',
      success: '#5CB87E',
      warning: '#D9A44F',
      danger: '#E06A54',
    },
  },
  {
    id: 'palette-02',
    name: '雾蓝',
    light: {
      bg: '#F7F9FB',
      surface: '#FFFFFF',
      border: '#E3E8EE',
      text: '#17202A',
      textSecondary: '#5E6B7A',
      accent: '#2F5D8A',
      accentSoft: '#E2EBF4',
      success: '#2E7D4F',
      warning: '#B7791F',
      danger: '#C03A2B',
    },
    dark: {
      bg: '#10141A',
      surface: '#1A2029',
      border: '#2C3540',
      text: '#EBF0F5',
      textSecondary: '#98A4B3',
      accent: '#6FA3D8',
      accentSoft: '#24344A',
      success: '#5CB87E',
      warning: '#D9A44F',
      danger: '#E06A54',
    },
  },
  {
    id: 'palette-03',
    name: '松绿',
    light: {
      bg: '#F7FAF8',
      surface: '#FFFFFF',
      border: '#E2EAE5',
      text: '#17211C',
      textSecondary: '#5D6E64',
      accent: '#2F6B4F',
      accentSoft: '#E1EFE7',
      success: '#2E7D4F',
      warning: '#B7791F',
      danger: '#C03A2B',
    },
    dark: {
      bg: '#101512',
      surface: '#1A221D',
      border: '#2B352E',
      text: '#EAF2ED',
      textSecondary: '#97A89E',
      accent: '#6FB390',
      accentSoft: '#22392C',
      success: '#5CB87E',
      warning: '#D9A44F',
      danger: '#E06A54',
    },
  },
  {
    id: 'palette-04',
    name: '墨',
    light: {
      bg: '#FAFAFA',
      surface: '#FFFFFF',
      border: '#E5E5E5',
      text: '#171717',
      textSecondary: '#616161',
      accent: '#1F2937',
      accentSoft: '#E8EAED',
      success: '#2E7D4F',
      warning: '#B7791F',
      danger: '#C03A2B',
    },
    dark: {
      bg: '#111111',
      surface: '#1C1C1C',
      border: '#303030',
      text: '#F0F0F0',
      textSecondary: '#9E9E9E',
      accent: '#D4D8DD',
      accentSoft: '#2E3237',
      success: '#5CB87E',
      warning: '#D9A44F',
      danger: '#E06A54',
    },
  },
  {
    id: 'palette-05',
    name: '暖沙',
    light: {
      bg: '#FBF8F3',
      surface: '#FFFFFF',
      border: '#EBE4D8',
      text: '#201B14',
      textSecondary: '#73685A',
      accent: '#A3722B',
      accentSoft: '#F4E9D7',
      success: '#2E7D4F',
      warning: '#B7791F',
      danger: '#C03A2B',
    },
    dark: {
      bg: '#161310',
      surface: '#211D18',
      border: '#383127',
      text: '#F3EDE3',
      textSecondary: '#B0A592',
      accent: '#D9A558',
      accentSoft: '#43331D',
      success: '#5CB87E',
      warning: '#D9A44F',
      danger: '#E06A54',
    },
  },
];

export const DEFAULT_PALETTE_ID = 'palette-01';

export function getPalette(id: string, mode: 'light' | 'dark'): Palette {
  const entry = palettes.find((p) => p.id === id) ?? palettes[0];
  return entry[mode];
}
