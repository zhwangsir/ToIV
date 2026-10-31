import type { ReactNode } from "react";

import { cn } from "@/lib/utils";

/** 资产库卡片外壳 — R6 Freezone surface/border/radius（拒廉价灰块）。 */
export function AssetLibraryCard({ children, className, selected = false }: { children: ReactNode; className?: string; selected?: boolean }) {
    return (
        <article
            className={cn(
                "product-collection-card library-card library-card-surface asset-library-card toiv-asset-library-card group",
                selected && "is-selected",
                className,
            )}
        >
            {children}
        </article>
    );
}

export function AssetLibraryCardMedia({ children, className }: { children: ReactNode; className?: string }) {
    return <div className={cn("library-card-media toiv-asset-library-media", className)}>{children}</div>;
}
