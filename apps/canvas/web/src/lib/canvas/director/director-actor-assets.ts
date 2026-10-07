import type { DirectorActorPresetId } from "@/types/director";
import { publicAsset } from "@/lib/app-base";

export const DIRECTOR_QUATERNIUS_MALE_URL = publicAsset("/canvas/models/quaternius-standard-male.glb");
export const DIRECTOR_QUATERNIUS_FEMALE_URL = publicAsset("/canvas/models/quaternius-standard-female.glb");

/** Resolve both new presets and URL-less older actors to the bundled rigged bases. */
export function resolveDirectorBuiltInActorUrl(preset?: DirectorActorPresetId): string | null {
    if (preset === "standard_female") return DIRECTOR_QUATERNIUS_FEMALE_URL;
    if (preset === "geometric") return null;
    return DIRECTOR_QUATERNIUS_MALE_URL;
}
