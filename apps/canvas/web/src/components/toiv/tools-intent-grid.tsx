/**
 * BF1 · 工具台意图密台网格。
 * 真源：homeIntentBarItems / HOME_INTENT_ENTRIES（首页禁止整墙铺；仅工具台/市场挂载）。
 * 分组：图像 / 视频 / 音频 / 短剧。禁营销海报 / 彩霓虹。
 */
import { Link } from "react-router";

import { homeIntentBarItems, type HomeIntentBarItem } from "@/pages/home/home-data";

import "@/components/toiv/tools-intent-grid.css";

export type IntentToolGroupId = "image" | "video" | "audio" | "drama";

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
    return (
        <section
            className={["toiv-tools-intent-grid", className].filter(Boolean).join(" ")}
            data-testid="tools-intent-grid"
            data-surface="beeftv-tools"
            aria-label="工具意图"
        >
            <header className="toiv-tools-intent-grid__head">
                <h2 className="toiv-tools-intent-grid__title">能力入口</h2>
                <p className="toiv-tools-intent-grid__meta">图像 · 视频 · 音频 · 短剧 · 深链打开市场应用</p>
            </header>
            <div className="toiv-tools-intent-grid__groups">
                {INTENT_TOOL_GROUPS.map((group) => {
                    const items = itemsForGroup(group);
                    if (items.length === 0) return null;
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
                            </ul>
                        </section>
                    );
                })}
            </div>
        </section>
    );
}
