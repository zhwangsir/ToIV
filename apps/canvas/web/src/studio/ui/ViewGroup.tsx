import { MediaTile, type MediaTileProps } from "./MediaTile";
import { STATUS_LABEL, type StudioStatus } from "./StatusDot";

export type ViewGroupScene = { id: string; name: string; slug: string };
export type ViewGroupView = MediaTileProps & { id: string };

export function groupStatus(views: { status: StudioStatus; progress?: number }[]): { status: StudioStatus; text: string } {
    const running = views.find((view) => view.status === "run");
    if (running) return { status: "run", text: `渲染中 ${running.progress ?? 0}%` };
    const done = views.filter((view) => view.status === "done").length;
    if (done === views.length && done > 0) return { status: "done", text: `${done}/${views.length} ${STATUS_LABEL.done}` };
    return { status: done > 0 ? "run" : "wait", text: `${done}/${views.length} ${STATUS_LABEL.done}` };
}

export function ViewGroup({ scene, views, selectedViewId, onViewSelect, onPreview, onReplace, onDownload }: {
    scene: ViewGroupScene;
    views: ViewGroupView[];
    selectedViewId?: string;
    onViewSelect: (sceneId: string, viewId: string) => void;
    onPreview: (sceneId: string, viewId: string) => void;
    onReplace: (sceneId: string, viewId: string) => void;
    onDownload: (sceneId: string, viewId: string) => void;
}) {
    const head = groupStatus(views);
    return (
        <section className="stv-scene">
            <header>
                <b>{scene.name}</b><span className="slug">{scene.slug}</span>
                <span className={`status stv-status-${head.status}`}><i />{head.text}</span>
            </header>
            <div className="stv-views">
                {views.map((view) => (
                    <MediaTile key={view.id} {...view} selected={view.id === selectedViewId}
                        onSelect={() => onViewSelect(scene.id, view.id)}
                        onPreview={() => onPreview(scene.id, view.id)}
                        onReplace={() => onReplace(scene.id, view.id)}
                        onDownload={() => onDownload(scene.id, view.id)} />
                ))}
            </div>
        </section>
    );
}
