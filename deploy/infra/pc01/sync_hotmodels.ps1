# Hot-model sync: NAS (Z:) -> RAM disk (R:)
# Runs at startup (scheduled task RamDiskHotSync) or manually.
$ErrorActionPreference = 'Continue'
$log = 'C:\ComfyUI\sync_hotmodels.log'
Start-Transcript -Path $log -Append -Force

# 0. Ensure R: exists (ImDisk, 2026-09-14 从 SoftPerfect 试用版迁移;60G 预分配=t vm)
if (-not (Test-Path 'R:\')) {
    & 'C:\Windows\System32\imdisk.exe' -a -t vm -s 60G -m R: -p "/FS:NTFS /Q /V:HotModels /Y"
    $n = 0
    while (-not (Test-Path 'R:\') -and $n -lt 30) { Start-Sleep 1; $n++ }
}
if (-not (Test-Path 'R:\')) { Write-Host 'FATAL: R: not available'; Stop-Transcript; exit 1 }

# 1. Mount NAS in this session (W-2: self-mount)
net use Z: /delete /y 2>$null | Out-Null
net use Z: \\192.168.71.7\NAS /user:dgmt-nas Aki.19950108 | Out-Null

# 2. Sync sets (robocopy per-file via /IF)
$sets = @(
    @{ src='Z:\Windows\ComfyUI\ComfyUIModel\models\checkpoints'; dst='R:\models\checkpoints'; files=@('flux1-dev-fp8.safetensors','flux2_dev_fp8mixed.safetensors') },
    @{ src='Z:\Windows\ComfyUI\ComfyUIModel\models\vae';           dst='R:\models\vae';           files=@('ae.safetensors','flux2-vae.safetensors') },
    @{ src='Z:\Windows\ComfyUI\ComfyUIModel\models\upscale_models'; dst='R:\models\upscale_models'; files=@('4x-UltraSharp.pth','RealESRGAN_x2plus.pth') },
    @{ src='Z:\Windows\ComfyUI\ComfyUIModel\models\loras';         dst='R:\models\loras';         files=@('wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors','wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors','realism_engine_krea2_v3.1.safetensors','Qwen-Image-Edit-2509-Lightning-8steps-V1.0-fp32.safetensors') }
)
foreach ($s in $sets) {
    New-Item -ItemType Directory -Force -Path $s.dst | Out-Null
    $fileArgs = $s.files | ForEach-Object { "/IF" ; $_ }
    robocopy $s.src $s.dst /E /COPY:DAT /R:2 /W:2 /NFL /NDL /NP $fileArgs | Out-Null
    Write-Host ("synced {0} -> {1} rc={2}" -f $s.src, $s.dst, $LASTEXITCODE)
}

# 3. Ready flag for StartComfyUI gate
Get-ChildItem R:\models -Recurse -File | Measure-Object Length -Sum | ForEach-Object {
    "{0} files, {1:N1} GB" -f $_.Count, ($_.Sum/1GB)
} | Out-File -Encoding ascii R:\ready.flag -Force
Write-Host "READY"
Stop-Transcript
