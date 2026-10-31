/** W5 · PoseBrowser — browse-only surface (market tools + library poses track). */
import { PoseGallerySurface } from "@/components/pose/pose-gallery-surface";

export type PoseBrowserProps = {
    className?: string;
    title?: string;
    meta?: string;
    enableLightbox?: boolean;
};

export function PoseBrowser({
    className,
    title = "姿势参考",
    meta = "只读浏览 · 可开大图",
    enableLightbox = true,
}: PoseBrowserProps) {
    return (
        <PoseGallerySurface
            mode="browse"
            className={className}
            title={title}
            meta={meta}
            enableLightbox={enableLightbox}
        />
    );
}
