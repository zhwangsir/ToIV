import { describe, expect, it } from 'vitest';

import { ICON_PATHS } from '@/components/ui/icons.generated';
import {
  DEFAULT_THEME_ID,
  THEME_PRESETS,
  accentOnColor,
  accentSoftFrom,
  getPalette,
  normalizeThemeId,
  toRpx,
} from '@/theme/tokens';

describe('设计 token（P4 / web v9）', () => {
  it('四套预设 × 双变体，10 个语义角色齐全', () => {
    expect(THEME_PRESETS).toHaveLength(4);
    expect(THEME_PRESETS.map((p) => p.id)).toEqual([
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

  it('默认主题是 minimal（浅色优先）', () => {
    expect(DEFAULT_THEME_ID).toBe('minimal');
  });

  it('未知 / 旧色板 id 回落或迁移', () => {
    expect(normalizeThemeId('nope')).toBe('minimal');
    expect(normalizeThemeId('palette-01')).toBe('minimal');
    expect(normalizeThemeId('palette-04')).toBe('graphite');
    expect(normalizeThemeId('palette-05')).toBe('paper');
    expect(getPalette('nope', 'light')).toEqual(getPalette('minimal', 'light'));
  });

  it('cinema accent 为 RunningHub 荧光绿', () => {
    expect(getPalette('cinema', 'dark').accent).toBe('#C9F24F');
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
