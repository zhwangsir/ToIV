import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const targets = ["src", "index.html"];
const files = [];

function walk(path) {
    for (const name of readdirSync(path)) {
        const full = join(path, name);
        if (statSync(full).isDirectory()) walk(full);
        else files.push(relative(root, full).split(sep).join("/"));
    }
}
for (const target of targets) {
    const full = join(root, target);
    if (statSync(full).isDirectory()) walk(full);
    else files.push(target);
}
files.sort();

const manifest = {
    provenance: "62f8d95d7ee6a5af9543351040e6183e9dcbbe65",
    allowlist: ["index.html", "src/main.tsx"],
    files: files.map((path) => ({
        path,
        sha256: createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
    })),
};
writeFileSync(join(root, "test/prime-vendor.manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`freeze manifest: ${manifest.files.length} files`);
