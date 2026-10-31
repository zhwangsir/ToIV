import { useMemo, useState } from "react";
import Button from "../../components/ui/Button";
import { legacyDestination } from "../addons/LegacyHandoff";
import ToivShell from "../shell/ToivShell";
import {
    applyThemeState, readThemeState, resolveTokens, saveThemeState,
    type ThemeOverrideMap, type ThemeState,
} from "../theme/apply";
import {
    EDITABLE_TOKENS, THEMES, THEME_IDS, contrastRatio,
    type ThemeId, type ThemeTokenKey,
} from "../theme/tokens";

function colorInputValue(value: string) {
    return /^#[0-9a-f]{6}$/i.test(value) ? value : "#000000";
}

export default function PrimeSettings() {
    const [state, setState] = useState<ThemeState>(() => readThemeState());
    const tokens = useMemo(() => resolveTokens(state.theme, state.overrides), [state]);
    const ratio = contrastRatio(tokens["--text-secondary"], tokens["--pf-bg"]);
    const legacy = typeof window === "undefined" ? null : legacyDestination(
        import.meta.env?.VITE_LEGACY_BASE, "/settings", window.location.origin, import.meta.env?.BASE_URL || "/",
    );

    const commit = (next: ThemeState) => {
        const saved = saveThemeState(next.theme, next.overrides);
        setState(saved);
        applyThemeState(saved.theme, saved.overrides);
    };
    const selectTheme = (theme: ThemeId) => commit({ theme, overrides: state.overrides });
    const editToken = (key: ThemeTokenKey, value: string) => commit({
        theme: state.theme,
        overrides: { ...state.overrides, [state.theme]: { ...(state.overrides[state.theme] ?? {}), [key]: value } },
    });
    const resetTheme = () => {
        const overrides: ThemeOverrideMap = { ...state.overrides };
        delete overrides[state.theme];
        commit({ theme: state.theme, overrides });
    };

    return (
        <ToivShell>
            <div className="toiv-settings">
                <header className="toiv-settings-head">
                    <h1>设置</h1>
                    <p className="toiv-settings-note">外观保存在此浏览器；模型、渠道与账号仍由兼容工作台管理。</p>
                </header>

                <section className="toiv-settings-section" aria-labelledby="settings-theme">
                    <div className="toiv-settings-section-head">
                        <h2 id="settings-theme">主题</h2>
                        <span className="meta">当前：{THEMES[state.theme].name}</span>
                    </div>
                    <div className="toiv-theme-grid" role="radiogroup" aria-label="主题">
                        {THEME_IDS.map((id) => {
                            const theme = THEMES[id];
                            const active = id === state.theme;
                            return (
                                <button type="button" key={id} role="radio" aria-checked={active}
                                    className={`toiv-theme-card${active ? " is-active" : ""}`} onClick={() => selectTheme(id)}>
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

                <section className="toiv-settings-section" aria-labelledby="settings-colors">
                    <div className="toiv-settings-section-head">
                        <h2 id="settings-colors">自定义颜色</h2>
                        <Button variant="text" size="sm" onClick={resetTheme}>恢复当前主题默认</Button>
                    </div>
                    <div className="toiv-color-grid">
                        {EDITABLE_TOKENS.map(({ key, label }) => (
                            <label className="toiv-color-field" key={key}>
                                <span>{label}</span>
                                <input type="color" aria-label={label} value={colorInputValue(tokens[key])}
                                    onChange={(event) => editToken(key, event.target.value)} />
                                <code>{tokens[key]}</code>
                            </label>
                        ))}
                    </div>
                    {ratio >= 4.5
                        ? <p className="toiv-contrast" role="status">次要文字对比度 {ratio.toFixed(2)}:1 · AA 通过</p>
                        : <p className="toiv-contrast is-low" role="alert">次要文字对比度 {ratio.toFixed(2)}:1 · 低于 AA 4.5:1，请调整次要文字或背景</p>}
                </section>

                <section className="toiv-settings-section" aria-labelledby="settings-legacy">
                    <div className="toiv-settings-section-head">
                        <h2 id="settings-legacy">模型与渠道</h2>
                    </div>
                    <p className="toiv-settings-note">旧版设置页保留模型、渠道与账号选项；切换完成后可在此打开。</p>
                    <Button variant="outline" disabled={!legacy}
                        onClick={() => { if (legacy) window.location.assign(legacy); }}>打开旧版设置</Button>
                </section>
            </div>
        </ToivShell>
    );
}
