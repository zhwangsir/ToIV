// 翻译插件防崩 guard(发版防御三件套之三):
// 浏览器「翻译此页」(Chrome/Edge/微信内置浏览器)会直接改写 React 托管的 DOM:
// 把文本节点塞进新插入的 <font> 容器,或整段替换。等 React 下一次协调对原节点执行
// removeChild / insertBefore 时,节点的 parentNode 已不再是 React 记忆里的父节点,
// 浏览器抛 NotFoundError,冒泡到根错误边界 → 整页「页面加载失败」。
// ToIV 是中文站点,用户群自动翻译使用率高,属于高发崩溃源。
//
// 通行缓解(社区通解,facebook/react#11538):包裹这两个原型方法,
// 父节点对不上时静默跳过/退化为追加而非抛错。只在「父节点不匹配」这一异常路径
// 短路,正常路径完全走原生实现,返回值契约保持不变,无副作用、无性能影响。

/** 结构化最小 DOM 接口:真实 Node 与测试替身(FakeNode)都满足,便于注入单测。 */
export interface DomNodeLike {
  parentNode: DomNodeLike | null;
  removeChild<T extends DomNodeLike>(this: DomNodeLike, child: T): T;
  insertBefore<T extends DomNodeLike>(
    this: DomNodeLike,
    node: T,
    ref: DomNodeLike | null,
  ): T;
}

export interface DomNodeCtor {
  prototype: DomNodeLike;
}

/**
 * 包裹给定 Node 构造器原型的 removeChild/insertBefore(核心逻辑,纯函数式注入,可单测)。
 * 幂等由外层 installDomReconciliationGuard 保证;直接调用本函数请确保只调一次。
 */
export function patchDomNodePrototype(NodeCtor: DomNodeCtor): void {
  const proto = NodeCtor.prototype;

  const originalRemoveChild = proto.removeChild;
  proto.removeChild = function guardedRemoveChild<T extends DomNodeLike>(
    this: DomNodeLike,
    child: T,
  ): T {
    if (child.parentNode !== this) {
      // 目标已被翻译器搬到别的父节点下,原生调用必抛。视为删除已完成,把 child
      // 原样交还(保持原生返回值契约);残留节点随翻译器容器一起被后续清理。
      console.warn("[dom-guard] removeChild 目标节点父节点已变更,跳过", child);
      return child;
    }
    return originalRemoveChild.call(this, child) as T;
  };

  const originalInsertBefore = proto.insertBefore;
  proto.insertBefore = function guardedInsertBefore<T extends DomNodeLike>(
    this: DomNodeLike,
    node: T,
    ref: DomNodeLike | null,
  ): T {
    if (ref && ref.parentNode !== this) {
      // 参照节点已被翻译器搬走,无法在其前插入。退化为追加
      // (insertBefore(node, null) 等价 appendChild),保证新节点仍进入 DOM,
      // React 下一轮协调会自行纠正顺序。
      console.warn(
        "[dom-guard] insertBefore 参照节点父节点已变更,改为追加",
        node,
      );
      return originalInsertBefore.call(this, node, null) as T;
    }
    return originalInsertBefore.call(this, node, ref) as T;
  };
}

let installed = false;

/**
 * 对全局 Node 原型安装 guard(幂等)。
 * 须在 React 接管前调用 —— 落点 instrumentation-client.ts(客户端最早入口),
 * 且仅生产启用:dev 下保留原生抛错,便于发现真实 DOM 操作 bug。
 */
export function installDomReconciliationGuard(): void {
  if (installed) return;
  if (typeof Node !== "function" || !Node.prototype) return;
  installed = true;
  patchDomNodePrototype(Node as unknown as DomNodeCtor);
}

export function resetDomReconciliationGuardForTests(): void {
  installed = false;
}
