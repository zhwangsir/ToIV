/**
 * AI 助手升级(2026-08-24:tool/job/proposal 三类 SSE 事件)单测(node:test,无 DOM):
 * ① api.ts 契约:agentChatResume 路径/方法/字段 + 命名事件 type 回填(consumeAgentSse)
 * ② AssistantView 源码断言:onEvent 三分支、提案卡三按钮接 resume、8s 轮询、done 媒体渲染
 * ③ 纯函数:upsert 同 id 更新 / applyJobSnapshots 轮询回写 / markProposalResolved 只读
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身(imageUrl 透传)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import type { JobItem } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

// ── window/localStorage 替身:必须在导入组件模块前装好(模块顶层读 window 兜底) ──
const g = globalThis as { window?: unknown; localStorage?: unknown };
g.window ??= globalThis;
const localStore = new Map<string, string>();
g.localStorage = {
  getItem: (k: string) => localStore.get(k) ?? null,
  setItem: (k: string, v: string) => void localStore.set(k, v),
  removeItem: (k: string) => void localStore.delete(k),
  clear: () => localStore.clear(),
};

const {
  upsertToolChip,
  upsertJobCard,
  upsertProposalCard,
  markProposalResolved,
  applyJobSnapshots,
  isJobCardActive,
  jobCardStatusLabel,
  mediaTypeForJob,
  buildApiMessages,
  MAX_API_MESSAGES,
  MAX_API_MESSAGE_CHARS,
  shouldRecoverFromTimeout,
  sessionHasAssistantAfterLastUser,
} = await import("../components/assistant/AssistantView");

type ChatMessage = import("../components/assistant/AssistantView").ChatMessage;

const makeMsg = (id: string, role: "user" | "assistant", over: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  role,
  content: "",
  timestamp: 1,
  ...over,
});

const makeJob = (id: string, over: Partial<JobItem> = {}): JobItem => ({
  id,
  prompt_id: id,
  kind: "txt2img",
  status: "done",
  prompt: "",
  seed: 1,
  created_at: "2026-08-24T00:00:00Z",
  results: [],
  ...over,
});

/* ── ① api.ts 契约 ── */
test("api.ts:agentChatResume 走 /api/agent/chat/resume 且字段齐全", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("export async function agentChatResume"), "agentChatResume 未导出");
  const fn = src.slice(src.indexOf("export async function agentChatResume"));
  assert.ok(fn.includes("`/api/agent/chat/resume`"), "resume 路径错误");
  assert.ok(fn.includes('method: "POST"'), "resume 应为 POST");
  // body 字段在 AgentChatResumeBody 接口(函数之前定义)
  const body = src.slice(src.indexOf("export interface AgentChatResumeBody"));
  assert.ok(body.includes("conversation_id: string"), "缺 conversation_id");
  assert.ok(body.includes("proposal_id: string"), "缺 proposal_id");
  assert.ok(body.includes('"approve" | "modify" | "reject"'), "action 枚举缺失");
  assert.ok(body.includes("note?: string"), "缺可选 note");
  // 响应是同构 SSE 流:复用统一消费器,返回会话 id
  assert.ok(fn.includes("consumeAgentSse"), "resume 未走统一 SSE 消费器");
  assert.ok(fn.includes("X-Agent-Session-Id"), "resume 未读会话 id 响应头");
});

test("api.ts:命名 SSE 事件(tool/job/proposal)以 event 名回填 type", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("async function consumeAgentSse"), "缺统一 SSE 消费器");
  const fn = src.slice(src.indexOf("async function consumeAgentSse"));
  // 命名事件 data 不带 type 字段,须回填,否则前端无法分流
  assert.ok(fn.includes("parsed.type = event"), "未以 event 名回填 type");
  assert.ok(fn.includes('event === "done"'), "缺 done 终止");
  // AgentEvent 承载三类新事件的可选字段
  const ev = src.slice(src.indexOf("export interface AgentEvent"));
  for (const f of ["job_id", "hold_reason", "results", "proposal_id", "estimate", "summary", "detail"]) {
    assert.ok(ev.includes(f), `AgentEvent 缺字段 ${f}`);
  }
});

/* ── ② AssistantView 源码断言 ── */
test("AssistantView:onEvent 处理 tool/job/proposal 三类新事件", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(
    src.includes('ev.type === "tool" || ev.type === "job" || ev.type === "proposal"'),
    "onEvent 缺三类事件分支",
  );
  assert.ok(src.includes("upsertToolChip"), "tool 事件未走 upsertToolChip");
  assert.ok(src.includes("upsertJobCard"), "job 事件未走 upsertJobCard");
  assert.ok(src.includes("upsertProposalCard"), "proposal 事件未走 upsertProposalCard");
  // 工具条渲染:三态图标 + 失败 detail
  assert.ok(src.includes("av-tool-chip"), "缺工具条渲染");
  assert.ok(src.includes('t.status === "error" && t.detail'), "失败未展示 detail");
  for (const s of ['"loading"', '"check"', '"close"']) {
    assert.ok(src.includes(s), `工具条缺 ${s} 图标`);
  }
});

test("AssistantView:提案卡三按钮调 resume 且 body 正确", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  for (const label of ["确认执行", "修改", "放弃", "提交修改"]) {
    assert.ok(src.includes(label), `提案卡缺「${label}」按钮`);
  }
  for (const a of ['onProposalDecision(p, "approve")', 'onProposalDecision(p, "reject")', 'onProposalDecision(p, "modify", modifyNote.trim())']) {
    assert.ok(src.includes(a), `缺 ${a} 调用`);
  }
  // resume body:四字段(note 空时不传)
  assert.ok(src.includes("conversation_id: resume.conversationId"), "resume 缺 conversation_id");
  assert.ok(src.includes("proposal_id: resume.proposalId"), "resume 缺 proposal_id");
  assert.ok(src.includes("action: resume.action"), "resume 缺 action");
  assert.ok(src.includes("resume.note?.trim()"), "resume note 未做空值剔除");
  // 落锤只读态
  assert.ok(src.includes("markProposalResolved"), "决策未落锤只读");
  for (const t of ["已确认执行", "已修改并执行", "已放弃"]) {
    assert.ok(src.includes(t), `缺只读态文案「${t}」`);
  }
});

test("AssistantView:作业卡 8s 轮询(列表+id 过滤)+ done 复用媒体渲染", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  // 轮询:fetchJobsPage 直连(不走 SWR 缓存)+ 8s 间隔 + 快照回写
  assert.ok(src.includes("fetchJobsPage(0, JOBS_PAGE_LIMIT)"), "轮询未走列表端点");
  assert.ok(src.includes("window.setInterval(poll, 8000)"), "轮询间隔非 8s");
  assert.ok(src.includes("applyJobSnapshots"), "轮询未回写快照");
  // 状态徽章五态 + held 原因展示
  for (const t of ["排队中", "资源等待", "运行中", "完成", "失败"]) {
    assert.ok(src.includes(t), `缺状态徽章「${t}」`);
  }
  assert.ok(src.includes('j.status === "held" && j.holdReason'), "held 未展示 hold_reason");
  // done 产物复用现有媒体渲染分支
  assert.ok(src.includes('j.status === "done" && j.results?.length'), "done 未渲染产物");
  assert.ok(src.includes("renderAvMedia"), "done 未复用 renderAvMedia");
  assert.ok(src.includes("mediaTypeForJob(j.kind, u)"), "done 产物未按 kind 分流媒体类型");
});

/* ── ④ 保活与不活跃超时(2026-08-24「回复失败:服务暂时不可用」修复) ── */
test("api.ts:consumeAgentSse 任何字节(含 : ping 注释行)回调 onActivity", () => {
  const src = readSrc("lib/api.ts");
  const fn = src.slice(src.indexOf("async function consumeAgentSse"));
  assert.ok(fn.includes("onActivity?: () => void"), "consumeAgentSse 缺 onActivity 形参");
  // 必须在字节入缓冲后即回调(comment 行不进事件解析,只能在这一层感知)
  assert.ok(fn.includes("onActivity?.()"), "收到字节未回调 onActivity");
  // 两条流入口都透传
  for (const entry of ["export async function agentChatStream", "export async function agentChatResume"]) {
    const f = src.slice(src.indexOf(entry));
    assert.ok(f.includes("onActivity"), `${entry} 未声明/透传 onActivity`);
    assert.ok(f.includes("consumeAgentSse(res.body, onEvent, onActivity)"), `${entry} 未把 onActivity 传入消费器`);
  }
});

test("AssistantView:120s 不活跃超时按活动重置;失败文案精确", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("FIRST_CHUNK_TIMEOUT_MS = 120_000"), "超时上限未调到 120s");
  assert.ok(!src.includes("30000"), "残留 30s 旧超时");
  // 重置逻辑:clearTimeout 后重新 setTimeout(controller.abort)
  assert.ok(src.includes("resetInactivityTimer"), "缺活动重置计时器");
  const reset = src.slice(src.indexOf("const resetInactivityTimer"));
  assert.ok(reset.includes("window.clearTimeout(timeoutId)"), "重置未先清旧计时");
  assert.ok(reset.includes("window.setTimeout(() => controller.abort(), FIRST_CHUNK_TIMEOUT_MS)"), "重置未重挂 abort 计时");
  // 两个调用点都接 onActivity
  assert.equal(src.split("resetInactivityTimer,").length - 1 >= 2, true, "chat/resume 调用点未都接 resetInactivityTimer");
  // 文案:不再承诺「服务不可用」细分
  assert.ok(src.includes("回复失败:连接中断或超时,请重试"), "失败气泡文案未更新");
  assert.ok(!src.includes("回复失败:服务暂时不可用"), "旧文案残留");
});

/* ── ④b 真实错误透出 + 404 会话降级(2026-08-25「立即超时」修复) ── */
test("api.ts:agentChatStream/Resume 非 2xx 抛错携带 HTTP status", () => {
  const src = readSrc("lib/api.ts");
  for (const entry of ["export async function agentChatStream", "export async function agentChatResume"]) {
    const fn = src.slice(src.indexOf(entry), src.indexOf(entry) + 1600);
    assert.ok(fn.includes("err.status = res.status"), `${entry} 抛错未携带 status`);
  }
});

test("AssistantView:真实错误原因透出(不再一律「连接中断或超时」)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  // catch 保留 Error.message 与 status
  assert.ok(src.includes("errorDetail = e.message"), "catch 丢弃了真实错误消息");
  assert.ok(src.includes("errorStatus"), "缺 errorStatus 记录");
  // 流内 error 事件保留 content
  assert.ok(src.includes("if (ev.content) errorDetail = ev.content"), "流内 error 事件 content 被丢弃");
  // 错误气泡优先真实原因
  assert.ok(src.includes("`回复失败:${errorDetail}`"), "错误气泡未透出真实原因");
});

test("AssistantView:404 会话失效自动降级新会话重试一次(不带 session_id)", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  const i = src.indexOf("errorStatus === 404");
  assert.ok(i > 0, "缺 404 判定");
  const seg = src.slice(i - 80, i + 420);
  assert.ok(seg.includes("activeConvIdRef.current = null"), "404 未清会话 id");
  assert.ok(seg.includes("return requestReply(baseMsgs, docIds)"), "404 未自动重试");
  // 重试路径不再携带 session_id(agentChatStream 入参 session_id 为 null)
  assert.ok(
    src.includes("session_id: convStore.serverMode ? (activeConvIdRef.current ?? null) : null"),
    "session_id 来源被破坏",
  );
});

test("AssistantView:流超时非用户停止则回放会话，有助手产出不展示超时错误", () => {
  const src = readSrc("components/assistant/AssistantView.tsx");
  assert.ok(src.includes("shouldRecoverFromTimeout"), "缺超时回放判定");
  assert.ok(src.includes("sessionHasAssistantAfterLastUser"), "缺会话助手产出判定");
  assert.ok(src.includes("await getAgentSession(sid)"), "超时回放未拉会话");
  assert.ok(src.includes("userStoppedRef.current"), "用户停止路径被破坏");
});

/* ── ⑤ 纯函数 ── */
test("upsertToolChip:同 id 更新而非追加;无 assistant 气泡时补空气泡", () => {
  let msgs: ChatMessage[] = [makeMsg("u1", "user", { content: "hi" })];
  msgs = upsertToolChip(msgs, { id: "tc_1", name: "search", status: "start", summary: "检索资料" });
  assert.equal(msgs.length, 2, "应补一条 assistant 气泡");
  assert.equal(msgs[1].role, "assistant");
  assert.equal(msgs[1].tools?.length, 1);
  // 同 id 推进:ok
  msgs = upsertToolChip(msgs, { id: "tc_1", name: "search", status: "ok", summary: "检索完成" });
  assert.equal(msgs[1].tools?.length, 1, "同 id 不得追加");
  assert.equal(msgs[1].tools?.[0].status, "ok");
  assert.equal(msgs[1].tools?.[0].summary, "检索完成");
  // 新 id 追加;error 带 detail
  msgs = upsertToolChip(msgs, { id: "tc_2", name: "gen", status: "error", summary: "提交失败", detail: "显存不足" });
  assert.equal(msgs[1].tools?.length, 2);
  assert.equal(msgs[1].tools?.[1].detail, "显存不足");
});

test("upsertJobCard / upsertProposalCard:同 id 更新", () => {
  let msgs: ChatMessage[] = [makeMsg("a1", "assistant", { content: "好" })];
  msgs = upsertJobCard(msgs, { jobId: "j1", kind: "h3_t2v", status: "queued", label: "片头" });
  msgs = upsertJobCard(msgs, { jobId: "j1", kind: "h3_t2v", status: "held", label: "片头", holdReason: "VRAM 不足" });
  assert.equal(msgs[0].jobs?.length, 1, "同 jobId 不得追加");
  assert.equal(msgs[0].jobs?.[0].status, "held");
  assert.equal(msgs[0].jobs?.[0].holdReason, "VRAM 不足");
  msgs = upsertProposalCard(msgs, { proposalId: "p1", title: "三步出片", body: "1. a\n2. b", estimate: "约 5 分钟" });
  assert.equal(msgs[0].proposals?.length, 1);
  assert.equal(msgs[0].proposals?.[0].resolution, undefined, "新提案应处于待确认态");
});

test("markProposalResolved:落锤写入选择,卡片只读", () => {
  let msgs: ChatMessage[] = [makeMsg("a1", "assistant")];
  msgs = upsertProposalCard(msgs, { proposalId: "p1", title: "方案", body: "body" });
  msgs = upsertProposalCard(msgs, { proposalId: "p2", title: "方案2", body: "body2" });
  msgs = markProposalResolved(msgs, "p1", "modify", "改成夜景");
  assert.equal(msgs[0].proposals?.[0].resolution, "modify");
  assert.equal(msgs[0].proposals?.[0].note, "改成夜景");
  assert.equal(msgs[0].proposals?.[1].resolution, undefined, "其他提案不受影响");
});

/* ── ⑤.5 buildApiMessages:2026-08-27 长会话 422「回复失败:[object Object]」根因修复 ── */
test("buildApiMessages:总数超 MAX_API_MESSAGES 保留最近 N 条(尾部优先)", () => {
  const msgs: ChatMessage[] = Array.from({ length: MAX_API_MESSAGES + 15 }, (_, i) =>
    makeMsg(`m${i}`, i % 2 === 0 ? "user" : "assistant", { content: `第${i}条` }),
  );
  const out = buildApiMessages(msgs);
  assert.equal(out.length, MAX_API_MESSAGES);
  assert.equal(out[0].content, `第15条`, "应丢弃最旧 15 条");
  assert.equal(out[out.length - 1].content, `第${MAX_API_MESSAGES + 14}条`);
});

test("buildApiMessages:单条超 MAX_API_MESSAGE_CHARS 截断并带标记;error 卡与非对话角色过滤", () => {
  const longContent = "长".repeat(MAX_API_MESSAGE_CHARS + 500);
  const sysMsg = { ...makeMsg("s1", "user", { content: "系统角色" }), role: "system" } as unknown as ChatMessage;
  const msgs: ChatMessage[] = [
    makeMsg("u1", "user", { content: "正常" }),
    makeMsg("e1", "assistant", { content: "报错卡", kind: "error" }),
    sysMsg,
    makeMsg("u2", "user", { content: longContent }),
  ];
  const out = buildApiMessages(msgs);
  assert.equal(out.length, 2, "error 卡与 system 角色应被过滤");
  assert.equal(out[0].content, "正常");
  assert.ok(out[1].content.length <= MAX_API_MESSAGE_CHARS + 6, "截断后长度应在上限+标记内");
  assert.ok(out[1].content.endsWith("…(已截断)"), out[1].content.slice(-12));
});

test("buildApiMessages:正常会话原样通过(role/content 对)", () => {
  const msgs: ChatMessage[] = [
    makeMsg("u1", "user", { content: "你好" }),
    makeMsg("a1", "assistant", { content: "你好,有什么可以帮你" }),
  ];
  assert.deepEqual(buildApiMessages(msgs), [
    { role: "user", content: "你好" },
    { role: "assistant", content: "你好,有什么可以帮你" },
  ]);
});

test("buildApiMessages:有 sessionId 时只上送最新 user", () => {
  const msgs: ChatMessage[] = [
    makeMsg("u1", "user", { content: "上文" }),
    makeMsg("a1", "assistant", { content: "回复" }),
    makeMsg("u2", "user", { content: "下一句" }),
  ];
  assert.deepEqual(buildApiMessages(msgs, { sessionId: "sess-1" }), [
    { role: "user", content: "下一句" },
  ]);
});

test("LibraryView 灯箱:createPortal 到 document.body(逃脱 view-stage 层叠上下文,防账户按钮反压)", () => {
  const src = readSrc("components/library/LibraryView.tsx");
  assert.ok(src.includes('from "react-dom"'), "缺 react-dom import");
  assert.ok(src.includes("createPortal("), "灯箱未走 createPortal");
  assert.ok(src.includes("document.body"), "portal 目标不是 document.body");
});

test("jobCardStatusLabel / isJobCardActive / mediaTypeForJob", () => {
  assert.equal(jobCardStatusLabel("queued"), "排队中");
  assert.equal(jobCardStatusLabel("held"), "资源等待");
  assert.equal(jobCardStatusLabel("running"), "运行中");
  assert.equal(jobCardStatusLabel("done"), "完成");
  assert.equal(jobCardStatusLabel("error"), "失败");
  assert.ok(isJobCardActive("queued") && isJobCardActive("held") && isJobCardActive("running"));
  assert.ok(!isJobCardActive("done") && !isJobCardActive("error"));
  // kind 映射优先,未知 kind 按扩展名兜底
  assert.equal(mediaTypeForJob("txt2img", "x.png"), "image");
  assert.equal(mediaTypeForJob("h3_t2v", "x"), "video");
  assert.equal(mediaTypeForJob("manju_voice", "x"), "audio");
  assert.equal(mediaTypeForJob("hunyuan3d", "x.glb"), "model3d");
  assert.equal(mediaTypeForJob("unknown_kind", "/api/images?f=a.mp4"), "video");
  assert.equal(mediaTypeForJob("unknown_kind", "a.wav"), "audio");
  assert.equal(mediaTypeForJob("unknown_kind", "a.glb"), "model3d");
  assert.equal(mediaTypeForJob("unknown_kind", "a.png"), "image");
});

test("applyJobSnapshots:进行中卡片按 id 过滤推进,done 灌产物,无变化原样返回", () => {
  let msgs: ChatMessage[] = [makeMsg("a1", "assistant")];
  msgs = upsertJobCard(msgs, { jobId: "j1", kind: "txt2img", status: "queued", label: "海报" });
  // 列表按 job id 匹配:queued → running
  const running = applyJobSnapshots(msgs, [makeJob("j1", { status: "running" })]);
  assert.equal(running[0].jobs?.[0].status, "running");
  // prompt_id 亦可匹配;done 灌产物(mock imageUrl 透传)
  const done = applyJobSnapshots(running, [
    makeJob("other", { prompt_id: "j1", status: "done", results: ["/api/images?f=a.png&sig=1"] }),
  ]);
  assert.equal(done[0].jobs?.[0].status, "done");
  assert.deepEqual(done[0].jobs?.[0].results, ["/api/images?f=a.png&sig=1"]);
  // 终态卡片不再被轮询改写
  const frozen = applyJobSnapshots(done, [makeJob("j1", { status: "error" })]);
  assert.equal(frozen[0].jobs?.[0].status, "done");
  // 无变化时引用不变(轮询空转不触发重渲染)
  const same = applyJobSnapshots(done, [makeJob("j1", { status: "done" })]);
  assert.equal(same, done);
});

test("shouldRecoverFromTimeout:无会话或 HTTP 4xx/5xx 不回放;AbortError/超时可回放", () => {
  assert.equal(shouldRecoverFromTimeout({ message: "请求超时", status: 0 }, null), false);
  assert.equal(shouldRecoverFromTimeout({ message: "对话失败 (502)", status: 502 }, "s1"), false);
  assert.equal(shouldRecoverFromTimeout({ message: "The user aborted a request", name: "AbortError" }, "s1"), true);
  assert.equal(shouldRecoverFromTimeout({ message: "请求超时，请检查网络后重试", status: 0 }, "s1"), true);
});

test("sessionHasAssistantAfterLastUser:最后一条 user 之后要有助手文本或媒体", () => {
  assert.equal(sessionHasAssistantAfterLastUser([{ role: "user", content: "hi" }]), false);
  assert.equal(sessionHasAssistantAfterLastUser([
    { role: "user", content: "hi" },
    { role: "assistant", content: "  " },
  ]), false);
  assert.equal(sessionHasAssistantAfterLastUser([
    { role: "user", content: "hi" },
    { role: "assistant", content: "好的" },
  ]), true);
  assert.equal(sessionHasAssistantAfterLastUser([
    { role: "user", content: "hi" },
    { role: "tool", content: "{}", media: [{ urls: ["/a.png"] }] },
  ]), true);
});
