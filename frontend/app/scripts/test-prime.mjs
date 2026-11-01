#!/usr/bin/env node
// Browser suites must run one file per Bun process. On Bun 1.2.17 a single
// process that loads several Playwright harnesses can hang or silently drop
// results, so a green "bun test test/" is not trustworthy for this directory.
//
// Playwright 1.64.1 also has a teardown race under Bun: destroying a context
// whose page still has responses in flight reports "Unhandled error between
// tests" for protocol objects that were already disposed. Every test passes in
// that case, but bun exits non-zero. The runner accepts such a process only
// when all counted tests passed AND every unhandled error matches one of the
// three dispatcher signatures below; anything else stays a hard failure. The
// suppression is never silent — it prints a warn line and a final count.
//
// Usage:
//   bun scripts/test-prime.mjs                 # unit batch + every browser suite
//   bun scripts/test-prime.mjs unit [filter]   # unit batch only
//   bun scripts/test-prime.mjs browser [filter] # browser suites only (one process each)
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args[0] === "unit" || args[0] === "browser" ? args[0] : "all";
const filters = (mode === "all" ? args : args.slice(1)).filter(Boolean);
const names = readdirSync(join(root, "test"))
    .filter((name) => name.endsWith(".test.ts") || name.endsWith(".test.tsx"))
    .sort();
const isBrowser = (name) => name.includes(".browser.test.");
const matches = (name) => !filters.length || filters.some((filter) => name.includes(filter));
const unit = names.filter((name) => !isBrowser(name) && matches(name));
const browser = names.filter((name) => isBrowser(name) && matches(name));
const bun = process.platform === "win32" ? "bun.exe" : "bun";

// Only Playwright's internal GUID dispatcher emits these; they carry no
// information about application behaviour and only appear while a target is
// being destroyed.
const TEARDOWN_SIGNATURES = [
    /^Cannot find parent object \S+ to create (?:response|request|route|frame)@\S+$/,
    /^Object with guid \S+ was not bound in the connection$/,
    /^Cannot find object to "\w+": \S+$/,
];

let failed = 0;
let noisy = 0;
const runs = [];

// eslint-disable-next-line no-control-regex -- strips bun's ANSI colour codes
const plain = (output) => output.replace(/\u001b\[[0-9;]*m/g, "");
function summary(output, pattern) {
    return Number(output.match(pattern)?.[1] ?? 0);
}

function teardownErrors(output) {
    return Array.from(output.matchAll(/# Unhandled error between tests[\s\S]*?\nerror: ([^\n]+)/g), (match) => match[1].trim());
}

function run(label, files, timeout) {
    const started = Date.now();
    const result = spawnSync(bun, ["test", ...files], {
        cwd: root, env: process.env, encoding: "utf8", timeout, maxBuffer: 64 * 1024 * 1024,
    });
    const output = plain(`${result.stdout ?? ""}${result.stderr ?? ""}`);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    if (result.error?.code === "ETIMEDOUT") {
        failed += 1;
        console.error(`FAIL ${label} · timeout after ${timeout / 1000}s\n${output}`);
        return;
    }
    const passes = summary(output, /^\s*(\d+) pass$/m);
    const fails = summary(output, /^\s*(\d+) fail$/m);
    const ran = summary(output, /^Ran (\d+) tests? across \d+ files?\./m);
    const errors = teardownErrors(output);
    const onlyTeardownNoise = errors.length > 0 && errors.every((line) => TEARDOWN_SIGNATURES.some((pattern) => pattern.test(line)));
    const counted = passes > 0 && fails === 0 && ran === passes;
    if (result.status !== 0 && !(counted && onlyTeardownNoise)) {
        failed += 1;
        console.error(`FAIL ${label} · ${seconds}s\n${output}`);
        return;
    }
    if (passes === 0) {
        failed += 1;
        console.error(`FAIL ${label} · no tests ran\n${output}`);
        return;
    }
    runs.push(label);
    console.log(`ok   ${label} · ${passes} pass · ${seconds}s`);
    if (errors.length) {
        noisy += 1;
        console.warn(`warn ${label} · suppressed ${errors.length} Playwright teardown protocol error${errors.length === 1 ? "" : "s"} (all ${passes} tests passed)`);
    }
}

if (mode !== "browser") {
    if (!unit.length) {
        console.error("no unit test files matched");
        failed += 1;
    } else {
        run(`unit (${unit.length} files)`, unit.map((name) => `test/${name}`), 300_000);
    }
}

if (mode !== "unit") {
    if (!browser.length) {
        console.error("no browser suites matched");
        failed += 1;
    }
    for (const name of browser) run(`test/${name}`, [`test/${name}`], 180_000);
}

if (!failed) {
    const note = noisy ? ` · ${noisy} process${noisy === 1 ? "" : "es"} had Playwright teardown noise` : "";
    console.log(`\nPASS · ${runs.length} test process${runs.length === 1 ? "" : "es"} · browser suites ran one file per process${note}`);
} else {
    console.error(`\nFAILED · ${failed} test process${failed === 1 ? "" : "es"}`);
}
process.exit(failed ? 1 : 0);
