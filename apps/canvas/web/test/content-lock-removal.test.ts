import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const webDir = resolve(import.meta.dir, "..");
const probe = `
const store = new Map();
globalThis.window = {
    localStorage: {
        getItem: key => store.get(key) ?? null,
        setItem: (key, value) => store.set(key, value),
        removeItem: key => store.delete(key),
    },
    dispatchEvent: () => true,
};
globalThis.document = { documentElement: { dataset: {} } };
const mod = await import('./src/redline.ts');
mod.applyAccountModePayload({ content_mode: 'ordinary' });
const dual = { content_modes: ['sfw', 'nsfw'] };
const result = {
    mode: mod.getAccountContentMode(),
    header: mod.nsfwHeaderEnabled(),
    allowed: mod.nsfwAllowed(),
    asset: mod.isNsfwAssetSelectable('example-nsfw.safetensors'),
    unknown: mod.isNsfwAssetListable({ content_rating: 'unknown' }),
    visible: mod.appVisibleForContentMode({ content_modes: ['nsfw'] }, false),
    pose: mod.isPoseSystemVisible('双人缠绵', false),
    redirect: mod.r18GuardRedirect({ pathname: '/nsfw', search: '' }),
    soften: mod.shouldApplyContentSoftening(),
    toggle: mod.canShowContentModeToggle(dual, false),
    selected: mod.resolveSubmitContentMode({ app: dual, r18On: false, selected: 'nsfw' }),
    ordinarySelected: mod.resolveSubmitContentMode({ app: dual, r18On: false, selected: 'sfw' }),
    classification: mod.classifyAssetContent({ is_nsfw: true, basename: 'clean.safetensors' }),
    fallback: mod.visibleSelectionOrFallback('example-nsfw.safetensors', 'other.safetensors'),
};
mod.applyAccountModePayload({ content_mode: 'adult' });
result.adultMode = mod.getAccountContentMode();
mod.applyAccountModePayload({ content_mode: 'ordinary' });
result.fallbackTip = mod.peekFallbackTip();
console.log(JSON.stringify(result));
`;

function withPolicyCopy(run: (directory: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "toiv-content-lock-"));
    const directory = join(root, "web");
    try {
        mkdirSync(join(directory, "src"), { recursive: true });
        copyFileSync(join(webDir, "tsconfig.json"), join(directory, "tsconfig.json"));
        for (const name of ["redline.ts", "content-policy.ts", "content-lock.ts"]) {
            const source = join(webDir, "src", name);
            if (existsSync(source)) copyFileSync(source, join(directory, "src", name));
        }
        run(directory);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
}

function snapshot(directory: string) {
    const result = Bun.spawnSync([process.execPath, "--eval", probe], { cwd: directory });
    expect(result.stderr.toString()).toBe("");
    expect(result.exitCode).toBe(0);
    return JSON.parse(result.stdout.toString());
}

const unlocked = {
    mode: "ordinary",
    header: false,
    allowed: true,
    asset: true,
    unknown: true,
    visible: true,
    pose: true,
    redirect: null,
    soften: false,
    toggle: true,
    selected: "nsfw",
    ordinarySelected: "sfw",
    classification: "nsfw",
    fallback: "example-nsfw.safetensors",
    adultMode: "adult",
    fallbackTip: false,
};

describe("optional content lock", () => {
    test("Vite loads the installed, missing and replaced policy through the same alias", () => {
        withPolicyCopy((directory) => {
            for (const file of ["vite.config.ts", "media-build-mode.ts"]) {
                copyFileSync(join(webDir, file), join(directory, file));
            }
            for (const file of ["VERSION", "CHANGELOG.md"]) {
                copyFileSync(join(webDir, "..", file), join(directory, "..", file));
            }
            symlinkSync(join(webDir, "node_modules"), join(directory, "node_modules"), "dir");
            writeFileSync(join(directory, "src/entry.ts"), 'export { contentPolicy } from "@content-lock";');
            const script = `
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), cacheDir: '.vite-test-cache', logLevel: 'silent', server: { middlewareMode: true } });
try {
    const { contentPolicy } = await server.ssrLoadModule('/src/entry.ts');
    console.log(JSON.stringify({ allowed: contentPolicy.allowsContent(false) }));
} finally {
    await server.close();
}
`;
            for (const [state, allowed] of [["installed", false], ["missing", true], ["replacement", true]] as const) {
                if (state === "missing") rmSync(join(directory, "src/content-lock.ts"));
                if (state === "replacement") {
                    writeFileSync(join(directory, "src/content-lock.ts"), 'export { contentPolicy } from "./content-policy";');
                }
                const result = Bun.spawnSync(["node", "--input-type=module", "--eval", script], { cwd: directory });
                expect(result.stderr.toString()).toBe("");
                expect(result.exitCode).toBe(0);
                expect(JSON.parse(result.stdout.toString())).toEqual({ allowed });
            }
        });
    }, 30_000);

    for (const initiallyInstalled of [true, false]) {
        test(`running Vite switches policy after file changes (initially installed: ${initiallyInstalled})`, () => {
            withPolicyCopy((directory) => {
                for (const file of ["vite.config.ts", "media-build-mode.ts"]) {
                    copyFileSync(join(webDir, file), join(directory, file));
                }
                for (const file of ["VERSION", "CHANGELOG.md"]) {
                    copyFileSync(join(webDir, "..", file), join(directory, "..", file));
                }
                symlinkSync(join(webDir, "node_modules"), join(directory, "node_modules"), "dir");
                writeFileSync(join(directory, "index.html"), '<body><script type="module" src="/src/entry.ts"></script></body>');
                writeFileSync(join(directory, "src/entry.ts"), `
import { contentPolicy } from '@content-lock';
document.body.dataset.allowed = String(contentPolicy.allowsContent(false));
document.body.innerHTML = '<button>Use studio</button><output>0</output>';
document.querySelector('button').onclick = () => { document.querySelector('output').textContent = '1'; };
`);
                const script = `
import assert from 'node:assert/strict';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'vite';
import { chromium } from 'playwright';
const lock = 'src/content-lock.ts';
const original = readFileSync(lock);
if (!${initiallyInstalled}) rmSync(lock);
const server = await createServer({ root: process.cwd(), cacheDir: '.vite-test-cache', logLevel: 'silent', server: { host: '127.0.0.1', port: 0 } });
let browser;
try {
    await server.listen();
    const executablePath = [process.env.CHROME_PATH, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(path => path && existsSync(path));
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(server.resolvedUrls.local[0]);
    const check = async allowed => {
        await page.waitForFunction(expected => document.body.dataset.allowed === String(expected), allowed, { timeout: 5000 });
        await page.getByRole('button', { name: 'Use studio' }).click();
        assert.equal(await page.locator('output').innerText(), '1');
        assert.equal(await page.locator('vite-error-overlay').count(), 0);
    };
    await check(!${initiallyInstalled});
    if (${initiallyInstalled}) { rmSync(lock); await check(true); }
    writeFileSync(lock, original);
    await check(false);
    writeFileSync(lock, 'export { contentPolicy } from "./content-policy";');
    await check(true);
    writeFileSync(lock, original);
    await check(false);
    rmSync(lock);
    await check(true);
    assert.deepEqual(errors, []);
} finally {
    await browser?.close();
    await server.close();
}
`;
                const result = Bun.spawnSync(["node", "--input-type=module", "--eval", script], { cwd: directory, timeout: 25_000 });
                expect(result.stderr.toString()).toBe("");
                expect(result.exitCode).toBe(0);
            });
        }, 30_000);
    }

    test("physical removal keeps selection, metadata and ordinary mode without restrictions", () => {
        withPolicyCopy((directory) => {
            rmSync(join(directory, "src/content-lock.ts"), { force: true });
            expect(snapshot(directory)).toEqual(unlocked);
        });
    });

    test("reinstall restores policy without changing the stable consumer", () => {
        withPolicyCopy((directory) => {
            const installed = snapshot(directory);
            expect(installed.asset).toBe(false);
            expect(installed.selected).toBe("sfw");
            expect(installed.redirect).toBe("/settings?section=general&focus=r18");
            rmSync(join(directory, "src/content-lock.ts"), { force: true });
            expect(snapshot(directory)).toEqual(unlocked);
            copyFileSync(join(webDir, "src/content-lock.ts"), join(directory, "src/content-lock.ts"));
            expect(snapshot(directory)).toEqual(installed);
        });
    });

    test("replacement changes one policy decision without changing mode or generation intent", () => {
        withPolicyCopy((directory) => {
            writeFileSync(join(directory, "src/content-lock.ts"), `
import { contentPolicy as openPolicy, type ContentPolicy } from './content-policy';
export const contentPolicy: ContentPolicy = {
    ...openPolicy,
    id: 'replacement',
    isAssetSelectable: () => false,
};
`);
            expect(snapshot(directory)).toEqual({ ...unlocked, asset: false, fallback: "other.safetensors" });
        });
    });
});
