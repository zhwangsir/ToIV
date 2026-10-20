# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手重犯同样错误，每次会话必读（约 22KB；干货优先于硬顶字节）
> **维护者**：设备管家
> **最后更新**：2026-10-15（①止血+取窗批 §七；②§〇b 开发命令与 npm/core 分流；③**工程结构清理**：删构建缓存/opentalking 本地副本/tmp 工作区，DEVELOPMENT 日志迁出，根目录只留主体）。10-14 许可口径不变（img2threejs=Apache、hypit=修改版 Apache 单租户自用可并码、转公开前须清）。
> **历史归档**：07-07~10-14 焦点全叙与易错点详版 `.archive/AGENTS-full-20261014.md`；更早 `.archive/AGENTS-focus-20260916-0921.md`、`AGENTS-changes-20260904-0911.md`、`AGENTS-full-20260903.md`；机读 `STATE.json`（753KB 只读头部）。

---

## 〇、🔒 硬性规则（每次会话必读）

1. **所有 AI/算力后端服务来源均在 Workstation**（192.168.71.127 / 100.68.100.90）。core 只跑 web/api+PG/Redis 是业务网关不是算力；Mac 只是操作终端。排查「服务离线/引擎不可达」第一反应=SSH 到 Workstation 查 systemd 和端口，禁止臆断。
2. **文档仅供参考，必须真机验证**。凡 GPU 显存/服务状态/端口/路径/挂载/模型占用，先 SSH 执行真实命令（nvidia-smi/systemctl/ss/mountpoint/df/free）再作答；文档与真机冲突以真机为准并修正文档。「已停用/已退役」记录尤其要复核（stop≠disable，重启会复活）。
3. **冒测战役在跑时（PG running>0）禁止重启 toiv-api**（留 running 孤儿，P-18b）；实例重启/迁移等 running=0 窗口。

## 〇b、本地开发与验证（代码会话；运维态仍以 §三–§六 为准）

**架构入口**：`apps/` 下四应用——api（FastAPI :8090）· web（Next.js :3100 `/studio`）· admin（:3200）· canvas（Go+Vite，**必读 `apps/canvas/AGENTS.md`**）；移动端 `MiniProgram/`。长文在 `DEVELOPMENT.md`；下列是会猜错的口径。工作暂存写 `tmp/`（已 ignore）；`opentalking` 不 vendor。
**六仓融合源**：`third_party/{dramaclaw,toonflow,hypit,video-use}`（工作树不入仓）+ `licenses/`；BeefTV 已并 `apps/canvas`。并码前读 `third_party/README.md` 许可表——video-use/Toonflow=MIT 可并码；hypit=修改 Apache **单租户**；dramaclaw=Elastic **留 NOTICE、禁对第三方托管**；ChatCut/OpenMontage 禁抄。

**测试命令（易踩坑：web/admin 不是 vitest，是 `node:test`）**：
```bash
cd apps/api && uv sync --extra dev && uv run pytest tests/test_foo.py::test_bar -q
cd apps/web && npm test && npm run typecheck          # node --import ./tests/register.mjs --test tests/*.test.ts
cd apps/admin && npm test && npm run typecheck
cd apps/canvas/backend && go vet ./... && go test ./...
cd apps/canvas/web && bun run lint && bun run typecheck && bun run build
```
- 新增 `lib/api` 导出必补 `tests/mocks/studioApi.ts`（`tests/loader.mjs` 把 `@/lib/api` 映射到替身）。
- CI 路径分发：`apps/api/**`→最小依赖 pytest（重依赖惰性导入，新依赖报 ModuleNotFoundError 要同步 `ci.yml`）；`apps/web/**`→**仅** `tsc --noEmit`（web 单测/e2e 不在 CI，绿 CI ≠ 测试绿）；`apps/canvas/**`→`canvas.yml`。
- Playwright：`apps/web/e2e`，`TOIV_WEB_BASE`/`TOIV_API_BASE` 指目标；globalSetup 真登录写 `.auth/admin.json`；`authed-*` 需已登录。

**包管理器**：`apps/web`/`apps/admin` 仅 **npm**（有 package-lock.json），禁止引入 pnpm；`apps/canvas/web` 仅 **bun**。

**部署（`deploy/deploy.sh`；`core-jump`=经 workstation 双跳进 core）**：
- api：`deploy/deploy.sh --skip-web core-jump`。渲染驱动在跑时脚本**拒重启 toiv-api**（`FORCE_API_RESTART=1` 强制）；`--web-only` 只动 web（保护烟测）；回滚 `--rollback`；画布 `--with-canvas`/`--canvas-only`/`--all`。
- web/admin 生产构建在 **core 本机**（外地 Mac 传不动 `.next`）：`ssh core-ts 'export PATH=/usr/share/nodejs/corepack/shims:$PATH && cd /home/merlin/toiv/web && rm -rf .next && pnpm build && sudo systemctl restart toiv-web'`；admin 先 core 全量 `npm install`（`--omit=dev` 缺 typescript 报假线索）。
- 本地 `rm -rf .next && npm run build` 后也可推 `.next`；deploy 校验 BUILD_ID 内 git 短 sha==HEAD，旧构建拒推（`ALLOW_STALE_WEB=1` 放行）。前端变更必须干净重建+查 BUILD_ID（P-2）。

## 一、集群设备清单

| 设备 | 角色 | LAN IP | Tailscale IP | SSH 用户 |
|---|---|---|---|---|
| openclaw01-04 | whisper ASR 集群 :9310 + JoyCaption :9305（经 TS 全 OPEN）；⚠️ openclaw01 SSH 拒连（服务不受影响） | .86/.75/.81/.85 | 100.115.23.67 / 100.76.35.7 / 100.76.140.121 / 100.125.217.11 | dgmt-openclaw01-04 |
| spark01 | DSv4 TP2 worker（rank1，`dsv4_60` 容器） | .82 | 100.81.235.124 | dgmt-spark |
| spark02 | 现网 LLM/VLM API DSv4 TP2 head :8000（`~/dsv4-serve.sh 1`(01)→`0`(02)，restart=no 重启需手动；guard cron 双侧） | .84 | 100.86.42.89 | dgmt-spark |
| workstation | 算力+全部后端服务（见三） | 192.168.71.127 | 100.68.100.90 | merlin |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | dgmt-nas |
| 路由器/光猫 | BE10000 Pro .42 / 主网关 .1 | — | — | — |
| cloud | 香港网关/frps/OpenResty；⚠️ tailscaled 僵死待现场重启（frp 不受影响） | 43.119.32.180 | 100.83.78.114 | root |
| core | **ToIV 生产**(web :3100+api :8090+admin :3200+PG+Redis) | 192.168.71.47 | 100.77.80.100 | merlin |
| beijing | CN 入口 toiv.wineryz.top | 8.140.222.24 | — | root |
| MateBook | 操作终端（外地时 bulk ~37KB/s） | 192.168.71.9 | 100.74.15.34 | 本机 |

> 🔒 浏览器侧 TS 优先；core→workstation 走 LAN；「TS 离线」≠「服务掉线」（N-5）。~~studio01-04/pc02~~ 已退役下线。

## 二、凭据与秘密（禁止写入仓库）

**纪律（2026-10-20 #12）**：口令/Token/连接串**不得**出现在 AGENTS、skills、公开文档或 commit 信息。  
需要时到 **core 机上的 env / secrets 文件**读取；缺省问「密钥在哪个文件」，不要让人把密码贴进聊天。

| 需要什么 | 落点（路径/键名，无值） |
|----------|-------------------------|
| ToIV admin 登录 | core `deploy/.env` → `TOIV_ADMIN_EMAIL` / `TOIV_ADMIN_PASSWORD`（登录 API 字段名是 `email`） |
| 生产 PG | 同上 `TOIV_DATABASE_URL`；或 systemd `toiv-api` 进程 environ。手跑 `app.*` 必须显式带该变量（P-18） |
| NAS SMB | 运维 secrets（见 `skills/toiv-cluster/credentials.md` 指针）；Windows `cmdkey` 用本机保管的口令，**勿回写文档** |
| JWT / 渠道 | `TOIV_JWT_SECRET`、`TOIV_WECHAT_*` 等仅在 `deploy/.env`（已 gitignore） |
| 测试号 | 例：core `secrets/e2e_user_review.env`（权限 600） |

轮换 runbook：`docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`。  
公开 GitHub 历史可能仍含旧明文——需另批授权 push/历史治理，本刀只洗工作树文档。


## 三、Workstation 服务与 GPU（🔒 启动服务前必须核对；显存/RAM 动态值先 nvidia-smi/free -h）

**现网常驻（全部 enabled；4× RTX PRO 6000 Blackwell 96GB + 183G RAM）**：

| 服务 | 端口 | 卡 | systemd |
|---|---|---|---|
| ComfyUI-LB（池=本地 **:8196+:8263+:8265 三后端**，10-15 扩；`backends.json` 5s 热重载） | :8188 | — | comfyui-lb |
| gpu0-alt（cache-lru 8） | :8196 | GPU0 | comfyui-gpu0-alt |
| LongCat（cache-lru 3） | :8197 | GPU0 | comfyui-longcat |
| ~~MiniMax H3 :8195~~（闲置 24h，10-15 停+disable 回收 60G RAM） | — | GPU2 | toiv-comfyui-h3 |
| MiniMax H3 worker#2（UUID 8a63d89c，~41G） | :8264 | GPU1 | toiv-comfyui-h3-gpu1 |
| ToIV VLM（Qwen3-VL-8B BF16，~44.6G） | :9311 | GPU3 | toiv-vlm |
| 超分 fleet（4x-UltraSharp；**:8261 已撤**；**:8263 在 LB 池**） | :8262/:8263 | GPU2/GPU3 | comfyui-upscale-gpu2/3 |
| 通用 worker#3（2026-10-15 加池扩容+SEEDVR2 余量；UUID 钉卡 H-6） | :8265 | GPU2 | comfyui-gpu2-gen |
| Qwen3-Embedding-4B（SentenceTransformer 脚本 `/opt/qwen3-embedding-server.py`，非 vLLM；进程名 nemotron-venv 有误导） | :9302 | **GPU1**（CVD=1 存量） | qwen3-embedding |
| IndexTTS 2.5（配音主路，勿再停） | :9200 | GPU0 | toiv-indextts |
| 音频分离 / comfy-mcp / fan_guard（`/opt/fan_guard.py`） | :9220/:9100/— | — | toiv-audio-sep / toiv-comfy-mcp / fan_guard |
| ~~opentalking~~ | 已下架 | — | unit 归档 systemd-archive；代码 /home/merlin/opentalking |

- **🔒 池后端变更只编辑 workstation `/opt/comfyui-lb/backends.json`**；禁止改 core env/LB 源码切成员。
- **🔒 新服务锁卡一律用 GPU UUID**（H-6）；新专用实例必须补 `deps.resolve_worker()` 精确匹配（E-1）。
- **散热**：无软件温度熔断，GPU 自降频即保护；仅持续 ≥95°C 人工介入。
- 关键路径：ComfyUI=/opt/ComfyUI · H3=/home/merlin/ComfyUI-h3-eval · LongCat=/home/merlin/ComfyUI-longcat · IndexTTS=/home/merlin/index-tts。

## 四、NAS

主库 `toiv/comfyui-models` ≈5.2T（新下载只进这里）core=`/mnt/toiv-nas`、工作站=`/home/merlin/nas_mount`；旧库 `Windows/ComfyUI/ComfyUIModel/models` ≈1.5T；两树合计会把硬链算重。端口挂载（10-09 实测）：:8196 两棵都可见；:8197 extra 挂 toiv+h3；:8195/:8264 只挂 h3/，**H3 生产口=:8264**。口径：盘上有≠产品在用（写死文件名见 STATE `branch_integrate_2026_10_09`）；PC01/02 extra 指旧树不得含 custom_nodes 键。下载清单 `docs/MODEL_SOURCES.md/.json`；主路=hf-mirror.com+aria2c -x16（N-2）。

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 / toiv-admin :3200 systemd 常驻；PG 18+Redis 仅 bind 127.0.0.1。域名双入口：toiv.dgmt.top（香港 frp）+ toiv.wineryz.top（CN 入口）。验证：局域网优先 LAN 直连 `192.168.71.47:3100`(/studio 同源)/`:8090`/`:3200`；外网/发布回归才走 wineryz（N-1）。
- **LLM/VLM（DSv4 无审查 TP2 LIVE）**：core `TOIV_LLM_*` 指 spark02 `http://192.168.71.84:8000/v1`；served `deepseek-v4-flash-dspark`+别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`；1M ctx、70.5 tok/s；换模型保别名=core 零改动。`/api/llm/v1` 白名单 `TOIV_LLM_PROXY_MODELS` 须含四名。
- **whisper ASR**：`TOIV_WHISPER_URL`=openclaw 四址故障转移。**Embedding**：workstation :9302。
- **数字人**：~~opentalking M1–M6~~ **已下架（2026-10-14 拍板）**——`TOIV_OPENTALKING_ENABLED=false` 待下一 api 重启窗生效（战役中禁重启 api）；web 数字人入口随 T-U UI 批隐藏。
- **部署口径**：见 §〇b（api=`deploy.sh --skip-web core-jump`；web/admin=core 本机 `pnpm build`/`npm install`；本地包管理器是 npm）。生产 PG 直查见 §二。
- **杂项**：`TOIV_VIDEO_SCORER_ENABLED=true`；web_search 代理 `TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`（依赖 Mac 在线）；内容限制管控已下线；封面 autorefire 勿手动乱调。

## 六、⚠️ 易错点（按主题归并；叙事详版见 .archive/AGENTS-full-20261014.md）

### H. 硬件/容量
- **H-1 禁止臆造硬件数据**，先 SSH 真机。**H-2 显存数字是快照**：共卡部署必须现场 nvidia-smi；vLLM 共卡显式调低 gpu-memory-utilization。**H-3 多引擎并跑先算 RAM**（183G 曾 OOM）。**H-4 「DB 标 error」≠失败**：先查 ComfyUI `/history/{pid}`，产物在就回写，禁盲目重提。**H-5** 无软件温度熔断。**H-6 CUDA 数字索引≠nvidia-smi 索引**：🔒 锁卡一律 GPU UUID+起服后 `--query-compute-apps` 复核。**H-7** :8189 已退役（disable 防复活）。

### D. 退役/迁移
- **D-1 stop≠disable，重启会复活**：退役必须 disable/mask；跨项目冲突记录真机复核。**D-2 一次性手工迁移无守护会静默失效**：生产依赖变更后必须实测业务链路。

### N. 网络/代理
- **N-1** 跨境链路波动污染 A/B 结论，先排除全局链路事件。**N-2** HF 下载=workstation 直连 hf-mirror.com+aria2c -x16 主路；Mac Clash(:7897) 备用。**N-3** 服务须监听 0.0.0.0 才经 TS 可达。**N-4** Windows 长命令经 SSH 换行截断：PowerShell `-EncodedCommand`；`schtasks /create /f` 覆盖。**N-5** 「TS 离线」≠「服务掉线」：先 LAN ping+端口扫；处置 Mac=`tailscale down && up`，Linux=ts-health 探针（常驻 core/WS）。

### W. Windows
- **W-1** SSH session 隔离：长期服务用计划任务+bat 或 NSSM。**W-2** SYSTEM 任务看不到用户盘符：ps1 自挂 `net use Z:`；模型可见性最终裁判=ComfyUI object_info。

### E. 引擎/工作流
- **E-1** 新专用 ComfyUI 实例必须补 `deps.resolve_worker()` 精确匹配，否则作业成功产物 502。**E-2** LongCat 坑：TI2V 用 WanVideoEncode→extra_latents；Avatar 音频必须 whisper-large-v3；WanVideoWrapper `rope_function="comfy"`。**E-3 🔴 探测通过≠链路可跑**：新引擎必须真机 e2e 出片后才算交付（三连实证）。**E-4** vLLM：NVML mismatch 补丁 `/home/merlin/patch_vllm_nvml.py`；served-model-name 别名机制=换模型 core 零改动。**E-6** 超分竖屏显式 --target-w/--target-h，生产一律 `--keep-frames`。**E-7** 回写协程生命周期≤tracker 作业生命周期（多轮等待+reconcile 双保险）。**E-8** 读用户参考图 input→output 双形态，统一 `get_image_bytes_any`（硬编码 input 必 404）。**E-9 🔴 专用实例分支必须在模型检查前先验模型**：`_pick_app_client`(routes/apps.py:4280) 按 class_type 前缀派专用实例直接 return，`required` 从不被检查；路由错被 combo_repair 伪装成「权重不兼容」（fp8 报错真因是路由）。处置：专用分支 return 前先验 required，不满足穿透 pool.pick；`h3_like`/`qwen_edit_like`/`animate2` 三分支同查；换模型文件必须同步处理耦合的量化/精度部件。**E-10 🔴 shim 输出元数必须 ≥ 云端节点被引用的最大 socket 索引**：越界报 `tuple index out of range` 且异常挂在下游消费者、真凶不在错误信息里。诊断：逐节点 object_info 断言每条 `[node_id, idx]` 的 `idx < len(output)`。禁止加宽 RETURN_TYPES 骗过校验；不可通用 shim 的终态=清晰归因失败。**E-11 🔴 库级失败(cusolver/cuDNN/NCCL)不能单调用点补丁当根修**：查环境面（Xid / `torch.backends.cuda.preferred_linalg_library` / libcusolver 与 torch+cu130/sm_120 匹配）；写「已验证」前两道必查：①补丁被加载（进程启动时间>文件 mtime）②同故障其他调用点。**E-12 🔴 节点包会把 HTTP 错误响应当模型写盘不校验**（WD14-Tagger 317 字节限流页冒充 onnx，7 应用被打死）：诊断先看文件大小与头部字节（错误页=几百字节纯文本；真 onnx=GB 级）；处置=hf-mirror 重下+舰队 venv 验证加载；「小得离谱的权重文件」可能是错误页/LFS 指针。

### P. 平台机制
- **P-1** 产物 URL 已签名+归属校验；媒体走 `?token=`。**P-2** 前端变更真机验证：干净重建+截图+查 BUILD_ID。**P-2b CSS 三约束**：appsRh 懒惰正则断言区次序；engineStudio 零 hex（先 grep globals.css）；新增 lib/api 导出必补 `tests/mocks/studioApi.ts` 替身；多组件文件 `<style jsx global>`+前缀命名。**P-3** 测 React：select 用 native setter+dispatchEvent；多 textarea 用 `.promptbar-textarea`。**P-4** `pkill -f` 用 `[f]an_guard` 式转义；/tmp 是 tmpfs（大件写 /var/tmp）。**P-5** 并行 SSH 会话互改状态：关键服务异常先 `journalctl -u <svc>`。**P-6** workstation pip 清华镜像、github ghfast.top；core 登录返回字段 `token`；上传 kind 下划线风格；H3 生成前 free 缓存。**P-7** 新 Python 服务三坑(sm_120)：torch cu128+/cu130；老 CV 包 `--no-build-isolation`；库主版本升级后旧调用逐处核对。**P-8 DB 会话纪律**：大 payload 端点内存拼字节+显式 close 再返回；异步长任务禁持 DB 会话跨 await；诊断=pg_stat_activity idle in transaction+py-spy。**P-9 agent 工具纪律**：加工具同步四处断言（BUILTIN_ORDER/schemas/LEGACY_SYSTEM/test_agent_gen_tools）；服务抽出 import 必须别名防遮蔽；成功文案首 60 字禁 hint 词（错误路径反而要含）。**P-10 kernels 0.16+ 信任门**：实例无 `HF_ENDPOINT` 会直连 hf 报 `runtime_cuda` 假缺包；处置=unit drop-in 补 `Environment=HF_ENDPOINT=https://hf-mirror.com`（drop-in 目录漏 `.service` 不生效）+`kernels>=0.16` 落 venv。**P-11 分页契约静默吞错=数据灾难**：`/api/apps` limit>1000 与未知 query 返 422；「拉全量去重」必须分页拉+任何一页失败即 raise，绝不返回空集当「库里没有」；同类自查=所有 `except → continue/return []` 的网络辅助函数。**P-12 派生指标不能自证**：admin 视图不按 is_public 过滤（验上架用 PG `count(*) FILTER`）；任何过滤参数用「换值看结果变不变」自证（RunningHub page/pageSize/searchValue、civitai baseModel 同病——`modelId=` 才真生效）；预期收益先做前后对照/翻转矩阵。**P-13 🔴 烟测通过≠生产可用**：`combo_repair` 只在烟测路径跑、`_finish` 不写 workflow_json；修复必须以结构化 edits 回放存量图落库；**绝不存运行图**（含烟测 fixture）；任何一条 edit 失败整体不落库；「探测/修复后重试」必须问「修复有没有写回持久层」。**P-14 枚举全库的结论会随数据增长过期**：按名字清单做兼容层的活，动手前重新枚举全库（RH_LLMAPI_NODE 662 图在用而 shim 未覆盖的教训）；清单按「语义族+正则」定。**P-15 装了文件≠生效**：多实例舰队节点包变更逐实例重启+逐个 `object_info/<class>` 核验，节点总数下降即回滚。**P-16 🔴 `/object_info/<未知类>` 返回 200+空对象**：存在性判据=body 键集合（`name in json.loads(raw)`），`-w %{http_code}` 作废；任何「拿 2xx 当存在性」的探测同风险。**P-17 上架类操作先查启动期不变量**（`SFW_NSFW_TWINS` 九对孪生卡 seed 时强制软隐藏 R18）；收益用稳定态口径复核，不信瞬时计数。**P-18 core 手跑 app.* 代码必须显式带 `TOIV_DATABASE_URL`**（否则静默回落废弃 SQLite；生产 DB 地址只在 systemd 进程 env，从 `/proc/<pid>/environ` 取）；运维脚本第一步断言 `engine.url` 是 postgresql 否则 raise；结论一律 psql 复核。**P-18b 已根治(2026-10-15)**：app.smoke_started_at 列上线，提交写/reconcile 清，`/admin/apps/smoke/status` 透出 running_cards{count,without_started_at,max_age_sec,ids}；判孤儿用它，勿用 updated_at（无 onupdate）。**P-19 前端注释里的「这个端点不用鉴权」必须实测**：探活一律经带 authHeaders() 的统一封装；可加「直接断言后端源码含 Depends(get_current_user)」的防回归测试。**P-20 SPA 挂 /studio 子路径时硬编 `/api/...` 必 404**：任何绕过 `http`/`apiBaseURL` 自拼 URL 的请求（fetch/EventSource/img src/window.open）都是雷，新增必须走 apiBaseURL。**P-21 浏览器判「碎图」不能用 `complete && naturalWidth===0`**：lazy 视口外假阳性；先滚动再测、或 fetch 状态码、或过滤 `loading==="lazy" && !inViewport`。**P-22 永久失败(401/403)不能当「还没起来」轮询**（一次刷 3877 条 403 的教训）：给 403 打可判定标记→终态+清定时器；判断轮询看时间轴增量（等 25s 再数 growth=0）。**P-23 「代理改 Host」类诊断必须无副作用探针实证**：Next rewrite 会把 Host 改写成目标；真拦人的是 Origin 同源分支；`CANVAS_OPS_TRUSTED_ORIGINS` 精确 Origin 准入已上线。**P-24 时间戳口径**：api 用 `datetime.utcnow()` 落库=UTC，而 PG TimeZone=Asia/Shanghai、OS 是 CST；读「多久以前」必须先换算（本次把 1 分钟前的完成误读成 8 小时前，差点得出「战役停摆」）。**P-25 舰队重启必须串行**：并行重启互写共享 user 配置（tinyterra config.ini 交错损坏→整包注册失败、节点数 -41，靠 P-15 计数互核抓出）；api worker 池=core env 直连**不经 LB**（backends.json 排水对 api 无效）；web 核心构建 `rm -rf .next`=:3100 全站停到 build 完，按窗口取。

## 七、当前焦点（活口径）

### 2026-10-15 凌晨（止血+取窗批；10-14 叙事见 EXEC_LOG 批次 1-3）
- **真源**：`docs/ops/TECH_STACK_PLAN_20261014.md`(v3)+`UI_UNIFY_FUSION_PLAN_20261014.md`(F9-F12+FU1-FU5，D-U1=B 已拍板)+OSS 调研仓 `~/Desktop/ALLProject/Ai-OSS-Reference`（引入仅限 Apache/MIT/BSD 且逐仓读 LICENSE）。
- **本批已落**：LB 探针补丁(65 次抖动/3h→1)；:8263 卡死重启(节点数不降)；:8195 闲置 H3 stop+disable(回收 61G RAM+整张 GPU2)；api 捆绑包部署(DramaScene+SVML×2+img2threejs+registry 加固)；`TOIV_OPENTALKING_ENABLED=false` 生效；P-18b 根治 smoke_started_at+status 透出 running_cards；SVML 浏览器 e2e 取证；战役重启(日志出仓)。基线 api 4393 全绿。
- **口径纠正**：running 列=在飞非孤儿(main.py:252 启动即清)；smoke_at 是 UTC(勿按 CST 读)；吞吐真值 ~21/h 非 40-50/h；降速真因=host RAM 耗尽+75G swap(已解)，非 GPU0 争卡。
- **状态**：`session_checkpoint_2026_10_15`（STATE 同键）；批次 4 见 EXEC_LOG。

## 八、未完成任务总表（仅存开口项；已核销见归档/STATE.json）

### 产品
- [x] 非管理员视角市场复核（**2026-10-17 闭账**：建立 role=user 测试号 `e2e-user-review@toiv.test`（凭据在 core:/home/merlin/toiv/secrets/e2e_user_review.env，600）；SFW 可见 2763==PG `is_public AND NOT is_nsfw` 2763、X-NSFW 上下文 2797==PG 全公开 2797，非公开/NSFW 零泄漏；顺带证实 /api/apps 分页契约=limit/offset（page 参数 422））
- [x] W0-1b canvas `web/test/asset-view-scope.browser.test.ts` 既有红灯（**2026-10-17 根治**：harness 构建按 key 逐个 define `import.meta.env.*` 漏 `BASE_URL`，src/lib/app-base.ts 引用即白屏、dialog 永不出现；改整体注入 `import.meta.env` 对象后 4/4 绿，防后续键漂移）
- [x] W0-2 门禁：pathname-key **已摘**（`w02-pathname-key.test.ts` 防回归）；**2026-10-17 真机回归闭账**：drama↔library↔market↔tasks 应用内点击往返×10=40/40 PASS（壳存续/无登录弹回/无崩溃，Playwright 实测）
- [x] Slice C 触发条件重定义（**2026-10-17 对齐收口**：按 V5 计划判定 Slice C=线上可见性验证项而非代码缺口；触发口径并入 W8 单一上架口径=「is_public + soft-hide + NSFW 门控」，已由非管理员市场复核同源实测覆盖（2763/2797 对账零泄漏），不再单立触发条件）
- [ ] SeC 387721：einops reshape 错=SecNodes×torch2.13/sm_120 上游边界（保留观察）
- [x] FU1 词锚定时间轴+改词重排（2026-10-15 落码；**2026-10-17 已部署+真机 e2e 闭账**：SVML 导入→投影→改词重排→DB 重载全链实证，beats_json/scene_ref_json 迁移已落 PG；授权破窗部署，running=2 由启动期 reconcile 收口）
- **T-U UI 优化波（2026-10-14 用户拍板，高优先）**：整体 UI 审计+体验修复；含数字人入口下架隐藏

### 设备/运维
- [ ] openclaw02-04 + cloud tailscaled 恢复（需现场）
- [ ] core BIOS 来电自启建议设置（断电后需人工确认）
- [ ] pc01 修复非紧急（已撤池；可达时补 kernels 0.16.x）
- [ ] SenseVoice 接 `/api/nas/models`（权重在 NAS，等 picker 盘扫）
- [ ] H3 service-token exp 2026-10-17 06:20（自动刷新已 enable，届时留意一跳）
- [ ] 旧 Admin JWT 吊销（HOLD，等设备侧执行）
- [ ] MODEL_SOURCES 持续追加（当前 ok487/blocked337/total825）
- [ ] **T1 吞吐解锁（2026-10-17 P-14 重枚举修正）**：旧「392 缺件装包」口径已过期——batch10 已查明 missing_node 大头=RH 云端节点(shim 范畴)+类键漂移+陈旧错误，真装包仅少量且已装（WanAnimatePlus/Qwen-Image_new/classkey aliases）；吞吐修复后实测 67/h（非 21/h）。现网残余（PG 重析）：FlashVSR streaming_dmd 模型缺件 **2026-10-17 已装**（5.24GiB→NAS 主库+/opt/ComfyUI/models/FlashVSR-v1.1，解锁 20 app）；missing_node_type 8 类 59 例（RH Captioner shim ~5、类键漂移 2、小节点包 4、inspyrenet 2 留档）C 波暂存中；timeout 424+1800s 27=900s 重估口径另账
- [ ] W8 冒测战役：未测 10961（image 5812/video 5064/audio 89），~21/h；368 条 timeout 归因需按 SEEDVR2 长 CPU 阶段重估（900s 超时把真作业打成假 timeout）
