/**
 * domGuard 翻译插件防崩补丁单测(node:test,无真 DOM,用 FakeNode 注入)。
 * 覆盖:
 *  ① 正常路径不受影响(原生行为+返回值契约保持);
 *  ② removeChild 父节点不匹配 → 静默跳过不抛,返回 child;
 *  ③ insertBefore 参照节点不匹配 → 退化为追加不抛,返回新节点;
 *  ④ node 环境下全局 Node 不存在,install 安全 no-op。
 */
import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import {
  installDomReconciliationGuard,
  patchDomNodePrototype,
  resetDomReconciliationGuardForTests,
} from "@/lib/domGuard";

/** 模拟真实 DOM 语义的测试替身(含自动 detach、NotFoundError 抛错)。 */
class FakeNode {
  parentNode: FakeNode | null = null;
  children: FakeNode[] = [];

  removeChild<T extends FakeNode>(this: FakeNode, child: T): T {
    const i = this.children.indexOf(child);
    if (i === -1) {
      throw new Error(
        "NotFoundError: The node to be removed is not a child of this node",
      );
    }
    this.children.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  insertBefore<T extends FakeNode>(
    this: FakeNode,
    node: T,
    ref: FakeNode | null,
  ): T {
    if (ref !== null && ref.parentNode !== this) {
      throw new Error(
        "NotFoundError: The node before which the new node is to be inserted is not a child of this node",
      );
    }
    // 真实 DOM 行为:插入前先从原父节点摘下
    if (node.parentNode) {
      const siblings = node.parentNode.children;
      const j = siblings.indexOf(node);
      if (j !== -1) siblings.splice(j, 1);
    }
    if (ref === null) {
      this.children.push(node);
    } else {
      this.children.splice(this.children.indexOf(ref), 0, node);
    }
    node.parentNode = this;
    return node;
  }
}

/** 静默 patch 过程中的 console.warn(避免测试输出噪音),返回恢复函数。 */
function silenceWarn(): () => void {
  const original = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = original;
  };
}

describe("patchDomNodePrototype", () => {
  before(() => {
    patchDomNodePrototype(FakeNode as never);
  });
  after(() => {
    resetDomReconciliationGuardForTests();
  });

  test("正常 removeChild:移除成功并返回 child(原生行为保持)", () => {
    const parent = new FakeNode();
    const child = new FakeNode();
    parent.insertBefore(child, null);
    const returned = parent.removeChild(child);
    assert.equal(returned, child);
    assert.equal(parent.children.length, 0);
    assert.equal(child.parentNode, null);
  });

  test("removeChild 父节点不匹配(已被翻译器搬走):不抛错,返回 child,父节点不变", () => {
    const restore = silenceWarn();
    try {
      const reactParent = new FakeNode();
      const translatorHost = new FakeNode();
      const text = new FakeNode();
      reactParent.insertBefore(text, null);
      // 模拟翻译插件:把文本节点搬进了它插入的容器
      translatorHost.insertBefore(text, null);
      // React 按记忆从原父节点移除 → 原生必抛,guard 应静默跳过
      const returned = reactParent.removeChild(text);
      assert.equal(returned, text);
      // 文本节点仍留在翻译器容器里,未被误删
      assert.equal(text.parentNode, translatorHost);
      assert.deepEqual(translatorHost.children, [text]);
    } finally {
      restore();
    }
  });

  test("正常 insertBefore:插到参照节点前,顺序正确", () => {
    const parent = new FakeNode();
    const a = new FakeNode();
    const b = new FakeNode();
    parent.insertBefore(a, null);
    parent.insertBefore(b, a);
    assert.deepEqual(parent.children, [b, a]);
  });

  test("insertBefore 参照节点不匹配:退化为追加,不抛错,返回新节点", () => {
    const restore = silenceWarn();
    try {
      const reactParent = new FakeNode();
      const translatorHost = new FakeNode();
      const ref = new FakeNode();
      reactParent.insertBefore(ref, null);
      // 参照节点被翻译器搬走
      translatorHost.insertBefore(ref, null);
      const incoming = new FakeNode();
      const returned = reactParent.insertBefore(incoming, ref);
      assert.equal(returned, incoming);
      // 退化为 appendChild:进入 reactParent 末尾
      assert.deepEqual(reactParent.children, [incoming]);
      assert.equal(incoming.parentNode, reactParent);
    } finally {
      restore();
    }
  });

  test("insertBefore ref 为 null(appendChild 语义):不受影响", () => {
    const parent = new FakeNode();
    const node = new FakeNode();
    const returned = parent.insertBefore(node, null);
    assert.equal(returned, node);
    assert.deepEqual(parent.children, [node]);
  });
});

describe("installDomReconciliationGuard", () => {
  test("node 环境无全局 Node:安全 no-op 不抛错", () => {
    resetDomReconciliationGuardForTests();
    assert.equal(typeof (globalThis as { Node?: unknown }).Node, "undefined");
    assert.doesNotThrow(() => installDomReconciliationGuard());
  });
});
