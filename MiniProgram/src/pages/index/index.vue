<script setup lang="ts">
/**
 * 创作页（Prompt-First：提示词是主角，引擎/参数收进抽屉）
 * 流程：选引擎 → 填提示词 →（引擎需要时）传参考图 → 提交 → 跳作业页轮询
 * 草稿：作品库"再次创作"经 draft store 回填，一次性消费
 */
import { computed, reactive, ref, watch } from 'vue';
import { onShow } from '@dcloudio/uni-app';

import {
  fetchEngines,
  optimizePrompt,
  reversePrompt,
  submitAceMusic,
  submitAvatarTalk,
  submitH3I2V,
  submitH3MultiShot,
  submitH3T2V,
  submitImg2Img,
  submitKeyframeChain,
  submitLongCatContinue,
  submitLongCatI2V,
  submitLongCatT2V,
  submitLtxNsfwI2V,
  submitLtxNsfwLipsync,
  submitLtxNsfwT2V,
  submitQwenEdit,
  submitTxt2Img,
  submitVaceEdit,
  submitWanAnimate,
  submitWanAnimate2,
  submitWanNsfwI2V,
  submitWanTransition,
  submitWanVace,
} from '@/api';
import ParamSheet from '@/components/business/param-sheet.vue';
import RefAudioField from '@/components/business/ref-audio-field.vue';
import RefImageField from '@/components/business/ref-image-field.vue';
import RefVideoField from '@/components/business/ref-video-field.vue';
import TabBar from '@/components/business/tab-bar.vue';
import Button from '@/components/ui/button.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import Sheet from '@/components/ui/sheet.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import { useDraftStore } from '@/stores/draft';
import type {
  EngineInfo,
  GenerateResponse,
  UploadedRefAudio,
  UploadedRefImage,
  UploadedRefVideo,
} from '@/types/api';
import { registerJobSseCredentials } from '@/utils/job-sse-registry';
import {
  buildAceMusicRequest,
  buildAvatarTalkRequest,
  buildH3I2VRequest,
  buildH3MultiShotRequest,
  buildH3NsfwI2VRequest,
  buildH3NsfwT2VRequest,
  buildH3T2VRequest,
  buildImg2ImgRequest,
  buildKeyframeChainRequest,
  buildLongCatContinueRequest,
  buildLongCatI2VRequest,
  buildLongCatT2VRequest,
  buildLtxNsfwI2VRequest,
  buildLtxNsfwLipsyncRequest,
  buildLtxNsfwT2VRequest,
  buildQwenEditRequest,
  buildTxt2ImgRequest,
  buildVaceEditRequest,
  buildWanAnimate2Request,
  buildWanAnimateRequest,
  buildWanNsfwI2VRequest,
  buildWanTransitionRequest,
  buildWanVaceRequest,
  defaultParamValues,
  engineImagesMax,
  engineNeedsAudio,
  engineNeedsMultiImage,
  engineNeedsRefImage,
  engineNeedsVideo,
  engineSheetParams,
  isEngineSupported,
  parseMultiShotPrompts,
  uploadKindForEngine,
} from '@/utils/build-request';

const { themeVars } = useAppTheme();
const { auth, requireAuth } = useAuthGuard();
const draft = useDraftStore();

// ── 引擎 ──
const engines = ref<EngineInfo[]>([]);
const enginesError = ref('');
const enginesLoading = ref(false);
const selectedEngineId = ref<string>('');

const engine = computed<EngineInfo | null>(
  () => engines.value.find((e) => e.id === selectedEngineId.value) ?? null,
);
// 自动选择只在「可用 + 已接入」集合内进行，未接入引擎永远不进表单
const selectableEngines = computed(() =>
  engines.value.filter((e) => e.available && isEngineSupported(e)),
);
// 进阶引擎(LTX/Wan)沉底,普通用户先看到 H3
const listedEngines = computed(() => {
  const rows = engines.value.slice();
  rows.sort((a, b) => Number(Boolean(a.advanced)) - Number(Boolean(b.advanced)));
  return rows;
});
const needsMultiImage = computed(() => engineNeedsMultiImage(engine.value));
const needsRefImage = computed(() => engineNeedsRefImage(engine.value) && !needsMultiImage.value);
const imagesMax = computed(() => Math.max(engineImagesMax(engine.value), 1));
const needsVideo = computed(() => engineNeedsVideo(engine.value));
const needsAudio = computed(() => engineNeedsAudio(engine.value));
const uploadKind = computed(() => uploadKindForEngine(engine.value?.id ?? ''));
/** 单图字段标签取注册表 images 参数 label（avatar-talk 为「人像首帧」，缺省「参考图」） */
const refImageLabel = computed(
  () => engine.value?.params?.find((p) => p.type === 'images')?.label ?? '参考图',
);
/** 多图字段标签（wan-transition 首尾帧 / keyframe-chain 关键帧 / wan-vace 参考图） */
const multiImageLabel = computed(
  () => engine.value?.params?.find((p) => p.type === 'images')?.label ?? '参考图（1-4 张）',
);
/** 视频字段标签（vace-edit 为「源视频」，缺省「驱动视频」） */
const refVideoLabel = computed(
  () => engine.value?.params?.find((p) => p.type === 'video')?.label ?? '驱动视频',
);
/** 抽屉参数（avatar-talk 的 text 占位 audio 键由音频上传字段承担，剔除） */
const sheetParams = computed(() => engineSheetParams(engine.value));

async function loadEngines() {
  enginesLoading.value = true;
  enginesError.value = '';
  try {
    engines.value = await fetchEngines();
    if (!engine.value && selectableEngines.value.length > 0) {
      // 不要落到 LTX/Wan 进阶引擎;图像默认仍是第一项非进阶(文生图)
      const preferred =
        selectableEngines.value.find((e) => !e.advanced) ??
        selectableEngines.value[0];
      selectEngine(preferred.id);
    }
  } catch (err) {
    enginesError.value = err instanceof Error ? err.message : '引擎加载失败';
  } finally {
    enginesLoading.value = false;
  }
}

// ── 表单 ──
const prompt = ref('');
const negative = ref('');
const showNegative = ref(false);
const paramValues = reactive<Record<string, unknown>>({});
const refImage = ref<UploadedRefImage | null>(null);
const refImages = ref<UploadedRefImage[]>([]);
const refVideo = ref<UploadedRefVideo | null>(null);
const refAudio = ref<UploadedRefAudio | null>(null);

const paramSheetVisible = ref(false);
const engineSheetVisible = ref(false);

// ── 对话助手入口（MP19） ──
function goAssistant() {
  uni.navigateTo({ url: '/pages/assistant/assistant' });
}

function selectEngine(id: string) {
  selectedEngineId.value = id;
  const target = engines.value.find((e) => e.id === id);
  const defaults = defaultParamValues(target);
  for (const key of Object.keys(paramValues)) delete paramValues[key];
  Object.assign(paramValues, defaults);
  refImage.value = null;
  refImages.value = [];
  refVideo.value = null;
  refAudio.value = null;
}

/**
 * 抽屉编辑回写：paramValues 是 reactive 引用（直接 v-model 会对 const 重新赋值，
 * 运行时被 Vue 错误吞掉、编辑静默丢失），显式清空+合并保持同一引用
 */
function onParamValuesUpdate(next: Record<string, unknown>) {
  for (const key of Object.keys(paramValues)) delete paramValues[key];
  Object.assign(paramValues, next);
}

// 引擎切换时若不再需要对应媒体，清掉已选
watch(needsRefImage, (needs) => {
  if (!needs) refImage.value = null;
});
watch(needsMultiImage, (needs) => {
  if (!needs) refImages.value = [];
});
watch(needsVideo, (needs) => {
  if (!needs) refVideo.value = null;
});
watch(needsAudio, (needs) => {
  if (!needs) refAudio.value = null;
});

/**
 * 单参考图变更：wan-animate / ltx-nsfw-lipsync 场景下若驱动视频/音频钉的是旧 worker
 * （互钉失配），清掉已传媒体强制重传（字段按 refImage key 重建，内部预览同步复位）
 */
function onSingleImageChange(v: UploadedRefImage | UploadedRefImage[] | null) {
  const next = Array.isArray(v) ? (v[0] ?? null) : v;
  refImage.value = next;
  if (refVideo.value && refVideo.value.worker !== (next?.worker ?? '')) {
    refVideo.value = null;
  }
  if (refAudio.value && refAudio.value.worker !== (next?.worker ?? '')) {
    refAudio.value = null;
  }
}

function onMultiImagesChange(v: UploadedRefImage | UploadedRefImage[] | null) {
  refImages.value = Array.isArray(v) ? v : v ? [v] : [];
}

// ── 提交 ──
const submitting = ref(false);
const formError = ref('');

// ── MP17 反推提示词：选图/视频 → POST /api/reverse → VLM 反推英文 prompt 回填 ──
const reversing = ref(false);

/**
 * MP17 反推提示词：选图/视频 → POST /api/reverse → VLM 反推英文 prompt 回填
 * 选择器 = showActionSheet + chooseImage/chooseVideo：uni.chooseMedia 仅微信小程序系实现，
 * uni-h5 导出清单无该 API（以 node_modules/@dcloudio/uni-h5/dist 源码验证），点按无响应；
 * 统一改走全端已实现的三件套，行为与 ref-image-field / ref-video-field 一致
 */
function handleReverse() {
  if (reversing.value || submitting.value) return;
  formError.value = '';
  // 音频反推小程序平台无系统选择器（chooseMessageFile 仅微信会话文件），本期范围图片/视频
  uni.showActionSheet({
    itemList: ['图片', '视频'],
    success: ({ tapIndex }) => {
      if (tapIndex === 0) {
        uni.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          success: (res) => {
            const filePath = res.tempFilePaths[0];
            if (filePath) void runReverse(filePath);
          },
          fail: () => {
            // 用户取消不提示
          },
        });
      } else if (tapIndex === 1) {
        uni.chooseVideo({
          sourceType: ['album', 'camera'],
          success: (res) => {
            if (res.tempFilePath) void runReverse(res.tempFilePath);
          },
          fail: () => {
            // 用户取消不提示
          },
        });
      }
    },
    fail: () => {
      // 用户取消不提示
    },
  });
}

/** 反推执行：prompt 覆盖语义对齐 Web GenerateView；negative 有值则展开填入 */
async function runReverse(filePath: string) {
  reversing.value = true;
  try {
    const r = await reversePrompt(filePath);
    prompt.value = r.prompt;
    if (r.negative) {
      negative.value = r.negative;
      showNegative.value = true;
    }
    uni.showToast({
      title: r.kind === 'video' ? '已反推视频内容并填入' : '已反推画面内容并填入',
      icon: 'none',
    });
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '反推失败，请重试';
  } finally {
    reversing.value = false;
  }
}

// ── MP18 优化提示词：口语输入 → POST /api/optimize → LLM 扩写专业英文 prompt 回填 ──
const optimizing = ref(false);

/**
 * MP18 优化提示词（回填语义对齐 Web OptimizeButton：prompt 覆盖 + negative 有值展开填入）
 * kind 跟随当前选中引擎（image/video/audio 直通后端题材判定）；空 prompt 不发起（按钮态同步禁用）
 * model/style/agent 为 Web 高阶入参（模型族方言/智能体人格），移动端本期走后端默认
 */
async function handleOptimize() {
  if (optimizing.value || submitting.value || reversing.value) return;
  const text = prompt.value.trim();
  if (!text) return;
  formError.value = '';
  optimizing.value = true;
  try {
    const r = await optimizePrompt({ prompt: text, kind: engine.value?.kind ?? 'image' });
    prompt.value = r.optimized;
    if (r.negative) {
      negative.value = r.negative;
      showNegative.value = true;
    }
    uni.showToast({ title: '已优化并填入', icon: 'none' });
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '优化失败，请重试';
  } finally {
    optimizing.value = false;
  }
}

const canSubmit = computed(() => {
  if (submitting.value) return false;
  if (!engine.value) return false;
  const id = engine.value.id;
  // wan-animate-2 提示词可空（后端自动反推外观）；qwen-image-edit 指令与相机角度至少一项
  const camera = typeof paramValues.camera === 'string' ? paramValues.camera.trim() : '';
  const promptOk =
    id === 'wan-animate-2' ||
    (id === 'qwen-image-edit' && (prompt.value.trim().length > 0 || camera.length > 0)) ||
    (id !== 'qwen-image-edit' && prompt.value.trim().length > 0);
  if (!promptOk) return false;
  if (needsRefImage.value && !refImage.value) return false;
  if (id === 'wan-transition') {
    if (refImages.value.length !== 2) return false;
  } else if (id === 'keyframe-chain') {
    if (refImages.value.length < 2) return false;
  } else if (needsMultiImage.value && refImages.value.length === 0) {
    return false;
  }
  if (id === 'h3-multishot' && parseMultiShotPrompts(prompt.value).length < 2) return false;
  if (needsVideo.value && !refVideo.value) return false;
  if (needsAudio.value && !refAudio.value) return false;
  return true;
});

async function handleSubmit() {
  formError.value = '';
  if (!engine.value) {
    formError.value = '请选择一个生成引擎';
    return;
  }
  const engineIdPre = engine.value.id;
  const cameraPre = typeof paramValues.camera === 'string' ? paramValues.camera.trim() : '';
  if (
    engineIdPre !== 'wan-animate-2' &&
    !(engineIdPre === 'qwen-image-edit' && cameraPre.length > 0) &&
    prompt.value.trim().length === 0
  ) {
    formError.value = '请先描述你想生成的画面';
    return;
  }

  const values = { ...paramValues };
  if (negative.value.trim()) values.negative = negative.value;
  const engineId = engine.value.id;

  submitting.value = true;
  try {
    // MP29：提交响应集中登记（prompt_id+client_id+worker），作业页据此起 SSE 进度流
    let submitted: GenerateResponse | null = null;
    // 按引擎 id 显式路由（未接入引擎在栅格层已禁用，到不了这里）
    switch (engineId) {
      case 'qwen-image-edit':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitQwenEdit(buildQwenEditRequest(prompt.value, refImage.value, values));
        break;
      case 'h3-multishot': {
        const shots = parseMultiShotPrompts(prompt.value);
        if (shots.length < 2) {
          formError.value = '请用空行或「镜头一/镜头二」分隔 2-4 个镜头描述';
          submitting.value = false;
          return;
        }
        submitted = await submitH3MultiShot(buildH3MultiShotRequest(prompt.value, values));
        break;
      }
      case 'wan-transition':
        if (refImages.value.length !== 2) {
          formError.value = '请按顺序上传首帧与尾帧（共 2 张）';
          submitting.value = false;
          return;
        }
        submitted = await submitWanTransition(
          buildWanTransitionRequest(prompt.value, refImages.value, values),
        );
        break;
      case 'keyframe-chain':
        if (refImages.value.length < 2) {
          formError.value = '请按链序上传 2-5 张关键帧';
          submitting.value = false;
          return;
        }
        submitted = await submitKeyframeChain(
          buildKeyframeChainRequest(prompt.value, refImages.value, values),
        );
        break;
      case 'vace-edit':
        if (!refVideo.value) {
          formError.value = '请先上传源视频';
          submitting.value = false;
          return;
        }
        submitted = await submitVaceEdit(buildVaceEditRequest(prompt.value, refVideo.value, values));
        break;
      case 'wan-animate-2':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        if (!refVideo.value) {
          formError.value = '请先上传驱动视频';
          submitting.value = false;
          return;
        }
        submitted = await submitWanAnimate2(
          buildWanAnimate2Request(prompt.value, refImage.value, refVideo.value, values),
        );
        break;
      case 'wan-nsfw-i2v':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitWanNsfwI2V(
          buildWanNsfwI2VRequest(prompt.value, refImage.value, values),
        );
        break;
      case 'wan-animate':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        if (!refVideo.value) {
          formError.value = '请先上传驱动视频';
          submitting.value = false;
          return;
        }
        submitted = await submitWanAnimate(
          buildWanAnimateRequest(prompt.value, refImage.value, refVideo.value, values),
        );
        break;
      case 'wan-vace':
        if (refImages.value.length === 0) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitWanVace(buildWanVaceRequest(prompt.value, refImages.value, values));
        break;
      case 'h3-t2v':
        submitted = await submitH3T2V(buildH3T2VRequest(prompt.value, values));
        break;
      case 'h3-i2v':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitH3I2V(buildH3I2VRequest(prompt.value, refImage.value, values));
        break;
      case 'longcat-t2v':
        submitted = await submitLongCatT2V(buildLongCatT2VRequest(prompt.value, values));
        break;
      case 'longcat-i2v':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitLongCatI2V(buildLongCatI2VRequest(prompt.value, refImage.value, values));
        break;
      case 'longcat-continue': {
        // 源视频为注册表 text 参数（/api/images? 产物 URL），提交前必填校验
        const video = typeof values.video === 'string' ? values.video.trim() : '';
        if (!video) {
          formError.value = '请先在参数面板填写源视频产物 URL';
          submitting.value = false;
          return;
        }
        submitted = await submitLongCatContinue(buildLongCatContinueRequest(prompt.value, values));
        break;
      }
      case 'ace-music':
        // positive 主提示词映射 tags 风格标签（builder 内完成）
        submitted = await submitAceMusic(buildAceMusicRequest(prompt.value, values));
        break;
      case 'ltx-nsfw-t2v':
        submitted = await submitLtxNsfwT2V(buildLtxNsfwT2VRequest(prompt.value, values));
        break;
      case 'ltx-nsfw-i2v':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitLtxNsfwI2V(buildLtxNsfwI2VRequest(prompt.value, refImage.value, values));
        break;
      case 'ltx-nsfw-lipsync':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        if (!refAudio.value) {
          formError.value = '请先上传驱动音频';
          submitting.value = false;
          return;
        }
        submitted = await submitLtxNsfwLipsync(
          buildLtxNsfwLipsyncRequest(prompt.value, refImage.value, refAudio.value, values),
        );
        break;
      case 'h3-nsfw-t2v':
        // 与 SFW H3 同一 POST /api/h3/t2v 链路（专区内自带 X-NSFW 头，后端打标进 R18 库）
        submitted = await submitH3T2V(buildH3NsfwT2VRequest(prompt.value, values));
        break;
      case 'h3-nsfw-i2v':
        if (!refImage.value) {
          formError.value = '请先上传参考图';
          submitting.value = false;
          return;
        }
        submitted = await submitH3I2V(buildH3NsfwI2VRequest(prompt.value, refImage.value, values));
        break;
      case 'avatar-talk':
        if (!refImage.value) {
          formError.value = '请先上传人像首帧';
          submitting.value = false;
          return;
        }
        if (!refAudio.value) {
          formError.value = '请先上传驱动音频';
          submitting.value = false;
          return;
        }
        if (refAudio.value.worker !== refImage.value.worker) {
          // 互钉上传后理论恒同机，兜底比对（对齐 Web AvatarGenPanel workerMismatch）
          formError.value = '人像与音频未落在同一 worker，请移除后重新上传';
          submitting.value = false;
          return;
        }
        submitted = await submitAvatarTalk(
          buildAvatarTalkRequest(prompt.value, refImage.value, refAudio.value, values),
        );
        break;
      default:
        // 图像引擎（txt2img/img2img/nsfw-*）：保持既有二分行为
        if (engineNeedsRefImage(engine.value)) {
          if (!refImage.value) {
            formError.value = '请先上传参考图';
            submitting.value = false;
            return;
          }
          submitted = await submitImg2Img(buildImg2ImgRequest(prompt.value, refImage.value, values));
        } else {
          submitted = await submitTxt2Img(buildTxt2ImgRequest(prompt.value, values));
        }
        break;
    }
    if (submitted) registerJobSseCredentials(submitted);
    uni.showToast({ title: '已提交，前往作业查看', icon: 'none' });
    prompt.value = '';
    refImage.value = null;
    refImages.value = [];
    refVideo.value = null;
    refAudio.value = null;
    uni.reLaunch({ url: '/pages/jobs/jobs' });
  } catch (err) {
    formError.value = err instanceof Error ? err.message : '提交失败，请重试';
  } finally {
    submitting.value = false;
  }
}

// ── 生命周期 ──
onShow(() => {
  if (!requireAuth()) return;
  if (engines.value.length === 0) void loadEngines();
  // 消费作品库回填的草稿（一次性）
  if (draft.hasDraft) {
    const consumed = draft.consume();
    prompt.value = consumed.prompt;
    negative.value = consumed.negativePrompt;
    if (consumed.engineId) {
      if (engines.value.length > 0) selectEngine(consumed.engineId);
      else selectedEngineId.value = consumed.engineId;
    }
    if (consumed.negativePrompt) showNegative.value = true;
  }
});
</script>

<template>
  <view
    class="create"
    :style="themeVars"
  >
    <NavBar title="创作">
      <template #right>
        <view class="create__nav-actions">
          <view
            class="create__assistant-btn"
            hover-class="create__assistant-btn--pressed"
            @tap="goAssistant"
          >
            <Icon
              name="message-square"
              :size="40"
              color="var(--color-text)"
            />
          </view>
          <view
            class="create__engine-btn"
            hover-class="create__engine-btn--pressed"
            @tap="engineSheetVisible = true"
          >
            <Icon
              name="zap"
              :size="32"
              color="var(--color-accent)"
            />
            <text
              class="create__engine-name"
              number-of-lines="1"
            >
              {{ engine?.label ?? (enginesLoading ? '加载中…' : '选引擎') }}
            </text>
          </view>
        </view>
      </template>
    </NavBar>

    <scroll-view
      scroll-y
      class="create__scroll"
    >
      <view class="create__body">
        <!-- 提示词（主角） -->
        <view class="create__prompt-wrap">
          <textarea
            v-model="prompt"
            class="create__prompt"
            placeholder="描述你想生成的画面…"
            placeholder-class="create__prompt-placeholder"
            auto-height
            :maxlength="-1"
            :disabled="submitting"
          />
          <!-- MP18 优化 + MP17 反推：prompt 卡右下角 ghost 按钮组（对齐 Web OptimizeButton/ReverseButton 语言） -->
          <view class="create__prompt-actions">
            <!-- MP18 优化提示词：口语输入 → LLM 扩写专业英文 prompt 回填 -->
            <view
              class="create__optimize"
              :class="{ 'create__optimize--disabled': submitting || optimizing || !prompt.trim() }"
              hover-class="create__optimize--pressed"
              data-testid="optimize-btn"
              @tap="handleOptimize"
            >
              <Icon
                name="sparkles"
                :size="24"
                :color="optimizing ? 'var(--color-text-secondary)' : 'var(--color-accent)'"
              />
              <text class="create__optimize-text">
                {{ optimizing ? '优化中…' : '优化' }}
              </text>
            </view>
            <!-- MP17 反推提示词：选图/视频反推英文 prompt 回填 -->
            <view
              class="create__reverse"
              :class="{ 'create__reverse--disabled': submitting || reversing }"
              hover-class="create__reverse--pressed"
              data-testid="reverse-btn"
              @tap="handleReverse"
            >
              <Icon
                name="wand-sparkles"
                :size="24"
                :color="reversing ? 'var(--color-text-secondary)' : 'var(--color-accent)'"
              />
              <text class="create__reverse-text">
                {{ reversing ? '反推中…' : '反推' }}
              </text>
            </view>
          </view>
        </view>

        <!-- 负面提示词（可折叠次级输入） -->
        <view
          v-if="!showNegative"
          class="create__negative-toggle"
          @tap="showNegative = true"
        >
          <Icon
            name="plus"
            :size="28"
            color="var(--color-text-secondary)"
          />
          <text class="create__negative-toggle-text">
            添加负面提示词
          </text>
        </view>
        <view
          v-else
          class="create__negative"
        >
          <textarea
            v-model="negative"
            class="create__negative-input"
            placeholder="不想出现的内容（可选）"
            placeholder-class="create__prompt-placeholder"
            auto-height
            :maxlength="-1"
          />
        </view>

        <!-- 单参考图（img2img / qwen-image-edit / wan-animate / avatar-talk 人像首帧） -->
        <RefImageField
          v-if="needsRefImage"
          :key="selectedEngineId"
          :label="refImageLabel"
          :kind="uploadKind"
          @change="onSingleImageChange"
        />

        <!-- 多参考图（wan-vace 1-4 张，第 2 张起互钉第 1 张 worker） -->
        <RefImageField
          v-if="needsMultiImage"
          :key="selectedEngineId"
          :label="multiImageLabel"
          :kind="uploadKind"
          :max="imagesMax"
          @change="onMultiImagesChange"
        />

        <!-- 驱动视频（wan-animate / wan-animate-2 / vace-edit 源视频） -->
        <RefVideoField
          v-if="needsVideo"
          :key="`${selectedEngineId}:${refImage?.filename ?? ''}`"
          :label="refVideoLabel"
          :kind="uploadKind"
          :pin-worker="refImage?.worker"
          @change="(v) => (refVideo = v)"
        />

        <!-- 驱动音频（ltx-nsfw-lipsync / avatar-talk，与参考图互钉同 worker；参考图变更后重建强制重传） -->
        <RefAudioField
          v-if="needsAudio"
          :key="`${selectedEngineId}:${refImage?.filename ?? ''}`"
          label="驱动音频"
          :kind="uploadKind"
          :pin-worker="refImage?.worker"
          @change="(v) => (refAudio = v)"
        />

        <!-- 引擎加载失败 -->
        <view
          v-if="enginesError"
          class="create__error-banner"
        >
          <Icon
            name="circle-alert"
            :size="32"
            color="var(--color-danger)"
          />
          <text class="create__error-text">
            {{ enginesError }}
          </text>
          <text
            class="create__error-retry"
            @tap="loadEngines"
          >
            重试
          </text>
        </view>

        <!-- 表单错误 -->
        <view
          v-if="formError"
          class="create__error-banner"
        >
          <Icon
            name="circle-alert"
            :size="32"
            color="var(--color-danger)"
          />
          <text class="create__error-text">
            {{ formError }}
          </text>
        </view>

        <!-- 恢复会话中 -->
        <view
          v-if="auth.status === 'restoring'"
          class="create__restoring"
        >
          <text class="create__restoring-text">
            正在恢复会话…
          </text>
        </view>
      </view>
    </scroll-view>

    <!-- 底部动作条 -->
    <view class="create__footer">
      <view
        class="create__params-btn"
        hover-class="create__params-btn--pressed"
        @tap="paramSheetVisible = true"
      >
        <Icon
          name="sliders-horizontal"
          :size="40"
          color="var(--color-text)"
        />
        <text class="create__params-text">
          参数
        </text>
      </view>
      <Button
        class="create__submit"
        label="生成"
        icon="send"
        :loading="submitting"
        :disabled="!canSubmit"
        block
        @click="handleSubmit"
      />
    </view>

    <!-- 参数抽屉 -->
    <ParamSheet
      :model-value="paramValues"
      :visible="paramSheetVisible"
      :params="sheetParams"
      @update:model-value="onParamValuesUpdate"
      @close="paramSheetVisible = false"
    />

    <!-- 引擎选择抽屉 -->
    <Sheet
      :visible="engineSheetVisible"
      title="选择引擎"
      @close="engineSheetVisible = false"
    >
      <view class="engine-list">
        <view
          v-for="item in listedEngines"
          :key="item.id"
          class="engine-item"
          :class="{
            'engine-item--active': item.id === selectedEngineId,
            'engine-item--disabled': !item.available || !isEngineSupported(item),
          }"
          hover-class="engine-item--pressed"
          @tap="
            item.available &&
              isEngineSupported(item) &&
              (selectEngine(item.id), (engineSheetVisible = false))
          "
        >
          <view class="engine-item__main">
            <view class="engine-item__head">
              <text class="engine-item__label">
                {{ item.label }}
              </text>
              <text
                v-if="item.nsfw"
                class="engine-item__badge"
              >
                R18
              </text>
              <text
                v-if="item.advanced"
                class="engine-item__badge"
              >
                进阶
              </text>
            </view>
            <text
              v-if="item.description"
              class="engine-item__desc"
              number-of-lines="2"
            >
              {{ item.description }}
            </text>
            <text
              v-if="!item.available"
              class="engine-item__reason"
            >
              {{ item.unavailable_reason ?? '暂不可用' }}
            </text>
            <text
              v-else-if="!isEngineSupported(item)"
              class="engine-item__reason"
            >
              即将支持
            </text>
          </view>
          <Icon
            v-if="item.id === selectedEngineId"
            name="check"
            :size="40"
            color="var(--color-accent)"
          />
        </view>
        <view
          class="param-sheet-bottom-gap"
          style="height: 64rpx"
        />
      </view>
    </Sheet>

    <TabBar :selected="0" />
  </view>
</template>

<style scoped lang="scss">
.create {
  min-height: 100vh;
  background: var(--color-bg);
  display: flex;
  flex-direction: column;

  &__nav-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__assistant-btn {
    min-width: 64rpx;
    min-height: 64rpx;
    display: flex;
    align-items: center;
    justify-content: center;

    &--pressed {
      opacity: 0.6;
    }
  }

  &__engine-btn {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    max-width: 320rpx;
    min-height: 64rpx;
    padding: 0 var(--space-3);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);

    &--pressed {
      opacity: 0.8;
    }
  }

  &__engine-name {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
    overflow: hidden;
  }

  &__scroll {
    flex: 1;
  }

  &__body {
    padding: var(--space-4) var(--space-6);
    display: flex;
    flex-direction: column;
    gap: var(--space-4);
  }

  &__prompt-wrap {
    position: relative;
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg);
    padding: var(--space-4);
  }

  /* MP18 优化 + MP17 反推：prompt 卡右下角 ghost 按钮组（对齐 Web ob-btn 语言） */
  &__prompt-actions {
    position: absolute;
    right: var(--space-3);
    bottom: var(--space-3);
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__reverse,
  &__optimize {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1) var(--space-3);
    border-radius: var(--radius-md);
  }

  &__reverse--pressed,
  &__optimize--pressed {
    background: var(--color-accent-soft);
  }

  &__reverse--disabled,
  &__optimize--disabled {
    opacity: 0.4;
  }

  &__reverse-text,
  &__optimize-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
  }

  &__prompt {
    width: auto;
    min-height: 200rpx;
    font-size: var(--font-body);
    line-height: 1.6;
    color: var(--color-text);
  }

  &__prompt-placeholder {
    color: var(--color-text-secondary);
  }

  &__negative-toggle {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-1);
    min-height: 64rpx;
  }

  &__negative-toggle-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__negative {
    background: var(--color-surface);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    padding: var(--space-3) var(--space-4);
  }

  &__negative-input {
    width: auto;
    min-height: 96rpx;
    font-size: var(--font-body);
    color: var(--color-text);
  }

  &__error-banner {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-md);
    background: var(--color-accent-soft);
  }

  &__error-text {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-danger);
  }

  &__error-retry {
    font-size: var(--font-caption);
    color: var(--color-accent);
    font-weight: 500;
    padding: var(--space-2) var(--space-3);
  }

  &__restoring {
    align-items: center;
    padding: var(--space-4);
  }

  &__restoring-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__footer {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-6);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--color-surface);
    border-top: 1rpx solid var(--color-border);
  }

  &__params-btn {
    min-width: 96rpx;
    min-height: 96rpx;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rpx;
    border-radius: var(--radius-md);

    &--pressed {
      background: var(--color-accent-soft);
    }
  }

  &__params-text {
    font-size: 20rpx;
    color: var(--color-text-secondary);
  }

  &__submit {
    flex: 1;
  }
}

.engine-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding-top: var(--space-2);
}

.engine-item {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1rpx solid var(--color-border);
  border-radius: var(--radius-lg);

  &--active {
    border-color: var(--color-accent);
    background: var(--color-accent-soft);
  }

  &--disabled {
    opacity: 0.5;
  }

  &--pressed {
    opacity: 0.85;
  }

  &__main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 4rpx;
  }

  &__head {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__label {
    font-size: var(--font-body);
    font-weight: 500;
    color: var(--color-text);
  }

  &__badge {
    font-size: 18rpx;
    font-weight: 600;
    line-height: 1.4;
    color: var(--color-danger);
    border: 1rpx solid var(--color-danger);
    border-radius: var(--radius-sm);
    padding: 2rpx 10rpx;
  }

  &__desc {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__reason {
    font-size: var(--font-caption);
    color: var(--color-warning);
  }
}
</style>
