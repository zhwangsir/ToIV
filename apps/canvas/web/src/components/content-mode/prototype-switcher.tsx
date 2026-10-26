import { useSyncExternalStore } from "react";

import { cn } from "@/lib/utils";
import {
    PROTOTYPE_META,
    getContentModePrototypeSnapshot,
    getServerContentModePrototypeSnapshot,
    setContentModePrototype,
    subscribeContentModePrototype,
    type ContentModePrototypeId,
} from "@/lib/content-mode-prototype";

const ORDER: ContentModePrototypeId[] = ["a", "b", "c"];

export function ContentModePrototypeSwitcher({
    collapsed,
    block,
    className,
}: {
    collapsed?: boolean;
    block?: boolean;
    className?: string;
}) {
    const active = useSyncExternalStore(
        subscribeContentModePrototype,
        getContentModePrototypeSnapshot,
        getServerContentModePrototypeSnapshot,
    );

    return (
        <div
            className={cn("cm-proto-switch", collapsed && "is-collapsed", block && "is-block", className)}
            role="group"
            aria-label="内容模式控件原型"
            data-testid="content-mode-prototype-switcher"
        >
            {ORDER.map((id) => {
                const meta = PROTOTYPE_META[id];
                return (
                    <button
                        key={id}
                        type="button"
                        className={cn("cm-proto-opt", active === id && "is-active")}
                        aria-pressed={active === id}
                        title={`${meta.label}（${meta.placement}）`}
                        data-testid={`content-mode-proto-${id}`}
                        onClick={() => setContentModePrototype(id)}
                    >
                        {collapsed ? id.toUpperCase() : meta.short}
                    </button>
                );
            })}
        </div>
    );
}
