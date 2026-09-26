/**
 * A1 工具结果卡片注册表(2026-09-22):tool ok 事件的结构化 payload → 卡片渲染器。
 * 向后兼容:未注册工具 / 无 payload / 渲染异常一律返回 null,
 * 渲染点(AssistantView 工具条)回退为仅 chip,绝不炸消息流。
 * 卡组件全部纯渲染零 hooks(cards.tsx 头部纪律),故此处 createElement 即安全。
 */
import { createElement, type ReactNode } from "react";
import {
  AppListCard,
  GenerationJobCard,
  KnowledgeCard,
  ModelsCard,
  OptimizePromptCard,
  SelfhealCard,
  StoryboardCard,
  type ToolCardCtx,
} from "./cards";

export type { ToolCardCtx };

export interface ToolRenderer {
  /** 卡片中文名(测试/后续 chip 摘要兜底用) */
  title: string;
  render: (payload: Record<string, unknown>, ctx: ToolCardCtx) => ReactNode;
}

export const TOOL_RENDERERS: Record<string, ToolRenderer> = {
  optimize_prompt: {
    title: "提示词优化",
    render: (payload, ctx) => createElement(OptimizePromptCard, { payload, ctx }),
  },
  search_knowledge: {
    title: "知识库检索",
    render: (payload, ctx) => createElement(KnowledgeCard, { payload, ctx }),
  },
  list_apps: {
    title: "应用列表",
    render: (payload, ctx) => createElement(AppListCard, { payload, ctx }),
  },
  list_models: {
    title: "可用模型",
    render: (payload, ctx) => createElement(ModelsCard, { payload, ctx }),
  },
  create_storyboard: {
    title: "分镜画板",
    render: (payload, ctx) => createElement(StoryboardCard, { payload, ctx }),
  },
  list_smoke_failures: {
    title: "自检失败清单",
    render: (payload, ctx) => createElement(SelfhealCard, { payload, ctx }),
  },
  explain_app_failure: {
    title: "失败诊断",
    render: (payload, ctx) => createElement(SelfhealCard, { payload, ctx }),
  },
  submit_generation: {
    title: "生成作业",
    render: (payload, ctx) => createElement(GenerationJobCard, { payload, ctx }),
  },
  run_app: {
    title: "应用作业",
    render: (payload, ctx) => createElement(GenerationJobCard, { payload, ctx }),
  },
  generate_image: {
    title: "文生图",
    render: (payload, ctx) => createElement(GenerationJobCard, { payload, ctx }),
  },
};

/** 作业类工具:与消息级 AvJobCards 同 job_id 时由 MessageList 去重,避免双卡。 */
export const JOB_TOOL_NAMES = new Set([
  "submit_generation",
  "run_app",
  "generate_image",
]);

/** 渲染入口:未注册 / payload 非对象 / 渲染抛错 → null(调用点维持仅 chip)。 */
export function renderToolCard(
  name: string,
  payload: Record<string, unknown>,
  ctx: ToolCardCtx,
): ReactNode {
  const entry = TOOL_RENDERERS[name];
  if (!entry || !payload || typeof payload !== "object") return null;
  try {
    return entry.render(payload, ctx) ?? null;
  } catch {
    return null;
  }
}
