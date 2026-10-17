---
name: toiv-platform
description: |
  AI 操作 ToIV 创作平台的产品侧手册：登录鉴权（email+JWT）、短剧创作全链（SVML 词锚脚本导入→分镜→改词重排→渲染/配音→任务中心）、场景锚点（变体/不可变冻结快照/绑定分镜）、角色设定卡（含 toonflow_board 四视图模板）、媒体作品与作业查询、加速档与 R18 上下文。当用户要 AI 代为在 ToIV 上创作/生成短剧、导入脚本、改台词重排时间轴、批量渲染、查作业或作品、生成角色参考板、绑定场景锚点，或编写调用 ToIV REST API 的自动化脚本时使用本 skill。集群 SSH/部署/凭据另见 toiv-cluster skill。
---

# ToIV 平台使用手册（AI 产品侧）

给 AI 助手的操作手册：如何以程序化方式驱动 ToIV 的创作能力。真源=本仓代码（`apps/api/app/routes/studio.py`、`drama_scenes.py`、`app/services/svml_lite.py`、`svml_timeline.py`）；本文标注核验日期 2026-10-16，端点语义与代码冲突时以代码为准。运维/SSH/部署见 `toiv-cluster` skill。

## 0. 心智模型（先读）

- **一个主 UI**：canvas `/studio`（SFW 主工作台）；web 只留登录+R18+官网。API 是唯一自动化面。
- **两个数据面**：`/api/studio/*`（StudioProject/StudioShot，短剧主链，词锚/时间轴在此）与 `/api/drama/*`（旧 Drama 域 + **scene_asset 场景锚点**，scene 端点双域兼容 Studio 项目/分镜 id）。
- **声明源纪律**：beats（拍结构）是时间的声明源，start/end 只是投影；改词→重排→派生对白/视觉文本，禁止把派生时间当事实写回。
- **锚点纪律**：冻结=内容寻址不可变快照（`scene_anchor_<sha16>.png`+sha256）；重复冻结产生新快照，已绑定分镜永不漂移。

## 1. 鉴权

```bash
# 登录（字段名是 email！）
curl -s -X POST http://192.168.71.47:8090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"admin","password":"admin123"}'   # → {"token":"..."}
# 之后所有请求带
-H "Authorization: Bearer $TOKEN"
```

- 外网入口 `https://toiv.wineryz.top`（同源 `/api`）；局域网优先 LAN。
- canvas 页面 URL 型访问（图片/下载/EventSource）走 `/studio/auth/exchange` 换会话 cookie；纯 API 自动化不需要。
- **R18 上下文**：请求头 `X-NSFW: 1` 才可见 R18 模型/应用/作品（默认 SFW）；未成年内容后端硬阻断，任何开关都绕不过。

## 2. 短剧创作主链（Studio 域）

### 2.1 建项目 + 导入 SVML 词锚脚本

SVML 语法（确定性拆镜，不经 LLM）：
- `||` 拍分隔（拍内字数估时 4.2 字/s，单拍夹 2–15s）
- `@{光}亮起@{/光}` 词锚（锚词跨拍附着）；`@{cue名}` 风格 cue
- `<小周|voice>` 说话人（`|voice` 后缀=进对白通道）
- `[scene:雨巷] [mood:压抑] [beat:3]` 元数据；`---` 分镜分隔
- 显式 `[duration:60]` / `<shot duration="60">` 总长 3–60s 不受估时夹限

```bash
curl -s -X POST .../api/studio/projects/$PID/import-svml \
  -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"script":"[duration:60]\n推近||@{光}亮起@{/光}\n<小周>旧词||旧尾"}'
# → {shots:[{..., beats:[{text,cues,anchor_words,kind,block,start_sec,end_sec,est_sec}], duration_sec}]}
```

- beats 响应是**服务端投影**（总长优先、末拍精确对齐）；前端/脚本不要自己估时。
- 落库走「建角色 + PUT shots 全量替换」单一写路径。

### 2.2 保存分镜（全量替换语义！）

```bash
curl -s -X PUT .../api/studio/projects/$PID/shots \
  -d '{"shots":[{"scene":"...","prompt":"...","dialogue":"...","duration_sec":6,
       "render_mode":"video","beats":[{"text":"...","cues":[],"anchor_words":"","kind":"d","block":0}]}]}'
```

- **PUT 是全量替换**：漏传的镜会被删；`beats` 字段 `null`=不改，`[]`=清空。
- 拍声明带 `kind`(v=视觉/d=对白) 时，保存会派生覆盖 prompt/dialogue 消费文本（防改词后生成文本脱节）。

### 2.3 改词重排（词锚投影）

```bash
curl -s -X POST .../api/studio/shots/$SID/reflow-beats \
  -d '{"texts":["新词","新尾"],"total_sec":30,"persist":true}'
```

- `texts` 须与拍数等长（空白编辑也保留一拍及其锚/cue）；`total_sec` 3–60 缺省沿用当前总长。
- `persist:false`=试算不落库（响应带 `persisted:false`+投影）；`persist:true` 同步派生 dialogue/prompt 并更新 updated_at。
- 无拍结构的镜改词 → 422「无词锚拍结构」；跨用户 → 404。

### 2.4 渲染/配音/任务

```bash
curl -s -X POST .../api/studio/shots/$SID/render -H "Authorization: Bearer $TOKEN"   # 单镜
curl -s -X POST .../api/studio/projects/$PID/render -d '{"accel":"off"}'             # 整批
curl -s -X POST .../api/studio/shots/$SID/voice -H "Authorization: Bearer $TOKEN"   # 配音
```

- **加速档**：产品默认满血 `accel:"off"`；提速是显式选项（`GET /api/acceleration/tiers` 查档位，h3 档带实测 speedup/ssim）。
- 异步作业查 `GET /api/jobs`（状态/错误/hold_reason），取消 `POST /api/jobs/{id}/cancel`。UI 侧任务中心=ToIV 作业+画布任务+智能体三源。
- 多候选：生成后 `candidates` 数组择一 `is_picked`；「DB 标 error ≠ 失败」先查产物再重提。

## 3. 场景锚点（scene_asset，跨镜背景一致性）

```bash
# 建基础场景（Studio 项目 id 可直接用）
POST /api/drama/projects/$PID/scenes  {"name":"雨巷","environment_prompt":"rainy alley","master_ref":"/api/studio/files/x.png"}
# 派生变体：只存增量+时段，环境继承基础
POST /api/drama/scenes/$SID/variants {"variant_prompt":"neon signs on","time_of_day":"night"}
# time_of_day 白名单：morning|noon|afternoon|dusk|night|late_night|dawn
# 冻结锚点（master=场景主参考 / reverse=反向参考 / selected=传 image_url）
POST /api/drama/scenes/$SID/freeze-anchor {"anchor_id":"master"}
# 绑定分镜（scene_ref 写入分镜；锚点=不可变快照 URL+sha256）
POST /api/drama/scenes/$SID/attach {"shot_id":"$SHOT_ID","use_frozen":true}
# 读回
GET /api/drama/shots/$SHOT_ID/scene-ref
```

- **渲染自动消费**：绑定后 H3 渲染链把锚点快照注入场景参考最前（跨镜共背景）；attach 还会幂等把组装环境词前置进分镜 prompt。
- 重冻不改旧绑定；要换背景=再冻结再绑定。删除场景=级联删变体+就地解绑分镜。

## 4. 角色设定卡（含四视图模板）

```bash
POST /api/studio/characters/$CID/character-sheet \
  -d '{"style":"anime","template":"toonflow_board","height_cm":168}'
# 或异步：POST .../character-sheet/async → {job_id} → GET .../async/{job_id}
```

- `style`：`anime`（二次元）| `ancient_realistic`（古风写实）。
- `template:"toonflow_board"`=Toonflow 四视图参考板：**特写+正面全身+严格右侧90°+背面全身**横排拼版；默认空=经典设定卡（立绘+三视图+面部格）。
- 首次定妆自动写入 `reference_images_by_style` 分桶供视频链取参考；`apply_to_video_refs:false` 时已有分桶不覆盖。

## 5. 媒体与文件

- 视频作业完成后自动产 Packed Transcript（`<产物名>.transcript.md`，whisper 词级 verbatim→pack），可用 `/api/fusion/transcript/of-video` 读取。

- 产物 URL 归属校验+签名，媒体走 `?token=`；不要把 URL 外传给无归属会话。
- studio 文件面：`/api/studio/files/{name}`（设定卡格/场景锚点快照都在这）。
- 作品库：`/api/jobs` 产物即作品；回收站/检索走 canvas `/studio/library`。

## 6. 边界与纪律（AI 必读）

1. **只经 API/UI 做产品操作**；SSH/部署/PG/重启是运维面→`toiv-cluster` skill，且**冒测战役（PG running>0）禁重启 toiv-api**。
2. 写路径全部有归属校验：跨用户/跨租户一律 404，别试越权。
3. PUT shots=全量替换；批量写前先 GET 当前态再合并，防误删。
4. 改词后必须走 `reflow-beats`（或带 beats 的 save）派生对白/视觉文本，禁止只改 beats 文本而留旧生成文本。
5. 422=输入问题（读 detail），503=算力/依赖缺，`gate_status=未通过-需复核` 类门禁=fail-closed 不放行，别绕。
6. 生成默认满血档；量化/加速只作显式选项。品牌文案只用 ToIV。
7. 手跑后端代码/脚本见 toiv-cluster 的 `TOIV_DATABASE_URL` 纪律；凭据不写日志不外传。

## 7. 端点速查表

| 动作 | 端点 | 关键参数 |
|---|---|---|
| 登录 | `POST /api/auth/login` | `email`+`password`→`token` |
| SVML 导入 | `POST /api/studio/projects/{pid}/import-svml` | `script`, `auto_duration` |
| 读项目/分镜 | `GET /api/studio/projects/{pid}` | shots.beats=服务端投影 |
| 存分镜(全量) | `PUT /api/studio/projects/{pid}/shots` | `shots[]`, beats null=不改 |
| 改词重排 | `POST /api/studio/shots/{sid}/reflow-beats` | `texts[]`,`total_sec`3-60,`persist` |
| 渲染 | `POST /api/studio/shots/{sid}/render` / `projects/{pid}/render` | `accel` |
| 配音/对口型 | `POST /api/studio/shots/{sid}/voice` / `lipsync` | — |
| 场景清单/新建 | `GET/POST /api/drama/projects/{pid}/scenes` | name,environment_prompt,master_ref |
| 派生变体 | `POST /api/drama/scenes/{sid}/variants` | variant_prompt,time_of_day |
| 冻结锚点 | `POST /api/drama/scenes/{sid}/freeze-anchor` | anchor_id, image_url |
| 绑定分镜 | `POST /api/drama/scenes/{sid}/attach` | shot_id,use_frozen |
| 读锚点 | `GET /api/drama/shots/{shot_id}/scene-ref` | — |
| 设定卡 | `POST /api/studio/characters/{cid}/character-sheet(/async)` | style,template |
| 作业 | `GET /api/jobs` / `POST /api/jobs/{id}/cancel` | — |
| 加速档 | `GET /api/acceleration/tiers` | — |
| LLM 代理 | `/api/llm/v1/*` | 需 JWT+白名单模型 |
| 词转写打包 | `POST /api/fusion/transcript/pack` | 词级 JSON→短语级 `[start-end]` markdown |
| 读产物转写 | `GET /api/fusion/transcript/of-video?path=` | 自动生成的 .transcript.md(路径限媒体目录) |
| EDL 体检 | `POST /api/fusion/edl/validate` | 词内切/越界/非法时间拒绝 |
| 剪点计划 | `POST /api/fusion/edl/cut-plan` | 安全切点窗+pad 30-200ms |
| 成片自评 | `POST /api/fusion/qa/review` | 剪点±1.5s 跳帧/爆音/遮挡+响度 |
| 视觉下钻 | `POST /api/fusion/qa/timeline-png` | 胶片条+波形+词标签复合 PNG |
| manifest 校验 | `POST /api/fusion/manifest/validate` | FU5 管线声明 |

**契约补充**：列表分页=`limit/offset`（`page` 参数 422）；limit>1000 422（P-11 fail-closed）。
运维生产路径已更名 `/home/merlin/toiv-studio`（beeftv-prod 为过渡软链）；运维细节见 toiv-cluster。
