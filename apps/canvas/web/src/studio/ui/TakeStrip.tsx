export type TakeItem = { id: string; label: string; seed: number; src?: string };

export function TakeStrip({ takes, activeId, onPick }: { takes: TakeItem[]; activeId?: string; onPick: (id: string) => void }) {
    return (
        <div className="stv-takes">
            {takes.map((take) => (
                <button key={take.id} type="button" className="stv-take" aria-pressed={take.id === activeId} onClick={() => onPick(take.id)}>
                    {take.id === activeId ? <span className="tag">ACTIVE</span> : null}
                    <div className="th" style={take.src ? { backgroundImage: `url(${take.src})` } : undefined} />
                    <div className="m">{take.label} · seed {take.seed}</div>
                </button>
            ))}
        </div>
    );
}
