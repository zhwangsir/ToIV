/**
 * 输入草稿持久化（M24）：按 sessionId 隔离的输入框草稿
 * - 存储走全局 MMKV 实例（lib/mmkv.ts，同步读写，与 settings 持久化同一封装；token 禁令不涉及）
 * - key `assistant_draft:{sid}`；新会话（尚未分配 id）固定 `assistant_draft:__new__`
 * - 纯函数层 loadDraft/saveDraft/clearDraft 便于单测；hook 层 300ms 防抖写，
 *   切换会话/卸载前补写未落盘内容（防竞态把 A 会话草稿写进 B 会话键）
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { storage } from '@/lib/mmkv';

/** 草稿键前缀（新会话占位 id：__new__） */
export const ASSISTANT_DRAFT_PREFIX = 'assistant_draft:';
export const NEW_SESSION_DRAFT_ID = '__new__';

/** 防抖写间隔（连续输入合并落盘） */
export const DRAFT_SAVE_DEBOUNCE_MS = 300;

export function draftKeyFor(sessionId: string | undefined): string {
  return `${ASSISTANT_DRAFT_PREFIX}${sessionId ?? NEW_SESSION_DRAFT_ID}`;
}

/** 读取草稿（无草稿返回空串，调用方直填输入框） */
export function loadDraft(sessionId: string | undefined): string {
  return storage.getString(draftKeyFor(sessionId)) ?? '';
}

/** 写入草稿；空串等价清除（不留空占位键） */
export function saveDraft(sessionId: string | undefined, text: string): void {
  const key = draftKeyFor(sessionId);
  if (text) storage.set(key, text);
  else storage.remove(key);
}

export function clearDraft(sessionId: string | undefined): void {
  storage.remove(draftKeyFor(sessionId));
}

export interface AssistantDraft {
  /** 受控输入值（初始/切换会话时从存储回填） */
  value: string;
  /** 输入变更：受控更新 + 300ms 防抖落盘 */
  setValue: (next: string) => void;
  /** 发送成功：立即清空并移除存储键（撤销未落盘的写） */
  clear: () => void;
}

/**
 * 输入草稿受控 hook
 * - 切换会话：渲染期调整（React 推荐模式，替代 setState-in-effect）——先补写旧会话
 *   未落盘的写，再回填目标会话草稿；卸载时经 effect cleanup 兜底补写
 * - 防抖回调经 pendingRef 捕获输入时的 sessionId，迟到的写不会串会话
 */
export function useAssistantDraft(sessionId: string | undefined): AssistantDraft {
  const [value, setValue] = useState(() => loadDraft(sessionId));
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingRef = useRef<{ sid: string | undefined; text: string } | null>(null);

  const flushPending = useCallback((): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const p = pendingRef.current;
    pendingRef.current = null;
    if (p) saveDraft(p.sid, p.text);
  }, []);

  // 卸载兜底：补写未落盘内容（切换会话走下方渲染期调整 + effect 补写，不经此处）
  useEffect(() => flushPending, [flushPending]);

  // 渲染期切换会话：回填新会话草稿（对齐 artifact-detail 保活模式；渲染期禁碰 ref，
  // 旧会话未落盘的 pending 写由下方 effect 在 commit 后补写——pendingRef 捕获的是旧 sid，不串键）
  const [loadedSid, setLoadedSid] = useState(sessionId);
  if (sessionId !== loadedSid) {
    setLoadedSid(sessionId);
    setValue(loadDraft(sessionId));
  }

  // 切换后补写上一会话未落盘草稿（effect 内访问 ref 合法；挂载首跑 pending 为空无害）
  useEffect(() => {
    flushPending();
  }, [sessionId, flushPending]);

  const setDraft = (next: string): void => {
    setValue(next);
    pendingRef.current = { sid: sessionId, text: next };
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      flushPending();
    }, DRAFT_SAVE_DEBOUNCE_MS);
  };

  const clear = (): void => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    pendingRef.current = null;
    setValue('');
    clearDraft(sessionId);
  };

  return { value, setValue: setDraft, clear };
}
