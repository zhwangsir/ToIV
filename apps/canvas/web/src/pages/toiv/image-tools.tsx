import { ArrowLeft, Box, Camera, Eraser, ImagePlus, Loader2, ScanFace, Sparkles, Upload, Wand2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router";

import { Button } from "antd";
import { ToolButton } from "@/components/ui/base/buttons";
import { Callout } from "@/components/ui/product/callout";
import { EmptyState } from "@/components/ui/product/empty-state";
import { WorkspacePage } from "@/components/layout/workspace-page";
import {
    generate3DModel,
    generateFaceDetailer,
    generateInpaint,
    generateQwenEdit,
    generateRemoveBg,
    generateUpscale,
    pollGenJob,
    uploadToivImage,
    type GenAck,
    type UploadImageHandle,
} from "@/services/toiv/client";
import { toivMediaUrl } from "@/services/toiv/agent-runs";

/**
 * 图片工具(F5 融合,自经典 ImageEditView 七工具迁入):
 * 去背景 / 高清增强 / 局部重绘(文字描述区域) / 人脸修复 / 智能编辑(Qwen 语义+相机)
 * / 3D 相机 360° / 图生 3D(Hunyuan3D GLB)。
 * 生成走 Job(prompt_id),3s 轮询本人作业列表取状态与产物。
 */

type Tool = "removebg" | "upscale" | "inpaint" | "facedetailer" | "qwenedit" | "camera3d" | "hunyuan3d";

const TOOLS: { key: Tool; icon: typeof Eraser; name: string; desc: string }[] = [
    { key: "removebg", icon: Eraser, name: "智能去背景", desc: "一键移除背景(通用/动漫/人物)" },
    { key: "upscale", icon: ImagePlus, name: "高清增强", desc: "放大分辨率并修复细节,最高 4 倍" },
    { key: "inpaint", icon: Wand2, name: "局部重绘", desc: "文字描述要修改的区域与替换内容" },
    { key: "facedetailer", icon: ScanFace, name: "人脸修复", desc: "检测并修复模糊/低质量人脸" },
    { key: "qwenedit", icon: Sparkles, name: "智能编辑", desc: "自然语言语义编辑,支持相机控制" },
    { key: "camera3d", icon: Camera, name: "3D 相机", desc: "控制方位/俯仰/距离,环绕一圈看全貌" },
    { key: "hunyuan3d", icon: Box, name: "图生 3D", desc: "单图生成 3D 模型(GLB)" },
];

const REMOVE_BG_MODES = [
    { value: "general", label: "通用" },
    { value: "anime", label: "动漫" },
    { value: "human", label: "人物" },
];

const QWEN_CAMERAS = [
    { value: "", label: "无(仅语义编辑)" },
    { value: "forward", label: "镜头前移" },
    { value: "left", label: "镜头左移" },
    { value: "right", label: "镜头右移" },
    { value: "up", label: "镜头上移" },
    { value: "down", label: "镜头下移" },
    { value: "rotate_left", label: "向左旋转 45°" },
    { value: "rotate_right", label: "向右旋转 45°" },
    { value: "top_down", label: "俯视" },
    { value: "wide", label: "广角" },
];

const CAM3D_AZIMUTHS = [
    { value: 0, label: "正面" }, { value: 45, label: "右前 45°" }, { value: 90, label: "右侧" },
    { value: 135, label: "右后 45°" }, { value: 180, label: "背面" }, { value: 225, label: "左后 45°" },
    { value: 270, label: "左侧" }, { value: 315, label: "左前 45°" },
];
const CAM3D_ELEVATIONS = [
    { value: -30, label: "仰视(低机位)" }, { value: 0, label: "平视" },
    { value: 30, label: "俯视(浅)" }, { value: 60, label: "俯视(高机位)" },
];
const CAM3D_DISTANCES = [
    { value: "closeup", label: "特写" }, { value: "medium", label: "标准" }, { value: "wide", label: "广角" },
];
const CAM3D_SPEEDS = [
    { value: "fast", label: "快速(4 步)" }, { value: "standard", label: "标准(20 步)" },
];
const THREED_OCTREES = [
    { value: 64, label: "64(最快)" }, { value: 128, label: "128" },
    { value: 256, label: "256(默认)" }, { value: 384, label: "384" }, { value: 512, label: "512(最精细)" },
];

const ACCEPT = [".jpg", ".jpeg", ".png", ".webp"];
const MAX_BYTES = 20 * 1024 * 1024;

const selectCls = "rounded-md border bg-background px-2 py-1.5 text-sm";
const inputCls = "w-full rounded-md border bg-background px-2.5 py-2 text-sm";

export default function ImageToolsPage() {
    const [tool, setTool] = useState<Tool>("removebg");
    const [source, setSource] = useState<UploadImageHandle | null>(null);
    const [srcPreview, setSrcPreview] = useState<string>("");
    const [srcName, setSrcName] = useState("");
    const [uploading, setUploading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [phase, setPhase] = useState("");
    const [error, setError] = useState<string | null>(null);
    const [resultUrl, setResultUrl] = useState<string>("");
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    // 工具参数
    const [removeBgMode, setRemoveBgMode] = useState("general");
    const [upscaleScale, setUpscaleScale] = useState(2);
    const [inpaintTarget, setInpaintTarget] = useState("");
    const [inpaintPositive, setInpaintPositive] = useState("");
    const [faceDenoise, setFaceDenoise] = useState(0.6);
    const [qwenPositive, setQwenPositive] = useState("");
    const [qwenCamera, setQwenCamera] = useState("");
    const [qwenFast, setQwenFast] = useState(true);
    const [cam3dNote, setCam3dNote] = useState("");
    const [cam3dAzimuth, setCam3dAzimuth] = useState(90);
    const [cam3dElevation, setCam3dElevation] = useState(0);
    const [cam3dDistance, setCam3dDistance] = useState("medium");
    const [cam3dSpeed, setCam3dSpeed] = useState("fast");
    const [threedOctree, setThreedOctree] = useState(256);
    const [threedSteps, setThreedSteps] = useState(30);

    useEffect(() => () => { if (pollRef.current) clearInterval(pollRef.current); }, []);

    const active = TOOLS.find((t) => t.key === tool) ?? TOOLS[0];

    const pickFile = async (file: File) => {
        setError(null);
        setResultUrl("");
        const ext = file.name.slice(file.name.lastIndexOf(".")).toLowerCase();
        if (!ACCEPT.includes(ext)) { setError(`不支持的格式:${file.name}`); return; }
        if (file.size > MAX_BYTES) { setError("图片超过 20MB"); return; }
        setUploading(true);
        setPhase("上传源图…");
        try {
            const kind = tool === "hunyuan3d" ? "hunyuan3d" : "img2img";
            const h = await uploadToivImage(file, kind);
            setSource(h);
            setSrcName(file.name);
            setSrcPreview(URL.createObjectURL(file));
        } catch (e) {
            setError(e instanceof Error ? e.message : "上传失败");
        } finally {
            setUploading(false);
            setPhase("");
        }
    };

    const track = (ack: GenAck) => {
        setPhase("生成中(3s 轮询作业)…");
        return new Promise<string[]>((resolve, reject) => {
            pollRef.current = setInterval(async () => {
                try {
                    const job = await pollGenJob(ack.prompt_id);
                    if (!job) return;
                    if (job.status === "done") {
                        if (pollRef.current) clearInterval(pollRef.current);
                        resolve(job.results);
                    } else if (job.status === "error" || job.status === "canceled") {
                        if (pollRef.current) clearInterval(pollRef.current);
                        reject(new Error(job.status === "canceled" ? "已取消" : "生成失败(可在任务中心查看)"));
                    }
                } catch (e) {
                    if (pollRef.current) clearInterval(pollRef.current);
                    reject(e);
                }
            }, 3000);
        });
    };

    const submit = async () => {
        if (!source || busy) return;
        setBusy(true);
        setError(null);
        setResultUrl("");
        try {
            const base = { image: source.filename, worker: source.worker };
            let ack: GenAck | null = null;
            switch (tool) {
                case "removebg":
                    ack = await generateRemoveBg({ ...base, mode: removeBgMode });
                    break;
                case "upscale":
                    ack = await generateUpscale({ ...base, scale: upscaleScale });
                    break;
                case "inpaint":
                    if (!inpaintTarget.trim() || !inpaintPositive.trim()) throw new Error("请填写要修改的区域和替换内容");
                    ack = await generateInpaint({ ...base, target: inpaintTarget.trim(), positive: inpaintPositive.trim() });
                    break;
                case "facedetailer":
                    ack = await generateFaceDetailer({ ...base, denoise: faceDenoise });
                    break;
                case "qwenedit":
                    if (!qwenPositive.trim() && !qwenCamera) throw new Error("请填写编辑指令或选择相机角度");
                    ack = await generateQwenEdit({ ...base, positive: qwenPositive.trim() || undefined, camera: qwenCamera || undefined, fast: qwenFast });
                    break;
                case "camera3d":
                    ack = await generateQwenEdit({
                        ...base,
                        positive: cam3dNote.trim() || undefined,
                        azimuth: cam3dAzimuth,
                        elevation: cam3dElevation,
                        distance: cam3dDistance,
                        fast: cam3dSpeed === "fast",
                    });
                    break;
                case "hunyuan3d":
                    ack = await generate3DModel({ ...base, steps: threedSteps, octree_resolution: threedOctree });
                    break;
            }
            if (!ack) return;
            const results = await track(ack);
            setResultUrl(results[0] ?? "");
        } catch (e) {
            setError(e instanceof Error ? e.message : "生成失败");
        } finally {
            setBusy(false);
            setPhase("");
        }
    };

    const isGlb = resultUrl.endsWith(".glb");

    return (
        <WorkspacePage fluid className="toiv-image-tools-page">
            <div className="mx-auto flex w-full max-w-4xl flex-col gap-4 p-6">
                <header className="flex items-center justify-between">
                    <div className="flex flex-col gap-1">
                        <h1 className="text-xl font-semibold leading-7 text-foreground">图片工具</h1>
                        <p className="text-xs leading-5 text-muted-foreground">去背景 / 高清 / 局部重绘 / 人脸修复 / 语义编辑 / 3D 相机 / 图生 3D</p>
                    </div>
                    <div className="flex items-center gap-2">
                        <Link to="/toiv/market"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="工具箱" /></Link>
                        <Link to="/"><ToolButton variant="default" icon={<ArrowLeft className="size-4" />} label="返回首页" /></Link>
                    </div>
                </header>

                <div className="flex flex-wrap gap-2" role="tablist" aria-label="图片工具">
                    {TOOLS.map((t) => (
                        <ToolButton key={t.key} variant={tool === t.key ? "default" : "ghost"} icon={<t.icon className="size-4" />} label={t.name} active={tool === t.key} onClick={() => { if (!busy) setTool(t.key); }} />
                    ))}
                </div>

                <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                    {/* 源图 */}
                    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
                        <div className="flex flex-col gap-0.5">
                            <h2 className="text-sm font-semibold">源图</h2>
                            <p className="text-xs text-muted-foreground">{active.desc}</p>
                        </div>
                        <label
                            className="flex min-h-40 cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border border-dashed p-4 text-sm text-muted-foreground transition-colors hover:border-[var(--workspace-accent,#666)]"
                            onDragOver={(e) => e.preventDefault()}
                            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files?.[0]; if (f) void pickFile(f); }}
                        >
                            {srcPreview ? (
                                <img src={srcPreview} alt={srcName} className="max-h-48 w-full rounded-lg object-contain" />
                            ) : (
                                <>
                                    <Upload className="size-6" />
                                    <span>点击或拖入图片(jpg/png/webp,≤20MB)</span>
                                </>
                            )}
                            <input type="file" className="hidden" accept={ACCEPT.join(",")} disabled={busy || uploading}
                                onChange={(e) => { const f = e.target.files?.[0]; e.currentTarget.value = ""; if (f) void pickFile(f); }} />
                        </label>
                        {srcName && <p className="truncate text-xs text-muted-foreground">{srcName}{source ? ` · worker ${source.worker}` : ""}</p>}
                    </section>

                    {/* 参数 + 结果 */}
                    <section className="flex flex-col gap-3 rounded-2xl border bg-card p-4">
                        <h2 className="text-sm font-semibold">{active.name}</h2>
                        {tool === "removebg" && (
                            <select className={selectCls} value={removeBgMode} onChange={(e) => setRemoveBgMode(e.target.value)}>
                                {REMOVE_BG_MODES.map((m) => <option key={m.value} value={m.value}>{m.label}</option>)}
                            </select>
                        )}
                        {tool === "upscale" && (
                            <div className="flex items-center gap-2 text-sm">
                                <span className="text-muted-foreground">放大倍数</span>
                                {[2, 4].map((n) => (
                                    <button key={n} type="button" className={`rounded-md px-2.5 py-1 text-xs ${upscaleScale === n ? "bg-[var(--surface-active,rgba(255,255,255,0.12))] text-foreground" : "text-muted-foreground hover:text-foreground"}`} onClick={() => setUpscaleScale(n)}>{n}x</button>
                                ))}
                            </div>
                        )}
                        {tool === "inpaint" && (
                            <div className="flex flex-col gap-2">
                                <input className={inputCls} value={inpaintTarget} placeholder="要修改的区域(如:背景中的天空)" onChange={(e) => setInpaintTarget(e.target.value)} />
                                <textarea className={`${inputCls} resize-y`} rows={3} value={inpaintPositive} placeholder="替换成什么(如:黄昏的橙色晚霞)" onChange={(e) => setInpaintPositive(e.target.value)} />
                            </div>
                        )}
                        {tool === "facedetailer" && (
                            <div className="flex items-center gap-3 text-sm">
                                <span className="text-muted-foreground">修复强度</span>
                                <input type="range" min={0.3} max={0.9} step={0.05} value={faceDenoise} onChange={(e) => setFaceDenoise(Number(e.target.value))} className="w-40" />
                                <span className="tabular-nums">{faceDenoise.toFixed(2)}</span>
                            </div>
                        )}
                        {tool === "qwenedit" && (
                            <div className="flex flex-col gap-2">
                                <textarea className={`${inputCls} resize-y`} rows={3} value={qwenPositive} placeholder="编辑指令(如:把外套改成红色)" onChange={(e) => setQwenPositive(e.target.value)} />
                                <div className="flex items-center gap-2">
                                    <span className="shrink-0 text-xs text-muted-foreground">相机</span>
                                    <select className={`${selectCls} min-w-0 flex-1`} value={qwenCamera} onChange={(e) => setQwenCamera(e.target.value)}>
                                        {QWEN_CAMERAS.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                                    </select>
                                </div>
                                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                    <input type="checkbox" checked={qwenFast} onChange={(e) => setQwenFast(e.target.checked)} /> 快速模式
                                </label>
                            </div>
                        )}
                        {tool === "camera3d" && (
                            <div className="grid grid-cols-2 gap-2">
                                <select className={selectCls} value={cam3dAzimuth} onChange={(e) => setCam3dAzimuth(Number(e.target.value))}>
                                    {CAM3D_AZIMUTHS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                <select className={selectCls} value={cam3dElevation} onChange={(e) => setCam3dElevation(Number(e.target.value))}>
                                    {CAM3D_ELEVATIONS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                <select className={selectCls} value={cam3dDistance} onChange={(e) => setCam3dDistance(e.target.value)}>
                                    {CAM3D_DISTANCES.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                <select className={selectCls} value={cam3dSpeed} onChange={(e) => setCam3dSpeed(e.target.value)}>
                                    {CAM3D_SPEEDS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                                </select>
                                <textarea className={`${inputCls} col-span-2 resize-y`} rows={2} value={cam3dNote} placeholder="附加提示(可选)" onChange={(e) => setCam3dNote(e.target.value)} />
                            </div>
                        )}
                        {tool === "hunyuan3d" && (
                            <div className="flex items-center gap-3 text-sm">
                                <span className="text-muted-foreground">网格精度</span>
                                <select className={selectCls} value={threedOctree} onChange={(e) => setThreedOctree(Number(e.target.value))}>
                                    {THREED_OCTREES.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                                </select>
                                <span className="text-muted-foreground">步数</span>
                                <input className={`${selectCls} w-20`} type="number" min={10} max={100} value={threedSteps} onChange={(e) => setThreedSteps(Number(e.target.value))} />
                            </div>
                        )}

                        {error && <Callout tone="error" title={error} onClose={() => setError(null)} />}
                        {phase && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" />{phase}</p>}

                        {resultUrl && !isGlb && (
                            <div className="flex flex-col gap-2 rounded-xl border p-3">
                                {/\.(mp4|webm|mov)(\?|$)/i.test(resultUrl) ? (
                                    <video src={toivMediaUrl(resultUrl)} controls muted playsInline className="max-h-72 w-full rounded-lg bg-black/5" />
                                ) : (
                                    <img src={toivMediaUrl(resultUrl)} alt="结果" className="max-h-72 w-full rounded-lg object-contain" />
                                )}
                                <a className="text-xs underline" href={toivMediaUrl(resultUrl)} download>下载产物</a>
                            </div>
                        )}
                        {resultUrl && isGlb && (
                            <div className="flex flex-col gap-2 rounded-xl border p-3">
                                <p className="text-sm">3D 模型已生成(GLB)</p>
                                <a className="text-xs underline" href={toivMediaUrl(resultUrl)} download>下载 GLB</a>
                            </div>
                        )}
                        {!resultUrl && !phase && <EmptyState description="上传源图并运行工具,结果将在这里呈现" />}

                        <div className="mt-auto flex justify-end">
                            <Button type="primary" size="small" icon={<active.icon className="size-3.5" />} loading={busy || uploading} disabled={!source} onClick={() => void submit()}>
                                运行{active.name}
                            </Button>
                        </div>
                    </section>
                </div>
            </div>
        </WorkspacePage>
    );
}
