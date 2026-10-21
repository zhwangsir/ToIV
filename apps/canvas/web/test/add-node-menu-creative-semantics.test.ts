import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
    ADD_NODE_MENU_CREATIVE_LABELS,
    defaultLocalVideoPreset,
    LOCAL_CREATE_PRESETS,
} from "../src/services/toiv/local-capability-surface";

const menu = readFileSync(
    resolve(import.meta.dir, "../src/lib/canvas/tool-registry/definitions/add-node-menu-tools.tsx"),
    "utf8",
);

describe("Wave P3 N5 add-node menu creative semantics", () => {
    test("primary menu has creative labels and no engine-as-type", () => {
        for (const label of ADD_NODE_MENU_CREATIVE_LABELS) {
            expect(menu).toContain(`label: "${label}"`);
        }
        expect(menu).not.toContain("本地·H3");
        expect(menu).not.toContain("本地·Wan");
        expect(menu).not.toContain("本地·出图");
        expect(menu).not.toMatch(/本地·H3:\d+/);
        expect(menu).not.toContain(":8264");
        expect(menu).not.toContain("LOCAL_CREATE_PRESETS.map");
    });

    test("default video create binds H3 short-drama main path", () => {
        expect(defaultLocalVideoPreset().protocol).toBe("toiv-h3");
        expect(menu).toContain("defaultLocalVideoPreset");
        expect(LOCAL_CREATE_PRESETS.some((p) => p.protocol === "toiv-h3")).toBe(true);
    });
});
