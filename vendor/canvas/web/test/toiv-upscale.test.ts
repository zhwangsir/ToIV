import { describe, expect, test } from "bun:test";

import { toivUploadedVideoUrl, upscaleUploadFilename } from "@/services/toiv/upscale";

describe("toiv upscale helpers (F10 超分入口)", () => {
    test("image filenames map mime → server-whitelisted extension", () => {
        expect(upscaleUploadFilename("image/png", "image")).toMatch(/^creation-result-[a-z0-9]+\.png$/);
        expect(upscaleUploadFilename("image/jpeg", "image", "shot").endsWith(".jpg")).toBe(true);
        expect(upscaleUploadFilename("image/webp; charset=binary", "image").endsWith(".webp")).toBe(true);
        expect(upscaleUploadFilename("image/gif", "image").endsWith(".gif")).toBe(true);
        // 未知/缺失 mime 回退 png(服务端按魔数复核,不会伪装成其他类型)
        expect(upscaleUploadFilename("", "image").endsWith(".png")).toBe(true);
        expect(upscaleUploadFilename("application/octet-stream", "image").endsWith(".png")).toBe(true);
    });

    test("video filenames map mime → mp4/webm/mov only", () => {
        expect(upscaleUploadFilename("video/mp4", "video").endsWith(".mp4")).toBe(true);
        expect(upscaleUploadFilename("video/webm", "video").endsWith(".webm")).toBe(true);
        expect(upscaleUploadFilename("video/quicktime", "video").endsWith(".mov")).toBe(true);
        expect(upscaleUploadFilename("image/png", "video").endsWith(".mp4")).toBe(true);
    });

    test("uploaded video url keeps the /api/images whitelist form with type=input", () => {
        const url = toivUploadedVideoUrl("clip 01.mp4", "http://192.168.71.127:8263");
        expect(url.startsWith("/api/images?")).toBe(true);
        const qs = new URLSearchParams(url.slice("/api/images?".length));
        expect(qs.get("filename")).toBe("clip 01.mp4");
        expect(qs.get("worker")).toBe("http://192.168.71.127:8263");
        expect(qs.get("type")).toBe("input");
    });
});
