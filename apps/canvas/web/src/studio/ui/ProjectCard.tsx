import type { ProjectCardModel } from "../faces/canvas/model";

const STILLS = ["fog", "tent", "camp", "lant"];

export function ProjectCard({ card, onOpen }: { card: ProjectCardModel; onOpen: (id: string) => void }) {
    return (
        <button type="button" className="pcard" aria-label={`打开项目 ${card.title}`} onClick={() => onOpen(card.id)}>
            <div className={`stv-still ${STILLS[card.stillSeed % STILLS.length]}`} />
            <div className="pcard-body">
                <b>{card.title}</b>
                <span className="meta">{card.status} · {card.shotCount} 镜</span>
            </div>
        </button>
    );
}
