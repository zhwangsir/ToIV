/**
 * W5 · Shared dense pose surface (browse + pick).
 * Systems × category × search × group cards with multi-angle switch.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
    filterPoseGroups,
    listPoseCategories,
    listPoseSystems,
    pickDefaultAngle,
    poseImgUrl,
    poseThumbUrl,
    visiblePoseSystems,
    type PoseEntry,
    type PoseGroup,
} from "@/lib/pose-catalog";
import { COPY_POSE_SYSTEMS_HIDDEN, getR18ModeSnapshot, getServerR18ModeSnapshot, subscribeR18Mode } from "@/redline";

import "@/components/pose/pose-gallery-surface.css";

export type PoseGallerySurfaceProps = {
    mode: "browse" | "pick";
    className?: string;
    title?: string;
    meta?: string;
    onPick?: (entry: PoseEntry, group: PoseGroup) => void;
    enableLightbox?: boolean;
};

export function PoseGallerySurface({
    mode,
    className,
    title = "姿势参考",
    meta = "体系 · 分类 · 多角度",
    onPick,
    enableLightbox = mode === "browse",
}: PoseGallerySurfaceProps) {
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const systems = useMemo(() => visiblePoseSystems(adultOn), [adultOn]);
    const [system, setSystem] = useState<string>("");
    const [category, setCategory] = useState<string>("");
    const [query, setQuery] = useState("");
    const [angleByGroup, setAngleByGroup] = useState<Record<string, string>>({});
    const [selectedKey, setSelectedKey] = useState<string | null>(null);
    const [lightbox, setLightbox] = useState<PoseEntry | null>(null);
    const [brokenThumbs, setBrokenThumbs] = useState<Record<string, true>>({});

    useEffect(() => {
        if (system && !systems.includes(system)) {
            setSystem("");
            setCategory("");
        }
    }, [system, systems]);

    const categories = useMemo(() => listPoseCategories(system || null), [system]);
    useEffect(() => {
        if (category && !categories.includes(category)) setCategory("");
    }, [category, categories]);

    const groups = useMemo(
        () =>
            filterPoseGroups({
                system: system || null,
                category: category || null,
                query,
                adultOn,
            }),
        [system, category, query, adultOn],
    );

    const selectedGroup = selectedKey ? groups.find((g) => g.key === selectedKey) : undefined;
    const selectedEntry = selectedGroup
        ? pickDefaultAngle(selectedGroup, angleByGroup[selectedGroup.key] ?? null)
        : null;

    const confirmPick = () => {
        if (!selectedGroup || !selectedEntry || !onPick) return;
        onPick(selectedEntry, selectedGroup);
    };

    return (
        <div
            className={["toiv-pose-gallery", className].filter(Boolean).join(" ")}
            data-testid="pose-gallery-surface"
            data-mode={mode}
            data-surface="beeftv-pose"
        >
            <header className="toiv-pose-gallery__head">
                <h2 className="toiv-pose-gallery__title">{title}</h2>
                <p className="toiv-pose-gallery__meta">
                    {meta} · {groups.length} 组
                    {systems.length < listPoseSystems().length && COPY_POSE_SYSTEMS_HIDDEN ? ` · ${COPY_POSE_SYSTEMS_HIDDEN}` : ""}
                </p>
            </header>

            <div className="toiv-pose-gallery__systems" role="tablist" aria-label="姿势体系">
                <button
                    type="button"
                    role="tab"
                    className={["toiv-pose-gallery__system", !system ? "is-active" : ""].filter(Boolean).join(" ")}
                    aria-selected={!system}
                    onClick={() => setSystem("")}
                >
                    全部
                </button>
                {systems.map((name) => (
                    <button
                        key={name}
                        type="button"
                        role="tab"
                        className={["toiv-pose-gallery__system", system === name ? "is-active" : ""].filter(Boolean).join(" ")}
                        aria-selected={system === name}
                        onClick={() => setSystem(name)}
                    >
                        {name}
                    </button>
                ))}
            </div>

            <div className="toiv-pose-gallery__filters">
                <input
                    className="toiv-pose-gallery__search"
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="检索姿势编号 / 名称 / 分类"
                    aria-label="检索姿势"
                />
                <select
                    className="toiv-pose-gallery__category"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    aria-label="分类筛选"
                >
                    <option value="">全部分类</option>
                    {categories.map((c) => (
                        <option key={c} value={c}>
                            {c}
                        </option>
                    ))}
                </select>
            </div>

            <div className="toiv-pose-gallery__grid" role="list" aria-label="姿势组">
                {groups.length === 0 ? (
                    <div className="toiv-pose-gallery__empty">当前筛选下没有匹配姿势，请调整关键词或分类。</div>
                ) : (
                    groups.map((group) => {
                        const entry = pickDefaultAngle(group, angleByGroup[group.key] ?? null);
                        const thumb = poseThumbUrl(entry);
                        const broken = Boolean(brokenThumbs[entry.id]);
                        return (
                            <div
                                key={group.key}
                                role="listitem"
                                className={[
                                    "toiv-pose-gallery__card",
                                    selectedKey === group.key ? "is-selected" : "",
                                ]
                                    .filter(Boolean)
                                    .join(" ")}
                                data-pose-group={group.key}
                            >
                                <button
                                    type="button"
                                    className="toiv-pose-gallery__thumb-wrap"
                                    aria-label={`${group.姿势名称} ${entry.角度}`}
                                    onClick={() => {
                                        setSelectedKey(group.key);
                                        if (mode === "browse" && enableLightbox) setLightbox(entry);
                                    }}
                                    onDoubleClick={() => {
                                        if (mode === "pick" && onPick) onPick(entry, group);
                                        if (mode === "browse" && enableLightbox) setLightbox(entry);
                                    }}
                                >
                                    {!broken ? (
                                        <img
                                            className="toiv-pose-gallery__thumb"
                                            src={thumb}
                                            alt=""
                                            loading="lazy"
                                            onError={() =>
                                                setBrokenThumbs((prev) => ({ ...prev, [entry.id]: true }))
                                            }
                                        />
                                    ) : (
                                        <span className="toiv-pose-gallery__thumb-fallback">
                                            缩略图待上线
                                            <br />
                                            {entry.姿势编号}
                                        </span>
                                    )}
                                </button>
                                <div className="toiv-pose-gallery__card-copy">
                                    <strong title={group.姿势名称}>{group.姿势名称}</strong>
                                    <span>
                                        {group.姿势编号} · {group.分类}
                                    </span>
                                </div>
                                <div className="toiv-pose-gallery__angles" role="group" aria-label="角度">
                                    {group.angles.map((angle) => (
                                        <button
                                            key={angle.id}
                                            type="button"
                                            className={[
                                                "toiv-pose-gallery__angle",
                                                entry.id === angle.id ? "is-active" : "",
                                            ]
                                                .filter(Boolean)
                                                .join(" ")}
                                            onClick={() =>
                                                setAngleByGroup((prev) => ({
                                                    ...prev,
                                                    [group.key]: angle.角度,
                                                }))
                                            }
                                        >
                                            {angle.角度}
                                        </button>
                                    ))}
                                </div>
                            </div>
                        );
                    })
                )}
            </div>

            {mode === "pick" ? (
                <div className="toiv-pose-gallery__footer">
                    <button
                        type="button"
                        className="toiv-pose-gallery__cta"
                        disabled={!selectedEntry}
                        onClick={confirmPick}
                        data-testid="pose-picker-confirm"
                    >
                        选用此姿势
                    </button>
                </div>
            ) : null}

            {lightbox ? (
                <div
                    className="toiv-pose-gallery__lightbox"
                    role="dialog"
                    aria-modal="true"
                    aria-label="姿势大图"
                    onClick={() => setLightbox(null)}
                >
                    <div className="toiv-pose-gallery__lightbox-inner" onClick={(e) => e.stopPropagation()}>
                        <button
                            type="button"
                            className="toiv-pose-gallery__lightbox-close"
                            onClick={() => setLightbox(null)}
                        >
                            关闭
                        </button>
                        <img src={poseImgUrl(lightbox)} alt={lightbox.姿势名称} />
                    </div>
                </div>
            ) : null}
        </div>
    );
}
