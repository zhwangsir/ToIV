export const ENGINE_DRAFT_KEY = "toiv_engine_draft";

export interface EngineDraft {
  prompt: string;
  target: string;
}

let lastConsumed: { draft: EngineDraft; at: number } | null = null;

/** 读取并消费 engine 草稿(读取后清除,避免重复回填)。
 *  500ms 内重复调用返回同一份草稿,兼容 React StrictMode 双挂载。
 *  传 expectedTarget 时只消费 target 匹配的草稿;不匹配返回 null 且保留原草稿,
 *  供锁定 kind 的板块视图(图片/视频/音频)避免吃掉其他板块的草稿。 */
export function consumeEngineDraft(expectedTarget?: string): EngineDraft | null {
  if (typeof window === "undefined") return null;
  try {
    if (lastConsumed && Date.now() - lastConsumed.at < 500) {
      if (expectedTarget && lastConsumed.draft.target !== expectedTarget) return null;
      return lastConsumed.draft;
    }
    const raw = window.localStorage.getItem(ENGINE_DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<EngineDraft>;
    if (typeof parsed.prompt !== "string" || typeof parsed.target !== "string") return null;
    if (expectedTarget && parsed.target !== expectedTarget) return null;
    window.localStorage.removeItem(ENGINE_DRAFT_KEY);
    const draft = { prompt: parsed.prompt, target: parsed.target };
    lastConsumed = { draft, at: Date.now() };
    return draft;
  } catch {
    return null;
  }
}
