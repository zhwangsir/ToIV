/**
 * chunkLoadRecovery 自动恢复决策单测(node:test,无 DOM)。
 * 覆盖:错误分类、每 BUILD_ID 仅一次自动刷新、storage 不可用降级、清理旧标记。
 */
import assert from "node:assert/strict";
import { test, describe, beforeEach } from "node:test";
import {
  isChunkLoadError,
  isNextChunkAssetUrl,
  createChunkLoadRecovery,
  resetChunkLoadRecoveryForTests,
  type ChunkRecoveryDeps,
} from "@/lib/chunkLoadRecovery";

beforeEach(() => {
  resetChunkLoadRecoveryForTests();
});

type FakeStorage = ChunkRecoveryDeps["storage"];

/** 供 createChunkLoadRecovery 注入的 FakeStorage(Map 底,只实现决策核心用到的子集)。 */
function fakeStorage(initial: Record<string, string> = {}): FakeStorage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  };
}

describe("isChunkLoadError", () => {
  test("匹配 Error", () => {
    assert.equal(
      isChunkLoadError(new Error("ChunkLoadError: loading chunk 2 failed")),
      true,
    );
  });
  test("匹配字符串", () => {
    assert.equal(
      isChunkLoadError("Failed to fetch dynamically imported module: /a.js"),
      true,
    );
  });
  test("匹配 Loading chunk failed", () => {
    assert.equal(
      isChunkLoadError("Loading chunk 3 failed."),
      true,
    );
  });
  test("不匹配无关 Error", () => {
    assert.equal(isChunkLoadError(new Error("网络超时")), false);
  });
  test("不匹配对象", () => {
    assert.equal(isChunkLoadError({ reason: "x" }), false);
  });
});

describe("isNextChunkAssetUrl", () => {
  test("匹配 /_next/static/chunks/a.js", () => {
    assert.equal(
      isNextChunkAssetUrl("/_next/static/chunks/123.js"),
      true,
    );
  });
  test("匹配 /_next/static/css/app.css", () => {
    assert.equal(
      isNextChunkAssetUrl("/_next/static/css/app.css"),
      true,
    );
  });
  test("不匹配外部 CDN", () => {
    assert.equal(
      isNextChunkAssetUrl("https://cdn.com/lib.js"),
      false,
    );
  });
  test("非字符串 → false", () => {
    assert.equal(isNextChunkAssetUrl(123), false);
  });
});

describe("createChunkLoadRecovery", () => {
  test("非 chunk 错误 → ignored", () => {
    const storage = fakeStorage();
    let reloadCount = 0;
    const r = createChunkLoadRecovery({
      buildId: "b1",
      storage,
      reload: () => {
        reloadCount += 1;
      },
    });
    const action = r.handle(new Error("无关错误"));
    assert.equal(action, "ignored");
    assert.equal(reloadCount, 0);
  });

  test("首次 chunk 错误 → reloaded", () => {
    const storage = fakeStorage();
    let reloadCount = 0;
    const r = createChunkLoadRecovery({
      buildId: "b1",
      storage,
      reload: () => {
        reloadCount += 1;
      },
    });
    const action = r.handle(
      new Error("ChunkLoadError: loading chunk 2 failed"),
    );
    assert.equal(action, "reloaded");
    assert.equal(reloadCount, 1);
    // 已打标
    assert.ok(storage.getItem("toiv:chunk-reload:b1"));
  });

  test("同 buildId 第二次 → already-reloaded(防死循环)", () => {
    const storage = fakeStorage();
    let reloadCount = 0;
    const r = createChunkLoadRecovery({
      buildId: "b1",
      storage,
      reload: () => {
        reloadCount += 1;
      },
    });
    r.handle(new Error("ChunkLoadError"));
    const action = r.handle(new Error("ChunkLoadError"));
    assert.equal(action, "already-reloaded");
    assert.equal(reloadCount, 1);
  });

  test("不同 buildId 获得新的自动恢复机会", () => {
    const storage = fakeStorage();
    let reloadCount = 0;
    const r1 = createChunkLoadRecovery({
      buildId: "b1",
      storage,
      reload: () => {
        reloadCount += 1;
      },
    });
    r1.handle(new Error("ChunkLoadError"));
    // 发版了,新 buildId
    const r2 = createChunkLoadRecovery({
      buildId: "b2",
      storage,
      reload: () => {
        reloadCount += 1;
      },
    });
    const action = r2.handle(new Error("ChunkLoadError"));
    assert.equal(action, "reloaded");
    assert.equal(reloadCount, 2);
  });

  test("新构建自动清除旧标记", () => {
    const storage = fakeStorage();
    storage.setItem("toiv:chunk-reload:old", "1");
    const r = createChunkLoadRecovery({
      buildId: "new",
      storage,
      reload: () => {},
    });
    r.handle(new Error("ChunkLoadError"));
    // 旧标记被清理
    assert.equal(storage.getItem("toiv:chunk-reload:old"), null);
    assert.ok(storage.getItem("toiv:chunk-reload:new"));
  });

  test("storage 异常(隐私模式等) → already-reloaded(放弃自动恢复,防死循环)", () => {
    // 每次写都抛(模拟隐私模式禁用 storage)
    const bad: FakeStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {},
      key: () => null,
      length: 0,
    };
    let reloadCount = 0;
    const r = createChunkLoadRecovery({
      buildId: "b1",
      storage: bad,
      reload: () => {
        reloadCount += 1;
      },
    });
    const action = r.handle(new Error("ChunkLoadError"));
    assert.equal(action, "already-reloaded");
    assert.equal(reloadCount, 0);
  });

  test("null buildId 以 unknown 为键", () => {
    const storage = fakeStorage();
    let reloadCount = 0;
    const r = createChunkLoadRecovery({
      buildId: null,
      storage,
      reload: () => {
        reloadCount += 1;
      },
    });
    r.handle(new Error("ChunkLoadError"));
    assert.equal(reloadCount, 1);
    assert.ok(storage.getItem("toiv:chunk-reload:unknown"));
  });
});
