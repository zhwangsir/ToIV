import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useParams } from "react-router-dom";
import Button from "../../components/ui/Button";
import ToivShell from "../shell/ToivShell";
import {
    defaultDurationValue, defaultModelValue, defaultSizeValue, fetchToolCapabilities,
    type ToolCapabilities, type ToolCapability,
} from "../adapters/capabilities";
import {
    fetchGenerationJob, isGenerationDone, isGenerationFailed, submitT2I, submitT2V,
    type GenerationJob,
} from "../adapters/generation";
import { primeMediaKind, toivMediaUrl } from "../adapters/media";
import { findTool, resolveToolId } from "../tools/catalog";

type CapabilityState =
    | { status: "loading"; data: null; error: "" }
    | { status: "ready"; data: ToolCapabilities; error: "" }
    | { status: "error"; data: null; error: string };

type Phase = "idle" | "submitting" | "queued" | "running" | "done" | "failed";

const PHASE_LABEL: Record<Phase, string> = {
    idle: "待提交",
    submitting: "提交中",
    queued: "排队中",
    running: "生成中",
    done: "已完成",
    failed: "生成失败",
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : "操作失败，请重试";
}

function unavailableHint(options: { label: string; available: boolean; reason: string }[]): string {
    return options
        .filter((option) => !option.available && option.reason)
        .map((option) => `${option.label}：${option.reason}`)
        .join("；");
}

export default function PrimeToolRun() {
    const { id } = useParams();
    const tool = findTool(resolveToolId(id));
    const isVideo = tool?.kind === "video";
    const title = tool?.title ?? "工具";
    const [prompt, setPrompt] = useState("");
    const [negative, setNegative] = useState("");
    const [capabilityState, setCapabilityState] = useState<CapabilityState>({ status: "loading", data: null, error: "" });
    const [capabilityAttempt, setCapabilityAttempt] = useState(0);
    const [sizeValue, setSizeValue] = useState("");
    const [durationValue, setDurationValue] = useState("");
    const [modelValue, setModelValue] = useState("");
    const [phase, setPhase] = useState<Phase>("idle");
    const [promptId, setPromptId] = useState<string | null>(null);
    const [seed, setSeed] = useState<number | undefined>(undefined);
    const [job, setJob] = useState<GenerationJob | null>(null);
    const [error, setError] = useState("");
    const [pollAttempt, setPollAttempt] = useState(0);
    const [failedMedia, setFailedMedia] = useState<Record<string, boolean>>({});
    const [mediaAttempt, setMediaAttempt] = useState(0);
    const promptRef = useRef<HTMLTextAreaElement>(null);

    useEffect(() => {
        let alive = true;
        setCapabilityState({ status: "loading", data: null, error: "" });
        fetchToolCapabilities()
            .then((data) => { if (alive) setCapabilityState({ status: "ready", data, error: "" }); })
            .catch((cause) => { if (alive) setCapabilityState({ status: "error", data: null, error: errorText(cause) }); });
        return () => { alive = false; };
    }, [capabilityAttempt]);

    const capability: ToolCapability | undefined = capabilityState.data?.tools[isVideo ? "video" : "image"];

    useEffect(() => {
        if (!capability) return;
        setSizeValue(defaultSizeValue(capability, isVideo ? "16:9" : "1:1"));
        setDurationValue(defaultDurationValue(capability));
        setModelValue(defaultModelValue(capability));
    }, [capability, isVideo]);

    useEffect(() => {
        setPhase("idle");
        setPromptId(null);
        setSeed(undefined);
        setJob(null);
        setError("");
        setFailedMedia({});
    }, [isVideo, title]);

    useEffect(() => {
        if (!promptId) return;
        let alive = true;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stop = () => { if (timer) clearTimeout(timer); timer = undefined; };
        const poll = async () => {
            try {
                const next = await fetchGenerationJob(promptId);
                if (!alive) return;
                if (!next) {
                    timer = setTimeout(() => void poll(), 3000);
                    return;
                }
                setJob(next);
                if (isGenerationDone(next.status)) { setPhase("done"); return; }
                if (isGenerationFailed(next.status)) { setPhase("failed"); return; }
                setPhase(next.status === "running" ? "running" : "queued");
                timer = setTimeout(() => void poll(), 3000);
            } catch (cause) {
                if (!alive) return;
                setError(errorText(cause));
            }
        };
        void poll();
        return () => { alive = false; stop(); };
    }, [promptId, pollAttempt]);

    if (!tool) return <Navigate to="/tools" replace />;

    const busy = phase === "submitting";
    const active = phase === "queued" || phase === "running";
    const selectedSize = capability?.sizes.find((size) => size.value === sizeValue)
        ?? capability?.sizes.find((size) => size.available);
    const selectedDuration = capability?.durations.find((duration) => duration.value === durationValue);
    const selectedModel = capability?.models.find((model) => model.value === modelValue);
    const sizeUnavailableHint = capability ? unavailableHint(capability.sizes) : "";
    const durationUnavailableHint = capability ? unavailableHint(capability.durations) : "";
    const capabilityUsable = Boolean(
        capability?.available
        && selectedSize?.available
        && (!isVideo || selectedDuration?.available),
    );

    const submit = async (event: FormEvent) => {
        event.preventDefault();
        if (!prompt.trim()) {
            setError("请先写提示词");
            promptRef.current?.focus();
            return;
        }
        if (!capability || !capability.available) {
            setError(capability?.unavailableReason || "生成能力未就绪");
            return;
        }
        if (!selectedSize || !selectedSize.available) {
            setError("当前画幅超出引擎能力范围，请换一个画幅");
            return;
        }
        if (isVideo && !selectedDuration?.available) {
            setError("当前时长不可用，请换一个时长档");
            return;
        }
        setError("");
        setJob(null);
        setSeed(undefined);
        setPromptId(null);
        setFailedMedia({});
        setPhase("submitting");
        try {
            const submission = isVideo
                ? await submitT2V({
                    prompt: prompt.trim(), size: selectedSize,
                    durationSec: selectedDuration!.seconds, route: capability.route,
                })
                : await submitT2I({
                    prompt: prompt.trim(), negative: negative.trim(), model: modelValue || undefined,
                    size: selectedSize, route: capability.route,
                });
            setSeed(submission.seed);
            setPromptId(submission.promptId);
            setPhase("queued");
        } catch (cause) {
            setError(errorText(cause));
            setPhase("idle");
        }
    };

    const retryPoll = () => {
        setError("");
        setPollAttempt((value) => value + 1);
    };

    const retryMedia = (url: string) => {
        setFailedMedia((current) => {
            const next = { ...current };
            delete next[url];
            return next;
        });
        setMediaAttempt((value) => value + 1);
    };

    const results = job?.results ?? [];
    return (
        <ToivShell>
            <div className="toiv-tools toiv-tool-run">
                <header className="toiv-tools-head">
                    <div>
                        <p className="toiv-tool-crumb"><Link to="/tools">工具</Link><span aria-hidden="true"> / </span>{title}</p>
                        <h1>{title}</h1>
                        <p className="toiv-settings-note">{tool.blurb} 产物统一进任务中心。</p>
                    </div>
                    <Button variant="outline" size="sm" to="/tools">回工具台</Button>
                </header>

                <div className="toiv-tool-body">
                    <form className="toiv-settings-section toiv-tool-form" onSubmit={submit} aria-labelledby="tool-form-title">
                        <div className="toiv-settings-section-head">
                            <h2 id="tool-form-title">{isVideo ? "出片参数" : "出图参数"}</h2>
                            <span className="meta">
                                {selectedSize ? `${selectedSize.width}×${selectedSize.height}` : "能力读取中"}
                                {isVideo && selectedDuration ? ` · ${selectedDuration.label}` : ""}
                            </span>
                        </div>
                        {capabilityState.status === "loading" ? (
                            <p className="toiv-workspace-note" role="status">正在读取生成能力…</p>
                        ) : null}
                        {capabilityState.status === "error" ? (
                            <div className="toiv-tool-error" role="alert">
                                <span>{capabilityState.error}</span>
                                <Button variant="text" size="sm" type="button"
                                    onClick={() => setCapabilityAttempt((value) => value + 1)}>重试能力</Button>
                            </div>
                        ) : null}
                        {capability && !capability.available ? (
                            <div className="toiv-tool-error" role="alert">
                                <span>{capability.label}暂不可用：{capability.unavailableReason}</span>
                                <Button variant="text" size="sm" type="button"
                                    onClick={() => setCapabilityAttempt((value) => value + 1)}>重试能力</Button>
                            </div>
                        ) : null}
                        <label className="toiv-tool-field">
                            <span>提示词</span>
                            <textarea ref={promptRef} value={prompt} rows={5}
                                placeholder={isVideo ? "描述镜头运动、光线与主体…" : "描述画面主体、光线与风格…"}
                                onChange={(event) => setPrompt(event.target.value)} />
                        </label>
                        {!isVideo ? (
                            <label className="toiv-tool-field">
                                <span>反向提示词（可选）</span>
                                <textarea value={negative} rows={2} placeholder="不希望出现的元素…"
                                    onChange={(event) => setNegative(event.target.value)} />
                            </label>
                        ) : null}
                        {capability?.models.length ? (
                            <label className="toiv-tool-field">
                                <span>模型</span>
                                <select className="toiv-tool-select" aria-label="模型" value={modelValue}
                                    onChange={(event) => setModelValue(event.target.value)}>
                                    {capability.models.map((model) => (
                                        <option key={model.value} value={model.value}>
                                            {model.label}{model.nsfw ? "（R18）" : ""}
                                        </option>
                                    ))}
                                </select>
                                {selectedModel?.desc ? <small className="meta">{selectedModel.desc}</small> : null}
                            </label>
                        ) : null}
                        {capability?.sizes.length ? (
                            <div className="toiv-field">
                                <span className="toiv-field-label">画幅</span>
                                <div className="toiv-seg toiv-seg-wrap" role="radiogroup" aria-label="画幅">
                                    {capability.sizes.map((option) => (
                                        <button key={option.value} type="button" role="radio"
                                            aria-checked={sizeValue === option.value}
                                            disabled={!option.available}
                                            title={option.reason || undefined}
                                            className={`toiv-seg-item${sizeValue === option.value ? " is-active" : ""}${option.available ? "" : " is-disabled"}`}
                                            onClick={() => { if (option.available) setSizeValue(option.value); }}>
                                            <span>{option.label}</span>
                                        </button>
                                    ))}
                                </div>
                                {sizeUnavailableHint ? <small className="toiv-seg-hint">{sizeUnavailableHint}</small> : null}
                                {capability.sizeHint ? <small className="meta">{capability.sizeHint}</small> : null}
                            </div>
                        ) : null}
                        {isVideo && capability?.durations.length ? (
                            <div className="toiv-field">
                                <span className="toiv-field-label">时长</span>
                                <div className="toiv-seg toiv-seg-wrap" role="radiogroup" aria-label="时长">
                                    {capability.durations.map((option) => (
                                        <button key={option.value} type="button" role="radio"
                                            aria-checked={durationValue === option.value}
                                            disabled={!option.available}
                                            title={option.reason || undefined}
                                            className={`toiv-seg-item${durationValue === option.value ? " is-active" : ""}${option.available ? "" : " is-disabled"}`}
                                            onClick={() => { if (option.available) setDurationValue(option.value); }}>
                                            {option.label}
                                        </button>
                                    ))}
                                </div>
                                {durationUnavailableHint ? <small className="toiv-seg-hint">{durationUnavailableHint}</small> : null}
                                {capability.durationHint ? <small className="meta">{capability.durationHint}</small> : null}
                            </div>
                        ) : null}
                        {isVideo && capability && capability.durations.length === 0 ? (
                            <p className="toiv-workspace-note">该引擎未声明时长档，暂不可提交。</p>
                        ) : null}
                        <div className="toiv-tool-actions">
                            <Button variant="lime" type="submit" disabled={busy || active || !capabilityUsable}>
                                {busy ? "提交中…" : active ? "生成中…" : isVideo ? "生成视频" : "生成图片"}
                            </Button>
                            <span className="meta">作业完成后自动展示结果</span>
                        </div>
                        {seed !== undefined ? <p className="meta">本次 seed {seed}</p> : null}
                        {error ? (
                            <p className="toiv-tool-error" role="alert">{error}
                                {promptId ? <Button variant="text" size="sm" type="button" onClick={retryPoll}>继续查询</Button> : null}
                            </p>
                        ) : null}
                    </form>

                    <section className="toiv-settings-section toiv-tool-results" aria-labelledby="tool-results-title">
                        <div className="toiv-settings-section-head">
                            <h2 id="tool-results-title">结果</h2>
                            <span className={`toiv-tool-status is-${phase}`} role="status" aria-live="polite">
                                <i aria-hidden="true" />{PHASE_LABEL[phase]}
                                {promptId ? <code>#{promptId}</code> : null}
                            </span>
                        </div>

                        {phase === "idle" ? <p className="toiv-workspace-note">填好提示词后提交，结果会出现在这里。</p> : null}
                        {phase === "submitting" ? <p className="toiv-workspace-note">正在提交作业…</p> : null}
                        {active ? <p className="toiv-workspace-note">作业已提交，完成后自动刷新；也可以先去任务中心。</p> : null}
                        {phase === "failed" ? (
                            <div className="toiv-tool-failure" role="alert">
                                <p>{job?.error || "生成失败，未返回原因。"}</p>
                            </div>
                        ) : null}
                        {phase === "done" && results.length === 0 ? (
                            <p className="toiv-workspace-note">作业已完成，但没有可预览产物。<Link to="/tasks">去任务中心查看</Link></p>
                        ) : null}
                        {results.length > 0 ? (
                            <div className="toiv-tool-result-grid">
                                {results.map((url, index) => {
                                    const src = toivMediaUrl(url);
                                    const kind = primeMediaKind(url) ?? (isVideo ? "video" : "image");
                                    if (!src) return <p className="toiv-workspace-note" key={`${url}-${index}`}>第 {index + 1} 个产物地址无效。</p>;
                                    const label = `${title}结果 ${index + 1}`;
                                    return (
                                        <figure className="toiv-tool-result" key={`${url}-${mediaAttempt}`}>
                                            {failedMedia[url] ? (
                                                <div className="toiv-tool-media is-failed">
                                                    <p>媒体载入失败，文件可能不可用或登录已过期。</p>
                                                    <Button size="sm" variant="outline" type="button" onClick={() => retryMedia(url)}>重试媒体</Button>
                                                </div>
                                            ) : kind === "video" ? (
                                                <video className="toiv-tool-media" src={src} controls preload="metadata" aria-label={label}
                                                    onError={() => setFailedMedia((current) => ({ ...current, [url]: true }))} />
                                            ) : (
                                                <img className="toiv-tool-media" src={src} alt={label} loading="lazy" referrerPolicy="no-referrer"
                                                    onError={() => setFailedMedia((current) => ({ ...current, [url]: true }))} />
                                            )}
                                            <figcaption>
                                                <a href={src} target="_blank" rel="noreferrer">{kind === "video" ? "打开原片" : "打开原图"}</a>
                                                <Link to="/tasks">在任务中心查看</Link>
                                            </figcaption>
                                        </figure>
                                    );
                                })}
                            </div>
                        ) : null}
                    </section>
                </div>
            </div>
        </ToivShell>
    );
}
