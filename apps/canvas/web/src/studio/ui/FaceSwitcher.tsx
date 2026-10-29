import type { StudioFace } from "../flags";

const FACES: { key: StudioFace; label: string }[] = [
    { key: "pipeline", label: "流水线" },
    { key: "canvas", label: "画布" },
    { key: "edit", label: "剪辑湾" },
];

export function FaceSwitcher({ value, onChange }: { value: StudioFace; onChange: (face: StudioFace) => void }) {
    return (
        <nav className="stv-faces" aria-label="工作面">
            {FACES.map((face) => (
                <button key={face.key} type="button" aria-pressed={face.key === value} onClick={() => onChange(face.key)}>
                    {face.label}
                </button>
            ))}
        </nav>
    );
}
