import { describe, expect, it } from 'vitest';

import type { AssetItem } from '@/types/api';
import {
  applyAssetBatchDelete,
  assetSelectIdle,
  canEnterAssetSelecting,
  enterAssetSelecting,
  exitAssetSelecting,
  longPressAssetCard,
  removeDeletedAssets,
  selectAllAssets,
  tapAssetCard,
} from '@/utils/assets-batch';
import type { BatchItemResult } from '@/utils/library-batch';

function makeAsset(overrides: Partial<AssetItem> = {}): AssetItem {
  return {
    id: 'a1',
    kind: 'character',
    name: '主角卡',
    description: '胶片风',
    images: [{ filename: 'f1.png', worker: 'w1' }],
    nsfw: false,
    created_at: '2026-08-14T00:00:00',
    updated_at: '2026-08-14T00:00:00',
    ...overrides,
  };
}

const GUARD_FREE = { editorOpen: false, acting: false };

describe('canEnterAssetSelecting（进入守卫）', () => {
  it('编辑弹层打开 → 拦截（长按让位编辑）', () => {
    expect(canEnterAssetSelecting({ editorOpen: true, acting: false })).toBe(false);
  });

  it('批量执行中 → 拦截（防重入）', () => {
    expect(canEnterAssetSelecting({ editorOpen: false, acting: true })).toBe(false);
  });

  it('弹层关闭且空闲 → 放行', () => {
    expect(canEnterAssetSelecting(GUARD_FREE)).toBe(true);
  });
});

describe('enterAssetSelecting（「选择」钮入口）', () => {
  it('进入选择模式：空选集', () => {
    const next = enterAssetSelecting(assetSelectIdle(), GUARD_FREE);
    expect(next).not.toBeNull();
    expect(next?.selecting).toBe(true);
    expect(next?.selected.size).toBe(0);
  });

  it('编辑弹层打开 → 返回 null（不进入）', () => {
    expect(
      enterAssetSelecting(assetSelectIdle(), { editorOpen: true, acting: false }),
    ).toBeNull();
  });

  it('已在选择态 → 幂等返回原态（不清空已选）', () => {
    const state = { selecting: true, selected: new Set(['a1']) };
    expect(enterAssetSelecting(state, GUARD_FREE)).toBe(state);
  });
});

describe('longPressAssetCard（长按卡片入口）', () => {
  it('未在选择态 → 进入选择模式并选中该卡', () => {
    const next = longPressAssetCard(assetSelectIdle(), GUARD_FREE, 'a1');
    expect(next?.selecting).toBe(true);
    expect(next ? [...next.selected] : []).toEqual(['a1']);
  });

  it('已在选择态 → toggle 该卡（长按加选/取消）', () => {
    const state = { selecting: true, selected: new Set(['a1']) };
    const added = longPressAssetCard(state, GUARD_FREE, 'a2');
    expect(added ? [...added.selected].sort() : []).toEqual(['a1', 'a2']);
    const removed = longPressAssetCard(state, GUARD_FREE, 'a1');
    expect(removed ? [...removed.selected] : []).toEqual([]);
  });

  it('守卫：编辑弹层打开时 longpress 不进入选择态（返回 null）', () => {
    expect(
      longPressAssetCard(assetSelectIdle(), { editorOpen: true, acting: false }, 'a1'),
    ).toBeNull();
  });

  it('守卫：批量执行中 longpress 不动作（返回 null）', () => {
    expect(
      longPressAssetCard(assetSelectIdle(), { editorOpen: false, acting: true }, 'a1'),
    ).toBeNull();
  });

  it('不可变语义：不改入参选择集', () => {
    const state = { selecting: true, selected: new Set(['a1']) };
    longPressAssetCard(state, GUARD_FREE, 'a2');
    expect([...state.selected]).toEqual(['a1']);
  });
});

describe('tapAssetCard（选择态点按 = toggle；非选择态 = 打开编辑）', () => {
  it('选择态点按：未选 → 选中；已选 → 取消', () => {
    const state = { selecting: true, selected: new Set(['a1']) };
    const toggled = tapAssetCard(state, 'a2');
    expect(toggled ? [...toggled.selected].sort() : []).toEqual(['a1', 'a2']);
    const untoggled = tapAssetCard(state, 'a1');
    expect(untoggled ? [...untoggled.selected] : []).toEqual([]);
  });

  it('非选择态点按 → 返回 null（调用方走 openEdit）', () => {
    expect(tapAssetCard(assetSelectIdle(), 'a1')).toBeNull();
  });
});

describe('selectAllAssets / exitAssetSelecting（全选 / 取消清空）', () => {
  it('全选当前过滤可见项的全量 id', () => {
    const items = [makeAsset({ id: 'a1' }), makeAsset({ id: 'a2' }), makeAsset({ id: 'a3' })];
    expect([...selectAllAssets(items)].sort()).toEqual(['a1', 'a2', 'a3']);
  });

  it('取消：退出选择模式并清空选择集', () => {
    const next = exitAssetSelecting();
    expect(next.selecting).toBe(false);
    expect(next.selected.size).toBe(0);
  });
});

function deleteResults(
  ids: string[],
  failIds: string[] = [],
): BatchItemResult<AssetItem>[] {
  return ids.map((id) =>
    failIds.includes(id)
      ? { item: makeAsset({ id }), ok: false, error: 'mock 失败' }
      : { item: makeAsset({ id }), ok: true },
  );
}

describe('applyAssetBatchDelete（批量删除结果落地）', () => {
  it('全部成功：退出选择态 + 清空勾选 + removedIds 全量 + toast「已删除 2 项」', () => {
    const outcome = applyAssetBatchDelete(deleteResults(['a1', 'a2']));
    expect(outcome.selecting).toBe(false);
    expect(outcome.selected.size).toBe(0);
    expect(outcome.removedIds).toEqual(['a1', 'a2']);
    expect(outcome.toast).toBe('已删除 2 项');
  });

  it('部分失败：失败项保留勾选 + 停留选择态 + removedIds 仅成功项 + 汇总文案', () => {
    const outcome = applyAssetBatchDelete(deleteResults(['a1', 'a2', 'a3'], ['a2']));
    expect(outcome.selecting).toBe(true);
    expect([...outcome.selected]).toEqual(['a2']);
    expect(outcome.removedIds).toEqual(['a1', 'a3']);
    expect(outcome.toast).toBe('成功 2 失败 1，失败项已保留勾选');
  });

  it('全败：全部保留勾选停留选择态 + removedIds 空 + 全败文案', () => {
    const outcome = applyAssetBatchDelete(deleteResults(['a1', 'a2'], ['a1', 'a2']));
    expect(outcome.selecting).toBe(true);
    expect([...outcome.selected].sort()).toEqual(['a1', 'a2']);
    expect(outcome.removedIds).toEqual([]);
    expect(outcome.toast).toBe('删除失败，请稍后重试');
  });
});

describe('removeDeletedAssets（本地列表移除成功项）', () => {
  it('移除成功项并保持剩余顺序', () => {
    const list = [
      makeAsset({ id: 'a1' }),
      makeAsset({ id: 'a2' }),
      makeAsset({ id: 'a3' }),
      makeAsset({ id: 'a4' }),
    ];
    const next = removeDeletedAssets(list, ['a2', 'a4']);
    expect(next.map((a) => a.id)).toEqual(['a1', 'a3']);
  });

  it('removedIds 为空 → 原列表内容不变', () => {
    const list = [makeAsset({ id: 'a1' })];
    expect(removeDeletedAssets(list, []).map((a) => a.id)).toEqual(['a1']);
  });
});
