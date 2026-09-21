/** 助手输入框一次性草稿通道(2026-09-22 A2「在对话中继续」)。
 *
 * 写入方(如 agent-runs 详情页)stash 文本后跳 `/?view=home`;
 * AssistantView(page 形态)挂载时 take 取出并即删——一次性,刷新不残留。
 */

export const ASSISTANT_DRAFT_KEY = "toiv_assistant_draft";

/** 存草稿(localStorage 不可用时静默忽略)。 */
export function stashAssistantDraft(text: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(ASSISTANT_DRAFT_KEY, text);
  } catch {
    /* localStorage 不可用时静默忽略 */
  }
}

/** 取草稿并即删(一次性语义);无草稿/无窗口/损坏一律回退空串。 */
export function takeAssistantDraft(): string {
  if (typeof window === "undefined") return "";
  try {
    const v = window.localStorage.getItem(ASSISTANT_DRAFT_KEY) ?? "";
    if (v) window.localStorage.removeItem(ASSISTANT_DRAFT_KEY);
    return v;
  } catch {
    return "";
  }
}
