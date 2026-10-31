import { afterEach, beforeEach, expect, test } from "bun:test";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const origin = "https://prime.example.test";
const token = "unit-test-only-token";
beforeEach(() => Object.defineProperty(globalThis, "window", { configurable: true, value: {
    location: { origin }, localStorage: { getItem: () => token },
} }));
afterEach(() => {
    if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
    else Reflect.deleteProperty(globalThis, "window");
});

test("media URLs attach one current token only to same-origin API and preserve filename/signature/fragment", async () => {
    const { toivMediaUrl } = await import("../src/toiv/adapters/media");
    for (const path of ["/api/images?filename=hello%20world.MP4&token=stale#clip", `${origin}/api/studio/files/voice.wav?sig=fixture`]) {
        const url = new URL(toivMediaUrl(path), origin);
        expect(url.origin).toBe(origin);
        expect(url.searchParams.getAll("token")).toEqual([token]);
        if (url.pathname === "/api/images") {
            expect(url.searchParams.get("filename")).toBe("hello world.MP4");
            expect(url.hash).toBe("#clip");
        } else expect(url.searchParams.get("sig")).toBe("fixture");
    }
    for (const path of ["https://external.example.test/api/images?filename=x.png", "//external.example.test/api/studio/files/a.mp4", "/static/a.png", "https://prime.example.test.evil.test/api/images?filename=x.png", "http://prime.example.test/api/images?filename=x.png"]) {
        expect(new URL(toivMediaUrl(path), origin).searchParams.has("token")).toBe(false);
    }
});

test("rejects executable/local/data URLs, credentials and backslash tricks before any media request", async () => {
    const { toivMediaUrl, primeMediaKind } = await import("../src/toiv/adapters/media");
    for (const path of ["javascript:alert(1)", "file:///tmp/a.png", "data:text/html,<img src=x>", "data:image/svg+xml,<svg/>", "blob:https://prime.example.test/a", "ftp://example.test/a.png", "https://user:password@example.test/a.png", "/\\external.example.test/api/images?filename=x.png", "java\nscript:alert(1)"]) {
        expect(toivMediaUrl(path)).toBe("");
        expect(primeMediaKind(path)).toBeUndefined();
    }
});

test("recognizes pathname or filename extensions, not job kind, worker URL, hash or substring", async () => {
    const { primeMediaKind } = await import("../src/toiv/adapters/media");
    for (const [path, kind] of [
        ["/api/images?filename=take%20one.MP4&worker=http%3A%2F%2Fworker", "video"],
        ["/api/studio/files/voice.wav?sig=fixture", "audio"],
        ["/api/studio/files/still%2Ewebp", "image"],
        ["/clip.webm#t=1", "video"], ["/sound.ogg", "audio"], ["/frame.avif", "image"],
        ["/document.html?worker=photo.png", undefined], ["/no-extension#image.png", undefined],
        ["/photo.png.exe", undefined], ["/clip.html?filename=clip.mp4", undefined],
    ] as const) expect(primeMediaKind(path)).toBe(kind);
});
