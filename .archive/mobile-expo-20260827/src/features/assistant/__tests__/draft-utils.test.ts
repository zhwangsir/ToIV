import { storage } from '@/lib/mmkv';

import {
  clearDraft,
  DRAFT_SAVE_DEBOUNCE_MS,
  draftKeyFor,
  loadDraft,
  NEW_SESSION_DRAFT_ID,
  saveDraft,
} from '../draft-utils';

// react-native-mmkv 由 jest moduleNameMapper 全局替换为内存替身（src/test/mmkv-mock.ts）
describe('draft-utils（M24.2 输入草稿持久化纯函数层）', () => {
  beforeEach(() => {
    storage.clearAll();
  });

  it('draftKeyFor：会话 id 拼前缀；新会话（undefined）走 __new__ 占位', () => {
    expect(draftKeyFor('s1')).toBe('assistant_draft:s1');
    expect(draftKeyFor(undefined)).toBe(`assistant_draft:${NEW_SESSION_DRAFT_ID}`);
  });

  it('saveDraft/loadDraft 往返；无草稿 loadDraft 返回空串', () => {
    expect(loadDraft('s1')).toBe('');
    saveDraft('s1', '画一只猫');
    expect(loadDraft('s1')).toBe('画一只猫');
    // 覆盖写
    saveDraft('s1', '画两只猫');
    expect(loadDraft('s1')).toBe('画两只猫');
  });

  it('saveDraft 空串等价清除（不留空占位键）', () => {
    saveDraft('s1', '有内容');
    saveDraft('s1', '');
    expect(loadDraft('s1')).toBe('');
    expect(storage.contains(draftKeyFor('s1'))).toBe(false);
  });

  it('clearDraft 移除存储键；清不存在的键不报错', () => {
    saveDraft('s1', 'x');
    clearDraft('s1');
    expect(loadDraft('s1')).toBe('');
    expect(() => clearDraft('ghost')).not.toThrow();
  });

  it('按 sessionId 隔离：新会话与会话互不可见', () => {
    saveDraft(undefined, '新会话草稿');
    saveDraft('s1', 's1 草稿');
    saveDraft('s2', 's2 草稿');
    expect(loadDraft(undefined)).toBe('新会话草稿');
    expect(loadDraft('s1')).toBe('s1 草稿');
    expect(loadDraft('s2')).toBe('s2 草稿');
    clearDraft('s1');
    expect(loadDraft('s1')).toBe('');
    expect(loadDraft(undefined)).toBe('新会话草稿');
  });

  it('防抖间隔常量 300ms（契约固定值，防手滑改没）', () => {
    expect(DRAFT_SAVE_DEBOUNCE_MS).toBe(300);
  });
});
