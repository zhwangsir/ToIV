import { App, Button, Progress, Select, Tag } from "antd";
import { RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
    LOCAL_CHAT_ALIAS,
    LOCAL_CHAT_CHANNEL_NAME,
    LOCAL_H3_CHANNEL_NAME,
    LOCAL_H3_WORKER_LABEL,
    LOCAL_IMAGE_WORKER_PLACEHOLDER,
    LOCAL_NAS_ROOT_DEFAULT,
    filterH3PickerEntries,
    localComputeDefaults,
} from "@/lib/local-model-defaults";
import { getNasModels, pollNasModelBind, startNasModelBind, type NasModelEntry } from "@/services/api/nas-models";
import { useConfigStore } from "@/stores/use-config-store";

export function LocalComputePane() {
    const { message } = App.useApp();
    const config = useConfigStore((s) => s.config);
    const replaceConfig = useConfigStore((s) => s.replaceConfig);
    const defaults = localComputeDefaults();
    const [entries, setEntries] = useState<NasModelEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [selected, setSelected] = useState<string>();
    const [boundPath, setBoundPath] = useState<string>();
    const [progress, setProgress] = useState<{ stage: string; percent: number; hint?: string } | null>(null);
    const [source, setSource] = useState<string>();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getNasModels("h3");
            const h3 = filterH3PickerEntries(data.inventory?.h3 || []);
            setEntries(h3);
            setSource(data.inventory?.source);
            const current = data.bindings?.h3?.rel_path;
            if (current) {
                setBoundPath(current);
                setSelected(current);
            }
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "无法加载 NAS H3 清单（可稍后重试）");
            setEntries([]);
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => { void load(); }, [load]);

    const options = useMemo(
        () => entries.map((e) => ({
            value: e.rel_path,
            label: `${e.basename}${e.用途 ? ` · ${e.用途}` : ""}`,
        })),
        [entries],
    );

    const applyLocalChannelLabels = () => {
        const channels = config.channels.map((channel) => {
            const isH3 = (channel.modelProfiles || []).some((p) => p.protocol === "toiv-h3" || p.model === "h3" || p.model === "h3-t2v");
            if (isH3) {
                return {
                    ...channel,
                    name: LOCAL_H3_CHANNEL_NAME,
                    publicAlias: `${LOCAL_H3_CHANNEL_NAME} · worker ${LOCAL_H3_WORKER_LABEL}`,
                };
            }
            if (channel.id === "toiv-llm") {
                const models = Array.from(new Set([LOCAL_CHAT_ALIAS, ...(channel.models || [])]));
                return {
                    ...channel,
                    name: LOCAL_CHAT_CHANNEL_NAME,
                    publicAlias: `Spark · ${LOCAL_CHAT_ALIAS}`,
                    models,
                };
            }
            return channel;
        });
        replaceConfig({
            ...config,
            channels,
            assistantModel: config.assistantModel || `toiv-llm::${LOCAL_CHAT_ALIAS}`,
            textModel: config.textModel || `toiv-llm::${LOCAL_CHAT_ALIAS}`,
            textModels: config.textModels?.length ? config.textModels : [`toiv-llm::${LOCAL_CHAT_ALIAS}`],
        });
    };

    useEffect(() => {
        applyLocalChannelLabels();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot label sync on mount
    }, []);

    const onBind = async () => {
        if (!selected) {
            message.warning("请先选择 H3 权重");
            return;
        }
        setProgress({ stage: "validate", percent: 10 });
        try {
            const job = await startNasModelBind(selected, "h3");
            setProgress({ stage: job.stage, percent: job.progress, hint: job.hint });
            const done = await pollNasModelBind(job.id);
            setProgress({ stage: done.stage, percent: done.progress, hint: done.hint });
            if (done.status === "error") {
                message.error(done.error || "绑定失败");
                return;
            }
            setBoundPath(done.binding?.rel_path || selected);
            applyLocalChannelLabels();
            message.success("已绑定本地 H3 权重");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "绑定失败");
            setProgress(null);
        }
    };

    return (
        <section className="settings-section mb-4" data-testid="local-compute-pane">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold">模型与算力（本地优先）</h2>
                    <p className="mt-1 text-xs text-foreground/55">
                        视频走 Workstation Comfy H3；对话走 Spark。NAS 根默认 <code>{LOCAL_NAS_ROOT_DEFAULT}</code>。
                    </p>
                </div>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                    刷新清单
                </Button>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <Server className="size-4" />
                        {LOCAL_H3_CHANNEL_NAME}
                        <Tag color="blue">worker {LOCAL_H3_WORKER_LABEL}</Tag>
                    </div>
                    <p className="mb-2 text-xs text-foreground/55">仅列出 NAS <code>h3/</code> 权重；换模后 refresh object_info，仍不见再重启该 worker。</p>
                    <Select
                        className="w-full"
                        showSearch
                        allowClear
                        loading={loading}
                        placeholder={entries.length ? "从 NAS h3/ 选择权重" : "暂无 h3/ 条目"}
                        options={options}
                        value={selected}
                        optionFilterProp="label"
                        onChange={(v) => setSelected(v)}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button type="primary" disabled={!selected || Boolean(progress && progress.percent < 100 && progress.stage !== "done")} onClick={() => void onBind()}>
                            替换并绑定
                        </Button>
                        {boundPath ? <span className="truncate text-xs text-foreground/55">当前：{boundPath}</span> : null}
                    </div>
                    {progress ? (
                        <div className="mt-3" data-testid="nas-bind-progress">
                            <Progress percent={progress.percent} size="small" status={progress.stage === "done" ? "success" : "active"} />
                            <div className="mt-1 text-xs text-foreground/55">阶段：{progress.stage}{progress.hint ? ` · ${progress.hint}` : ""}</div>
                        </div>
                    ) : null}
                    {source ? <div className="mt-2 truncate text-[11px] text-foreground/40">清单源：{source}</div> : null}
                </div>

                <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <Server className="size-4" />
                        {LOCAL_CHAT_CHANNEL_NAME}
                        <Tag color="green">Spark</Tag>
                    </div>
                    <p className="mb-2 text-xs text-foreground/55">对话别名固定走现有 <code>/api/llm/v1</code>，不浏览 NAS <code>LLM/</code>。</p>
                    <div className="text-sm">主别名：<code>{LOCAL_CHAT_ALIAS}</code></div>
                    <div className="mt-2 text-xs text-foreground/55">同进程别名：qwen3.8-27b / qwen3.6-uncensored / glm-5.3-flash</div>
                    <div className="mt-3 rounded border border-dashed border-border/50 p-2 text-xs text-foreground/50">
                        出图 NAS 绑定（worker {LOCAL_IMAGE_WORKER_PLACEHOLDER}）→ slice 2 占位；chat 默认：{defaults.chatModelRef}
                    </div>
                </div>
            </div>
        </section>
    );
}
