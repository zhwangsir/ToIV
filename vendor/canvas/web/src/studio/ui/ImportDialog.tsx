import { useState } from "react";
import type { ToivRecipeExport } from "@/services/toiv/client";
import { Button } from "./Button";
import { RECIPE_SCHEMA, parseRecipeImport } from "../faces/pipeline/recipes-model";

export function ImportDialog({ open, onClose, onInstall }: {
    open: boolean;
    onClose: () => void;
    onInstall: (payload: ToivRecipeExport) => void;
}) {
    const [text, setText] = useState("");
    if (!open) return null;
    const parsed = text.trim() ? parseRecipeImport(text) : null;
    const error = parsed && "error" in parsed ? parsed.error : null;
    return (
        <div className="stv-scrim" onClick={onClose} onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}>
            <div className="stv-dialog" role="dialog" aria-modal="true" aria-label="安装配方" onClick={(event) => event.stopPropagation()}>
                <header>
                    <b>安装配方</b><span className="meta">{RECIPE_SCHEMA}</span>
                    <button type="button" className="stv-drawer-x" onClick={onClose} aria-label="关闭安装配方">×</button>
                </header>
                <p className="stv-dialog-hint">粘贴从别的机器导出的配方 JSON。格式不符一律拒绝，不落半成品。</p>
                <textarea aria-label="配方 JSON" rows={10} value={text} onChange={(event) => setText(event.target.value)} />
                {error ? <p className="stv-dialog-error" role="alert">{error}</p> : null}
                <footer>
                    <Button variant="quiet" onClick={onClose}>取消</Button>
                    <Button variant="primary" disabled={!parsed || Boolean(error)}
                        onClick={() => {
                            if (!parsed || "error" in parsed) return;
                            onInstall(parsed.payload);
                            setText("");
                        }}>安装</Button>
                </footer>
            </div>
        </div>
    );
}
