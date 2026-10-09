import { App, Button, Progress, Select, Tag } from "antd";
import { RefreshCw, Server } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import {
    LOCAL_CHAT_ALIAS,
    LOCAL_CHAT_CHANNEL_NAME,
    LOCAL_H3_CHANNEL_NAME,
    LOCAL_H3_WORKER_LABEL,
    LOCAL_IMAGE_CHANNEL_ID,
    LOCAL_IMAGE_CHANNEL_NAME,
    LOCAL_IMAGE_LB_LABEL,
    LOCAL_IMAGE_MODEL,
    LOCAL_IMAGE_MODEL_REF,
    LOCAL_IMAGE_WORKER_LABEL,
    LOCAL_NAS_ROOT_DEFAULT,
    LOCAL_VIDEO_CHANNEL_ID,
    LOCAL_VIDEO_CHANNEL_NAME,
    LOCAL_VIDEO_MODEL,
    LOCAL_VIDEO_MODEL_REF,
    LOCAL_VIDEO_WORKER_LABEL,
    filterH3PickerEntries,
    filterImagePickerEntries,
    filterVideoPickerEntries,
    localComputeDefaults,
} from "@/lib/local-model-defaults";
import {
    getNasModels,
    pollNasModelBind,
    startNasModelBind,
    type NasBindGroup,
    type NasModelEntry,
} from "@/services/api/nas-models";
import { useConfigStore } from "@/stores/use-config-store";

type BindProgress = { stage: string; percent: number; hint?: string } | null;

export function LocalComputePane() {
    const { message } = App.useApp();
    const config = useConfigStore((s) => s.config);
    const replaceConfig = useConfigStore((s) => s.replaceConfig);
    const defaults = localComputeDefaults();
    const [h3Entries, setH3Entries] = useState<NasModelEntry[]>([]);
    const [imageEntries, setImageEntries] = useState<NasModelEntry[]>([]);
    const [videoEntries, setVideoEntries] = useState<NasModelEntry[]>([]);
    const [loading, setLoading] = useState(false);
    const [h3Selected, setH3Selected] = useState<string>();
    const [imageSelected, setImageSelected] = useState<string>();
    const [videoSelected, setVideoSelected] = useState<string>();
    const [h3Bound, setH3Bound] = useState<string>();
    const [imageBound, setImageBound] = useState<string>();
    const [videoBound, setVideoBound] = useState<string>();
    const [h3Progress, setH3Progress] = useState<BindProgress>(null);
    const [imageProgress, setImageProgress] = useState<BindProgress>(null);
    const [videoProgress, setVideoProgress] = useState<BindProgress>(null);
    const [source, setSource] = useState<string>();

    const load = useCallback(async () => {
        setLoading(true);
        try {
            const data = await getNasModels("all");
            const h3 = filterH3PickerEntries(data.inventory?.h3 || []);
            const images = filterImagePickerEntries(data.inventory?.main || []);
            const videos = filterVideoPickerEntries(data.inventory?.main || []);
            setH3Entries(h3);
            setImageEntries(images);
            setVideoEntries(videos);
            setSource(data.inventory?.source);
            if (data.bindings?.h3?.rel_path) {
                setH3Bound(data.bindings.h3.rel_path);
                setH3Selected(data.bindings.h3.rel_path);
            }
            if (data.bindings?.image?.rel_path) {
                setImageBound(data.bindings.image.rel_path);
                setImageSelected(data.bindings.image.rel_path);
            }
            if (data.bindings?.video?.rel_path) {
                setVideoBound(data.bindings.video.rel_path);
                setVideoSelected(data.bindings.video.rel_path);
            }
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "无法加载 NAS 选模清单（可稍后重试）");
            setH3Entries([]);
            setImageEntries([]);
            setVideoEntries([]);
        } finally {
            setLoading(false);
        }
    }, [message]);

    useEffect(() => { void load(); }, [load]);

    const h3Options = useMemo(
        () => h3Entries.map((e) => ({
            value: e.rel_path,
            label: `${e.basename}${e.用途 ? ` · ${e.用途}` : ""}`,
        })),
        [h3Entries],
    );
    const groupByPurpose = (entries: NasModelEntry[]) => {
        const groups = new Map<string, { value: string; label: string }[]>();
        for (const e of entries) {
            const purpose = String(e.用途 || "其他").trim() || "其他";
            const list = groups.get(purpose) || [];
            list.push({ value: e.rel_path, label: e.basename });
            groups.set(purpose, list);
        }
        return Array.from(groups.entries()).map(([label, options]) => ({ label, options }));
    };
    const imageOptions = useMemo(() => groupByPurpose(imageEntries), [imageEntries]);
    const videoOptions = useMemo(() => groupByPurpose(videoEntries), [videoEntries]);

    const applyLocalChannelLabels = () => {
        let channels = config.channels.map((channel) => {
            const isH3 = (channel.modelProfiles || []).some((p) => p.protocol === "toiv-h3" || p.model === "h3" || p.model === "h3-t2v");
            if (isH3) {
                return {
                    ...channel,
                    name: LOCAL_H3_CHANNEL_NAME,
                    publicAlias: `${LOCAL_H3_CHANNEL_NAME} · worker ${LOCAL_H3_WORKER_LABEL}`,
                };
            }
            if (channel.id === LOCAL_IMAGE_CHANNEL_ID || channel.name === LOCAL_IMAGE_CHANNEL_NAME) {
                return {
                    ...channel,
                    id: LOCAL_IMAGE_CHANNEL_ID,
                    name: LOCAL_IMAGE_CHANNEL_NAME,
                    publicAlias: `${LOCAL_IMAGE_CHANNEL_NAME} · worker ${LOCAL_IMAGE_WORKER_LABEL}（LB ${LOCAL_IMAGE_LB_LABEL}）`,
                    modelProfiles: (channel.modelProfiles || []).map((p) =>
                        p.capability === "image" || p.model === LOCAL_IMAGE_MODEL || p.protocol === "openai-images"
                            ? { ...p, protocol: "toiv-comfy-image", displayName: LOCAL_IMAGE_CHANNEL_NAME }
                            : p,
                    ),
                };
            }

            if (channel.id === LOCAL_VIDEO_CHANNEL_ID || channel.name === LOCAL_VIDEO_CHANNEL_NAME) {
                return {
                    ...channel,
                    id: LOCAL_VIDEO_CHANNEL_ID,
                    name: LOCAL_VIDEO_CHANNEL_NAME,
                    publicAlias: `${LOCAL_VIDEO_CHANNEL_NAME} · worker ${LOCAL_VIDEO_WORKER_LABEL}`,
                    modelProfiles: (channel.modelProfiles || []).map((p) =>
                        p.capability === "video" || p.model === LOCAL_VIDEO_MODEL
                            ? { ...p, protocol: "toiv-comfy-video", displayName: LOCAL_VIDEO_CHANNEL_NAME }
                            : p,
                    ),
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

        if (!channels.some((c) => c.id === LOCAL_IMAGE_CHANNEL_ID || c.name === LOCAL_IMAGE_CHANNEL_NAME)) {
            channels = [
                ...channels,
                {
                    id: LOCAL_IMAGE_CHANNEL_ID,
                    name: LOCAL_IMAGE_CHANNEL_NAME,
                    publicAlias: `${LOCAL_IMAGE_CHANNEL_NAME} · worker ${LOCAL_IMAGE_WORKER_LABEL}（LB ${LOCAL_IMAGE_LB_LABEL}）`,
                    enabled: true,
                    apiFormat: "openai",
                    apiKey: "",
                    baseUrl: "http://127.0.0.1:8090",
                    headers: [],
                    models: [LOCAL_IMAGE_MODEL],
                    modelProfiles: [
                        {
                            capability: "image",
                            model: LOCAL_IMAGE_MODEL,
                            protocol: "toiv-comfy-image",
                            displayName: LOCAL_IMAGE_CHANNEL_NAME,
                            defaultOptions: {
                                toivWorkerLabel: LOCAL_IMAGE_WORKER_LABEL,
                                toivNasRoot: LOCAL_NAS_ROOT_DEFAULT,
                            },
                        } as any,
                    ],
                    pinned: false,
                    scope: "user",
                    sortOrder: 2,
                } as any,
            ];
        }

        if (!channels.some((c) => c.id === LOCAL_VIDEO_CHANNEL_ID || c.name === LOCAL_VIDEO_CHANNEL_NAME)) {
            channels = [
                ...channels,
                {
                    id: LOCAL_VIDEO_CHANNEL_ID,
                    name: LOCAL_VIDEO_CHANNEL_NAME,
                    publicAlias: `${LOCAL_VIDEO_CHANNEL_NAME} · worker ${LOCAL_VIDEO_WORKER_LABEL}`,
                    enabled: true,
                    apiFormat: "openai",
                    apiKey: "",
                    baseUrl: "http://127.0.0.1:8090",
                    headers: [],
                    models: [LOCAL_VIDEO_MODEL],
                    modelProfiles: [
                        {
                            capability: "video",
                            model: LOCAL_VIDEO_MODEL,
                            protocol: "toiv-comfy-video",
                            displayName: LOCAL_VIDEO_CHANNEL_NAME,
                            defaultOptions: {
                                toivWorkerLabel: LOCAL_VIDEO_WORKER_LABEL,
                                toivNasRoot: LOCAL_NAS_ROOT_DEFAULT,
                            },
                        } as any,
                    ],
                    pinned: false,
                    scope: "user",
                    sortOrder: 3,
                } as any,
            ];
        }


        replaceConfig({
            ...config,
            channels,
            assistantModel: config.assistantModel || `toiv-llm::${LOCAL_CHAT_ALIAS}`,
            textModel: config.textModel || `toiv-llm::${LOCAL_CHAT_ALIAS}`,
            textModels: config.textModels?.length ? config.textModels : [`toiv-llm::${LOCAL_CHAT_ALIAS}`],
            imageModel: config.imageModel || LOCAL_IMAGE_MODEL_REF,
            imageModels: config.imageModels?.length ? config.imageModels : [LOCAL_IMAGE_MODEL_REF],
            videoModels: Array.from(new Set([...(config.videoModels || []), LOCAL_VIDEO_MODEL_REF])),
        } as any);
    };

    useEffect(() => {
        applyLocalChannelLabels();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- one-shot label sync on mount
    }, []);

    const runBind = async (opts: {
        selected?: string;
        group: NasBindGroup;
        worker: string;
        setProgress: (p: BindProgress) => void;
        setBound: (path: string) => void;
        emptyMsg: string;
        okMsg: string;
    }) => {
        if (!opts.selected) {
            message.warning(opts.emptyMsg);
            return;
        }
        opts.setProgress({ stage: "validate", percent: 10 });
        try {
            const job = await startNasModelBind(opts.selected, opts.group, opts.worker);
            opts.setProgress({ stage: job.stage, percent: job.progress, hint: job.hint });
            const done = await pollNasModelBind(job.id);
            opts.setProgress({ stage: done.stage, percent: done.progress, hint: done.hint });
            if (done.status === "error") {
                message.error(done.error || "绑定失败");
                return;
            }
            opts.setBound(done.binding?.rel_path || opts.selected);
            const basename = done.binding?.basename;
            if (basename && (opts.group === "image" || opts.group === "video")) {
                const channelId = opts.group === "image" ? LOCAL_IMAGE_CHANNEL_ID : LOCAL_VIDEO_CHANNEL_ID;
                const protocol = opts.group === "image" ? "toiv-comfy-image" : "toiv-comfy-video";
                const channels = config.channels.map((channel) => {
                    if (channel.id !== channelId && channel.name !== (opts.group === "image" ? LOCAL_IMAGE_CHANNEL_NAME : LOCAL_VIDEO_CHANNEL_NAME)) {
                        return channel;
                    }
                    const models = Array.from(new Set([basename, ...(channel.models || [])]));
                    return {
                        ...channel,
                        id: channelId,
                        models,
                        modelProfiles: (channel.modelProfiles || []).map((prof) => ({
                            ...prof,
                            model: basename,
                            protocol,
                            defaultOptions: {
                                ...(prof.defaultOptions || {}),
                                toivWorkerLabel: opts.worker,
                                toivNasRoot: LOCAL_NAS_ROOT_DEFAULT,
                                ckpt_name: basename,
                            },
                        })),
                    };
                });
                const next: any = { ...config, channels };
                if (opts.group === "image") {
                    next.imageModel = `${LOCAL_IMAGE_CHANNEL_ID}::${basename}`;
                    next.imageModels = Array.from(new Set([...(config.imageModels || []), next.imageModel]));
                } else {
                    next.videoModels = Array.from(new Set([...(config.videoModels || []), `${LOCAL_VIDEO_CHANNEL_ID}::${basename}`]));
                }
                replaceConfig(next);
            }
            applyLocalChannelLabels();
            message.success(opts.okMsg);
        } catch (error) {
            message.error(error instanceof Error ? error.message : "绑定失败");
            opts.setProgress(null);
        }
    };

    const bindingBusy = (p: BindProgress) => Boolean(p && p.percent < 100 && p.stage !== "done");

    return (
        <section className="settings-section mb-4" data-testid="local-compute-pane">
            <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                    <h2 className="text-base font-semibold">模型与算力（本地优先）</h2>
                    <p className="mt-1 text-xs text-foreground/55">
                        生图走 Workstation Comfy {LOCAL_IMAGE_WORKER_LABEL}（LB {LOCAL_IMAGE_LB_LABEL}）；Wan/LongCat/VACE 走 {LOCAL_VIDEO_WORKER_LABEL}；H3 走 {LOCAL_H3_WORKER_LABEL}；对话走 Spark。NAS 根默认 <code>{LOCAL_NAS_ROOT_DEFAULT}</code>。
                    </p>
                </div>
                <Button size="small" icon={<RefreshCw className="size-3.5" />} loading={loading} onClick={() => void load()}>
                    刷新清单
                </Button>
            </div>

            <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-border/60 bg-background/40 p-3" data-testid="local-image-bind">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <Server className="size-4" />
                        {LOCAL_IMAGE_CHANNEL_NAME}
                        <Tag color="purple">worker {LOCAL_IMAGE_WORKER_LABEL}</Tag>
                    </div>
                    <p className="mb-2 text-xs text-foreground/55">
                        列出 NAS main 中用途含「出图」的权重；绑定到生产生图口 {LOCAL_IMAGE_WORKER_LABEL}（非试验床，禁 :8205/:8261）。落盘后 refresh object_info，仍不见再重启该 worker。
                    </p>
                    <Select
                        className="w-full"
                        showSearch
                        allowClear
                        loading={loading}
                        placeholder={imageEntries.length ? "从 NAS 选择出图权重" : "暂无出图条目"}
                        options={imageOptions}
                        value={imageSelected}
                        optionFilterProp="label"
                        onChange={(v) => setImageSelected(v)}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                            type="primary"
                            disabled={!imageSelected || bindingBusy(imageProgress)}
                            onClick={() => void runBind({
                                selected: imageSelected,
                                group: "image",
                                worker: LOCAL_IMAGE_WORKER_LABEL,
                                setProgress: setImageProgress,
                                setBound: setImageBound,
                                emptyMsg: "请先选择出图权重",
                                okMsg: "已绑定本地生图权重 → :8196",
                            })}
                        >
                            替换并绑定
                        </Button>
                        {imageBound ? <span className="truncate text-xs text-foreground/55">当前：{imageBound}</span> : null}
                    </div>
                    {imageProgress ? (
                        <div className="mt-3" data-testid="nas-image-bind-progress">
                            <Progress percent={imageProgress.percent} size="small" status={imageProgress.stage === "done" ? "success" : "active"} />
                            <div className="mt-1 text-xs text-foreground/55">阶段：{imageProgress.stage}{imageProgress.hint ? ` · ${imageProgress.hint}` : ""}</div>
                        </div>
                    ) : null}
                </div>

                <div className="rounded-lg border border-border/60 bg-background/40 p-3" data-testid="local-video-bind">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <Server className="size-4" />
                        {LOCAL_VIDEO_CHANNEL_NAME}
                        <Tag color="orange">worker {LOCAL_VIDEO_WORKER_LABEL}</Tag>
                    </div>
                    <p className="mb-2 text-xs text-foreground/55">
                        列出 NAS main 中用途含「出视频」且非 <code>h3/</code> 的权重（含 出图/出视频·diffusion、出视频·Wan Animate 等）；绑定到 LongCat/Wan/VACE 口 {LOCAL_VIDEO_WORKER_LABEL}。H3 仍走 {LOCAL_H3_WORKER_LABEL}。落盘后 refresh object_info，仍不见再重启该 worker。
                    </p>
                    <Select
                        className="w-full"
                        showSearch
                        allowClear
                        loading={loading}
                        placeholder={videoEntries.length ? "从 NAS 选择出视频权重" : "暂无出视频条目"}
                        options={videoOptions}
                        value={videoSelected}
                        optionFilterProp="label"
                        onChange={(v) => setVideoSelected(v)}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                            type="primary"
                            disabled={!videoSelected || bindingBusy(videoProgress)}
                            onClick={() => void runBind({
                                selected: videoSelected,
                                group: "video",
                                worker: LOCAL_VIDEO_WORKER_LABEL,
                                setProgress: setVideoProgress,
                                setBound: setVideoBound,
                                emptyMsg: "请先选择出视频权重",
                                okMsg: "已绑定本地 Wan/LongCat 权重 → :8197",
                            })}
                        >
                            替换并绑定
                        </Button>
                        {videoBound ? <span className="truncate text-xs text-foreground/55">当前：{videoBound}</span> : null}
                    </div>
                    {videoProgress ? (
                        <div className="mt-3" data-testid="nas-video-bind-progress">
                            <Progress percent={videoProgress.percent} size="small" status={videoProgress.stage === "done" ? "success" : "active"} />
                            <div className="mt-1 text-xs text-foreground/55">阶段：{videoProgress.stage}{videoProgress.hint ? ` · ${videoProgress.hint}` : ""}</div>
                        </div>
                    ) : null}
                </div>

                <div className="rounded-lg border border-border/60 bg-background/40 p-3" data-testid="local-h3-bind">
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
                        placeholder={h3Entries.length ? "从 NAS h3/ 选择权重" : "暂无 h3/ 条目"}
                        options={h3Options}
                        value={h3Selected}
                        optionFilterProp="label"
                        onChange={(v) => setH3Selected(v)}
                    />
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                        <Button
                            type="primary"
                            disabled={!h3Selected || bindingBusy(h3Progress)}
                            onClick={() => void runBind({
                                selected: h3Selected,
                                group: "h3",
                                worker: LOCAL_H3_WORKER_LABEL,
                                setProgress: setH3Progress,
                                setBound: setH3Bound,
                                emptyMsg: "请先选择 H3 权重",
                                okMsg: "已绑定本地 H3 权重",
                            })}
                        >
                            替换并绑定
                        </Button>
                        {h3Bound ? <span className="truncate text-xs text-foreground/55">当前：{h3Bound}</span> : null}
                    </div>
                    {h3Progress ? (
                        <div className="mt-3" data-testid="nas-bind-progress">
                            <Progress percent={h3Progress.percent} size="small" status={h3Progress.stage === "done" ? "success" : "active"} />
                            <div className="mt-1 text-xs text-foreground/55">阶段：{h3Progress.stage}{h3Progress.hint ? ` · ${h3Progress.hint}` : ""}</div>
                        </div>
                    ) : null}
                </div>

                <div className="rounded-lg border border-border/60 bg-background/40 p-3">
                    <div className="mb-2 flex items-center gap-2 text-sm font-semibold">
                        <Server className="size-4" />
                        {LOCAL_CHAT_CHANNEL_NAME}
                        <Tag color="green">Spark</Tag>
                    </div>
                    <p className="mb-2 text-xs text-foreground/55">对话别名固定走现有 <code>/api/llm/v1</code>，不浏览 NAS <code>LLM/</code>，不调度到 Workstation 显卡。</p>
                    <div className="text-sm">主别名：<code>{LOCAL_CHAT_ALIAS}</code></div>
                    <div className="mt-2 text-xs text-foreground/55">同进程别名：qwen3.8-27b / qwen3.6-uncensored / glm-5.3-flash · 默认：{defaults.chatModelRef}</div>
                    {source ? <div className="mt-2 truncate text-[11px] text-foreground/40">清单源：{source}</div> : null}
                </div>
            </div>
        </section>
    );
}
