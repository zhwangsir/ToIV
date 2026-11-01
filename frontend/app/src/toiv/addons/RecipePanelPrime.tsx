import { useEffect, useRef, useState } from "react";
import Button from "../../components/ui/Button";
import Modal from "../../components/ui/Modal";
import {
    applyPrimeRecipeToShot,
    exportPrimeRecipeBundle,
    installPrimeRecipe,
    loadPrimeRecipes,
    parsePrimeRecipeImport,
    savePrimeRecipeFromShot,
    PRIME_RECIPE_SCHEMA,
    type PrimeRecipeCard,
} from "../adapters/recipes";

function download(fileName: string, text: string) {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = fileName;
    anchor.click();
    URL.revokeObjectURL(url);
}

export function PrimeImportDialog({ open, onClose, onInstall }: {
    open: boolean;
    onClose: () => void;
    onInstall: (payload: unknown) => Promise<void>;
}) {
    const [text, setText] = useState("");
    const [pending, setPending] = useState(false);
    const [failure, setFailure] = useState("");
    const submitting = useRef(false);
    const input = useRef<HTMLTextAreaElement>(null);
    useEffect(() => {
        if (!open) return;
        const previous = document.activeElement as HTMLElement | null;
        const panel = input.current?.closest<HTMLElement>('[role="dialog"]');
        input.current?.focus();
        const trap = (event: KeyboardEvent) => {
            if (event.key !== "Tab" || !panel) return;
            const controls = [...panel.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
            const first = controls[0];
            const last = controls.at(-1);
            if (!first) { event.preventDefault(); panel.tabIndex = -1; panel.focus(); return; }
            if (!panel.contains(document.activeElement) || (!event.shiftKey && document.activeElement === last)) {
                event.preventDefault(); first.focus();
            } else if (event.shiftKey && document.activeElement === first) {
                event.preventDefault(); last?.focus();
            }
        };
        document.addEventListener("keydown", trap);
        return () => { document.removeEventListener("keydown", trap); if (previous?.isConnected) previous.focus(); };
    }, [open]);
    const parsed = text.trim() ? parsePrimeRecipeImport(text) : null;
    const error = parsed && "error" in parsed ? parsed.error : null;
    const install = async () => {
        if (submitting.current || !parsed || "error" in parsed) return;
        submitting.current = true;
        setPending(true);
        setFailure("");
        try {
            await onInstall(parsed.payload);
            setText("");
            onClose();
        } catch {
            setFailure("安装失败，已保留配方内容，请重试。");
        } finally { submitting.current = false; setPending(false); }
    };
    return (
        <Modal open={open} onClose={onClose} dismissible={!pending} title="安装配方" footer={<>
            <Button variant="ghost" disabled={pending} onClick={onClose}>取消</Button>
            <Button variant="lime" disabled={pending || !parsed || Boolean(error)} onClick={() => { void install(); }}>{pending ? "正在安装…" : "安装"}</Button>
        </>}>
            <p className="pf-muted">粘贴导出的配方 JSON · {PRIME_RECIPE_SCHEMA}</p>
            <textarea ref={input} className="pf-input" aria-label="配方 JSON" rows={10} value={text} disabled={pending} onChange={event => { setText(event.target.value); setFailure(""); }} />
            {error || failure ? <p role="alert">{error || failure}</p> : null}
        </Modal>
    );
}

export function RecipePanelPrime({ shotId, shotRevisionId, onNotice, onApplied }: {
    shotId?: string;
    shotRevisionId?: string;
    onNotice: (text: string, warn?: boolean) => void;
    onApplied?: () => void;
}) {
    const [recipes, setRecipes] = useState<PrimeRecipeCard[]>([]);
    const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
    const [attempt, setAttempt] = useState(0);
    const [name, setName] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    const [saving, setSaving] = useState(false);
    const [exporting, setExporting] = useState("");
    const [applying, setApplying] = useState("");
    const [revision, setRevision] = useState(shotRevisionId ?? "");
    const noticeRef = useRef(onNotice);
    const busyRef = useRef({ save: false, export: "", apply: "" });
    noticeRef.current = onNotice;
    useEffect(() => {
        let alive = true;
        setPhase("loading");
        loadPrimeRecipes().then((cards) => {
            if (alive) { setRecipes(cards); setPhase("ready"); }
        }).catch(() => {
            if (alive) setPhase("error");
        });
        return () => { alive = false; };
    }, [attempt]);
    useEffect(() => { setRevision(shotRevisionId ?? ""); }, [shotId, shotRevisionId]);
    const save = async () => {
        if (!shotId || busyRef.current.save) return;
        busyRef.current.save = true;
        setSaving(true);
        try {
            const card = await savePrimeRecipeFromShot(shotId, name.trim() || "镜01 配方");
            setRecipes((prev) => [card, ...prev]);
            noticeRef.current(`已存为配方 · ${card.name}`);
        } catch {
            noticeRef.current("存配方失败 · 镜头需已有采用候选", true);
        } finally { busyRef.current.save = false; setSaving(false); }
    };
    const exportOne = async (recipeId: string) => {
        if (busyRef.current.export) return;
        busyRef.current.export = recipeId;
        setExporting(recipeId);
        try {
            const bundle = await exportPrimeRecipeBundle(recipeId);
            download(bundle.fileName, bundle.text);
            noticeRef.current(`配方已导出 · ${bundle.fileName}`);
        } catch {
            noticeRef.current("导出失败", true);
        } finally { busyRef.current.export = ""; setExporting(""); }
    };
    const apply = async (recipeId: string) => {
        if (!shotId || busyRef.current.apply) return;
        busyRef.current.apply = recipeId;
        setApplying(recipeId);
        try {
            const result = await applyPrimeRecipeToShot(recipeId, shotId, revision || undefined);
            if (result.revisionId) setRevision(result.revisionId);
            noticeRef.current(`已复用配方 · 写入 ${result.fields.join(" / ") || "无字段变化"}`);
            onApplied?.();
        } catch (error) {
            const conflict = error instanceof Error && error.message.includes("409");
            noticeRef.current(conflict
                ? "复用失败 · 分镜已被其他修改更新，请刷新分镜后重试"
                : `复用失败 · ${error instanceof Error ? error.message : "请求失败"}`, true);
        } finally { busyRef.current.apply = ""; setApplying(""); }
    };
    return (
        <div className="toiv-recipes">
            <label className="toiv-recipe-name">配方名
                <input value={name} placeholder="镜01 配方" onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="toiv-recipebar">
                <Button variant="lime" disabled={!shotId || saving} onClick={() => { void save(); }}>
                    {saving ? "正在保存…" : "从本镜存配方"}
                </Button>
                <Button variant="ghost" onClick={() => setImportOpen(true)}>安装配方 JSON</Button>
            </div>
            {phase === "loading" ? <p className="meta" role="status">正在载入配方…</p> : null}
            {phase === "error" ? (
                <div className="toiv-empty" role="alert">
                    <p>配方列表载入失败 · 创作不受影响</p>
                    <Button variant="outline" size="sm" onClick={() => setAttempt(value => value + 1)}>重试载入配方</Button>
                </div>
            ) : null}
            {phase === "ready" && recipes.length === 0 ? <div className="toiv-empty"><p>还没有配方。存一个满意的镜头，或安装别处导出的 JSON。</p></div> : null}
            {recipes.map((recipe) => (
                <article className="toiv-recipe" key={recipe.id}>
                    <header>
                        <b>{recipe.name}</b>
                        {recipe.isDefault ? <span className="tag">默认</span> : null}
                        <span className="meta">{recipe.meta}</span>
                    </header>
                    {recipe.description ? <p className="desc">{recipe.description}</p> : null}
                    <footer>
                        <span className="sub">更新 {recipe.updatedOn}</span>
                        <span className="acts">
                            <Button variant="ghost" size="sm" disabled={Boolean(exporting)}
                                onClick={() => { void exportOne(recipe.id); }}>
                                {exporting === recipe.id ? "导出中…" : "导出"}
                            </Button>
                            <Button variant="lime" size="sm" disabled={!shotId || Boolean(applying)}
                                onClick={() => { void apply(recipe.id); }}>
                                {applying === recipe.id ? "复用中…" : "复用到本镜"}
                            </Button>
                        </span>
                    </footer>
                </article>
            ))}
            <PrimeImportDialog open={importOpen} onClose={() => setImportOpen(false)}
                onInstall={async (payload) => {
                    const card = await installPrimeRecipe(payload);
                    setRecipes(prev => [card, ...prev]);
                    noticeRef.current(`配方已安装 · ${card.name}`);
                }} />
        </div>
    );
}
