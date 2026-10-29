export type StudioFace = "pipeline" | "canvas" | "edit";

export function studioFaceEnabled(face: StudioFace): boolean {
    const raw = String(import.meta.env.VITE_STUDIO_FACE_FALLBACK ?? "");
    if (raw.trim() === "all") return false;
    return !raw.split(",").map((part) => part.trim()).includes(face);
}
