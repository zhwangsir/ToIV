import type { ProjectCardModel } from "../faces/canvas/model";
import { ProjectCard } from "./ProjectCard";
import { Button } from "./Button";

export function ProjectGrid({ cards, onOpen, onCreate }: { cards: ProjectCardModel[]; onOpen: (id: string) => void; onCreate: () => void }) {
    if (cards.length === 0) {
        return (
            <div className="stv-empty">
                <p>还没有项目。从一段剧本或一张参考图开始。</p>
                <Button variant="primary" onClick={onCreate}>新建项目</Button>
            </div>
        );
    }
    return (
        <div className="pgrid">
            {cards.map((card) => <ProjectCard key={card.id} card={card} onOpen={onOpen} />)}
        </div>
    );
}
