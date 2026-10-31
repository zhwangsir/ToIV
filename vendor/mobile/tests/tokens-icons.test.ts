import { describe, expect, it } from 'vitest';

import { ICON_PATHS } from '@/components/ui/icons.generated';
import {
  DEFAULT_THEME_ID,
  PASS_BADGE_BG,
  THEME_PRESETS,
  accentOnColor,
  accentSoftFrom,
  getPalette,
  normalizeThemeId,
  toRpx,
} from '@/theme/tokens';

describe('设计 token（P4 / web v9）', () => {
  it('五套预设 × 双变体，10 个语义角色齐全', () => {
    expect(THEME_PRESETS).toHaveLength(5);
    expect(THEME_PRESETS.map((p) => p.id)).toEqual([
      'toiv',
      'minimal',
      'cinema',
      'paper',
      'graphite',
    ]);
    const roles = [
      'bg',
      'surface',
      'border',
      'text',
      'textSecondary',
      'accent',
      'accentSoft',
      'success',
      'warning',
      'danger',
    ] as const;
    for (const p of THEME_PRESETS) {
      expect(typeof p.darkBased).toBe('boolean');
      expect(p.swatchBg).toMatch(/^#[0-9A-Fa-f]{6}$/);
      expect(p.swatchAccent).toMatch(/^#[0-9A-Fa-f]{6}$/);
      for (const mode of ['light', 'dark'] as const) {
        for (const role of roles) {
          expect(p[mode][role], `${p.id}.${mode}.${role}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
      }
    }
  });

  it('cinema/graphite 为暗基底；minimal/paper 为亮基底', () => {
    expect(THEME_PRESETS.find((p) => p.id === 'cinema')?.darkBased).toBe(true);
    expect(THEME_PRESETS.find((p) => p.id === 'graphite')?.darkBased).toBe(true);
    expect(THEME_PRESETS.find((p) => p.id === 'minimal')?.darkBased).toBe(false);
    expect(THEME_PRESETS.find((p) => p.id === 'paper')?.darkBased).toBe(false);
  });

  it('暗基底 getPalette 忽略 mode（light===dark）', () => {
    expect(getPalette('cinema', 'light')).toEqual(getPalette('cinema', 'dark'));
    expect(getPalette('graphite', 'light')).toEqual(getPalette('graphite', 'dark'));
  });

  it('默认主题是 toiv（浅色优先）', () => {
    expect(DEFAULT_THEME_ID).toBe('toiv');
    expect(THEME_PRESETS.find((p) => p.id === 'toiv')?.darkBased).toBe(false);
  });

  it('toiv 预设对齐桌面/Web --user-* token', () => {
    expect(getPalette('toiv', 'light')).toMatchObject({ bg: '#F8F8FA', surface: '#FFFFFF', text: '#1D1D21', accent: '#242426' });
    expect(getPalette('toiv', 'dark')).toMatchObject({ bg: '#101010', surface: '#161616', text: '#F3F3F5', accent: '#3B3B3E' });
    expect(accentOnColor(getPalette('toiv', 'light').accent)).toBe('#FFFFFF');
    expect(accentOnColor(getPalette('toiv', 'dark').accent)).toBe('#FFFFFF');
  });

  it('未知 / 旧色板 id 回落或迁移', () => {
    expect(normalizeThemeId('nope')).toBe('toiv');
    expect(normalizeThemeId('palette-01')).toBe('toiv');
    expect(normalizeThemeId('atelier')).toBe('toiv');
    expect(normalizeThemeId('beeftv')).toBe('toiv');
    expect(THEME_PRESETS.find((p) => p.id === 'toiv')?.name).toBe('ToIV');
    expect(normalizeThemeId('minimal')).toBe('minimal');
    expect(normalizeThemeId('palette-04')).toBe('graphite');
    expect(normalizeThemeId('palette-05')).toBe('paper');
    expect(getPalette('nope', 'light')).toEqual(getPalette('toiv', 'light'));
  });

  it('cinema accent 为 RunningHub 荧光绿', () => {
    expect(getPalette('cinema', 'dark').accent).toBe('#C9F24F');
  });

  it('实测可用徽标字色固定为深色（荧光绿底）', () => {
    expect(accentOnColor(PASS_BADGE_BG)).toBe('#17181A');
  });

  it('accentOnColor / accentSoftFrom 工具', () => {
    expect(accentOnColor('#C9F24F')).toBe('#17181A');
    expect(accentOnColor('#17181A')).toBe('#FFFFFF');
    expect(accentSoftFrom('#8B5CF6', false)).toMatch(/^#[0-9A-Fa-f]{6}$/);
    expect(accentSoftFrom('#8B5CF6', true)).toMatch(/^#[0-9A-Fa-f]{6}$/);
  });

  it('pt → rpx ×2 换算', () => {
    expect(toRpx(4)).toBe('8rpx');
    expect(toRpx(16)).toBe('32rpx');
  });
});

describe('Lucide 图标白名单', () => {
  it('关键图标已生成', () => {
    for (const name of ['sparkles', 'layers', 'image', 'user', 'send', 'x', 'check']) {
      expect(ICON_PATHS[name], name).toBeTruthy();
    }
  });

  it('内容为 SVG 内部片段（path/circle 等）', () => {
    for (const inner of Object.values(ICON_PATHS)) {
      expect(inner).toMatch(/^<(path|circle|rect|line|polyline|polygon|ellipse)/);
    }
  });

  it('无外链引用（离线可用）', () => {
    for (const inner of Object.values(ICON_PATHS)) {
      expect(inner).not.toContain('http');
    }
  });
});
