import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const script = readFileSync(resolve(import.meta.dir, "../../../../deploy/deploy.sh"), "utf8");

describe("deploy --prime gray switch", () => {
    test("flag parses and defaults off", () => {
        expect(script).toMatch(/--prime\)\s+PRIME=true/);
        expect(script).toContain("PRIME=false");
    });
    test("prime flag reaches the remote build heredoc", () => {
        expect(script).toContain('bash -s -- "${REMOTE_DIR}" "${PRIME}"');
        expect(script).toContain('PRIME="${2:-false}"');
    });
    test("prime branch builds apps/prime/web with studio base and ToIV api base", () => {
        expect(script).toContain('cd "$TOIV/apps/prime/web"');
        expect(script).toContain("BEEFTV_PUBLIC_BASE=/studio/ VITE_API_BASE=/api");
    });
    test("default branch still builds the legacy canvas web", () => {
        expect(script).toContain('cd "$CANVAS/web"');
        expect(script).toContain("VITE_CANVAS_BACKEND_URL=/studio/api ./node_modules/.bin/vite build --base=/studio/");
    });
    test("prime sources are rsynced only when the flag is on", () => {
        expect(script).toMatch(/if \[ "\$PRIME" = true \]; then[\s\S]*?echo "▶ \[prime\] rsync frontend\/app/);
        expect(script).toContain('frontend/app/ "${REMOTE}:${REMOTE_DIR}/apps/prime/web/"');
    });
});
