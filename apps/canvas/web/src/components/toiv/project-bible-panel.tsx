/**
 * P0-4 ProjectBible 前端最小面。
 * - 列表 GET /api/project-bibles
 * - 读冻结/历史必须显式 version（拒绝 latest / 静默 latest）
 * - 展示 characters / locations / style_prefix / version
 * - 诚实空态；不加 NSFW 闸
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import {
    characterLabel,
    getProjectBibleVersion,
    getProjectBibleWorking,
    listProjectBibleVersions,
    listProjectBibles,
    locationLabel,
    type ProjectBibleDocument,
    type ProjectBibleListItem,
    type ProjectBibleVersionMeta,
} from "@/services/toiv/project-bibles";

import "@/components/toiv/project-bible-panel.css";

type LoadState = "idle" | "loading" | "ready" | "empty" | "error" | "api_only";

function errMessage(err: unknown): string {
    if (!err) return "未知错误";
    if (typeof err === "string") return err;
    const ax = err as {
        message?: string;
        response?: { status?: number; data?: { detail?: { code?: string; message?: string } | string } };
    };
    const detail = ax.response?.data?.detail;
    if (detail && typeof detail === "object") {
        return `${detail.code || "error"}${detail.message ? `: ${detail.message}` : ""}`;
    }
    if (typeof detail === "string" && detail) return detail;
    if (ax.response?.status === 401 || ax.response?.status === 403) {
        return "需要登录才能读取 ProjectBible（API-only 内存仓仍可用，本面只读）。";
    }
    return ax.message || "加载失败";
}

function pickDefaultVersion(
    item: ProjectBibleListItem | null,
    versions: ProjectBibleVersionMeta[],
): string {
    if (!item) return "";
    const frozen = versions.find((v) => v.status === "frozen" || Boolean(v.frozen_at));
    if (frozen?.version) return frozen.version;
    if (item.status === "frozen" && item.current_version) return item.current_version;
    // 展示用 latest_version 不可静默当读参数；仅作候选提示
    return item.current_version || "";
}

export function ProjectBiblePanel({
    variant = "rail",
    className,
}: {
    variant?: "rail" | "page";
    className?: string;
}) {
    const [items, setItems] = useState<ProjectBibleListItem[]>([]);
    const [bibleId, setBibleId] = useState("");
    const [versions, setVersions] = useState<ProjectBibleVersionMeta[]>([]);
    const [version, setVersion] = useState("");
    const [doc, setDoc] = useState<ProjectBibleDocument | null>(null);
    const [kind, setKind] = useState<"version" | "working_copy" | null>(null);
    const [status, setStatus] = useState<string>("");
    const [load, setLoad] = useState<LoadState>("idle");
    const [error, setError] = useState<string | null>(null);

    const selected = useMemo(
        () => items.find((it) => it.id === bibleId) || null,
        [items, bibleId],
    );

    const refreshList = useCallback(async () => {
        setLoad("loading");
        setError(null);
        try {
            const list = await listProjectBibles();
            setItems(list);
            if (list.length === 0) {
                setBibleId("");
                setVersions([]);
                setVersion("");
                setDoc(null);
                setKind(null);
                setStatus("");
                setLoad("empty");
                return;
            }
            const nextId = list.some((x) => x.id === bibleId) ? bibleId : list[0].id;
            setBibleId(nextId);
            setLoad("ready");
        } catch (err) {
            setItems([]);
            setDoc(null);
            setLoad("api_only");
            setError(errMessage(err));
        }
    }, [bibleId]);

    useEffect(() => {
        void refreshList();
        // eslint-disable-next-line react-hooks/exhaustive-deps -- mount once
    }, []);

    useEffect(() => {
        if (!bibleId) return;
        let cancelled = false;
        (async () => {
            setError(null);
            try {
                const vr = await listProjectBibleVersions(bibleId);
                if (cancelled) return;
                const vers = Array.isArray(vr.versions) ? vr.versions : [];
                setVersions(vers);
                const item = items.find((x) => x.id === bibleId) || null;
                const def = pickDefaultVersion(
                    item
                        ? {
                              ...item,
                              current_version: vr.current_version || item.current_version,
                              latest_version: vr.latest_version || item.latest_version,
                          }
                        : {
                              id: bibleId,
                              title: bibleId,
                              status: "",
                              current_version: vr.current_version,
                              latest_version: vr.latest_version,
                          },
                    vers,
                );
                setVersion((prev) => (prev && vers.some((v) => v.version === prev) ? prev : def));
            } catch (err) {
                if (cancelled) return;
                setVersions([]);
                setError(errMessage(err));
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [bibleId, items]);

    const loadPinnedVersion = useCallback(async () => {
        if (!bibleId) return;
        if (!version.trim()) {
            setError("读历史必须显式选择 version（禁止 latest / 空 version）");
            return;
        }
        if (version.trim().toLowerCase() === "latest") {
            setError("version=latest 禁止；请钉死不可变版本号");
            return;
        }
        setLoad("loading");
        setError(null);
        try {
            const res = await getProjectBibleVersion(bibleId, version);
            setDoc(res.document || null);
            setKind(res.kind);
            setStatus(String(res.status || res.document?.status || selected?.status || ""));
            setLoad("ready");
        } catch (err) {
            setDoc(null);
            setKind(null);
            setLoad("error");
            setError(errMessage(err));
        }
    }, [bibleId, version, selected?.status]);

    const loadWorkingCopy = useCallback(async () => {
        if (!bibleId) return;
        setLoad("loading");
        setError(null);
        try {
            const res = await getProjectBibleWorking(bibleId);
            setDoc(res.document || null);
            setKind("working_copy");
            setStatus(String(res.bible?.status || res.document?.status || ""));
            // 工作副本不是历史；version 选择框仍保留，避免用户误以为已钉历史
            setLoad("ready");
        } catch (err) {
            setDoc(null);
            setKind(null);
            setLoad("error");
            setError(errMessage(err));
        }
    }, [bibleId]);

    useEffect(() => {
        if (!bibleId || !version) return;
        void loadPinnedVersion();
    }, [bibleId, version, loadPinnedVersion]);

    const characters = Array.isArray(doc?.characters) ? doc!.characters! : [];
    const locations = Array.isArray(doc?.locations) ? doc!.locations! : [];
    const stylePrefix = String(doc?.style_prefix || "").trim();
    const shownVersion = String(doc?.version || version || selected?.current_version || "—");
    const isFrozen =
        status === "frozen" ||
        Boolean(doc?.frozen_at) ||
        versions.some((v) => v.version === version && (v.status === "frozen" || Boolean(v.frozen_at)));

    return (
        <section
            className={"toiv-bible-panel" + (className ? ` ${className}` : "")}
            data-testid="project-bible-panel"
            data-variant={variant}
            data-load={load}
            aria-label="Project Bible"
        >
            <header className="toiv-bible-panel-head">
                <h2 className="toiv-bible-panel-title">设定圣经</h2>
                <p className="toiv-bible-panel-meta">
                    {kind === "version" ? "钉版只读" : kind === "working_copy" ? "工作副本" : "API 只读"}
                    {shownVersion !== "—" ? ` · v ${shownVersion}` : ""}
                </p>
            </header>

            {load === "empty" ? (
                <p className="toiv-bible-empty" data-testid="project-bible-empty">
                    <strong>尚无 ProjectBible。</strong>
                    {" "}当前为 API-only 内存仓：需后端 ingest / freeze 后才会出现在列表。本面不加 NSFW 闸，也不伪造示例数据。
                </p>
            ) : null}

            {load === "api_only" ? (
                <p className="toiv-bible-empty" data-testid="project-bible-api-only">
                    <strong>Bible 面已挂载，但列表不可达。</strong>
                    {" "}{error || "请确认已登录且 /api/project-bibles 可用。"} 前端未内置演示 Bible。
                </p>
            ) : null}

            {load !== "empty" && load !== "api_only" ? (
                <div className={variant === "page" ? "toiv-bible-grid" : undefined}>
                    <div className="toiv-bible-controls">
                        <div className="toiv-bible-field">
                            <label htmlFor="toiv-bible-select">Bible</label>
                            <select
                                id="toiv-bible-select"
                                value={bibleId}
                                onChange={(e) => {
                                    setDoc(null);
                                    setVersion("");
                                    setBibleId(e.target.value);
                                }}
                                disabled={items.length === 0}
                                data-testid="project-bible-select"
                            >
                                {items.length === 0 ? <option value="">（空）</option> : null}
                                {items.map((it) => (
                                    <option key={it.id} value={it.id}>
                                        {it.title || it.id} · {it.status} · {it.current_version}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="toiv-bible-field">
                            <label htmlFor="toiv-bible-version">Version（读历史必选）</label>
                            <select
                                id="toiv-bible-version"
                                value={version}
                                onChange={(e) => setVersion(e.target.value)}
                                disabled={!bibleId || versions.length === 0}
                                data-testid="project-bible-version"
                            >
                                {versions.length === 0 ? <option value="">无版本快照</option> : null}
                                {versions.map((v) => (
                                    <option key={v.version} value={v.version}>
                                        {v.version}
                                        {v.status ? ` · ${v.status}` : ""}
                                        {v.frozen_at ? " · frozen" : ""}
                                    </option>
                                ))}
                            </select>
                        </div>

                        <div className="toiv-bible-actions">
                            <button
                                type="button"
                                className="toiv-bible-btn is-primary"
                                onClick={() => void loadPinnedVersion()}
                                disabled={!bibleId || !version}
                                data-testid="project-bible-load-version"
                            >
                                读钉版
                            </button>
                            <button
                                type="button"
                                className="toiv-bible-btn"
                                onClick={() => void loadWorkingCopy()}
                                disabled={!bibleId}
                                data-testid="project-bible-load-working"
                            >
                                工作副本
                            </button>
                            <button
                                type="button"
                                className="toiv-bible-btn"
                                onClick={() => void refreshList()}
                                data-testid="project-bible-refresh"
                            >
                                刷新列表
                            </button>
                        </div>

                        <div className="toiv-bible-actions" aria-label="状态">
                            <span className={"toiv-bible-badge" + (isFrozen ? " is-frozen" : " is-draft")}>
                                {isFrozen ? "FROZEN" : status || selected?.status || "UNKNOWN"}
                            </span>
                            <span className="toiv-bible-badge">v {shownVersion}</span>
                        </div>
                    </div>

                    <div>
                        {error && load !== "api_only" ? (
                            <p className="toiv-bible-error" role="alert" data-testid="project-bible-error">
                                {error}
                            </p>
                        ) : null}

                        {doc ? (
                            <>
                                <section className="toiv-bible-section" aria-labelledby="toiv-bible-style">
                                    <h3 id="toiv-bible-style">style_prefix</h3>
                                    {stylePrefix ? (
                                        <p className="toiv-bible-style" data-testid="project-bible-style">
                                            {stylePrefix}
                                        </p>
                                    ) : (
                                        <p className="toiv-bible-empty">无 style_prefix</p>
                                    )}
                                </section>

                                <section className="toiv-bible-section" aria-labelledby="toiv-bible-chars">
                                    <h3 id="toiv-bible-chars">characters · {characters.length}</h3>
                                    {characters.length === 0 ? (
                                        <p className="toiv-bible-empty">无角色条目</p>
                                    ) : (
                                        <ul className="toiv-bible-list" data-testid="project-bible-characters">
                                            {characters.map((c, idx) => (
                                                <li key={String(c.id || idx)}>
                                                    <strong>{characterLabel(c)}</strong>
                                                    <em>
                                                        {[c.id, c.name_en, c.ethnicity_note]
                                                            .filter(Boolean)
                                                            .map(String)
                                                            .join(" · ") || "—"}
                                                    </em>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </section>

                                <section className="toiv-bible-section" aria-labelledby="toiv-bible-locs">
                                    <h3 id="toiv-bible-locs">locations · {locations.length}</h3>
                                    {locations.length === 0 ? (
                                        <p className="toiv-bible-empty">无地点条目</p>
                                    ) : (
                                        <ul className="toiv-bible-list" data-testid="project-bible-locations">
                                            {locations.map((loc, idx) => (
                                                <li key={String(loc.id || idx)}>
                                                    <strong>{locationLabel(loc)}</strong>
                                                    <em>
                                                        {[loc.color_temp, Array.isArray(loc.keywords) ? loc.keywords.join(", ") : ""]
                                                            .filter(Boolean)
                                                            .join(" · ") || "—"}
                                                    </em>
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                </section>
                            </>
                        ) : load === "loading" ? (
                            <p className="toiv-bible-empty">加载中…</p>
                        ) : load === "ready" && !error ? (
                            <p className="toiv-bible-empty">选择显式 version 后读取钉版。</p>
                        ) : null}
                    </div>
                </div>
            ) : null}
        </section>
    );
}

export default ProjectBiblePanel;
