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

export function RecipePanelPrime({ shotId, onNotice }: { shotId?: string; onNotice: (text: string, warn?: boolean) => void }) {
    const [recipes, setRecipes] = useState<PrimeRecipeCard[]>([]);
    const [name, setName] = useState("");
    const [importOpen, setImportOpen] = useState(false);
    useEffect(() => {
        let alive = true;
        loadPrimeRecipes().then((cards) => { if (alive) setRecipes(cards); }).catch(() => { if (alive) onNotice("配方列表加载失败 · 创作不受影响", true); });
        return () => { alive = false; };
    }, [onNotice]);
    const save = async () => {
        if (!shotId) return;
        try {
            const card = await savePrimeRecipeFromShot(shotId, name.trim() || "镜01 配方");
            setRecipes((prev) => [card, ...prev]);
            onNotice(`已存为配方 · ${card.name}`);
        } catch {
            onNotice("存配方失败 · 镜头需已有采用候选", true);
        }
    };
    const exportOne = async (recipeId: string) => {
        try {
            const bundle = await exportPrimeRecipeBundle(recipeId);
            download(bundle.fileName, bundle.text);
            onNotice(`配方已导出 · ${bundle.fileName}`);
        } catch {
            onNotice("导出失败", true);
        }
    };
    const apply = async (recipeId: string) => {
        if (!shotId) return;
        try {
            const fields = await applyPrimeRecipeToShot(recipeId, shotId);
            onNotice(`已复用配方 · 写入 ${fields.join(" / ") || "无字段变化"}`);
        } catch {
            onNotice("复用失败 · 修订号冲突或镜头不存在", true);
        }
    };
    return (
        <div className="toiv-recipes">
            <label className="toiv-recipe-name">配方名
                <input value={name} placeholder="镜01 配方" onChange={(event) => setName(event.target.value)} />
            </label>
            <div className="toiv-recipebar">
                <Button variant="lime" disabled={!shotId} onClick={() => { void save(); }}>从本镜存配方</Button>
                <Button variant="ghost" onClick={() => setImportOpen(true)}>安装配方 JSON</Button>
            </div>
            {recipes.length === 0 ? <div className="toiv-empty"><p>还没有配方。存一个满意的镜头，或安装别处导出的 JSON。</p></div> : null}
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
                            <Button variant="ghost" size="sm" onClick={() => { void exportOne(recipe.id); }}>导出</Button>
                            <Button variant="lime" size="sm" disabled={!shotId} onClick={() => { void apply(recipe.id); }}>复用到本镜</Button>
                        </span>
                    </footer>
                </article>
            ))}
            <PrimeImportDialog open={importOpen} onClose={() => setImportOpen(false)}
                onInstall={async (payload) => {
                    const card = await installPrimeRecipe(payload);
                    setRecipes(prev => [card, ...prev]);
                    onNotice(`配方已安装 · ${card.name}`);
                }} />
        </div>
    );
}
