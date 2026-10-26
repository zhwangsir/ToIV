/**
 * 普通/成人内容模式设置（死令 2026-10-26 · A 光幕收束）。
 * 主切换：顶栏右 LightCurtainPaddle（R2）；本页仅状态说明 + focus=r18 确认闸；拒绝设置页主开关。
 * 真源：GET/PATCH /api/me/mode（ordinary|adult）。
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import {
    COPY_ACCOUNT_GLOBAL,
    COPY_ACCOUNT_SYNC_HINT,
    COPY_CONFIRM_SWITCH,
    COPY_IN_FLIGHT_SAFE,
    COPY_MODE_ADULT,
    COPY_MODE_NORMAL,
    getR18ModeSnapshot,
    getServerR18ModeSnapshot,
    isUnderage,
    setR18Mode,
    subscribeR18Mode,
} from "@/redline";
import { CLASSIC_NSFW_TO_MARKET } from "@/services/toiv/content-mode";
import { ContentModeFallbackTip } from "@/components/toiv/content-mode-fallback-tip";

export function R18SettingsPane() {
    const enabled = useSyncExternalStore(subscribeR18Mode, getR18ModeSnapshot, getServerR18ModeSnapshot);
    const [confirming, setConfirming] = useState(false);
    const [searchParams, setSearchParams] = useSearchParams();
    const paneRef = useRef<HTMLElement | null>(null);
    const focusParam = searchParams.get("focus");

    useEffect(() => {
        if (focusParam !== "r18") return;
        paneRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (!enabled) setConfirming(true);
        const next = new URLSearchParams(searchParams);
        if (!next.has("focus")) return;
        next.delete("focus");
        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to focus=r18 arrival
    }, [focusParam]);

    const enable = () => {
        if (isUnderage()) {
            setConfirming(false);
            return;
        }
        setR18Mode(true);
        setConfirming(false);
    };

    return (
        <section ref={paneRef} className="settings-section" data-testid="r18-settings-pane" id="r18-settings-pane">
            <div className="settings-r18-row">
                <div className="flex min-w-0 items-start gap-2">
                    {enabled ? (
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--cm-adult,#8b7cff)]" aria-hidden />
                    ) : (
                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-[var(--cm-primary,#00bdcf)]" aria-hidden />
                    )}
                    <div className="min-w-0">
                        <h3>内容模式</h3>
                        <p>
                            当前：{enabled ? COPY_MODE_ADULT : COPY_MODE_NORMAL}
                            <span className="mx-1 text-foreground/30">·</span>
                            <span className="text-foreground/70">{COPY_ACCOUNT_GLOBAL}</span>
                        </p>
                    </div>
                </div>
                <span
                    className="inline-flex items-center gap-1 rounded-full border border-[var(--border)] px-2.5 py-1 text-[11px] font-semibold text-[var(--muted-foreground)]"
                    data-testid="r18-settings-status"
                    aria-label={`内容模式：${enabled ? COPY_MODE_ADULT : COPY_MODE_NORMAL}`}
                >
                    {enabled ? COPY_MODE_ADULT : COPY_MODE_NORMAL}
                </span>
            </div>

            <p className="mt-2 text-[11px] leading-5 text-[var(--muted-foreground)]" data-testid="r18-account-global-hint">
                主切换在<strong className="text-foreground/80">侧栏脚光幕芯片（深浅色旁）</strong>
                （普通 / 成人，图标+纹理双通道）。本页不提供开关。
                {COPY_ACCOUNT_GLOBAL}。{COPY_ACCOUNT_SYNC_HINT}。{COPY_IN_FLIGHT_SAFE}。
                深链 <code className="text-[10px]">?focus=r18</code> 仍可打开下方确认闸（失败卡跳转兼容）。
            </p>

            <ContentModeFallbackTip />

            {confirming && (
                <div className="mt-2 rounded-lg border border-[var(--border)] p-3" role="alertdialog" aria-label="确认切换到成人模式" data-testid="r18-settings-confirm">
                    <p className="text-xs leading-5 text-foreground">{COPY_CONFIRM_SWITCH}</p>
                    <p className="mt-1 text-[11px] text-[var(--muted-foreground)]">{COPY_ACCOUNT_GLOBAL} · {COPY_ACCOUNT_SYNC_HINT}</p>
                    <div className="mt-2 flex gap-2">
                        <button type="button" onClick={enable} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" data-testid="r18-settings-confirm-enable">
                            确认切换
                        </button>
                        <button type="button" onClick={() => setConfirming(false)} className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-foreground">
                            取消
                        </button>
                    </div>
                </div>
            )}

            {enabled && (
                <div className="mt-2 rounded-lg border border-[var(--border)] px-3 py-2.5 text-xs leading-5 text-[var(--muted-foreground)]">
                    <p className="font-medium text-foreground">入口</p>
                    <p className="mt-1">应用市场 →「成人」筛选。切回普通后 NSFW 项灰化锁标「NSFW」。</p>
                    <p className="mt-2 flex flex-wrap gap-2">
                        <Link to="/toiv/market" className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-foreground hover:bg-muted/50">
                            应用市场
                        </Link>
                        {CLASSIC_NSFW_TO_MARKET.filter((x) => x.via === "is_nsfw_app")
                            .slice(0, 3)
                            .map((x) => (
                                <Link
                                    key={x.marketAppId}
                                    to={`/toiv/market?app=${encodeURIComponent(x.marketAppId)}`}
                                    className="rounded-lg border border-[var(--border)] px-2.5 py-1 text-foreground hover:bg-muted/50"
                                >
                                    {x.marketAppId}
                                </Link>
                            ))}
                    </p>
                </div>
            )}
        </section>
    );
}
