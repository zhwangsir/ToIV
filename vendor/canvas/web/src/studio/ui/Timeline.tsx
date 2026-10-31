import type { EditClip } from "../faces/edit/model";

const TRACKS: { key: EditClip["track"]; label: string }[] = [
    { key: "v1", label: "V1" },
    { key: "a1", label: "A1" },
    { key: "a2", label: "A2" },
];

function pct(value: number, total: number) {
    return total > 0 ? `${((value / total) * 100).toFixed(2).replace(/\.00$/, "")}%` : "0%";
}

export function Timeline({ clips, totalSec, playheadSec, activeClipId, onClipPick }: {
    clips: EditClip[];
    totalSec: number;
    playheadSec: number;
    activeClipId?: string;
    onClipPick: (id: string) => void;
}) {
    const marks = Array.from({ length: Math.max(1, Math.ceil(totalSec / 10)) }, (_, index) => index * 10);
    return (
        <div className="seq">
            <header><b>Sequence</b><span className="meta">{totalSec.toFixed(1)}s</span></header>
            <div className="ruler">{marks.map((mark) => <span key={mark}>{`0:${String(mark).padStart(2, "0")}`}</span>)}</div>
            {TRACKS.map((track) => (
                <div className="track" key={track.key}>
                    <span className="lbl">{track.label}</span>
                    <div className="lane" data-track={track.key}>
                        {clips.filter((clip) => clip.track === track.key).map((clip) => (
                            <button key={clip.id} type="button" className={`clip ${clip.kind === "video" ? "v" : "a"}`}
                                style={{ left: pct(clip.startSec, totalSec), width: pct(clip.durationSec, totalSec) }}
                                aria-pressed={clip.id === activeClipId} onClick={() => onClipPick(clip.id)}>
                                {clip.label}
                            </button>
                        ))}
                        <span className="playhead" style={{ left: pct(playheadSec, totalSec) }} aria-hidden="true" />
                    </div>
                </div>
            ))}
        </div>
    );
}
