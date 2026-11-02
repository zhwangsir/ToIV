# .env port note (DRAFT — do not apply)

**Read 2026-11-02 Asia/Shanghai** from core `/home/merlin/toiv/deploy/.env`.

## Text LLM — already correct

No change needed for ToIV text LLM vars; they already target TensorFold:

- `TOIV_LLM_BASE_URL=http://192.168.71.84:8888/v1`
- `TOIV_LLM_NSFW_BASE_URL=http://192.168.71.84:8888/v1`
- `TOIV_LLM_L2_BASE_URL=http://192.168.71.84:8888/v1`
- `TOIV_LLM_L3_BASE_URL=http://192.168.71.84:8888/v1`
- Model display: `DeepSeek-V4.1-Flash-1017` (comments document 2026-10-25 Mia :8888 switch)

## Leftover `:8000` (not LLM text — audit separately)

These still point at spark02 `:8000`, which is **down** on current hosts (no listener; live API is `:8888`):

- `TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.84:8000/v1`
- `TOIV_OMNI_CAPTIONER_BASE_URL=http://192.168.71.84:8000/v1`

**Do not blindly rewrite them to `:8888/v1`** — TensorFold head is a text LLM, not the Omni/VLM captioner endpoints those vars historically meant. Confirm real VLM hosts (e.g. workstation Comfy/VLM ports) before any edit.

One-line LLM suggestion (already satisfied): `TOIV_LLM_BASE_URL=http://192.168.71.84:8888/v1`
