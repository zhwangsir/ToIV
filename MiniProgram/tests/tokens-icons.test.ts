import { describe, expect, it } from 'vitest';

import { ICON_PATHS } from '@/components/ui/icons.generated';
import {
  DEFAULT_PALETTE_ID,
  getPalette,
  palettes,
  toRpx,
} from '@/theme/tokens';

describe('设计 token', () => {
  it('5 套色板 × 双变体，10 个语义角色齐全', () => {
    expect(palettes).toHaveLength(5);
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
    for (const p of palettes) {
      for (const mode of ['light', 'dark'] as const) {
        for (const role of roles) {
          expect(p[mode][role], `${p.id}.${mode}.${role}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
        }
      }
    }
  });

  it('默认色板是 palette-01（浅色优先）', () => {
    expect(DEFAULT_PALETTE_ID).toBe('palette-01');
  });

  it('未知 id 回落 palette-01', () => {
    expect(getPalette('nope', 'light')).toEqual(getPalette('palette-01', 'light'));
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
