# 对口型(LatentSync 1.6)worker 侧设置

> 漫剧 B 阶段 · 让分镜视频里角色的嘴型对上配音。后端见 `apps/api/app/routes/lipsync.py`
> + `apps/api/app/workflows/lipsync.py`(纯函数构造 LatentSync 工作流图)。
> 以下为 worker(.100 ComfyUI)侧的一次性环境准备 —— **非 git 部署内容,手动复现**。

## 节点
- `ComfyUI-LatentSyncWrapper`(LatentSyncNode)+ `ComfyUI-VideoHelperSuite`(VHS_LoadVideo/VHS_VideoCombine)已装。
- 节点 Python 依赖(mediapipe / face-alignment 等)已随 wrapper 装好(节点能进 object_info 即证)。

## 模型(已下)
```
hf download ByteDance/LatentSync-1.6 \
  --include latentsync_unet.pt "whisper/tiny.pt" \
  --local-dir <wrapper>/checkpoints
```
落到 `custom_nodes/ComfyUI-LatentSyncWrapper/checkpoints/`:
- `latentsync_unet.pt`
- `whisper/tiny.pt`

## 坑 ①:torchcodec(torch 2.10 / torchvision 0.25)—— 已解决
comfy venv 是 **torch 2.10.0+cu130 / torchvision 0.25**。我曾 `pip install torchcodec` 但其
`libtorchcodec_core*.dll` 与 torch 2.10/cu130 不配、加载失败(缺匹配 FFmpeg)。

**实测诊断(关键)**:**卸载 torchcodec** 后 —— `io.write_video` / `io.read_video` 各自有
非 torchcodec 路径、**正常工作**;唯独 `torchaudio.save` 硬依赖 torchcodec。

**最终修复(已落)**:
1. `pip uninstall -y torchcodec`(让 write/read 走自带路径)。
2. patch `nodes.py`:`torchaudio.save(audio_path, waveform_cpu, sr)` →
   `import soundfile as _sf; _sf.write(audio_path, waveform_cpu.numpy().T, sr)`。
   (另有一处 write_video 的 `except TypeError`→`except Exception` 兜底,现非必需,无害保留。)
备份:`nodes.py.toivbak`。

## 生效(已做)
补丁改磁盘 `nodes.py` + 卸 torchcodec 是 venv 级,**ComfyUI 需重启重载**。
**已滚动重启全部 4 个 worker(8000/8002/8003/8004)**,补丁全激活。
重启脚本 = 重跑 `F:\toiv_worker{0-3}.bat`(net use NAS + comfy --port --cuda-device),
经 schtasks 脱离 SSH。**E2E 验证**:管线端到端跑通到人脸检测(无 torchcodec 报错)。

## ⚠ 已确认的硬局限:不支持动漫脸
实测:生成动漫近景脸 → LatentSync **"Face not detected"**。LatentSync 人脸检测+同步模型
训练于**真人脸**,**对动漫脸不工作**。故对口型仅适用**写实层(电视剧/电影)**。
**漫剧/动漫的口型需换方案** —— worker 已装 **MultiTalk(WanVideoImageToVideoMultiTalk)/
FantasyTalking**(音频驱动生成,Wan 系,可能支持动漫),待评估/接入。

## 工作流链
```
VHS_LoadVideo(源视频, force_rate=25) → 帧
LoadAudio(配音 wav) → 音频
LatentSyncNode(帧, 音频, lips_expression=1.5, inference_steps=20) → 同步帧 + 音频
VHS_VideoCombine(同步帧, 25fps, h264, audio) → 成片
```
后端把源视频 + 配音下载后上传到选中 worker 的 input 再提交。

## 已知局限
LatentSync 训练于**真人脸**,人脸检测对**动漫脸**可能不稳。写实层(电视剧/电影)效果好;
纯动漫漫剧的口型质量需用真实分镜验证,必要时换 anime 友好的口型方案(后续)。
