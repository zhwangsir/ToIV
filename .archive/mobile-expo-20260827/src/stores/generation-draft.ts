/**
 * 创作草稿回填（作品库「复用提示词」→ 创作屏）
 * - 非持久化：草稿只活一次会话，消费即焚（一次性语义，防回退页面后重复回填）
 * - 与 settings 分层：settings 是用户偏好（MMKV 持久化），draft 是跨屏一次性传参
 */
import { create } from 'zustand';

export interface GenerationDraft {
  /** 回填到 PromptBar 的正向提示词 */
  prompt: string;
}

interface GenerationDraftState {
  draft: GenerationDraft | null;
  setDraft: (draft: GenerationDraft) => void;
  /** 取出并清空（consume-once）；无草稿返回 null */
  consumeDraft: () => GenerationDraft | null;
}

export const useGenerationDraft = create<GenerationDraftState>((set, get) => ({
  draft: null,
  setDraft: (draft) => set({ draft }),
  consumeDraft: () => {
    const { draft } = get();
    if (draft) set({ draft: null });
    return draft;
  },
}));
