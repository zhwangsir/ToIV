# Admin 后端管理系统重规划：深度调研与完整方案（2026-09-22）

> 问题：用户报「后端管理系统的体量太小、功能太少，需要重新规划」，四域方案 D 项深化专篇。
> 调研方法：生产审计实数 + 后端端点全覆盖矩阵 + 前端组件核查（行号截至 commit `a3d6db3`）。

---

## 一、问题定量（生产实数）

| 事实 | 数据 |
|---|---|
| 审计日志动作分布（2932 条） | job.delete **1675(57%)** / app.run 1079 / session.delete 54 / job.cancel 30 / job.purge_all 10 / job.restore 6 / orch.wake 2 …**全部点号风格** |
| **审计页筛选键实锤失效** | `AuditLogView.tsx:12-20` 下拉键是下划线（`job_delete`），后端 action 全点号（`job.delete`）且按 startswith 过滤——**下拉筛选对 2932 条现存数据零匹配** |
| 后端管理面端点 | 26 个显式 `/api/admin/*` + 30+ 个 admin 门控端点；前端仅覆盖约一半（差距清单见 §2） |
| admin 自身质量门 | **零测试**（无 jest 配置/无 test 脚本，仅 `tsc --noEmit`） |
| 前端工程债 | `lib/api.ts` 4923 行全量搬移（实际只用尾部 ~100 行 admin 封装）；`deploy-admin.sh` 仍是 Mac 构建+rsync 旧口径（实际已改 core 本机构建）；实测矩阵页=占位文案 |
| 运营动作信号 | job.delete 占审计 57%——**作业/作品管理是最高频运营场景**，但 admin 只有失败作业只读列表+一键清理 |

## 二、端点覆盖矩阵（有 API 无 UI 的确凿清单）

| 域 | 仅 API 无 UI 的能力 |
|---|---|
| 说明书 | 批量生成（generate）、批量发布（publish-all）、关联回填（relations/backfill）、全量列表 |
| 封面 | 单应用上传（`POST /apps/{aid}/cover`）、旧管线批量（covers/generate） |
| 烟测/自愈 | 导入前预检 preflight |
| 设备/系统 | GPU 冒烟（gpu-smoke+latest）、harness 自省（停用引擎/插件）、`GET /system/gpu` |
| 知识图谱 | `GET /admin/knowledge-graph`（RH webappId/引擎/模型出处反查） |
| 模型资产 | models/local、model wiki/enrich、引擎注册表读+refresh、models/health |
| 作业/队列 | 全员作业行内操作（cancel/rerun/delete/restore/purge）、回收站管理 |
| 应用 | 创建（POST /apps）、删除、导入两阶段、workflow deploy |

## 三、方案：新六域信息架构（分期）

### P0（最高优先——直接服务当前痛点）
1. **审计修复**（D5）：筛选键改点号+动作中文标签表+user/action 组合筛选；2932 条存量立即可查。
2. **设备与服务域 v1**（D1，与掉线处置联动）：
   - fleet 网格强化：**「假活」识别**（systemd active 但端口不监听——upscale-gpu3 类事故巡检化，数据来自观测/fleet 探测+端口核对）；
   - openclaw 节点卡（whisper 集群四节点状态，`/v1/audio/transcriptions` 健康探针）；
   - LB 后端健康（`/admin/backends`）、超分池、GPU 冒烟触发+最近报告。
3. **说明书批量**（D3）：全量列表（草稿/发布筛选）+ 批量生成/发布/关联回填入口（端点全有，纯前端）。

### P1
4. **作业与队列域**（D4）：全员作业列表（kind/status/user/时间筛选）+ 行内 cancel/rerun/delete/restore/purge（审计 57% 是 delete——高频场景补齐）+ 回收站管理视图。
5. **内容运营强化**（D3 续）：应用创建/删除/导入 UI、单应用封面上传、preflight 预检面板、批量 featured。

### P2
6. **模型资产域**（D2）：本地模型浏览、model wiki+enrich、引擎注册表只读+手动探测刷新、MODEL_SOURCES 只读视图（新端点读 `docs/MODEL_SOURCES.json`）。
7. **知识图谱+观测深化**（D5 续）：knowledge-graph 查询 UI（webappId 反查）；观测页并入「假活服务」与队列深度闸状态。
8. **实测矩阵实装**（D6）：L2 矩阵结果接 API（历史 jsonl 入端点/DB），替换占位页。
9. **工程化**（D7 贯穿）：
   - admin 测试 0→1：node:test 同 web 模式（lib 封装契约+关键交互不变式），保留 typecheck；
   - `lib/api.ts` 瘦身：删未引用搬移函数（静态核），4900→~800 行，按域分包；
   - `deploy-admin.sh` 固化现行口径：源码 rsync→core 本机 `npm install && npm run build`→restart（删 Mac 构建前置校验）。

**不做**：不动现有 5 tab 骨架（新域以 tab 增量接入）；不引入状态库/组件库；服务重启类操作一律走 orch 白名单端点+审计+二次确认（不开放任意 systemctl）。

## 四、验证

- 后端新端点（如有）：api jest；前端每域：typecheck + 新增 node:test；
- 真机：:3200 逐域走查截图（审计筛选命中、fleet 假活识别、说明书批量流）；
- e2e 不动（admin 无 e2e 现状保持）；每阶段 AGENTS.md/STATE 入账 + commit。
