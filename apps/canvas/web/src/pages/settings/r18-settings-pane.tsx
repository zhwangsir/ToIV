/**
 * R18 门控模式设置(D-U1 拍板 2026-10-15)。
 *
 * 两步确认门:开关 → 显式确认(说明本地上下文语义)。开启后 toivHttp 全请求
 * 附加 X-NSFW:1(见 services/toiv/r18-mode.ts 与 client.ts 拦截器),
 * 后端 nsfw_ctx 按请求放行 R18 模型/应用/作品;未成年硬阻断在后端,不可绕过。
 */
import { useState } from "react";
import { ShieldAlert, ShieldCheck } from "lucide-react";

import { isR18Mode, setR18Mode } from "@/services/toiv/r18-mode";

export function R18SettingsPane() {
    const [enabled, setEnabled] = useState<boolean>(() => isR18Mode());
    const [confirming, setConfirming] = useState(false);

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
        <section className="settings-section" data-testid="r18-settings-pane">
            <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                    {enabled
                        ? <ShieldAlert className="size-4 text-[var(--workspace-accent,#c4a265)]" aria-hidden />
                        : <ShieldCheck className="size-4 text-muted-foreground" aria-hidden />}
                    <div>
                        <h3 className="text-sm font-medium text-foreground">R18 上下文模式</h3>
                        <p className="text-xs text-muted-foreground">
                            {enabled
                                ? "已开启:全部请求附带 X-NSFW 上下文,R18 模型/应用/作品可见"
                                : "关闭:仅可见 SFW 内容(默认)"}
                        </p>
                    </div>
                </div>
                {enabled ? (
                    <button
                        type="button"
                        onClick={disable}
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
                    >
                        关闭 R18 模式
                    </button>
                ) : (
                    <button
                        type="button"
                        onClick={() => setConfirming(true)}
                        className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-foreground transition-colors hover:bg-muted/50"
                    >
                        开启 R18 模式
                    </button>
                )}
            </div>
            {confirming && (
                <div className="mt-3 rounded-lg border border-[var(--border)] p-3" role="alertdialog" aria-label="确认开启 R18 模式">
                    <p className="text-xs leading-5 text-foreground">
                        确认开启?开启后本机全部请求将进入 R18 上下文(成人内容可见)。
                        仅限本地自用环境;后端未成年硬阻断不受本开关影响。
                    </p>
                    <div className="mt-2 flex gap-2">
                        <button
                            type="button"
                            onClick={enable}
                            className="rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
                        >
                            确认开启
                        </button>
                        <button
                            type="button"
                            onClick={() => setConfirming(false)}
                            className="rounded-lg border border-[var(--border)] px-3 py-1.5 text-xs text-foreground"
                        >
                            取消
                        </button>
                    </div>
                </div>
            )}
        </section>
    );
}
