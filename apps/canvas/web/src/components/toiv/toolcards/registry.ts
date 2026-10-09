/**
 * ToIV 智能体工具卡注册表(M2 移植自 apps/web assistant/toolcards,2026-10-09):
 * 外层换 BeefTV token/壳；逻辑与六族+作业卡对齐。未注册/坏 payload → null。
 */
import { createElement, type ReactNode } from "react";

import {
    AppListCard,
    GenerationJobCard,
    KnowledgeCard,
    ModelsCard,
    OptimizePromptCard,
    ProposalCard,
    SelfhealCard,
    StoryboardCard,
    type ToolCardCtx,
} from "./cards";

export type { ToolCardCtx };

export interface ToolRenderer {
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

export const JOB_TOOL_NAMES = new Set(["submit_generation", "run_app", "generate_image"]);

export function renderToolCard(name: string, payload: Record<string, unknown>, ctx: ToolCardCtx): ReactNode {
    const entry = TOOL_RENDERERS[name];
    if (!entry || !payload || typeof payload !== "object") return null;
    try {
        return entry.render(payload, ctx) ?? null;
    } catch {
        return null;
    }
}

export function renderProposalCard(payload: Record<string, unknown>, ctx: ToolCardCtx): ReactNode {
    try {
        return createElement(ProposalCard, { payload, ctx });
    } catch {
        return null;
    }
}

export function toolTitle(name: string): string {
    return TOOL_RENDERERS[name]?.title || name;
}
