/**
 * Character reference modal — LumenX@f2a02e2 three-view / R2V lock UX (MIT adapted).
 * See lib/absorb/lumenx/NOTICE.
 */
import { AudioLines, BadgeCheck, Image as ImageIcon, Lock, UserRound, Volume2 } from "lucide-react";
import { AppModal } from "@/components/ui/product/app-modal";
import type { ReactNode } from "react";

import { buildThreeViewLockState, characterViewUrlsFromNode } from "@/lib/absorb/lumenx";
import type { CanvasNodeData } from "@/types/canvas";

export function CanvasCharacterReferenceModal({ node, open, onClose }: { node: CanvasNodeData | null; open: boolean; onClose: () => void }) {
    if (!node) return null;
    const metadata = node.metadata;
    const definition = metadata?.characterDefinition || {};
    const name = metadata?.characterName || node.title || "未命名角色";
    const aliases = metadata?.characterAliases || stringList(definition.aliases);
    const visualReady = metadata?.characterVisualStatus === "ready";
    const voiceReady = metadata?.characterVoiceStatus === "ready";
    const voiceProfile = metadata?.characterVoiceProfile;
    const r2vLocked = Boolean((definition as Record<string, unknown>).r2vLocked ?? (metadata as Record<string, unknown> | undefined)?.characterR2vLocked);
    const urls = characterViewUrlsFromNode(node);
    const lockState = buildThreeViewLockState(urls, r2vLocked);

    return (
        <AppModal
            open={open}
            title={null}
            footer={null}
            destroyOnHidden
            width="min(1180px, calc(100vw - 32px))"
            onCancel={onClose}
            flush
        >
            <div className="grid h-[min(720px,calc(100dvh-48px))] min-h-0 grid-rows-[minmax(220px,38vh)_minmax(0,1fr)] overflow-hidden bg-background text-foreground md:grid-rows-[minmax(240px,42vh)_minmax(0,1fr)]">
                <section className="min-h-0 border-b border-border" aria-label="角色三视图工作台">
                    <div className="flex h-11 items-center justify-between gap-2 border-b border-border/70 px-4 pr-14">
                        <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-border/80 bg-background/80 px-2.5 text-[var(--fs-label)] font-medium">
                            <ImageIcon className="size-3.5" />
                            人物三视图 / R2V
                        </span>
                        <div className="flex items-center gap-1.5">
                            {lockState.r2vLocked ? (
                                <span className="inline-flex h-7 items-center gap-1 rounded-md border border-amber-500/25 bg-amber-500/10 px-2 text-[var(--fs-tiny)] font-medium text-amber-700 dark:text-amber-300">
                                    <Lock className="size-3" /> R2V 已锁定
                                </span>
                            ) : null}
                            <StatusDot icon={<ImageIcon />} ready={visualReady} readyLabel="形象已绑定" emptyLabel="形象待完善" />
                        </div>
                    </div>
                    <div className="grid h-[calc(100%-2.75rem)] min-h-0 grid-cols-3 divide-x divide-border/70">
                        {lockState.slots.map((slot) => (
                            <div key={slot.id} className="relative flex min-h-0 flex-col bg-foreground/[.02]" data-slot={slot.id} data-locked={slot.locked || undefined}>
                                <div className="flex items-center justify-between px-3 pt-2">
                                    <span className="text-[var(--fs-tiny)] font-semibold text-foreground/70">{slot.label}</span>
                                    {slot.locked ? <Lock className="size-3.5 text-foreground/35" aria-label="已锁定" /> : null}
                                </div>
                                <div className="relative min-h-0 flex-1 p-2">
                                    {slot.url ? (
                                        <img src={slot.url} alt={`${name}${slot.label}`} className="h-full w-full select-none object-contain" draggable={false} />
                                    ) : (
                                        <div className="grid h-full place-items-center text-foreground/28">
                                            <div className="text-center">
                                                <UserRound className="mx-auto size-8 stroke-[1.25]" />
                                                <p className="mt-1 text-[10px]">{slot.locked ? "需先绑定主形象" : "尚未绑定"}</p>
                                            </div>
                                        </div>
                                    )}
                                    {slot.locked ? (
                                        <div className="absolute inset-0 grid place-items-center bg-background/55 backdrop-blur-[1px]">
                                            <div className="rounded-md border border-border bg-background/90 px-2 py-1 text-[10px] text-foreground/55">
                                                <Lock className="mr-1 inline size-3" />
                                                派生视图已锁定
                                            </div>
                                        </div>
                                    ) : null}
                                </div>
                                <p className="truncate px-3 pb-2 text-[10px] text-foreground/40">{slot.description}</p>
                            </div>
                        ))}
                    </div>
                </section>

                <aside className="thin-scrollbar min-h-0 overflow-y-auto md:grid md:grid-cols-[minmax(0,1.1fr)_minmax(280px,.9fr)]">
                    <header className="border-b border-border px-6 pb-5 pt-5 pr-14 md:border-b-0 md:border-r">
                        <div className="flex items-start gap-3">
                            <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-md bg-foreground/[.07]">
                                <UserRound className="size-4.5" />
                            </span>
                            <div className="min-w-0">
                                <h2 className="truncate text-xl font-semibold leading-7">{name}</h2>
                                <p className="mt-1 text-[var(--fs-label)] text-foreground/45">项目角色引用 · 三视图锁定（LumenX MIT）</p>
                            </div>
                        </div>
                        <div className="mt-4 flex flex-wrap gap-1.5">
                            <StatusDot icon={<ImageIcon />} ready={visualReady} readyLabel="图片已绑定" emptyLabel="图片未绑定" />
                            <StatusDot icon={<Volume2 />} ready={voiceReady} readyLabel="声音已绑定" emptyLabel="声音未绑定" />
                        </div>
                    </header>

                    <div className="space-y-7 px-6 py-6">
                        <DetailSection icon={<BadgeCheck />} title="身份与外观">
                            <DetailRow label="剧情身份" value={stringValue(definition.role)} />
                            <DetailRow label="别名" value={aliases.join("、")} />
                            <DetailRow label="外貌特征" value={stringValue(definition.appearance)} />
                            <DetailRow label="体型姿态" value={stringValue(definition.physique)} />
                            <DetailRow label="服装造型" value={stringValue(definition.clothing)} />
                            <DetailRow label="性格气质" value={stringValue(definition.personality)} />
                            <DetailRow label="标志道具" value={stringValue(definition.props)} />
                            <DetailRow label="一致性要求" value={stringValue(definition.consistencyPrompt)} />
                        </DetailSection>

                        <DetailSection icon={<AudioLines />} title="音色">
                            <DetailRow label="语言口音" value={stringValue(definition.voiceLanguage) || voiceProfile?.language} />
                            <DetailRow label="声音年龄感" value={stringValue(definition.voiceAge)} />
                            <DetailRow label="音色气质" value={stringValue(definition.voiceTimbre) || voiceProfile?.timbre} />
                            <DetailRow label="绑定声音" value={metadata?.characterVoiceName} emphasis={voiceReady} />
                            <DetailRow label="朗读要求" value={metadata?.characterVoiceInstructions} />
                        </DetailSection>
                    </div>
                </aside>
            </div>
        </AppModal>
    );
}

function DetailSection({ icon, title, children }: { icon: ReactNode; title: string; children: ReactNode }) {
    return (
        <section>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold">
                <span className="grid size-6 place-items-center rounded bg-foreground/[.06] [&_svg]:size-3.5">{icon}</span>
                {title}
            </div>
            <dl className="divide-y divide-border/65 border-y border-border/65">{children}</dl>
        </section>
    );
}

function DetailRow({ label, value, emphasis = false }: { label: string; value?: string; emphasis?: boolean }) {
    return (
        <div className="grid grid-cols-[76px_minmax(0,1fr)] gap-3 py-3 text-[var(--fs-caption)] leading-5">
            <dt className="text-foreground/42">{label}</dt>
            <dd className={value ? (emphasis ? "font-medium text-emerald-600 dark:text-emerald-300" : "text-foreground/78") : "text-foreground/28"}>{value || "未设置"}</dd>
        </div>
    );
}

function StatusDot({ icon, ready, readyLabel, emptyLabel }: { icon: ReactNode; ready: boolean; readyLabel: string; emptyLabel: string }) {
    return (
        <span className={`inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[var(--fs-tiny)] font-medium ${ready ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : "border-border bg-background/65 text-foreground/42"}`}>
            <span className="[&_svg]:size-3">{icon}</span>
            {ready ? readyLabel : emptyLabel}
        </span>
    );
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value.trim() : "";
}

function stringList(value: unknown) {
    return Array.isArray(value) ? value.map(stringValue).filter(Boolean) : [];
}
