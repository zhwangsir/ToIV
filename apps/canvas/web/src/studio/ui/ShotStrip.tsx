import type { EditShot } from "../faces/edit/model";

const STILLS = ["fog", "tent", "camp", "lant"];

export function ShotStrip({ shots, activeId, onPick }: { shots: EditShot[]; activeId?: string; onPick: (id: string) => void }) {
    return (
        <div className="shotstrip" aria-label="镜头条">
            {shots.map((shot, index) => (
                <button key={shot.id} type="button" className="shot" aria-pressed={shot.id === activeId} onClick={() => onPick(shot.id)}>
                    <div className={`th still ${STILLS[index % STILLS.length]}`} />
                    <span className="n">{shot.title.replace("镜", "")}</span>
                    <div className="d">{shot.durationSec > 0 ? `${shot.durationSec}s` : "—"}</div>
                </button>
            ))}
        </div>
    );
}
