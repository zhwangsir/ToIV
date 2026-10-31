/**
 * Studio 剧本拆解轮询决策(2026-08-30)。
 *
 * 拆解已异步(提交 Job → 2s 轮询),但超时只抛错不 cancelJob,作业继续跑;
 * 确认框「取消」在 parsing 时 disabled,主按钮「AI 拆解中…」也是死控件。
 * 本模块把「还要不要等」收成纯函数,超时/用户中止都走 cancelJob。
 */
export const STUDIO_PARSE_DEADLINE_MS = 8 * 60_000;
export const STUDIO_PARSE_POLL_MS = 2_000;

export type StudioParsePollAction = "done" | "fail" | "wait" | "timeout";

/** 一轮 GET parse-status 之后:done 取结果;fail 抛业务错;timeout 先中止再报超时;wait 再睡 2s。 */
export function studioParsePollDecision(
  status: string,
  elapsedMs: number,
  deadlineMs = STUDIO_PARSE_DEADLINE_MS,
): StudioParsePollAction {
  if (status === "done") return "done";
  if (status === "error" || status === "canceled") return "fail";
  if (elapsedMs >= deadlineMs) return "timeout";
  return "wait";
}

export function isParseAbortError(e: unknown): boolean {
  return (
    (typeof DOMException !== "undefined" && e instanceof DOMException && e.name === "AbortError") ||
    (e instanceof Error && e.name === "AbortError")
  );
}
