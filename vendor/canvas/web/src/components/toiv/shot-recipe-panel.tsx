/**
 * C1b:配方创作台 —— 保存当前 shot 为配方 / 列表 / 编辑 / 克隆 / 每引擎默认 /
 * 删除(App 上下文 modal)/ JSON 导入导出 / apply 前 diff / 应用(409 不覆盖)。
 *
 * 全部读写走后端 /studio/recipes(服务端真值,不用 localforage 伪造跨设备配方);
 * 应用成功后用返回的 render_params 调 parent 的真实渲染动作(keyframe 闸在
 * parent runShotRender,本组件不绕过)。
 */
import { App } from "antd";
import { Copy, Download, FlaskConical, Pencil, PlayCircle, Save, Star, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { StatusBadge } from "@/components/ui/base/badges";
import { ToolButton } from "@/components/ui/base/buttons";
import {
    applyRecipe,
    cloneRecipe,
    createRecipeFromShot,
    deleteRecipe,
    exportRecipe,
    fetchRecipeDiff,
    fetchRecipes,
    importRecipe,
    patchRecipe,
    setDefaultRecipe,
    type ToivDramaShot,
    type ToivRecipe,
    type ToivRecipeDiff,
    type ToivRecipeExport,
    type ToivRecipePickStrategy,
    type ToivRecipeRenderParams,
} from "@/services/toiv/client";
import { triggerBlobDownload } from "@/services/toiv/jianying-draft";

// ---- 纯函数(可单测) ----

/** diff/apply 涉及的镜头字段中文标签(与 C1a REVISION_FIELD_LABELS 同口径) */
export const RECIPE_FIELD_LABELS: Record<string, string> = {
    prompt: "提示语",
    negative: "负向词",
    camera: "运镜",
    duration_sec: "时长",
    video_model: "视频模型",
    render_mode: "生成方式",
    ref_epoch: "参考纪元",
    ref_epoch_note: "纪元备注",
    scene_ref_json: "场景引用",
    ref_images: "参考图",
};

export function recipeFieldLabel(field: string): string {
    return RECIPE_FIELD_LABELS[field] ?? field;
}

export const RECIPE_PICK_STRATEGY_LABELS: Record<string, string> = {
    auto_best: "自动择优",
    manual: "手动挑选",
};

export function recipePickStrategyLabel(strategy: string): string {
    return RECIPE_PICK_STRATEGY_LABELS[strategy] ?? strategy;
}

/** 可快照性预判(与后端 build_snapshot 口径一致:无渲染修订/内容修订/媒体 → 422) */
export function canSaveRecipeFromShot(
    shot: Pick<ToivDramaShot, "rendered_revision_id" | "current_revision_id" | "video_url" | "image_url">,
): boolean {
    return Boolean(
        (shot.rendered_revision_id || "").trim()
            || (shot.current_revision_id || "").trim()
            || (shot.video_url || "").trim()
            || (shot.image_url || "").trim(),
    );
}

export type RecipeImportParse = { ok: true; payload: unknown } | { ok: false; error: string };

/** 导入文本本地预检:非 JSON 对象不发请求,给出可读错误 */
export function parseRecipeImportText(text: string): RecipeImportParse {
    try {
        const payload: unknown = JSON.parse(text);
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
            return { ok: false, error: "导入内容须为 JSON 对象(toiv_generation_recipe_v1 导出形状)" };
        }
        return { ok: true, payload };
    } catch {
        return { ok: false, error: "导入内容不是合法 JSON" };
    }
}

/** 错误透出:409 乐观并发优先(不覆盖语义),其次后端 detail,最后 Error.message/fallback */
export function recipeErrorMessage(e: unknown, fallback: string): string {
    const resp = (e as { response?: { status?: number; data?: { detail?: unknown } } } | null)?.response;
    if (resp?.status === 409) {
        const detail = resp.data?.detail;
        return typeof detail === "string" && detail.trim()
            ? detail
            : "分镜已被其他修改更新,请刷新后重试";
    }
    const detail = resp?.data?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (e instanceof Error && e.message.trim()) return e.message;
    return fallback;
}

export function recipeExportFilename(name: string): string {
    const cleaned = (name || "")
        .replace(/[^\w一-龥.-]+/g, "_")
        .replace(/^[\s._]+|[\s._]+$/g, "")
        .slice(0, 44) || "toiv-recipe";
    return `${cleaned}_recipe.json`;
}

/** render_params 可读摘要(空值跳过;wait 是实现细节不展示) */
export function recipeRenderParamSummary(params: ToivRecipeRenderParams): string[] {
    const out: string[] = [];
    if (params.video_model) out.push(`视频模型 ${params.video_model}`);
    if (params.pipeline) out.push(`管线 ${params.pipeline}`);
    if (typeof params.num_candidates === "number") out.push(`候选 ${params.num_candidates}`);
    if (typeof params.seed === "number") out.push(`seed ${params.seed}`);
    if (typeof params.auto_pick === "boolean") out.push(params.auto_pick ? "自动择优" : "手动挑选");
    if (Array.isArray(params.ref_images) && params.ref_images.length > 0) out.push(`参考图 ${params.ref_images.length} 张`);
    if (Array.isArray(params.scene_images) && params.scene_images.length > 0) out.push(`场景图 ${params.scene_images.length} 张`);
    if (params.ref_style) out.push(`画风 ${params.ref_style}`);
    if (params.accel) out.push(`加速 ${params.accel}`);
    return out;
}

/** 导出下载前的导出文件兜底脱敏:与后端 recipes.strip_url_secret 同口径(后端为真源,
 *  前端只兜底下载文件这一侧)——/api/images 保留 filename/subfolder/worker/type 定位参数,
 *  其余 query 与 userinfo/fragment 一律剥除;非法 URL 不抛、不回显秘密(置空)。不 mutate 入参。 */
const EXPORT_BANNED_KEYS = ["worker_url", "context_latent_path", "parent_chain_job_id"] as const;
const EXPORT_URL_LIST_KEYS = ["ref_images", "scene_images"] as const;
// 与后端 _SAFE_IMAGE_QUERY_KEYS 同口径(顺序即输出顺序)
const SAFE_IMAGE_QUERY_KEYS = ["filename", "subfolder", "worker", "type"] as const;

function stripUrlSecret(raw: string): string {
    const u = (raw || "").trim();
    if (!u) return u;
    const absolute = /^([a-zA-Z][a-zA-Z\d+.-]*:)?\/\//.test(u);
    const bareRelative = !absolute && !u.startsWith("/");
    let parsed: URL;
    try {
        parsed = absolute
            ? new URL(u.startsWith("//") ? `http:${u}` : u)
            : new URL(u, "http://toiv.export-sanitizer.local");
    } catch {
        return ""; // 非法主机/端口等:不抛崩溃、不回显原文(可能带签名)
    }
    let path = parsed.pathname;
    if (bareRelative && path.startsWith("/")) path = path.slice(1);
    const pairs: string[] = [];
    if (path.startsWith("/api/images")) {
        for (const key of SAFE_IMAGE_QUERY_KEYS) {
            for (const value of parsed.searchParams.getAll(key)) {
                pairs.push(`${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
            }
        }
    }
    const query = pairs.join("&");
    if (absolute) {
        // host 含端口、不含 userinfo(凭据剥除);协议相对 //host/path 原样保留
        const schemeMatch = /^([a-zA-Z][a-zA-Z\d+.-]*:)?\/\//.exec(u)!;
        const scheme = schemeMatch[1] ?? "";
        return `${scheme}//${parsed.host}${path}${query ? `?${query}` : ""}`;
    }
    return `${path}${query ? `?${query}` : ""}`;
}

/** scene_ref_json 与后端 sanitize_scene_ref 同口径:有效 JSON 保留结构只脱 anchor_image;
 *  非 JSON 游离字符串按 URL 同法脱敏;其余原样。 */
function sanitizeSceneRef(raw: unknown): unknown {
    if (!raw) return raw;
    if (typeof raw !== "string") {
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
            const image = (raw as Record<string, unknown>).anchor_image;
            if (typeof image === "string" && image) {
                return { ...raw, anchor_image: stripUrlSecret(image) };
            }
        }
        return raw;
    }
    try {
        const data: unknown = JSON.parse(raw);
        if (!data || typeof data !== "object" || Array.isArray(data)) return raw;
        const image = (data as Record<string, unknown>).anchor_image;
        if (typeof image !== "string" || !image) return raw;
        return JSON.stringify({ ...data, anchor_image: stripUrlSecret(image) });
    } catch {
        return stripUrlSecret(raw);
    }
}

export function sanitizeRecipeExportForDownload(payload: ToivRecipeExport): ToivRecipeExport {
    const snapshot: Record<string, unknown> = { ...(payload.snapshot ?? {}) };
    for (const key of EXPORT_BANNED_KEYS) delete snapshot[key];
    for (const key of EXPORT_URL_LIST_KEYS) {
        const value = snapshot[key];
        if (!Array.isArray(value)) continue;
        snapshot[key] = value
            .filter((x): x is string => typeof x === "string")
            .map(stripUrlSecret);
    }
    if ("scene_ref_json" in snapshot) {
        snapshot.scene_ref_json = sanitizeSceneRef(snapshot.scene_ref_json);
    }
    const out: Record<string, unknown> = { ...payload };
    for (const key of EXPORT_BANNED_KEYS) delete out[key];
    out.snapshot = snapshot;
    return out as ToivRecipeExport;
}

function formatRecipeTime(iso: string): string {
    const t = new Date(iso);
    return Number.isNaN(t.getTime()) ? iso : t.toLocaleString("zh-CN", { hour12: false });
}

// ---- 组件 ----

export type ShotRecipePanelProps = {
    shot: ToivDramaShot;
    busy?: boolean;
    onSaved: () => Promise<void> | void;
    onError?: (message: string) => void;
    /** 应用成功后用返回的 render_params 调 parent 真实渲染(keyframe 闸/force_direct 在 parent 补) */
    onApplyRender?: (shotId: string, params: ToivRecipeRenderParams) => void;
};

type RecipeDraft = {
    name: string;
    description: string;
    prompt: string;
    negative: string;
    pick_strategy: ToivRecipePickStrategy;
};

function draftFrom(recipe: ToivRecipe): RecipeDraft {
    return {
        name: recipe.name ?? "",
        description: recipe.description ?? "",
        prompt: recipe.snapshot?.prompt ?? "",
        negative: recipe.snapshot?.negative ?? "",
        pick_strategy: recipe.pick_strategy === "manual" ? "manual" : "auto_best",
    };
}

export function ShotRecipePanel({ shot, busy = false, onSaved, onError, onApplyRender }: ShotRecipePanelProps) {
    const { modal } = App.useApp();
    const [recipes, setRecipes] = useState<ToivRecipe[]>([]);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [message, setMessage] = useState<{ tone: "success" | "error"; text: string } | null>(null);

    const [saveOpen, setSaveOpen] = useState(false);
    const [saveName, setSaveName] = useState("");
    const [saveDescription, setSaveDescription] = useState("");
    const [saving, setSaving] = useState(false);

    const [editingId, setEditingId] = useState<string | null>(null);
    const [draft, setDraft] = useState<RecipeDraft | null>(null);
    const [patching, setPatching] = useState(false);

    const [applyTarget, setApplyTarget] = useState<{ recipeId: string; diff: ToivRecipeDiff | null } | null>(null);
    const [applySpecs, setApplySpecs] = useState(false);
    const [applying, setApplying] = useState(false);

    const importInputRef = useRef<HTMLInputElement | null>(null);
    const [importing, setImporting] = useState(false);

    const refresh = useCallback(async () => {
        setLoading(true);
        setError(null);
        try {
            setRecipes(await fetchRecipes());
        } catch (e) {
            setError(recipeErrorMessage(e, "配方列表加载失败"));
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void refresh();
    }, [refresh]);

    const saveFromShot = useCallback(async () => {
        setSaving(true);
        setMessage(null);
        try {
            const created = await createRecipeFromShot(shot.id, { name: saveName, description: saveDescription });
            setSaveOpen(false);
            setSaveName("");
            setSaveDescription("");
            setMessage({ tone: "success", text: `已保存配方「${created.name}」` });
            await refresh();
        } catch (e) {
            const text = recipeErrorMessage(e, "保存配方失败");
            setMessage({ tone: "error", text });
            onError?.(text);
        } finally {
            setSaving(false);
        }
    }, [shot.id, saveName, saveDescription, refresh, onError]);

    const startEdit = (recipe: ToivRecipe) => {
        setMessage(null);
        setEditingId(recipe.id);
        setDraft(draftFrom(recipe));
    };

    const saveEdit = useCallback(async () => {
        if (!editingId || !draft) return;
        setPatching(true);
        setMessage(null);
        try {
            const updated = await patchRecipe(editingId, {
                name: draft.name,
                description: draft.description,
                prompt: draft.prompt,
                negative: draft.negative,
                pick_strategy: draft.pick_strategy,
            });
            setEditingId(null);
            setDraft(null);
            setMessage({ tone: "success", text: `已更新配方「${updated.name}」` });
            await refresh();
        } catch (e) {
            const text = recipeErrorMessage(e, "配方更新失败");
            setMessage({ tone: "error", text });
            onError?.(text);
        } finally {
            setPatching(false);
        }
    }, [editingId, draft, refresh, onError]);

    const clone = useCallback(async (recipe: ToivRecipe) => {
        setMessage(null);
        try {
            const dup = await cloneRecipe(recipe.id);
            setMessage({ tone: "success", text: `已克隆为「${dup.name}」` });
            await refresh();
        } catch (e) {
            const text = recipeErrorMessage(e, "克隆失败");
            setMessage({ tone: "error", text });
            onError?.(text);
        }
    }, [refresh, onError]);

    const setDefault = useCallback(async (recipe: ToivRecipe) => {
        setMessage(null);
        try {
            await setDefaultRecipe(recipe.id);
            setMessage({ tone: "success", text: `「${recipe.name}」已设为 ${recipe.engine} 默认配方` });
            await refresh();
        } catch (e) {
            const text = recipeErrorMessage(e, "设置默认失败");
            setMessage({ tone: "error", text });
            onError?.(text);
        }
    }, [refresh, onError]);

    const remove = useCallback((recipe: ToivRecipe) => {
        modal.confirm({
            title: `删除配方「${recipe.name}」?`,
            content: "只删除配方行,不碰源镜与产物。此操作不可撤销。",
            okText: "删除",
            okButtonProps: { danger: true },
            cancelText: "取消",
            onOk: async () => {
                try {
                    await deleteRecipe(recipe.id);
                    setMessage({ tone: "success", text: `已删除「${recipe.name}」` });
                    await refresh();
                } catch (e) {
                    const text = recipeErrorMessage(e, "删除失败");
                    setMessage({ tone: "error", text });
                    onError?.(text);
                }
            },
        });
    }, [modal, refresh, onError]);

    const exportOne = useCallback(async (recipe: ToivRecipe) => {
        setMessage(null);
        try {
            const payload = sanitizeRecipeExportForDownload(await exportRecipe(recipe.id));
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
            triggerBlobDownload(blob, recipeExportFilename(payload.name || recipe.name));
            setMessage({ tone: "success", text: `已导出「${recipe.name}」` });
        } catch (e) {
            const text = recipeErrorMessage(e, "导出失败");
            setMessage({ tone: "error", text });
            onError?.(text);
        }
    }, [onError]);

    const importFile = useCallback(async (file: File) => {
        setImporting(true);
        setMessage(null);
        try {
            const text = await file.text();
            const parsed = parseRecipeImportText(text);
            if (!parsed.ok) {
                setMessage({ tone: "error", text: parsed.error });
                return;
            }
            const created = await importRecipe(parsed.payload);
            setMessage({ tone: "success", text: `已导入「${created.name}」` });
            await refresh();
        } catch (e) {
            // 服务端校验错误(422 detail)原样透出:不落半成品,由用户修正后重试
            const msg = recipeErrorMessage(e, "导入失败");
            setMessage({ tone: "error", text: msg });
            onError?.(msg);
        } finally {
            setImporting(false);
            if (importInputRef.current) importInputRef.current.value = "";
        }
    }, [refresh, onError]);

    const openApply = useCallback(async (recipe: ToivRecipe) => {
        setMessage(null);
        setApplySpecs(false);
        setApplyTarget({ recipeId: recipe.id, diff: null });
        try {
            const diff = await fetchRecipeDiff(recipe.id, shot.id);
            setApplyTarget((prev) => (prev?.recipeId === recipe.id ? { recipeId: recipe.id, diff } : prev));
        } catch (e) {
            setApplyTarget(null);
            const text = recipeErrorMessage(e, "差异对比加载失败");
            setMessage({ tone: "error", text });
            onError?.(text);
        }
    }, [shot.id, onError]);

    const confirmApply = useCallback(async () => {
        if (!applyTarget) return;
        setApplying(true);
        setMessage(null);
        try {
            const result = await applyRecipe(applyTarget.recipeId, {
                shot_id: shot.id,
                expected_revision: shot.current_revision_id ?? "",
                apply_project_specs: applySpecs,
            });
            const specs = result.project_specs_changed.length > 0
                ? `;项目规格已写入:${result.project_specs_changed.join("/")}`
                : "";
            setApplyTarget(null);
            setMessage({ tone: "success", text: `已应用配方(${result.applied_fields.length} 个字段${specs}),开始渲染` });
            await onSaved();
            onApplyRender?.(shot.id, result.render_params);
        } catch (e) {
            const conflict = (e as { response?: { status?: number } } | null)?.response?.status === 409;
            const text = recipeErrorMessage(e, "应用失败");
            setApplyTarget(null);
            setMessage({ tone: "error", text });
            onError?.(text);
            if (conflict) {
                // 409:服务端已变,不覆盖;刷新到服务端真值
                void onSaved();
            }
        } finally {
            setApplying(false);
        }
    }, [applyTarget, shot.id, shot.current_revision_id, applySpecs, onSaved, onError, onApplyRender]);

    const savable = canSaveRecipeFromShot(shot);
    const applyRecipeRow = applyTarget ? recipes.find((r) => r.id === applyTarget.recipeId) : null;

    return (
        <div data-testid="shot-recipe-panel" className="flex flex-col gap-3 text-xs">
            <div className="flex flex-wrap items-center gap-1.5">
                <ToolButton
                    size="xs"
                    variant="default"
                    icon={<FlaskConical />}
                    label={saving ? "保存中…" : "保存当前为配方"}
                    loading={saving}
                    disabled={busy || !savable}
                    title={savable ? undefined : "该镜还没有可复用的生成输入(先渲染或保存分镜)"}
                    onClick={() => setSaveOpen((v) => !v)}
                />
                <ToolButton
                    size="xs"
                    variant="ghost"
                    icon={<Upload />}
                    label={importing ? "导入中…" : "导入 JSON"}
                    loading={importing}
                    disabled={busy}
                    onClick={() => importInputRef.current?.click()}
                />
                <input
                    ref={importInputRef}
                    data-testid="recipe-import-input"
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file) void importFile(file);
                    }}
                />
            </div>
            {saveOpen && (
                <div data-testid="shot-recipe-save-form" className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] p-2">
                    <input
                        value={saveName}
                        onChange={(e) => setSaveName(e.target.value)}
                        placeholder="配方名称(可空,后端按镜头命名)"
                        aria-label="配方名称"
                        className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-foreground"
                    />
                    <textarea
                        value={saveDescription}
                        onChange={(e) => setSaveDescription(e.target.value)}
                        placeholder="描述(可选)"
                        aria-label="配方描述"
                        rows={2}
                        className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-foreground"
                    />
                    <div className="flex gap-1.5">
                        <ToolButton size="xs" variant="default" icon={<Save />} label="保存配方" loading={saving} onClick={() => void saveFromShot()} />
                        <ToolButton size="xs" variant="ghost" icon={<X />} label="取消" disabled={saving} onClick={() => setSaveOpen(false)} />
                    </div>
                </div>
            )}
            {message && (
                <p
                    data-testid="shot-recipe-message"
                    className={`rounded border border-[var(--border)] p-2 ${message.tone === "error" ? "text-[var(--danger)]" : "text-foreground"}`}
                >
                    {message.text}
                </p>
            )}
            {error && <p className="rounded border border-[var(--border)] p-2 text-[var(--danger)]">{error}</p>}
            {loading && <p className="text-[var(--muted-foreground)]">加载配方…</p>}
            {!loading && recipes.length === 0 && !error && (
                <p className="text-[var(--muted-foreground)]">暂无配方:把当前镜头的生成输入保存为配方,或导入 JSON。</p>
            )}
            <ul data-testid="shot-recipe-list" className="flex flex-col gap-2">
                {recipes.map((recipe) => (
                    <li key={recipe.id} className="flex flex-col gap-1.5 rounded-lg border border-[var(--border)] p-2.5">
                        <div className="flex items-center justify-between gap-2">
                            <p className="m-0 break-all font-medium text-foreground">{recipe.name}</p>
                            <span className="flex shrink-0 items-center gap-1">
                                <StatusBadge variant="filled" tone="neutral" label={recipe.engine} size="sm" />
                                {recipe.is_default && <StatusBadge variant="filled" tone="success" label="默认" size="sm" />}
                            </span>
                        </div>
                        {(recipe.description || "").trim() && (
                            <p className="m-0 whitespace-pre-wrap break-words text-[var(--muted-foreground)]">{recipe.description}</p>
                        )}
                        {(recipe.snapshot?.prompt || "").trim() && (
                            <p className="m-0 break-all text-[var(--muted-foreground)]">{(recipe.snapshot?.prompt ?? "").slice(0, 80)}</p>
                        )}
                        <p className="m-0 text-[var(--muted-foreground)]">
                            {recipePickStrategyLabel(recipe.pick_strategy)} · {recipe.pipeline} · 更新 {formatRecipeTime(recipe.updated_at)}
                        </p>
                        {editingId === recipe.id && draft ? (
                            <div data-testid="recipe-edit-form" className="flex flex-col gap-1.5 rounded border border-[var(--border)] p-2">
                                <input
                                    value={draft.name}
                                    onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                                    aria-label="编辑配方名称"
                                    className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-foreground"
                                />
                                <textarea
                                    value={draft.description}
                                    onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                                    aria-label="编辑配方描述"
                                    rows={2}
                                    className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-foreground"
                                />
                                <textarea
                                    value={draft.prompt}
                                    onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
                                    aria-label="编辑提示语"
                                    rows={3}
                                    className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-foreground"
                                />
                                <textarea
                                    value={draft.negative}
                                    onChange={(e) => setDraft({ ...draft, negative: e.target.value })}
                                    aria-label="编辑负向词"
                                    rows={2}
                                    className="w-full rounded border border-[var(--border)] bg-transparent px-2 py-1 text-foreground"
                                />
                                <label className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                                    挑选策略
                                    <select
                                        value={draft.pick_strategy}
                                        onChange={(e) => setDraft({ ...draft, pick_strategy: e.target.value as ToivRecipePickStrategy })}
                                        aria-label="编辑挑选策略"
                                        className="rounded border border-[var(--border)] bg-transparent px-1 py-0.5 text-foreground"
                                    >
                                        <option value="auto_best">{RECIPE_PICK_STRATEGY_LABELS.auto_best}</option>
                                        <option value="manual">{RECIPE_PICK_STRATEGY_LABELS.manual}</option>
                                    </select>
                                </label>
                                <div className="flex gap-1.5">
                                    <ToolButton size="xs" variant="default" icon={<Save />} label={patching ? "保存中…" : "保存"} loading={patching} onClick={() => void saveEdit()} />
                                    <ToolButton size="xs" variant="ghost" icon={<X />} label="取消" disabled={patching} onClick={() => { setEditingId(null); setDraft(null); }} />
                                </div>
                            </div>
                        ) : (
                            <div className="flex flex-wrap items-center gap-1.5">
                                <ToolButton size="xs" variant="default" icon={<PlayCircle />} label="应用" disabled={busy} onClick={() => void openApply(recipe)} />
                                <ToolButton size="xs" variant="ghost" icon={<Pencil />} label="编辑" disabled={busy} onClick={() => startEdit(recipe)} />
                                <ToolButton size="xs" variant="ghost" icon={<Copy />} label="克隆" disabled={busy} onClick={() => void clone(recipe)} />
                                <ToolButton size="xs" variant="ghost" icon={<Download />} label="导出" disabled={busy} onClick={() => void exportOne(recipe)} />
                                {!recipe.is_default && (
                                    <ToolButton size="xs" variant="ghost" icon={<Star />} label="设为默认" disabled={busy} onClick={() => void setDefault(recipe)} />
                                )}
                                <ToolButton size="xs" variant="ghost" tone="danger" icon={<Trash2 />} label="删除" disabled={busy} onClick={() => remove(recipe)} />
                            </div>
                        )}
                        {applyTarget?.recipeId === recipe.id && (
                            <div data-testid="recipe-diff" className="flex flex-col gap-2 rounded border border-[var(--border)] p-2">
                                <p className="m-0 font-medium text-foreground">应用前对比 · {applyRecipeRow?.name ?? ""} → 镜头 #{shot.idx}</p>
                                {!applyTarget.diff && <p className="m-0 text-[var(--muted-foreground)]">加载差异…</p>}
                                {applyTarget.diff && Object.keys(applyTarget.diff.fields).length === 0 && (
                                    <p className="m-0 text-[var(--muted-foreground)]">与当前镜头一致(无字段变化)</p>
                                )}
                                {applyTarget.diff && Object.entries(applyTarget.diff.fields).map(([field, change]) => (
                                    <div key={field} className="flex flex-col gap-0.5">
                                        <p className="m-0 font-medium text-foreground">{recipeFieldLabel(field)}</p>
                                        <p className="m-0 break-words text-[var(--danger)] line-through">{String(change.from ?? "") || "—"}</p>
                                        <p className="m-0 break-words text-foreground">{String(change.to ?? "") || "—"}</p>
                                    </div>
                                ))}
                                {applyTarget.diff && recipeRenderParamSummary(applyTarget.diff.render_params).length > 0 && (
                                    <p className="m-0 text-[var(--muted-foreground)]">
                                        渲染参数:{recipeRenderParamSummary(applyTarget.diff.render_params).join(" · ")}
                                    </p>
                                )}
                                <label className="flex items-center gap-1.5 text-[var(--muted-foreground)]">
                                    <input
                                        type="checkbox"
                                        data-testid="recipe-apply-specs"
                                        checked={applySpecs}
                                        onChange={(e) => setApplySpecs(e.target.checked)}
                                    />
                                    同时把配方规格写入项目(width/height/fps/模型)(默认不动)
                                </label>
                                <div className="flex gap-1.5">
                                    <ToolButton size="xs" variant="default" icon={<PlayCircle />} label={applying ? "应用中…" : "确认应用并渲染"} loading={applying} onClick={() => void confirmApply()} />
                                    <ToolButton size="xs" variant="ghost" icon={<X />} label="取消" disabled={applying} onClick={() => setApplyTarget(null)} />
                                </div>
                            </div>
                        )}
                    </li>
                ))}
            </ul>
        </div>
    );
}
