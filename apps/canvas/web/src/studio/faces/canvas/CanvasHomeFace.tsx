import { useState } from "react";
import { ProjectGrid } from "@/studio/ui/ProjectGrid";
import { Button } from "@/studio/ui/Button";
import type { CanvasHomeModel } from "./model";

export function CanvasHomeFace({ model, onOpen, onCreate }: { model: CanvasHomeModel; onOpen: (id: string) => void; onCreate: () => void }) {
    const [query, setQuery] = useState("");
    const cards = query.trim() ? model.cards.filter((card) => card.title.includes(query.trim())) : model.cards;
    return (
        <div className="stv-main" style={{ paddingTop: 4 }}>
            <div className="stv-bar">
                <h2>项目</h2><span className="meta">{cards.length} 个项目</span>
                <span className="right">
                    <input className="stv-search" aria-label="搜索项目" placeholder="搜索项目…" value={query} onChange={(event) => setQuery(event.target.value)} />
                    <Button variant="primary" onClick={onCreate}>新建项目</Button>
                </span>
            </div>
            <ProjectGrid cards={cards} onOpen={onOpen} onCreate={onCreate} />
        </div>
    );
}
