import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import {
    CREW_ASSIST_GATE_HINT,
    isCrewAssistMode,
    setCrewAssistMode,
} from "../src/services/toiv/crew-assist-mode";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

function installMemoryStorage() {
    const store = new Map<string, string>();
    const ls = {
        getItem: (key: string) => (store.has(key) ? store.get(key)! : null),
        setItem: (key: string, value: string) => {
            store.set(key, String(value));
        },
        removeItem: (key: string) => {
            store.delete(key);
        },
        clear: () => store.clear(),
    };
    const prevWindow = globalThis.window;
    Object.defineProperty(globalThis, "window", {
        configurable: true,
        value: { localStorage: ls },
    });
    return () => {
        if (prevWindow === undefined) {
            // @ts-expect-error cleanup
            delete globalThis.window;
        } else {
            Object.defineProperty(globalThis, "window", { configurable: true, value: prevWindow });
        }
    };
}

describe("D5-A crew-assist-mode（localStorage）", () => {
    let restore: () => void;

    beforeEach(() => {
        restore = installMemoryStorage();
    });

    afterEach(() => {
        restore();
    });

    test("默认关", () => {
        expect(isCrewAssistMode()).toBe(false);
        expect(isCrewAssistMode("proj-a")).toBe(false);
    });

    test("按项目持久化，互不串扰", () => {
        setCrewAssistMode(true, "proj-a");
        expect(isCrewAssistMode("proj-a")).toBe(true);
        expect(isCrewAssistMode("proj-b")).toBe(false);
        setCrewAssistMode(false, "proj-a");
        expect(isCrewAssistMode("proj-a")).toBe(false);
    });

    test("人闸提示文案钉死三点", () => {
        expect(CREW_ASSIST_GATE_HINT).toContain("定妆选角");
        expect(CREW_ASSIST_GATE_HINT).toContain("合成");
        expect(CREW_ASSIST_GATE_HINT).toContain("不会代发 Agent");
    });
});

describe("D5-A drama-workspace 剧组协助接线", () => {
    const page = read("src/pages/toiv/drama-workspace.tsx");

    test("顶栏有「剧组协助」Switch 且默认从 isCrewAssistMode 读", () => {
        expect(page).toContain("剧组协助");
        expect(page).toContain('aria-label="剧组协助"');
        expect(page).toContain("isCrewAssistMode(id)");
        expect(page).toContain("setCrewAssistMode(on, id)");
        expect(page).toContain("const [crewAssist, setCrewAssist] = useState(false)");
    });

    test("开启时人闸旁露出轻提示，不代发 Agent", () => {
        expect(page).toContain("CREW_ASSIST_GATE_HINT");
        expect(page).toContain('data-testid="crew-assist-gate-hint"');
        expect(page).toContain("人闸·定妆选角");
        expect(page).toContain("人闸·合成");
        expect(page).not.toContain("createAgentTeam");
        expect(page).not.toContain("agent_team");
    });
});
