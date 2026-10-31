import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

import { creationCanonSkills, findCreationCanonSkill } from "@/pages/create/creation-canon-skills";

describe("creation canon skills (F10 技能 tab 正典目录)", () => {
    test("catalog mirrors the server-side canonical registry incl. img2threejs", () => {
        const ids = creationCanonSkills.map((skill) => skill.id);
        expect(new Set(ids).size).toBe(ids.length);
        // 与 apps/api/app/skills/* 注册表一一对应(6 个正典技能)
        expect(ids.sort()).toEqual([
            "editorial-mg-pv",
            "h3-app-catalog",
            "h3-multi-ref",
            "h3-prompt-writer",
            "h3-seam-polish",
            "img2threejs",
        ]);
    });

    test("every skill carries a usable direct-out prompt and valid mode", () => {
        for (const skill of creationCanonSkills) {
            expect(["image", "video", "text"]).toContain(skill.mode);
            expect(skill.prompt.length).toBeGreaterThan(30);
            // 直出模板必须点名技能本身,便于模型按正典执行
            expect(skill.prompt).toContain(skill.name);
            expect(skill.description.trim().length).toBeGreaterThan(8);
            expect(skill.triggers.length).toBeGreaterThan(0);
            expect(skill.version).toMatch(/^\d+\.\d+\.\d+$/);
            expect(existsSync(resolve(import.meta.dir, "../public", skill.image.slice(1)))).toBe(true);
        }
    });

    test("img2threejs keeps Apache-2.0 attribution and 3D reconstruction intent", () => {
        const skill = findCreationCanonSkill("img2threejs");
        expect(skill).toBeDefined();
        expect(skill?.author).toContain("Apache-2.0");
        expect(skill?.prompt).toContain("ObjectSculptSpec");
        expect(skill?.triggers).toContain("图生3D");
    });

    test("findCreationCanonSkill returns undefined for unknown ids", () => {
        expect(findCreationCanonSkill("not-a-skill")).toBeUndefined();
    });
});
