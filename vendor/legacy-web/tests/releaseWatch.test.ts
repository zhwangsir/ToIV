/**
 * releaseWatch 发版侦测纯逻辑单测(node:test,无 DOM)。
 * 覆盖:BUILD_ID 解析、部署指纹比对、拉取桩(成功/非2xx/脏数据/异常)。
 */
import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  deployedVersionDiffers,
  fetchDeployedBuildId,
  resolveRunningBuildId,
} from "@/lib/releaseWatch";

describe("resolveRunningBuildId", () => {
  test("正常指纹 → 原值", () => {
    assert.equal(resolveRunningBuildId("20260815-abc123"), "20260815-abc123");
  });
  test("undefined → null(未注入,侦测停用)", () => {
    assert.equal(resolveRunningBuildId(undefined), null);
  });
  test("空串/纯空白 → null", () => {
    assert.equal(resolveRunningBuildId(""), null);
    assert.equal(resolveRunningBuildId("   "), null);
  });
});

describe("deployedVersionDiffers", () => {
  test("相同 → false", () => {
    assert.equal(deployedVersionDiffers("a", "a"), false);
  });
  test("不同 → true(有新构建)", () => {
    assert.equal(deployedVersionDiffers("b", "a"), true);
  });
  test("任一侧为 null → false(无法确定,不打扰)", () => {
    assert.equal(deployedVersionDiffers(null, "a"), false);
    assert.equal(deployedVersionDiffers("a", null), false);
  });
});

describe("fetchDeployedBuildId", () => {
  test("正常响应 → 提取 buildId,且请求带 cache-bust 与 no-store", async () => {
    let seenUrl = "";
    let seenInit: RequestInit | undefined;
    const fetchFn: typeof fetch = async (input, init) => {
      seenUrl = String(input);
      seenInit = init;
      return Response.json({ buildId: "20260815-abc" });
    };
    assert.equal(await fetchDeployedBuildId(fetchFn), "20260815-abc");
    assert.match(seenUrl, /^\/version\.json\?_v=\d+$/);
    assert.equal(seenInit?.cache, "no-store");
  });

  test("非 2xx → null", async () => {
    const fetchFn: typeof fetch = async () =>
      new Response(null, { status: 503 });
    assert.equal(await fetchDeployedBuildId(fetchFn), null);
  });

  test("buildId 缺失/类型不对/空串 → null", async () => {
    for (const payload of [{}, { buildId: 123 }, { buildId: "" }, null]) {
      const fetchFn: typeof fetch = async () => Response.json(payload);
      assert.equal(await fetchDeployedBuildId(fetchFn), null);
    }
  });

  test("网络抛错 → null(静默等下轮)", async () => {
    const fetchFn: typeof fetch = async () => {
      throw new Error("network down");
    };
    assert.equal(await fetchDeployedBuildId(fetchFn), null);
  });
});
