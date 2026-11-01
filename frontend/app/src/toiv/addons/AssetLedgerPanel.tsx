import { useEffect, useRef, useState } from "react";
import Button from "../../components/ui/Button";
import {
    applyPrimeLedgerAction, loadPrimeAssetLedger,
    type PrimeAssetLedger, type PrimeLedgerAction, type PrimeLedgerAssetStatus,
    type PrimeLedgerSuggestion,
} from "../adapters/assetLedger";

const STATUS_LABEL: Record<PrimeLedgerAssetStatus, string> = {
    synced: "已同步", outdated: "待归并", local_only: "仅本集", missing_reference: "缺定妆",
};
const ACTION_LABEL: Record<PrimeLedgerAction, string> = {
    merge: "归并进正典", import: "写回项目卡", create: "新建正典",
};
const ACTION_CTA: Record<PrimeLedgerAction, string> = { merge: "归并", import: "写回", create: "新建" };
const DRIFT_LABEL: Record<string, string> = {
    ASSET_MULTI_VERSION: "同角色多版本",
    ASSET_LOCAL_ONLY: "正典缺失",
    ASSET_MISSING_REFERENCE: "缺定妆",
    SHOT_REF_EPOCH_SWITCH: "参考版本切换",
    SHOT_MEDIA_STALE: "媒体过期",
};

const assetLabel = (key: string) => {
    const index = key.indexOf(":");
    return (index >= 0 ? key.slice(index + 1) : key) || "资产";
};
const nameKey = (value: string) => value.trim().split(/\s+/).join(" ").toLowerCase();
const receiptId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
const errorText = (error: unknown) => error instanceof Error ? error.message : "请求失败，请重试";

export default function AssetLedgerPanel({ projectId, onJumpToShot }: {
    projectId: string;
    onJumpToShot: (projectId: string, shotId: string) => void;
}) {
    const [ledger, setLedger] = useState<PrimeAssetLedger | null>(null);
    const [loading, setLoading] = useState(true);
    const [failed, setFailed] = useState("");
    const [notice, setNotice] = useState("");
    const [busy, setBusy] = useState(false);
    const alive = useRef(true);
    const seq = useRef(0);
    const busyRef = useRef(false);

    async function reload(silent = false) {
        const token = ++seq.current;
        if (!silent) { setLoading(true); setFailed(""); }
        try {
            const next = await loadPrimeAssetLedger(projectId);
            if (!alive.current || token !== seq.current) return;
            setLedger(next);
            if (!silent) setFailed("");
        } catch (error) {
            if (!alive.current || token !== seq.current) return;
            setFailed(errorText(error));
        } finally {
            if (alive.current && token === seq.current) setLoading(false);
        }
    }

    useEffect(() => {
        alive.current = true;
        void reload();
        return () => { alive.current = false; seq.current += 1; };
    }, [projectId]);

    async function applyOne(suggestion: PrimeLedgerSuggestion, fixedReceipt?: string) {
        if (busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setNotice("");
        setFailed("");
        try {
            const result = await applyPrimeLedgerAction(projectId, {
                receiptId: fixedReceipt ?? receiptId("ledger"),
                action: suggestion.action, assetKey: suggestion.assetKey, entityId: suggestion.entityId,
            });
            setNotice(result.replayed
                ? `回执已存在，未重复写入：${assetLabel(suggestion.assetKey)}`
                : `已应用：${assetLabel(suggestion.assetKey)} · ${ACTION_LABEL[suggestion.action]}`);
            await reload(true);
        } catch (error) {
            setFailed(errorText(error));
            await reload(true);
        } finally {
            busyRef.current = false;
            setBusy(false);
        }
    }

    async function applyAll() {
        if (!ledger || ledger.suggestions.length === 0 || busyRef.current) return;
        busyRef.current = true;
        setBusy(true);
        setNotice("");
        setFailed("");
        const batch = receiptId("bulk");
        let applied = 0;
        let replayed = 0;
        try {
            for (const suggestion of ledger.suggestions) {
                const result = await applyPrimeLedgerAction(projectId, {
                    receiptId: `${batch}:${suggestion.assetKey}:${suggestion.action}`,
                    action: suggestion.action, assetKey: suggestion.assetKey, entityId: suggestion.entityId,
                });
                if (result.replayed) replayed += 1;
                else applied += 1;
            }
            setNotice(`已确认 ${applied} 条建议${replayed ? `，${replayed} 条为幂等重放` : ""}。`);
        } catch (error) {
            setNotice(applied ? `已应用 ${applied} 条，后续建议失败。` : "");
            setFailed(errorText(error));
        } finally {
            await reload(true);
            busyRef.current = false;
            setBusy(false);
        }
    }

    const statusByName = new Map<string, PrimeLedgerAssetStatus>(
        (ledger?.assets ?? []).filter(asset => asset.kind === "character")
            .map(asset => [nameKey(asset.name), asset.status] as const),
    );
    const counts = ledger ? {
        episodes: ledger.episodes.length,
        characters: ledger.assets.filter(asset => asset.kind === "character").length,
        drifts: ledger.drifts.length,
        suggestions: ledger.suggestions.length,
    } : null;

    return (
        <section className="toiv-ledger" aria-label="跨集资产对账" aria-busy={loading || busy}>
            <header className="toiv-ledger-head">
                <div>
                    <h3>跨集资产对账</h3>
                    <p className="meta">
                        {counts
                            ? `${counts.episodes} 集 · ${counts.characters} 个角色资产 · ${counts.drifts} 个漂移点 · ${counts.suggestions} 条建议`
                            : loading ? "正在汇总各集资产…" : "尚未取到对账数据"}
                    </p>
                    <p className="meta">建议基于同名与参考图差异确定性命中；应用只补空槽位，不覆盖后来编辑。</p>
                </div>
                <div className="toiv-ledger-toolbar">
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => void reload()}>刷新</Button>
                    <Button size="sm" variant="lime" disabled={busy || !ledger?.suggestions.length}
                        title={!ledger?.suggestions.length ? "没有待应用建议" : undefined}
                        onClick={() => void applyAll()}>
                        {busy ? "应用…" : `全部确认${ledger?.suggestions.length ? `（${ledger.suggestions.length}）` : ""}`}
                    </Button>
                </div>
            </header>

            {failed ? (
                <div className="toiv-ledger-error" role="alert">
                    <span>{failed}</span>
                    <Button size="sm" variant="outline" onClick={() => void reload()}>重新载入</Button>
                </div>
            ) : null}
            {notice ? <p className="toiv-ledger-notice" role="status">{notice}</p> : null}
            {loading && !ledger ? <p className="meta" role="status">正在汇总跨集资产…</p> : null}

            {ledger ? (
                <>
                    <section aria-label="逐集资产">
                        <h4>逐集资产 <span className="meta">{ledger.episodes.length} 集</span></h4>
                        {ledger.episodes.length === 0 ? <p className="meta">还没有可对账的剧集。</p> : (
                            <div className="toiv-ledger-episodes">
                                {ledger.episodes.map(episode => (
                                    <article key={episode.projectId}
                                        className={`toiv-ledger-episode${episode.isCurrent ? " is-current" : ""}`}>
                                        <header>
                                            <b>{episode.title || "未命名剧集"}</b>
                                            {episode.isCurrent ? <span className="src">当前</span> : null}
                                            <span className="meta">{episode.characters.length} 角色</span>
                                        </header>
                                        {episode.characters.length === 0 ? <p className="meta">还没有角色卡。</p> : (
                                            <ul>
                                                {episode.characters.map(character => {
                                                    const status = statusByName.get(nameKey(character.name));
                                                    return (
                                                        <li key={character.id || character.name}>
                                                            <span>{character.name}</span>
                                                            {status ? <span className={`toiv-ledger-status is-${status}`}>{STATUS_LABEL[status]}</span> : null}
                                                            <span className="meta">{character.refCount} 张参考</span>
                                                        </li>
                                                    );
                                                })}
                                            </ul>
                                        )}
                                    </article>
                                ))}
                            </div>
                        )}
                    </section>

                    <section aria-label="资产漂移">
                        <h4>漂移点 <span className="meta">{ledger.drifts.length}</span></h4>
                        {ledger.drifts.length === 0 ? <p className="meta">未发现漂移，各集参考与正典一致。</p> : (
                            <ul className="toiv-ledger-drifts">
                                {ledger.drifts.map((drift, index) => (
                                    <li key={`${drift.code}-${drift.shotId ?? index}`}>
                                        <span className={`toiv-ledger-sev is-${drift.severity}`}>
                                            {drift.severity === "info" ? "提示" : "待处理"}
                                        </span>
                                        <div>
                                            <b>{DRIFT_LABEL[drift.code] ?? drift.code}</b>
                                            <p>{drift.message}</p>
                                            {drift.assetKey ? <span className="meta">{drift.assetKey}</span> : null}
                                        </div>
                                        {drift.shotId ? (
                                            <Button size="sm" variant="outline"
                                                onClick={() => onJumpToShot(drift.projectId || projectId, drift.shotId!)}>
                                                查看镜头
                                            </Button>
                                        ) : null}
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    <section aria-label="对账建议">
                        <h4>建议 <span className="meta">{ledger.suggestions.length}</span></h4>
                        {ledger.suggestions.length === 0 ? <p className="meta">没有待应用建议。</p> : (
                            <ul className="toiv-ledger-suggestions">
                                {ledger.suggestions.map(suggestion => (
                                    <li key={`${suggestion.assetKey}:${suggestion.action}`}>
                                        <div>
                                            <b>{assetLabel(suggestion.assetKey)}</b>{" "}
                                            <span className="toiv-ledger-action">{ACTION_LABEL[suggestion.action]}</span>{" "}
                                            <span className="meta">置信度 {Math.round(suggestion.confidence * 100)}%</span>
                                            <p>{suggestion.reason}</p>
                                        </div>
                                        <Button size="sm" variant="lime" disabled={busy}
                                            title={busy ? "正在应用其他建议" : undefined}
                                            onClick={() => void applyOne(suggestion)}>
                                            {ACTION_CTA[suggestion.action]}
                                        </Button>
                                    </li>
                                ))}
                            </ul>
                        )}
                    </section>

                    {ledger.receipts.length ? (
                        <section aria-label="对账回执">
                            <h4>已应用 <span className="meta">{ledger.receipts.length}</span></h4>
                            <ul className="toiv-ledger-receipts">
                                {ledger.receipts.map(receipt => (
                                    <li key={receipt.receiptId}>
                                        <b>{assetLabel(receipt.assetKey)}</b>
                                        <span className="meta">{ACTION_LABEL[receipt.action as PrimeLedgerAction] ?? receipt.action} · 回执 {receipt.receiptId}</span>
                                    </li>
                                ))}
                            </ul>
                        </section>
                    ) : null}
                </>
            ) : null}
        </section>
    );
}
