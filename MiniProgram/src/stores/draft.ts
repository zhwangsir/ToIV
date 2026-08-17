/**
 * 创作草稿 store：作品库"再次创作"→ 创作屏的提示词回填载体
 * 非持久化，一次性语义（consume 后即清空，对齐 Mobile draft 语义）
 */
import { defineStore } from 'pinia';

interface DraftState {
  prompt: string;
  negativePrompt: string;
  engineId: string | null;
  /** 来源作业 id（用于版本链追踪展示） */
  fromJobId: string | null;
}

export const useDraftStore = defineStore('draft', {
  state: (): DraftState => ({
    prompt: '',
    negativePrompt: '',
    engineId: null,
    fromJobId: null,
  }),

  getters: {
    hasDraft: (s) => s.prompt.length > 0 || s.engineId !== null,
  },

  actions: {
    fill(draft: { prompt: string; negativePrompt?: string; engineId?: string; fromJobId?: string }) {
      this.prompt = draft.prompt;
      this.negativePrompt = draft.negativePrompt ?? '';
      this.engineId = draft.engineId ?? null;
      this.fromJobId = draft.fromJobId ?? null;
    },

    /** 创作屏消费草稿：读走即清空 */
    consume(): DraftState {
      const snapshot = { ...this.$state };
      this.$reset();
      return snapshot;
    },
  },
});
