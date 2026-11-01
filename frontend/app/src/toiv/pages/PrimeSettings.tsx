import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from "react";
import Button from "../../components/ui/Button";
import { legacyDestination } from "../addons/LegacyHandoff";
import ToivShell from "../shell/ToivShell";
import AppearancePreview from "../theme/AppearancePreview";
import { containTab, focusFirst } from "../a11y/focus";
import {
    fetchToolCapabilities, refreshModelEndpoints,
    type EngineProbeResult, type ToolCapabilities,
} from "../adapters/capabilities";
import {
    LOCAL_PRICING, SETTINGS_SECTIONS, buildModelSheet, settingsIssueMarkers,
    type SettingsSectionId,
} from "../adapters/settings";
import {
    LAYOUT_PRESETS, MAX_THEME_NAME,
    applyAppearanceTo, createCustomTheme, deleteCustomTheme, editActiveToken, exportAppearance,
    importAppearance, readAppearance, renameCustomTheme, resetActiveTokens, resolveTheme,
    saveAppearance, selectTheme,
    type AppearanceState, type LayoutPreferences, type LayoutPreset,
} from "../theme/appearance";
import {
    THEMES, THEME_IDS, TOKEN_GROUPS, contrastRatio, formatColor, parseColor,
    type ColorTokenField, type ThemeTokenKey,
} from "../theme/tokens";

type CapabilityState =
    | { status: "loading"; data: null; error: "" }
    | { status: "ready"; data: ToolCapabilities; error: "" }
    | { status: "error"; data: null; error: string };

type ProbeState =
    | { status: "idle"; result: null; error: "" }
    | { status: "running"; result: null; error: "" }
    | { status: "done"; result: EngineProbeResult; error: "" }
    | { status: "error"; result: null; error: string };

const SECTION_ANCHORS: Record<SettingsSectionId, string> = {
    appearance: "settings-theme",
    colors: "settings-colors",
    layout: "settings-layout",
    models: "settings-models",
};

const DENSITY_OPTIONS = [
    { value: "compact", label: "紧凑" },
    { value: "regular", label: "标准" },
    { value: "relaxed", label: "舒展" },
] as const;
const RADIUS_OPTIONS = [
    { value: "square", label: "直角" },
    { value: "classic", label: "常规" },
    { value: "round", label: "圆润" },
] as const;
const NAV_OPTIONS = [
    { value: "compact", label: "紧凑" },
    { value: "standard", label: "标准" },
    { value: "relaxed", label: "舒展" },
] as const;
const WIDTH_OPTIONS = [
    { value: "focus", label: "聚焦" },
    { value: "standard", label: "标准" },
    { value: "wide", label: "宽屏" },
    { value: "full", label: "全宽" },
] as const;
const LINE_OPTIONS = [
    { value: "tight", label: "紧凑" },
    { value: "normal", label: "标准" },
    { value: "loose", label: "宽松" },
] as const;
const SCALE_OPTIONS = [
    { value: "sm", label: "90%" },
    { value: "md", label: "100%" },
    { value: "lg", label: "110%" },
] as const;
const MOTION_OPTIONS = [
    { value: "full", label: "完整" },
    { value: "reduced", label: "精简" },
    { value: "system", label: "跟随系统" },
] as const;

const LAYOUT_LABELS: Record<keyof LayoutPreferences, Record<string, string>> = {
    density: { compact: "紧凑", regular: "标准", relaxed: "舒展" },
    radius: { square: "直角", classic: "常规", round: "圆润" },
    navHeight: { compact: "紧凑", standard: "标准", relaxed: "舒展" },
    contentWidth: { focus: "聚焦", standard: "标准", wide: "宽屏", full: "全宽" },
    lineHeight: { tight: "紧凑", normal: "标准", loose: "宽松" },
    textScale: { sm: "90%", md: "100%", lg: "110%" },
    motion: { full: "完整", reduced: "精简", system: "跟随系统" },
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : "操作失败，请重试";
}

function layoutOfPreset(preset: LayoutPreset): LayoutPreferences {
    const { density, radius, navHeight, contentWidth, lineHeight, textScale, motion } = preset;
    return { density, radius, navHeight, contentWidth, lineHeight, textScale, motion };
}

function Segmented<T extends string>({ label, value, options, onChange }: {
    label: string;
    value: T;
    options: readonly { value: T; label: string }[];
    onChange: (value: T) => void;
}) {
    return (
        <div className="toiv-field">
            <span className="toiv-field-label">{label}</span>
            <div className="toiv-seg toiv-seg-wrap" role="radiogroup" aria-label={label}>
                {options.map((option) => {
                    const active = option.value === value;
                    return (
                        <button key={option.value} type="button" role="radio" aria-checked={active}
                            className={`toiv-seg-item${active ? " is-active" : ""}`}
                            onClick={() => onChange(option.value)}>{option.label}</button>
                    );
                })}
            </div>
        </div>
    );
}

function ColorField({ field, value, onChange }: {
    field: ColorTokenField;
    value: string;
    onChange: (key: ThemeTokenKey, value: string) => void;
}) {
    const parsed = parseColor(value) ?? { hex: "#000000", alpha: 1 };
    return (
        <div className="toiv-color-field">
            <label>
                <span>{field.label}</span>
                <input type="color" aria-label={field.label} value={parsed.hex}
                    onChange={(event) => onChange(field.key, formatColor(event.target.value, field.alpha ? parsed.alpha : 1))} />
                <code>{value}</code>
            </label>
            {field.alpha ? (
                <label className="toiv-alpha">
                    <span>不透明度 {Math.round(parsed.alpha * 100)}%</span>
                    <input type="range" aria-label={`${field.label}不透明度`} min={0} max={100}
                        value={Math.round(parsed.alpha * 100)}
                        onChange={(event) => onChange(field.key, formatColor(parsed.hex, Number(event.target.value) / 100))} />
                </label>
            ) : null}
        </div>
    );
}

export default function PrimeSettings() {
    const [state, setState] = useState<AppearanceState>(() => readAppearance());
    const [naming, setNaming] = useState(false);
    const [draftName, setDraftName] = useState("");
    const [pendingDelete, setPendingDelete] = useState<string | null>(null);
    const [notice, setNotice] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
    const fileInput = useRef<HTMLInputElement>(null);
    const [activeSection, setActiveSection] = useState<SettingsSectionId>("appearance");
    const [capabilityState, setCapabilityState] = useState<CapabilityState>({ status: "loading", data: null, error: "" });
    const [capabilityAttempt, setCapabilityAttempt] = useState(0);
    const [sheetOpen, setSheetOpen] = useState(false);
    const sheetRef = useRef<HTMLDivElement>(null);
    const sheetOpener = useRef<HTMLElement | null>(null);
    const [activeSlot, setActiveSlot] = useState("");
    const [probe, setProbe] = useState<ProbeState>({ status: "idle", result: null, error: "" });

    const resolved = useMemo(() => resolveTheme(state), [state]);
    const tokens = resolved.tokens;
    const ratio = contrastRatio(tokens["--text-secondary"], tokens["--pf-bg"]);
    const sheet = useMemo(() => buildModelSheet(capabilityState.data), [capabilityState.data]);
    const markers = settingsIssueMarkers(capabilityState.data, {
        contrastOk: ratio >= 4.5,
        modelsError: capabilityState.status === "error",
    });
    const activeGroup = sheet.groups.find((group) => group.id === activeSlot) ?? sheet.groups[0] ?? null;

    useEffect(() => {
        let alive = true;
        setCapabilityState({ status: "loading", data: null, error: "" });
        fetchToolCapabilities()
            .then((data) => { if (alive) setCapabilityState({ status: "ready", data, error: "" }); })
            .catch((cause) => { if (alive) setCapabilityState({ status: "error", data: null, error: errorText(cause) }); });
        return () => { alive = false; };
    }, [capabilityAttempt]);

    useEffect(() => {
        if (!sheetOpen) return;
        if (!sheetRef.current?.contains(document.activeElement)) focusFirst(sheetRef.current);
        const onKey = (event: KeyboardEvent) => {
            if (event.key === "Escape") {
                setSheetOpen(false);
                return;
            }
            containTab(event, sheetRef.current);
        };
        window.addEventListener("keydown", onKey);
        return () => {
            window.removeEventListener("keydown", onKey);
            const opener = sheetOpener.current;
            sheetOpener.current = null;
            if (opener?.isConnected) opener.focus();
        };
    }, [sheetOpen]);

    const openSheet = () => {
        sheetOpener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
        setProbe({ status: "idle", result: null, error: "" });
        setActiveSlot(sheet.groups[0]?.id ?? "");
        setSheetOpen(true);
    };

    const runProbe = async () => {
        setProbe({ status: "running", result: null, error: "" });
        try {
            setProbe({ status: "done", result: await refreshModelEndpoints(), error: "" });
        } catch (cause) {
            setProbe({ status: "error", result: null, error: errorText(cause) });
        }
    };

    const activeCustom = resolved.custom
        ? state.customThemes.find((theme) => theme.id === resolved.id) ?? null
        : null;
    const legacy = typeof window === "undefined" ? null : legacyDestination(
        import.meta.env?.VITE_LEGACY_BASE, "/settings", window.location.origin, import.meta.env?.BASE_URL || "/",
    );

    const commit = (next: AppearanceState) => {
        const saved = saveAppearance(next);
        setState(saved);
        if (typeof document !== "undefined") applyAppearanceTo(document.documentElement, saved);
    };

    const beginSave = () => {
        setDraftName(`${resolved.name} 副本`);
        setNaming(true);
        setNotice(null);
    };

    const submitSave = (event: FormEvent) => {
        event.preventDefault();
        try {
            const created = createCustomTheme(state, draftName);
            commit(created.state);
            setNaming(false);
            setNotice({ kind: "ok", text: `已保存「${created.theme.name}」` });
        } catch (error) {
            setNotice({ kind: "error", text: errorText(error) });
        }
    };

    const onImport = async (event: ChangeEvent<HTMLInputElement>) => {
        const file = event.target.files?.[0];
        event.target.value = "";
        if (!file) return;
        try {
            const result = importAppearance(await file.text(), state);
            commit(result.state);
            setNotice({
                kind: "ok",
                text: `已导入「${result.theme.name}」${result.appliedLayout ? "（含排版）" : ""}`,
            });
        } catch (error) {
            setNotice({ kind: "error", text: errorText(error) });
        }
    };

    const onExport = () => {
        const text = exportAppearance(state);
        const blob = new Blob([text], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement("a");
        anchor.href = url;
        anchor.download = `toiv-appearance-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
        setNotice({ kind: "ok", text: "已导出当前外观" });
    };

    const setLayout = (patch: Partial<LayoutPreferences>) => commit({
        ...state,
        layout: { ...state.layout, ...patch },
    });

    return (
        <ToivShell>
            <div className="toiv-settings">
                <header className="toiv-settings-head">
                    <h1>设置</h1>
                    <p className="toiv-settings-note">外观与排版保存在此浏览器；模型、渠道与账号仍由兼容工作台管理。</p>
                </header>

                {notice ? (
                    <p className={`toiv-notice${notice.kind === "error" ? " is-error" : ""}`}
                        role={notice.kind === "error" ? "alert" : "status"}>{notice.text}</p>
                ) : null}

                <div className="toiv-settings-body">
                    <nav className="toiv-settings-nav" aria-label="设置分区">
                        {SETTINGS_SECTIONS.map((section) => {
                            const count = markers[section.id];
                            return (
                                <a key={section.id} href={`#${SECTION_ANCHORS[section.id]}`}
                                    title={section.hint}
                                    className={activeSection === section.id ? "is-active" : undefined}
                                    aria-current={activeSection === section.id ? "true" : undefined}
                                    onClick={() => setActiveSection(section.id)}>
                                    <span>{section.label}</span>
                                    {count > 0 ? (
                                        <span className="toiv-nav-badge" aria-label={`${count} 个待处理问题`}>{count > 99 ? "99+" : count}</span>
                                    ) : null}
                                </a>
                            );
                        })}
                    </nav>
                    <div className="toiv-settings-main">
                        <section className="toiv-settings-section" aria-labelledby="settings-theme">
                            <div className="toiv-settings-section-head">
                                <h2 id="settings-theme">主题预设</h2>
                                <span className="meta">当前：{resolved.name}</span>
                            </div>
                            <div className="toiv-theme-grid" role="radiogroup" aria-label="主题">
                                {THEME_IDS.map((id) => {
                                    const theme = THEMES[id];
                                    const active = !resolved.custom && id === resolved.base;
                                    return (
                                        <button type="button" key={id} role="radio" aria-checked={active}
                                            className={`toiv-theme-card${active ? " is-active" : ""}`}
                                            onClick={() => commit(selectTheme(state, id))}>
                                            <span className="toiv-theme-swatch" aria-hidden="true">
                                                <i style={{ background: theme.tokens["--pf-bg"] }} />
                                                <i style={{ background: theme.tokens["--pf-card"] }} />
                                                <i style={{ background: theme.tokens["--pf-lime"] }} />
                                            </span>
                                            <b>{theme.name}</b>
                                            <small>{theme.description}</small>
                                        </button>
                                    );
                                })}
                            </div>
                        </section>

                        <section className="toiv-settings-section" aria-labelledby="settings-custom">
                            <div className="toiv-settings-section-head">
                                <h2 id="settings-custom">我的主题</h2>
                                <span className="meta">{state.customThemes.length} / 24</span>
                            </div>
                            {activeCustom ? (
                                <label className="toiv-name-field">
                                    <span>主题名称</span>
                                    <input key={activeCustom.id} defaultValue={activeCustom.name} maxLength={MAX_THEME_NAME}
                                        aria-label="主题名称"
                                        onBlur={(event) => {
                                            const value = event.target.value.trim();
                                            if (value && value !== activeCustom.name) {
                                                commit(renameCustomTheme(state, activeCustom.id, value));
                                            }
                                        }}
                                        onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }} />
                                </label>
                            ) : null}
                            {state.customThemes.length ? (
                                <div className="toiv-custom-list">
                                    {state.customThemes.map((theme) => {
                                        const base = THEMES[theme.base];
                                        const active = theme.id === state.activeTheme;
                                        return (
                                            <div className={`toiv-custom-theme${active ? " is-active" : ""}`} key={theme.id}>
                                                <button type="button" className="toiv-custom-pick" aria-pressed={active}
                                                    onClick={() => commit(selectTheme(state, theme.id))}>
                                                    <span className="toiv-theme-swatch" aria-hidden="true">
                                                        <i style={{ background: base.tokens["--pf-bg"] }} />
                                                        <i style={{ background: theme.tokens["--pf-card"] ?? base.tokens["--pf-card"] }} />
                                                        <i style={{ background: theme.tokens["--pf-lime"] ?? base.tokens["--pf-lime"] }} />
                                                    </span>
                                                    <b>{theme.name}</b>
                                                    <small>基于 {base.name}</small>
                                                </button>
                                                <div className="toiv-custom-actions">
                                                    {pendingDelete === theme.id ? (
                                                        <>
                                                            <Button variant="text" size="sm" onClick={() => {
                                                                commit(deleteCustomTheme(state, theme.id));
                                                                setPendingDelete(null);
                                                            }}>确认删除</Button>
                                                            <Button variant="text" size="sm" onClick={() => setPendingDelete(null)}>取消</Button>
                                                        </>
                                                    ) : (
                                                        <Button variant="text" size="sm" onClick={() => setPendingDelete(theme.id)}>删除</Button>
                                                    )}
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            ) : (
                                <p className="toiv-settings-note">把当前主题的颜色另存为命名主题，之后可随时切回。</p>
                            )}
                            <div className="toiv-custom-toolbar">
                                <Button variant="outline" size="sm" onClick={beginSave}>另存为我的主题</Button>
                                <Button variant="outline" size="sm" onClick={onExport}>导出当前外观</Button>
                                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>导入外观</Button>
                                <input ref={fileInput} type="file" accept="application/json,.json"
                                    className="toiv-visually-hidden" aria-label="导入外观文件" onChange={onImport} />
                            </div>
                            {naming ? (
                                <form className="toiv-save-form" onSubmit={submitSave}>
                                    <label>
                                        <span>新主题名称</span>
                                        <input autoFocus value={draftName} maxLength={MAX_THEME_NAME} aria-label="新主题名称"
                                            onChange={(event) => setDraftName(event.target.value)} />
                                    </label>
                                    <Button variant="lime" size="sm" type="submit">保存</Button>
                                    <Button variant="text" size="sm" type="button" onClick={() => setNaming(false)}>取消</Button>
                                </form>
                            ) : null}
                        </section>

                        <section className="toiv-settings-section" aria-labelledby="settings-colors">
                            <div className="toiv-settings-section-head">
                                <h2 id="settings-colors">颜色</h2>
                                <Button variant="text" size="sm" onClick={() => commit(resetActiveTokens(state))}>恢复当前主题默认</Button>
                            </div>
                            {TOKEN_GROUPS.map((group) => (
                                <fieldset className="toiv-token-group" key={group.id}>
                                    <legend>{group.label}</legend>
                                    <div className="toiv-color-grid">
                                        {group.tokens.map((field) => (
                                            <ColorField key={field.key} field={field} value={tokens[field.key]}
                                                onChange={(key, value) => commit(editActiveToken(state, key, value))} />
                                        ))}
                                    </div>
                                </fieldset>
                            ))}
                            {ratio >= 4.5
                                ? <p className="toiv-contrast" role="status">次要文字对比度 {ratio.toFixed(2)}:1 · AA 通过</p>
                                : <p className="toiv-contrast is-low" role="alert">次要文字对比度 {ratio.toFixed(2)}:1 · 低于 AA 4.5:1，请调整次要文字或背景</p>}
                        </section>

                        <section className="toiv-settings-section" aria-labelledby="settings-layout">
                            <div className="toiv-settings-section-head">
                                <h2 id="settings-layout">排版</h2>
                                <Button variant="text" size="sm" onClick={() => setLayout(layoutOfPreset(LAYOUT_PRESETS[1]))}>恢复默认排版</Button>
                            </div>
                            <div className="toiv-preset-row" role="group" aria-label="排版预设">
                                {LAYOUT_PRESETS.map((preset) => (
                                    <button type="button" key={preset.id} className="toiv-preset"
                                        onClick={() => commit({ ...state, layout: layoutOfPreset(preset) })}>
                                        <b>{preset.label}</b>
                                        <small>{preset.density === "compact" ? "更密的列表与更矮的顶栏" : preset.density === "relaxed" ? "更大的间距与圆角" : "当前默认节奏"}</small>
                                    </button>
                                ))}
                            </div>
                            <div className="toiv-layout-grid">
                                <Segmented label="密度" value={state.layout.density} options={DENSITY_OPTIONS}
                                    onChange={(density) => setLayout({ density })} />
                                <Segmented label="圆角" value={state.layout.radius} options={RADIUS_OPTIONS}
                                    onChange={(radius) => setLayout({ radius })} />
                                <Segmented label="导航高度" value={state.layout.navHeight} options={NAV_OPTIONS}
                                    onChange={(navHeight) => setLayout({ navHeight })} />
                                <Segmented label="内容宽度" value={state.layout.contentWidth} options={WIDTH_OPTIONS}
                                    onChange={(contentWidth) => setLayout({ contentWidth })} />
                                <Segmented label="行距" value={state.layout.lineHeight} options={LINE_OPTIONS}
                                    onChange={(lineHeight) => setLayout({ lineHeight })} />
                                <Segmented label="界面缩放" value={state.layout.textScale} options={SCALE_OPTIONS}
                                    onChange={(textScale) => setLayout({ textScale })} />
                                <Segmented label="动效" value={state.layout.motion} options={MOTION_OPTIONS}
                                    onChange={(motion) => setLayout({ motion })} />
                            </div>
                        </section>

                        <section className="toiv-settings-section" id="settings-models" aria-labelledby="settings-legacy">
                            <div className="toiv-settings-section-head">
                                <h2 id="settings-legacy">模型与渠道</h2>
                                <span className="meta">
                                    {capabilityState.status === "ready"
                                        ? `${sheet.available} / ${sheet.total} 槽位可用`
                                        : capabilityState.status === "error" ? "能力读取失败" : "读取中"}
                                </span>
                            </div>
                            <p className="toiv-settings-note">
                                生成能力只读自后端引擎注册表；新增模型、比例或时长档只改注册表一处，生成面板与设置页同时生效。
                            </p>
                            {capabilityState.status === "loading" ? (
                                <p className="toiv-settings-note" role="status">正在读取生成能力…</p>
                            ) : null}
                            {capabilityState.status === "error" ? (
                                <div className="toiv-capability-error">
                                    <p role="status">能力读取失败：{capabilityState.error}</p>
                                    <Button variant="outline" size="sm"
                                        onClick={() => setCapabilityAttempt((attempt) => attempt + 1)}>重试</Button>
                                </div>
                            ) : null}
                            {capabilityState.status === "ready" ? (
                                <div className="toiv-capability-card">
                                    <div className="toiv-capability-summary">
                                        <div><span className="meta">业务槽位</span><b>{sheet.available} / {sheet.total} 可用</b></div>
                                        <div><span className="meta">待处理问题</span><b>{sheet.issues}</b></div>
                                        <div><span className="meta">计费</span><b>{LOCAL_PRICING.label}</b></div>
                                    </div>
                                    <div className="toiv-capability-slots">
                                        {sheet.groups.map((group) => (
                                            <span key={group.id}
                                                className={`toiv-slot-chip${group.available ? "" : " is-off"}`}
                                                title={group.available ? group.coverage.join("、") : group.reason}>
                                                {group.label}
                                                <small>{group.available ? "可用" : "不可用"}</small>
                                            </span>
                                        ))}
                                    </div>
                                    <Button variant="outline" size="sm" onClick={openSheet}>打开模型能力</Button>
                                </div>
                            ) : null}
                            <p className="toiv-settings-note">旧版设置页保留模型、渠道与账号选项；切换完成后可在此打开。</p>
                            <Button variant="outline" disabled={!legacy}
                                onClick={() => { if (legacy) window.location.assign(legacy); }}>打开旧版设置</Button>
                        </section>
                    </div>

                    <aside className="toiv-settings-aside" aria-label="当前外观">
                        <AppearancePreview name={resolved.name} description={resolved.description} />
                        <div className="toiv-appearance-summary">
                            <span className="meta">当前外观</span>
                            <b>{resolved.name}</b>
                            <small>{resolved.custom ? resolved.description : "内置主题 · 可另存为自定义"}</small>
                            <div className="toiv-chips">
                                <span>密度 {LAYOUT_LABELS.density[state.layout.density]}</span>
                                <span>圆角 {LAYOUT_LABELS.radius[state.layout.radius]}</span>
                                <span>{LAYOUT_LABELS.contentWidth[state.layout.contentWidth]}</span>
                                <span>{LAYOUT_LABELS.textScale[state.layout.textScale]}</span>
                            </div>
                        </div>
                    </aside>
                </div>

                {sheetOpen ? (
                    <div className="toiv-sheet-backdrop"
                        onMouseDown={(event) => { if (event.target === event.currentTarget) setSheetOpen(false); }}>
                        <div ref={sheetRef} className="toiv-sheet" role="dialog" aria-modal="true" aria-labelledby="settings-sheet-title" tabIndex={-1}>
                            <header className="toiv-sheet-head">
                                <div>
                                    <span className="meta">模型能力 · 只读</span>
                                    <h2 id="settings-sheet-title">模型能力</h2>
                                </div>
                                <Button variant="text" size="sm" autoFocus onClick={() => setSheetOpen(false)}>关闭</Button>
                            </header>
                            <div className="toiv-sheet-tabs" role="tablist" aria-label="业务槽位">
                                {sheet.groups.map((group) => (
                                    <button key={group.id} type="button" role="tab"
                                        aria-selected={group.id === activeGroup?.id}
                                        className={group.id === activeGroup?.id ? "is-active" : undefined}
                                        onClick={() => setActiveSlot(group.id)}>
                                        {group.label}
                                        <i className={`toiv-slot-dot${group.available ? " is-on" : " is-off"}`} aria-hidden="true" />
                                    </button>
                                ))}
                            </div>
                            {activeGroup ? (
                                <div className="toiv-sheet-body" role="tabpanel" aria-label={activeGroup.label}>
                                    <div className="toiv-sheet-price">
                                        <span className="meta">价格</span>
                                        <b>{activeGroup.price}</b>
                                        <small>{activeGroup.priceNote}</small>
                                    </div>
                                    <div className="toiv-sheet-block">
                                        <span className="meta">能力覆盖</span>
                                        <div className="toiv-chips">
                                            {activeGroup.coverage.map((item) => <span key={item}>{item}</span>)}
                                        </div>
                                    </div>
                                    {!activeGroup.available ? (
                                        <div className="toiv-sheet-block is-impact">
                                            <span className="meta">未配置影响</span>
                                            <div className="toiv-chips">
                                                {activeGroup.impact.map((item) => <span key={item}>{item}</span>)}
                                            </div>
                                            <p>{activeGroup.reason}</p>
                                        </div>
                                    ) : null}
                                    {activeGroup.issues.length ? (
                                        <ul className="toiv-sheet-issues">
                                            {activeGroup.issues.map((issue) => (
                                                <li key={issue.id}><b>{issue.title}</b><span>{issue.reason}</span></li>
                                            ))}
                                        </ul>
                                    ) : null}
                                    <div className="toiv-sheet-engines">
                                        {activeGroup.engines.map((engine) => (
                                            <article className="toiv-sheet-engine" key={engine.id}>
                                                <header>
                                                    <b>{engine.label}</b>
                                                    <span className={`toiv-engine-state${engine.available ? " is-on" : " is-off"}`}>
                                                        {engine.available ? "可用" : "不可用"}
                                                    </span>
                                                </header>
                                                <p className="meta">
                                                    {engine.kind || "引擎"}{engine.nsfw ? " · NSFW" : ""}
                                                    {engine.route ? ` · ${engine.route}` : ""}
                                                </p>
                                                {engine.reason ? <p className="toiv-sheet-reason">{engine.reason}</p> : null}
                                                {engine.params.length ? (
                                                    <dl className="toiv-sheet-params">
                                                        {engine.params.map((param) => (
                                                            <div key={param.key}>
                                                                <dt>{param.label}</dt>
                                                                <dd>{param.summary}</dd>
                                                            </div>
                                                        ))}
                                                    </dl>
                                                ) : null}
                                                {engine.durations.length ? (
                                                    <div className="toiv-sheet-block">
                                                        <span className="meta">时长档</span>
                                                        <div className="toiv-chips">
                                                            {engine.durations.map((duration) => <span key={duration}>{duration}</span>)}
                                                        </div>
                                                    </div>
                                                ) : null}
                                            </article>
                                        ))}
                                        {!activeGroup.engines.length ? (
                                            <p className="toiv-settings-note">该槽位暂无已注册引擎。</p>
                                        ) : null}
                                    </div>
                                    <div className="toiv-sheet-probe">
                                        <Button variant="outline" size="sm"
                                            disabled={probe.status === "running"} onClick={runProbe}>
                                            {probe.status === "running" ? "探测中…" : "测试端点"}
                                        </Button>
                                        {probe.status === "done" ? (
                                            <p className="toiv-probe-result" role="status">
                                                已探测 {probe.result.count} 个引擎 · {probe.result.availableCount} 个可用
                                            </p>
                                        ) : null}
                                        {probe.status === "error" ? (
                                            <p className="toiv-probe-result is-error" role="alert">{probe.error}</p>
                                        ) : null}
                                    </div>
                                    {probe.status === "done" && probe.result.engines.some((engine) => !engine.available) ? (
                                        <ul className="toiv-sheet-issues">
                                            {probe.result.engines.filter((engine) => !engine.available).map((engine) => (
                                                <li key={engine.id}><b>{engine.label}</b><span>{engine.reason || "不可用"}</span></li>
                                            ))}
                                        </ul>
                                    ) : null}
                                </div>
                            ) : (
                                <p className="toiv-settings-note">暂无可展示的业务槽位。</p>
                            )}
                        </div>
                    </div>
                ) : null}
            </div>
        </ToivShell>
    );
}
