/**
 * R18 门控模式设置(D-U1 拍板 2026-10-15)。
 * focus=r18 深链：滚动到本 pane 并打开既有 confirming 两步闸（失败卡不另起对话框）。
 */
import { useEffect, useRef, useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";
import { Link, useSearchParams } from "react-router";
import { isR18Mode, setR18Mode } from "@/services/toiv/r18-mode";
import { CLASSIC_NSFW_TO_MARKET } from "@/services/toiv/content-mode";

export function R18SettingsPane() {
    const [enabled, setEnabled] = useState<boolean>(() => isR18Mode());
    const [confirming, setConfirming] = useState(false);
    const [searchParams, setSearchParams] = useSearchParams();
    const paneRef = useRef<HTMLElement | null>(null);
    const focusParam = searchParams.get("focus");

    useEffect(() => {
        if (focusParam !== "r18") return;
        paneRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
        if (!isR18Mode()) setConfirming(true);
        const next = new URLSearchParams(searchParams);
        if (!next.has("focus")) return;
        next.delete("focus");
        setSearchParams(next, { replace: true });
        // eslint-disable-next-line react-hooks/exhaustive-deps -- only react to focus=r18 arrival
    }, [focusParam]);

    const enable = () => {
        setR18Mode(true);
        setEnabled(true);
        setConfirming(false);
    };
    const disable = () => {
        setR18Mode(false);
        setEnabled(false);
        setConfirming(false);
    };

    return (
        <section ref={paneRef} className="settings-section" data-testid="r18-settings-pane" id="r18-settings-pane">
            <div className="settings-r18-row">
                <div className="flex min-w-0 items-start gap-2">
                    {enabled ? (
                        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-[var(--workspace-accent,#c4a265)]" aria-hidden />
                    ) : (
                        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                    )}
                    <div className="min-w-0">
                        <h3>R18 模式</h3>
                        <p>{enabled ? "已开启 · 成人内容可见" : "关闭 · 仅 SFW（默认）"}</p>
                    </div>
                </div>
                {enabled ? (
                    <button
                        type="button"
                        onClick={disable}
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
                    >
                        关闭
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
                        data-testid="r18-settings-open"
                    >
                        开启
                    </button>
                )}
            </div>

            {confirming && (
                <div className="mt-2 rounded-lg border border-[var(--border)] p-3" role="alertdialog" aria-label="确认开启 R18 模式" data-testid="r18-settings-confirm">
                    <p className="text-xs leading-5 text-foreground">
                        确认开启？本机请求将进入 R18 上下文。未成年硬阻断不受影响。
                    </p>
                    <div className="mt-2 flex gap-2">
                        <button type="button" onClick={enable} className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground" data-testid="r18-settings-confirm-enable">
                            确认开启
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
                    <p className="mt-1">应用市场 →「R18」筛选，或孪生父卡切内容模式。</p>
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
