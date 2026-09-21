# 会话移交提示词套件（2026-09-22）

> 用法：新会话直接粘贴。主提示词=完整移交（推荐）；专项变体=只做某一域。配套阅读：压缩后的 `AGENTS.md`（40KB）+ 四份方案文档。

---

## ① 主提示词（完整移交，推荐）

```text
你是 ToIV 项目的设备/产品管家会话（接手 2026-09-22 的工作）。本项目在 /Users/wangzhenyu/Desktop/ALLProject/ToIV，分支 feat/app-guides-admin-cms（勿 push、勿 stage .regen_tmp/dogfood-output）。

第一步：完整阅读 AGENTS.md（已压缩至 40KB，约 5 分钟），特别是「🔒 硬性规则」「⚠️ 易错点」「七、当前焦点」「八、未完成任务总表」——全部产出与坑都在里面。凡涉及 GPU/服务/端口/路径必须先真机验证（SSH 一律经 Tailscale；core=ssh core-ts、workstation=ssh merlin@100.68.100.90；LAN 直连从 Mac 不可达），禁止凭文档臆断。「TS 离线」≠「服务掉线」，先 LAN ping+端口扫再下结论。

当前状态快照（2026-09-22，树 clean @f06e1c5）：
- 测试基线：api 3315 绿 / web 988 绿 / e2e 六 spec 11/11
- 生产：core toiv-api :8090（whisper 四址集群+连接池修复已部署）；web BUILD_ID 20260921-052336-nogit；admin :3200；验证入口一律 CN 入口 https://toiv.wineryz.top（dgmt frp 抖动）
- 目录规模：应用 6773 总/5061 公开/5558 rh-acc，use_case 打标全覆盖；说明卡 550/550
- admin token：curl -X POST .../api/auth/login -d '{"email":"admin","password":"admin123"}'（字段是 email）
- 用户定位拍板：ToIV 仅本地自用/学习，不公开运营

下一项工作（批 1，三件套，方案已备）：
① 作品库文件夹整组删除 P0——按 docs/LIBRARY_FOLDER_DELETE_PLAN_20260922.md：文件夹卡加「删除整组」入口+确认 Modal（成员数/状态分布/进行中排除）+复用 deleteJobsBatch 与「全部撤销」；三处「不做整组删除」注释与 libraryBatch 测试同步改；新增 4 组 jest + 1 例 e2e
② 助手 A0 快赢——按 docs/ASSISTANT_UI_REDESIGN_PLAN_20260922.md：移动端 CTA ctaAction 跳 fusion→改 home（page.tsx:806）；popup 快捷键提示按断点隐藏；AgentRunStyles 空文件/「模型设置」残留注释清理
③ Admin 审计筛选键修复——按 docs/ADMIN_REPLAN_20260922.md：AuditLogView.tsx:12-20 下划线键→点号（job_delete→job.delete 等），动作中文标签表；2932 条存量立即可查
总方案 docs/EVOLUTION_PLAN_20260922.md；后续批：助手 A1 工具卡片 → Admin P0 设备域+说明书批量 → 文件夹 P1 bulk 端点+Admin P1 作业队列。

操作口径（坑已踩平，照用即可）：
- 部署：web/admin 一律 core 本机构建（Mac 外地 TS 37KB/s，.next 不可传）——web=core 上 cd /home/merlin/toiv/web && rm -rf .next && pnpm build && sudo systemctl restart toiv-web；admin 构建前必须 core 上全量 npm install（生产装 --omit=dev 缺 typescript 会报假线索）；api=deploy/deploy.sh --skip-web core-jump（重试循环）
- 生产 PG：core 上 export PGPASSWORD=68799b59242beeccfd54963902a35006; psql -h 127.0.0.1 -U toiv -d toiv（core 的 toiv/api/toiv.db 是废弃 SQLite 勿用）
- e2e：cd apps/web && TOIV_WEB_BASE=https://toiv.wineryz.top TOIV_API_BASE=https://toiv.wineryz.top npx playwright test <spec> --project=chromium-authed --workers=1（并发会饿死 frp）
- web 测试 mock：新增 lib/api 导出必补 tests/mocks/studioApi.ts 替身；CSS 改 apps.css 注意 P-2b 三约束（懒惰正则位置/零 hex/token 必须已定义）
- agent 工具开发守 P-9 纪律（四处断言同步+成功文案禁 hint 词）；DB 会话守 P-8 纪律（大响应先拼字节再显式 close）
- 封面 autorefire 有深度闸 12+尝试上限 3，勿手动乱调；demo 批失败多为已知硬阻塞类，勿误读回归

每批纪律：实现→测试补齐（api/web jest+e2e 按 apps/web/e2e/authed-library-p0.spec.ts 模式）→真机验证（CN 入口+截图）→AGENTS.md 第七节/STATE.json 入账→commit。所有工作自主进行直到批 1 三件全部完成且测试全绿。
```

---

## ② 专项变体 A：只做作品库文件夹删除

```text
你是 ToIV 项目（/Users/wangzhenyu/Desktop/ALLProject/ToIV，分支 feat/app-guides-admin-cms，勿 push、勿 stage .regen_tmp）的产品开发会话。
先读 AGENTS.md 的「🔒 硬性规则」「六、易错点」「七、当前焦点」，再读 docs/LIBRARY_FOLDER_DELETE_PLAN_20260922.md（深度调研+完整方案，含生产实数与八条删除语义红线）。
任务：按方案 P0 实施作品库文件夹整组删除——文件夹卡 hover 加「删除整组」+批量模式可选中文件夹；确认 Modal（成员数/状态分布/进行中成员排除/回收站 72h 提示）；执行复用 lib/libraryQuery.ts 的 deleteJobsBatch 与既有「全部撤销」toast；Saved Views chips 加 ×（文案「仅删视图不删作品」，与作品删除分离）。
同步更新：LibraryView.tsx 三处「不做整组删除」注释（:1695/:895/:2413 附近）、apps/web/tests/libraryBatch.test.ts 形态断言（保留「成员<2 回落普通卡」不变式）；新增文件夹删除入口/确认流/撤销/进行中排除 4 组 jest；e2e 按 apps/web/e2e/authed-library-p0.spec.ts 模式补一例（造变体组→整组删→撤销还原）。
验证：cd apps/web && npm test 全绿；e2e 用 TOIV_WEB_BASE=https://toiv.wineryz.top npx playwright test <spec> --project=chromium-authed --workers=1；真机截图文件夹卡删除流。
若时间充裕接 P1：POST /api/jobs/bulk-delete（ids≤200 逐件归属校验+软删+per-job 审计/undo_token；api jest 覆盖）+ 板列表卡删除入口+boards.py:208 补 audit.record。
全部完成后 AGENTS.md 第七节+STATE.json 入账并 commit（api 测试 cd apps/api && .venv/bin/python -m pytest tests/ -q -p no:cacheprovider 须全绿）。
```

---

## ③ 专项变体 B：只做 AI 助手 UI

```text
你是 ToIV 项目（/Users/wangzhenyu/Desktop/ALLProject/ToIV，分支 feat/app-guides-admin-cms，勿 push、勿 stage .regen_tmp）的前端开发会话。
先读 AGENTS.md 的「🔒 硬性规则」「六、易错点」（重点 P-2b CSS 三约束），再读 docs/ASSISTANT_UI_REDESIGN_PLAN_20260922.md（生产实数：工具结果占消息 46%，工具分布定卡片优先级）。
任务分两批：
A0 快赢：①移动端底部 CTA ctaAction 跳 fusion→改 home（apps/web/app/page.tsx:806，W2 改 label 未同步的遗留 bug）②popup 空态「Shift+Enter」提示按断点隐藏（移动端无键盘）③删 AgentRunStyles.tsx 空实现与「模型设置」残留注释（AssistantView.tsx:3197 附近）。
A1 工具卡片体系：建 components/assistant/toolcards/ 注册表（按 tool.name 渲染，未注册回退现有 av-tool-chip 小条，向后兼容）；首批六族按生产频次：optimize_prompt 对照卡（原文⇄优化文+应用到输入框）/search_knowledge 结果列表卡/submit_generation 作业卡（复用 AvJobCards）/storyboard 画板卡（缩略+打开画板深链）/selfheal 报告卡（归因+查看应用）/list_apps 应用卡（封面+名称+「打开应用」/?view=market&app= 深链）。协议零改动（AgentEvent.tool 已带 name+结构化结果）。
红线：tests/assistant* 十组不变式必须全绿（onEvent 三分支/提案卡 resume/回放归并/popup 互斥/霓虹参数/离线导航/R18 门控等）；新增 toolRenderers 注册/回退/六族渲染测试。
验证：cd apps/web && npm test 全绿；e2e authed-agent-drama.spec.ts + authed-agents-ui.spec.ts 复跑（workers=1）；真机 CN 入口截图（对话门户+六族卡片）。
完成后 AGENTS.md 第七节+STATE.json 入账并 commit。
```

---

## ④ 专项变体 C：只做 Admin 重规划 P0

```text
你是 ToIV 项目（/Users/wangzhenyu/Desktop/ALLProject/ToIV，分支 feat/app-guides-admin-cms，勿 push、勿 stage .regen_tmp）的全栈开发会话。
先读 AGENTS.md 的「🔒 硬性规则」「五、Core 生产状态」「七、当前焦点」，再读 docs/ADMIN_REPLAN_20260922.md（生产实数：审计 2932 条、job.delete 占 57%、筛选键零匹配实锤、端点覆盖矩阵）。
任务按 P0 三件：
①审计修复：apps/admin/components/admin/AuditLogView.tsx:12-20 筛选键下划线→点号（对齐后端 action：job.delete/app.run/session.delete/job.cancel 等）+动作中文标签表+user/action 组合筛选——2932 条存量立即可查。
②设备与服务域 v1：fleet 网格加「假活」识别（systemd active 但端口不监听——参照观测/fleet 探测+端口核对；2026-09-21 upscale-gpu3 :8263 实例）、openclaw 节点卡（whisper 集群四节点 /v1/audio/transcriptions 健康探针）、LB 后端健康（workstation :8188/admin/backends）。
③说明书批量：说明书全量列表（草稿/发布筛选）+批量生成/发布/关联回填入口（端点全有：POST /api/admin/apps/{id}/guide/generate、POST /api/admin/app-guides/publish-all、POST /api/admin/app-guides/relations/backfill）。
部署：core 本机——ssh core-ts 'export PATH=/usr/share/nodejs/corepack/shims:$PATH && cd /home/merlin/toiv/admin && npm install && rm -rf .next && npm run build && sudo systemctl restart toiv-admin'（必须先全量 npm install，生产装 --omit=dev 缺 typescript 会报假线索）；源码同步走 deploy/deploy.sh --skip-web core-jump（会带上 apps/admin？确认 rsync 覆盖，否则单独 rsync apps/admin）。
验证：npm run typecheck 过；真机 :3200 三域走查截图（审计筛选命中/假活识别/说明书批量流）；后端若加端点须 api jest 全绿（cd apps/api && .venv/bin/python -m pytest tests/ -q -p no:cacheprovider）。
完成后 AGENTS.md 第七节+STATE.json 入账并 commit。
```

---

## ⑤ 专项变体 D：设备管家（纯运维轮）

```text
你是 ToIV 项目的设备管家会话（/Users/wangzhenyu/Desktop/ALLProject/ToIV，勿 push、勿 stage .regen_tmp）。
先完整读 AGENTS.md（40KB）——全部设备/凭据/端口/坑在里面；凡 GPU/服务/端口/路径必须先真机验证（SSH 一律 Tailscale；「TS 离线」≠「服务掉线」先 LAN ping+端口扫，N-5）。
本轮巡检项：①引擎矩阵 /api/models/engines 可用数（基线 23/24，唯一 flux1-nunchaku=上游 SM120 已登记）②LB /admin/backends 双后端 healthy ③专用实例 :8195/:8196/:8197/:8199 + 超分 :8261-8263 + IndexTTS :9200 + Embedding :9302 端口全 OPEN ④whisper 四节点（192.168.71.86/.75/.81/.85:9310）/v1/audio/transcriptions 实测出段 ⑤DSv4 spark 容器 dsv4_60 Up + guard cron 双侧在 ⑥core pg_stat_activity 无 >5min idle in transaction（池健康基线 20 idle/0 楔死）⑦封面 autorefire 批状态（深度闸 12，勿乱调）。
遗留现场项（远程不可为，见到用户时提醒）：openclaw02-04 与 cloud 的 tailscaled 需现场 tailscale down && up / systemctl restart tailscaled；core BIOS 来电自启。
发现异常先按 AGENTS.md 易错点处置，修完 AGENTS.md/STATE.json 入账并 commit。
```
