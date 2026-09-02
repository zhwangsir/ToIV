"use client";

/**
 * 应用「工作流」模式(2026-09-02):把 ComfyUI API 图展现给用户——
 * 节点按拓扑序纵向成流,绑定参数在所属节点内联编辑(与简洁模式共享 values),
 * 未绑定叶子只读展示(标量直读,连线显示 ← #节点),拓扑不可改。
 */

import { ParamField } from "@/components/generate/ParamField";
import { Icon } from "@/components/ui/Icon";
import {
  bindingsByNode,
  orderWorkflowNodes,
  type AppItem,
  type AppBinding,
  type AppWorkflowNode,
} from "@/lib/apps";

interface AppWorkflowGraphProps {
  app: AppItem;
  values: Record<string, unknown>;
  onParamChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}

/** 标量叶子格式化:字符串截断、对象/数组 JSON 截断(连线不走到这里)。 */
function leafText(v: unknown): string {
  if (typeof v === "string") return v.length > 56 ? `${v.slice(0, 56)}…` : v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v === null || v === undefined) return "—";
  const j = JSON.stringify(v);
  return j.length > 48 ? `${j.slice(0, 48)}…` : j;
}

/** 单节点卡:头部(id/类型/标题)+ 绑定参数内联编辑 + 只读输入行。 */
function WorkflowNodeCard({
  id,
  node,
  bound,
  app,
  values,
  onParamChange,
  disabled,
}: {
  id: string;
  node: AppWorkflowNode;
  bound: { key: string; field: string }[];
  app: AppItem;
  values: Record<string, unknown>;
  onParamChange: (key: string, value: unknown) => void;
  disabled?: boolean;
}) {
  // 已绑定叶子不在只读区重复展示(inputs.<名> → 名;widgets_values.<n> → widgets 行整行让位)
  const boundInputNames = new Set(
    bound.filter((b) => b.field.startsWith("inputs.")).map((b) => b.field.slice(7)),
  );
  const inputs = Object.entries(node.inputs ?? {}).filter(
    ([name]) => !boundInputNames.has(name),
  );
  const widgetsBound = bound.some((b) => b.field.startsWith("widgets_values."));

  return (
    <section className={`wf-node${bound.length ? " is-bound" : ""}`} aria-label={`节点 ${id}`}>
      <header className="wf-node-head">
        <span className="wf-node-id">#{id}</span>
        <span className="wf-node-type">{node.class_type}</span>
        {node.title && <span className="wf-node-title">{node.title}</span>}
        {bound.length > 0 && (
          <span className="wf-node-flag">
            <Icon name="sliders" size={11} /> 可调
          </span>
        )}
      </header>

      {bound.length > 0 && (
        <div className="wf-bound">
          {bound.map((b) => {
            const param = app.params_schema.find((p) => p.key === b.key);
            if (!param) return null;
            return (
              <ParamField
                key={b.key}
                param={param}
                value={values[b.key]}
                onChange={onParamChange}
                disabled={disabled}
              />
            );
          })}
        </div>
      )}

      {inputs.length > 0 && (
        <dl className="wf-node-ios">
          {inputs.map(([name, v]) => (
            <div key={name} className="wf-io">
              <dt className="wf-io-name">{name}</dt>
              <dd className="wf-io-val">
                {Array.isArray(v) ? (
                  <span className="wf-io-link">← #{String(v[0])}</span>
                ) : (
                  leafText(v)
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
      {Array.isArray(node.widgets_values) && node.widgets_values.length > 0 && !widgetsBound && (
        <p className="wf-io wf-io-widgets">
          <span className="wf-io-name">widgets</span>
          <span className="wf-io-val">{leafText(node.widgets_values)}</span>
        </p>
      )}
    </section>
  );
}

export function AppWorkflowGraph({ app, values, onParamChange, disabled }: AppWorkflowGraphProps) {
  const wf = app.workflow_json;
  if (!wf || Object.keys(wf).length === 0) {
    return <p className="wf-empty">该应用未提供工作流细节</p>;
  }
  const order = orderWorkflowNodes(wf);
  const byNode = bindingsByNode(app.bindings as Record<string, AppBinding>);
  return (
    <div className="wf-flow" aria-label="工作流">
      {order.map((id, i) => (
        <div key={id} className="wf-flow-item">
          {i > 0 && (
            <div className="wf-join" aria-hidden="true">
              <Icon name="chevron-down" size={12} />
            </div>
          )}
          <WorkflowNodeCard
            id={id}
            node={wf[id]}
            bound={byNode.get(id) ?? []}
            app={app}
            values={values}
            onParamChange={onParamChange}
            disabled={disabled}
          />
        </div>
      ))}
    </div>
  );
}
