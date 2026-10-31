import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const manifest = JSON.parse(readFileSync(resolve(import.meta.dir, "prime-vendor.manifest.json"), "utf8"));
const ALLOWLIST = new Set(["index.html", "src/main.tsx"]);

describe("prime vendor freeze", () => {
    test("vendor tree matches provenance manifest", () => {
        expect(manifest.provenance).toBe("62f8d95d7ee6a5af9543351040e6183e9dcbbe65");
        for (const entry of manifest.files) {
            if (ALLOWLIST.has(entry.path)) continue;
            const body = readFileSync(resolve(import.meta.dir, "..", entry.path));
            expect(createHash("sha256").update(body).digest("hex")).toBe(entry.sha256);
        }
    });
    test("bootstrap allowlist is exactly index.html and main.tsx", () => {
        expect([...manifest.allowlist].sort()).toEqual([...ALLOWLIST].sort());
    });
    test("manifest covers the vendor source tree", () => {
        expect(manifest.files.length).toBeGreaterThan(100);
        expect(manifest.files.some((file) => file.path === "src/App.tsx")).toBe(true);
    });
});
