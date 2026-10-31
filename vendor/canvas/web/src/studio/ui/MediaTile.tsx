import type { StudioStatus } from "./StatusDot";

export type MediaTileProps = {
    label: string;
    src?: string;
    status: StudioStatus;
    progress?: number;
    badge?: string;
    locked?: boolean;
    selected?: boolean;
    onSelect?: () => void;
    onPreview?: () => void;
    onReplace?: () => void;
    onDownload?: () => void;
};

export function MediaTile({ label, src, status, progress, badge, locked, selected, onSelect, onPreview, onReplace, onDownload }: MediaTileProps) {
    const badgeText = badge ?? (status === "run" ? `${progress ?? 0}%` : "");
    return (
        <div className="stv-view" role="button" tabIndex={0} aria-pressed={Boolean(selected)}
            onClick={onSelect} onKeyDown={(event) => { if (event.key === "Enter" && onSelect) onSelect(); }}>
            <div className="t">{label}{locked ? <span className="lock" title="视图锁">⌗</span> : null}</div>
            <div className="stv-still" style={src ? { backgroundImage: `url(${src})` } : undefined}>
                {status !== "wait" && badgeText ? <span className="badge">{badgeText}</span> : null}
                {status === "run" ? <span className="prog"><i style={{ width: `${progress ?? 0}%` }} /></span> : null}
            </div>
            <div className="acts">
                <button type="button" onClick={(event) => { event.stopPropagation(); onPreview?.(); }}>预览</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); onReplace?.(); }}>替换</button>
                <button type="button" onClick={(event) => { event.stopPropagation(); onDownload?.(); }}>下载</button>
            </div>
        </div>
    );
}
