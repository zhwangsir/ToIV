const NSFW_KEY = "toiv_nsfw_pref";

export function readNsfwPreference(): boolean {
    try {
        return localStorage.getItem(NSFW_KEY) === "1";
    } catch {
        return false;
    }
}

/** Preference only; content gating stays with the shared content policy. */
export function writeNsfwPreference(on: boolean): void {
    try {
        localStorage.setItem(NSFW_KEY, on ? "1" : "0");
    } catch {
        // Storage unavailable: keep the locked default.
    }
}
