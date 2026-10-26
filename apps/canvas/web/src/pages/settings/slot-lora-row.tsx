import { App, Button, InputNumber, Modal, Spin, Tag } from "antd";
import { ExternalLink, Layers3 } from "lucide-react";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

import {
    SLOT_LORA_CAP,
    SLOT_LORA_EMPTY_HINT,
    fetchSlotLoraCandidates,
    formatLoraConflictHint,
    formatSlotLoraSummary,
    readSlotLoras,
    slotLoraInventoryFooter,
    writeSlotLoras,
    type SlotLoraCandidate,
    type SlotLoraKey,
    type SlotLoraPick,
} from "@/lib/slot-lora";
import {
    COPY_MODE_ADULT,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isNsfwAssetVisible,
    subscribeR18Mode,
} from "@/redline";

type Props = {
    slot: SlotLoraKey;
    /** 当前基座友好名，仅展示配对关系 */
    baseLabel?: string;
    /** 模型 ref / basename，供兼容图谱解析族 */
    baseHint?: string;
};

export function SlotLoraRow({ slot, baseLabel, baseHint }: Props) {
    const { message } = App.useApp();
    const adultOn = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const [picks, setPicks] = useState<SlotLoraPick[]>(() => readSlotLoras(slot));
    const [open, setOpen] = useState(false);
    const [loading, setLoading] = useState(false);
    const [candidates, setCandidates] = useState<SlotLoraCandidate[]>([]);
    const [draft, setDraft] = useState<SlotLoraPick[]>([]);
    const [filterTag, setFilterTag] = useState<string | "all">("all");

    useEffect(() => {
        setPicks(readSlotLoras(slot));
    }, [slot]);

    // 切回普通：钉选里的 NSFW LoRA 清掉，避免普通模式仍带着成人挂件
    useEffect(() => {
        if (adultOn) return;
        const current = readSlotLoras(slot);
        const cleaned = current.filter((p) => isNsfwAssetVisible(p.name));
        if (cleaned.length !== current.length) {
            writeSlotLoras(slot, cleaned);
            setPicks(cleaned);
        }
        setDraft((d) => d.filter((p) => isNsfwAssetVisible(p.name)));
        setCandidates((list) =>
            list.filter((c) => isNsfwAssetVisible({ nsfw: c.nsfw, value: c.value, label: c.label })),
        );
    }, [adultOn, slot]);

    const resolvedHint = baseHint || baseLabel || "";
    const summary = useMemo(() => formatSlotLoraSummary(picks), [picks]);
    const footer = useMemo(
        () => slotLoraInventoryFooter(slot, { baseHint: resolvedHint, shown: candidates.length || undefined }),
        [slot, resolvedHint, candidates.length],
    );

    const typeTags = useMemo(() => {
        const set = new Set<string>();
        for (const c of candidates) {
            if (c.typeTag) set.add(c.typeTag);
        }
        return Array.from(set).sort((a, b) => a.localeCompare(b, "zh"));
    }, [candidates]);

    const visible = useMemo(() => {
        const gated = candidates.filter((c) => isNsfwAssetVisible({ nsfw: c.nsfw, value: c.value, label: c.label }));
        if (filterTag === "all") return gated;
        return gated.filter((c) => c.typeTag === filterTag);
    }, [candidates, filterTag, adultOn]);

    const openManage = async () => {
        setOpen(true);
        setFilterTag("all");
        setDraft(readSlotLoras(slot));
        setLoading(true);
        try {
            const list = await fetchSlotLoraCandidates(slot, { baseHint: resolvedHint });
            setCandidates(list);
        } finally {
            setLoading(false);
        }
    };

    const toggle = (c: SlotLoraCandidate) => {
        setDraft((prev) => {
            const exists = prev.find((p) => p.name === c.value);
            if (exists) return prev.filter((p) => p.name !== c.value);
            if (prev.length >= SLOT_LORA_CAP) {
                message.warning(`最多挂 ${SLOT_LORA_CAP} 个 LoRA`);
                return prev;
            }
            const strength = typeof c.recommendedStrength === "number" ? c.recommendedStrength : 0.6;
            const triggers = c.triggers?.length ? c.triggers : undefined;
            return [...prev, { name: c.value, strength, label: c.label, triggers }];
        });
    };

    const setStrength = (name: string, strength: number | null) => {
        setDraft((prev) =>
            prev.map((p) => (p.name === name ? { ...p, strength: typeof strength === "number" ? strength : p.strength } : p)),
        );
    };

    const save = () => {
        writeSlotLoras(slot, draft);
        setPicks(draft);
        setOpen(false);
        message.success(draft.length ? `已挂 ${draft.length} 个 LoRA（本地偏好）` : "已清空本槽 LoRA");
    };

    return (
        <div className="settings-lora-chip" data-testid={`slot-lora-${slot}`}>
            <div className="min-w-0 flex-1">
                <div className="settings-lora-chip__label inline-flex items-center gap-1.5">
                    <Layers3 className="size-3" aria-hidden />
                    LoRA
                </div>
                <p className="settings-lora-chip__summary truncate" title={summary}>
                    {summary}
                </p>
                {baseLabel ? <p className="settings-lora-chip__base">基座 · {baseLabel}</p> : null}
            </div>
            <Button size="small" onClick={() => void openManage()} data-testid={`slot-lora-manage-${slot}`}>
                管理
            </Button>

            <Modal
                title="LoRA"
                open={open}
                onCancel={() => setOpen(false)}
                onOk={save}
                okText="保存到本槽"
                cancelText="取消"
                width={680}
                destroyOnHidden
            >
                <p className="settings-lora-modal-intro">
                    最多 {SLOT_LORA_CAP} 个 · 按底模族过滤 · 灰显为命名推断（可强制）
                    {baseLabel ? ` · 基座 ${baseLabel}` : ""}
                </p>
                <p className="settings-lora-modal-footer" data-testid={`slot-lora-inventory-footer-${slot}`}>
                    {footer}
                </p>

                {loading ? (
                    <div className="flex justify-center py-8">
                        <Spin />
                    </div>
                ) : candidates.length === 0 ? (
                    <div
                        className="rounded-md border border-border/60 bg-surface-secondary/40 px-3 py-3 text-xs leading-relaxed text-foreground/70"
                        role="status"
                        data-testid={`slot-lora-empty-${slot}`}
                    >
                        <p className="font-medium text-foreground/85">暂无候选</p>
                        <p className="mt-1">{SLOT_LORA_EMPTY_HINT[slot]}</p>
                        {draft.length ? (
                            <p className="mt-2 text-foreground/55">仍保留你之前钉选的 {draft.length} 项（可清空后保存）。</p>
                        ) : null}
                        {draft.length ? (
                            <Button size="small" className="mt-2" danger onClick={() => setDraft([])}>
                                清空已钉选
                            </Button>
                        ) : null}
                    </div>
                ) : (
                    <>
                        {typeTags.length > 1 ? (
                            <div className="mb-2 flex flex-wrap gap-1" data-testid={`slot-lora-type-filters-${slot}`}>
                                <Tag.CheckableTag checked={filterTag === "all"} onChange={() => setFilterTag("all")}>
                                    全部 · {candidates.length}
                                </Tag.CheckableTag>
                                {typeTags.map((tag) => (
                                    <Tag.CheckableTag key={tag} checked={filterTag === tag} onChange={() => setFilterTag(tag)}>
                                        {tag} · {candidates.filter((c) => c.typeTag === tag).length}
                                    </Tag.CheckableTag>
                                ))}
                            </div>
                        ) : null}
                        <ul className="max-h-[22rem] space-y-2 overflow-y-auto pr-1" data-testid={`slot-lora-list-${slot}`}>
                            {visible.map((c) => {
                                const selected = draft.find((p) => p.name === c.value);
                                const heuristic = Boolean(c.heuristic || c.compatConfidence === "C");
                                return (
                                    <li
                                        key={c.value}
                                        className="settings-lora-card"
                                        data-compat={c.compatConfidence || ""}
                                        data-heuristic={heuristic ? "1" : "0"}
                                    >
                                        <input
                                            type="checkbox"
                                            className="mt-1"
                                            checked={Boolean(selected)}
                                            onChange={() => toggle(c)}
                                            aria-label={c.label}
                                        />
                                        <div className="min-w-0">
                                            <div className="settings-lora-card__title" title={c.value}>
                                                <span className="truncate">{c.label}</span>
                                                {c.purposeGrade === "P-A" ? <span className="settings-lora-pill is-purpose">确定</span> : null}
                                                {c.typeTag ? <span className="settings-lora-pill is-purpose">{c.typeTag}</span> : null}
                                                {c.compatConfidence === "A" || c.compatConfidence === "B" ? (
                                                    <span className="settings-lora-pill is-ok">
                                                        {c.compatConfidence === "A" ? "兼容·产品" : "兼容·卡页"}
                                                    </span>
                                                ) : heuristic ? (
                                                    <span className="settings-lora-pill is-warn">{c.compatBadge || "命名推断"}</span>
                                                ) : null}
                                                {c.nsfw ? <span className="settings-lora-pill is-nsfw">{COPY_MODE_ADULT}</span> : null}
                                            </div>
                                            {c.purposeZh ? <p className="settings-lora-card__purpose">{c.purposeZh}</p> : null}
                                            {formatLoraConflictHint(c.conflicts) ? (
                                                <p className="settings-lora-card__purpose" data-testid="lora-conflict-hint" title={(c.conflicts || []).join(", ")}>
                                                    {formatLoraConflictHint(c.conflicts)}
                                                </p>
                                            ) : null}
                                            <div className="settings-lora-card__meta">
                                                {typeof c.recommendedStrength === "number" ? (
                                                    <span
                                                        className={`settings-lora-pill${c.strengthSource === "heuristic" ? " is-warn" : ""}`}
                                                        title={
                                                            c.strengthSource === "heuristic"
                                                                ? "用途启发式推荐强度"
                                                                : c.strengthSource === "card"
                                                                  ? "卡页描述推荐强度"
                                                                  : c.strengthSource === "catalog"
                                                                    ? "策划卡推荐强度"
                                                                    : "推荐强度"
                                                        }
                                                    >
                                                        强度 {c.recommendedStrength}
                                                        {c.strengthSource === "heuristic" ? "·推断" : ""}
                                                    </span>
                                                ) : null}
                                                {c.triggers?.map((t) => (
                                                    <span key={t} className="settings-lora-pill is-trigger" title="触发词">
                                                        {t}
                                                    </span>
                                                ))}
                                            </div>
                                        </div>
                                        <div className="flex shrink-0 flex-col items-end gap-2">
                                            {c.sourceUrl ? (
                                                <a
                                                    href={c.sourceUrl}
                                                    target="_blank"
                                                    rel="noreferrer"
                                                    className="inline-flex items-center gap-0.5 text-[10px] text-foreground/45 hover:text-foreground/80"
                                                    title="来源"
                                                    onClick={(e) => e.stopPropagation()}
                                                >
                                                    <ExternalLink className="size-3" aria-hidden />
                                                </a>
                                            ) : null}
                                            {selected ? (
                                                <label className="inline-flex items-center gap-1 text-[11px] text-foreground/55">
                                                    强度
                                                    <InputNumber
                                                        size="small"
                                                        min={0}
                                                        max={2}
                                                        step={0.1}
                                                        value={selected.strength}
                                                        onChange={(v) => setStrength(c.value, v)}
                                                        className="w-16"
                                                    />
                                                </label>
                                            ) : null}
                                        </div>
                                    </li>
                                );
                            })}
                        </ul>
                    </>
                )}
            </Modal>
        </div>
    );
}
