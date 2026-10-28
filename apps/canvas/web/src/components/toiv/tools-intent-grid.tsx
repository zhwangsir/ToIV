/**
 * BF1 · 工具台意图密台网格。
 * 真源：homeIntentBarItems / HOME_INTENT_ENTRIES（首页禁止整墙铺；仅工具台/市场挂载）。
 * 分组：图像 / 视频 / 音频 / 短剧 / 扩展。W5：姿势参考；W7：扩展组挂「插件中心」→ /plugins。
 * 禁营销海报 / 彩霓虹。
 */
import { Blocks, PersonStanding } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";

import { PoseBrowser } from "@/components/pose/pose-browser";
import { AppModal } from "@/components/ui/product/app-modal";
import { homeIntentBarItems, type HomeIntentBarItem } from "@/pages/home/home-data";

import "@/components/toiv/tools-intent-grid.css";

export type IntentToolGroupId = "image" | "video" | "audio" | "drama" | "extensions";

export type IntentToolGroup = {
    id: IntentToolGroupId;
    label: string;
    intentIds: readonly string[];
};

/** 工具台分组口径（BF1）；覆盖 INTENT_ENTRIES 全量 id。 */
export const INTENT_TOOL_GROUPS: readonly IntentToolGroup[] = [
    {
        id: "image",
        label: "图像",
        intentIds: ["t2i", "outfit", "bg", "cutout", "upscale", "line", "restore", "inpaint", "portrait", "product", "edit", "style", "3d"],
    },
    {
        id: "video",
        label: "视频",
        intentIds: ["i2v", "t2v", "vfi", "vace"],
    },
    {
        id: "audio",
        label: "音频",
        intentIds: ["voice", "music"],
    },
    {
        id: "drama",
        label: "短剧",
        intentIds: ["lipsync", "avatar"],
    },
    {
        // W7 F11：插件主入口 = 市场 ToolsIntent（禁新一级导航）
        id: "extensions",
        label: "扩展",
        intentIds: [],
    },
] as const;

function itemsForGroup(group: IntentToolGroup): HomeIntentBarItem[] {
    const byId = new Map(homeIntentBarItems.map((item) => [item.id, item]));
    return group.intentIds.map((id) => byId.get(id)).filter((item): item is HomeIntentBarItem => Boolean(item));
}

export type ToolsIntentGridProps = {
    className?: string;
    /** 点击意图后可选回调（默认走 Link to 市场深链） */
    onSelectIntent?: (item: HomeIntentBarItem) => void;
};

/** BeefTV 密台风格能力网格 — 挂 /toiv/market，不挂首页。 */
export function ToolsIntentGrid({ className, onSelectIntent }: ToolsIntentGridProps) {
    const [poseOpen, setPoseOpen] = useState(false);
    return (
        <section
            className={["toiv-tools-intent-grid", className].filter(Boolean).join(" ")}
            data-testid="tools-intent-grid"
            data-surface="beeftv-tools"
            aria-label="工具意图"
        >
            <header className="toiv-tools-intent-grid__head">
                <h2 className="toiv-tools-intent-grid__title">能力入口</h2>
                <p className="toiv-tools-intent-grid__meta">图像 · 视频 · 音频 · 短剧 · 姿势参考 · 插件中心 · 深链打开市场应用</p>
            </header>
            <div className="toiv-tools-intent-grid__groups">
                {INTENT_TOOL_GROUPS.map((group) => {
                    const items = itemsForGroup(group);
                    if (items.length === 0 && group.id !== "image" && group.id !== "extensions") return null;
                    return (
                        <section
                            key={group.id}
                            id={`tools-intent-${group.id}`}
                            className="toiv-tools-intent-group"
                            data-group={group.id}
                            aria-label={group.label}
                        >
                            <h3 className="toiv-tools-intent-group__label">{group.label}</h3>
                            <ul className="toiv-tools-intent-group__list">
                                {items.map((item) => {
                                    const Icon = item.icon;
                                    const body = (
                                        <>
                                            <span className="toiv-tools-intent-card__icon" aria-hidden>
                                                <Icon />
                                            </span>
                                            <span className="toiv-tools-intent-card__copy">
                                                <strong>{item.label}</strong>
                                                <em>{item.detail}</em>
                                            </span>
                                        </>
                                    );
                                    return (
                                        <li key={item.id}>
                                            {onSelectIntent ? (
                                                <button
                                                    type="button"
                                                    className="toiv-tools-intent-card"
                                                    data-intent={item.id}
                                                    onClick={() => onSelectIntent(item)}
                                                >
                                                    {body}
                                                </button>
                                            ) : (
                                                <Link
                                                    to={item.to}
                                                    className="toiv-tools-intent-card"
                                                    data-intent={item.id}
                                                    title={item.detail}
                                                >
                                                    {body}
                                                </Link>
                                            )}
                                        </li>
                                    );
                                })}
                                {group.id === "image" ? (
                                    <li key="pose-ref">
                                        <button
                                            type="button"
                                            className="toiv-tools-intent-card"
                                            data-intent="pose-ref"
                                            data-testid="tools-intent-pose-ref"
                                            onClick={() => setPoseOpen(true)}
                                            title="姿势参考库"
                                        >
                                            <span className="toiv-tools-intent-card__icon" aria-hidden>
                                                <PersonStanding />
                                            </span>
                                            <span className="toiv-tools-intent-card__copy">
                                                <strong>姿势参考</strong>
                                                <em>体系 · 多角度浏览</em>
                                            </span>
                                        </button>
                                    </li>
                                ) : null}
                                {group.id === "extensions" ? (
                                    <li key="plugins">
                                        <Link
                                            to="/plugins"
                                            className="toiv-tools-intent-card"
                                            data-intent="plugins"
                                            data-testid="tools-intent-plugins"
                                            title="插件中心"
                                        >
                                            <span className="toiv-tools-intent-card__icon" aria-hidden>
                                                <Blocks />
                                            </span>
                                            <span className="toiv-tools-intent-card__copy">
                                                <strong>插件中心</strong>
                                                <em>模型 · 素材 · 工作流扩展</em>
                                            </span>
                                        </Link>
                                    </li>
                                ) : null}
                            </ul>
                        </section>
                    );
                })}
            </div>
            <AppModal
                open={poseOpen}
                onCancel={() => setPoseOpen(false)}
                title="姿势参考"
                footer={null}
                centered
                destroyOnHidden
                width="min(960px, calc(100vw - 32px))"
                className="toiv-pose-browser-modal"
                data-testid="tools-pose-browser-modal"
            >
                <div style={{ padding: "4px 4px 8px" }}>
                    <PoseBrowser title="姿势参考" meta="工具台浏览 · 可开大图" />
                </div>
            </AppModal>
        </section>
    );
}
