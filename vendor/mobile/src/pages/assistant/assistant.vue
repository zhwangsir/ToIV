<script setup lang="ts">
/**
 * 对话助手页（MP19 一期 + MP20 文档挂载 + MP24 分叉/预览/草稿）
 * - 消息流：user 右气泡 / assistant 左气泡；text 流式追加、tool 活动条、媒体内联、error 内联
 * - 发送：底部输入栏（Enter 发送 / 流式中变停止键）；新会话首轮响应头回填 sessionId
 * - 历史：NavBar 右侧 history 开底部抽屉（列表/打开/删除/分叉副本），plus 开新对话
 * - 媒体（MP24）：image 点击 uni.previewImage 整组预览；video 点击开全屏覆盖层播放；
 *   audio/model3d 芯片占位（一期不内联渲染）
 * - 分叉（MP24）：会话列表项 copy 钮全量分叉；气泡长按 action sheet「从此分叉」
 *   （仅回放消息有 backendId 可定位 at_message_id，本地流式轮次不出入口）
 * - 草稿（MP24）：输入按会话持久化（防抖 300ms），切换/重进回填，发送即清
 * - 文档挂载（MP20，对齐 Web/Mobile 语义）：输入栏左侧 paperclip ghost 钮开文档面板
 *   （上传/挂载切换/删除）；挂载文档在输入栏上方横排 chips（X 可移除，≤8）；
 *   发送时 document_ids 随 chat 上行，chips 清空转移到 user 气泡留痕；错误气泡可重试
 *   （复用上轮挂载，store.retry）
 * - 用户附图（MP30）：输入栏 image ghost 钮（文档钮旁）→ showActionSheet（拍照/相册）→
 *   chooseImage → 选图即传（uploadImage img2img）；chip 缩略预览 + X 移除，单图替换语义；
 *   发送随 chat 上行 image={filename,worker}，chip 清空转移到 user 气泡本地留痕
 *   （回放无图为后端契约现状）；上传中禁发、流式中图片钮禁用
 */
import { computed, nextTick, ref, watch } from 'vue';
import { onHide, onShow } from '@dcloudio/uni-app';

import { mediaUrl } from '@/api/client';
import Empty from '@/components/ui/empty.vue';
import Icon from '@/components/ui/icon.vue';
import NavBar from '@/components/ui/nav-bar.vue';
import Sheet from '@/components/ui/sheet.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import { useAuthGuard } from '@/composables/use-auth-guard';
import {
  ATTACHED_DOCS_MAX,
  toolActivityLabel,
  useAssistantStore,
  type ChatMedia,
  type ChatMessage,
} from '@/stores/assistant';
import type { DocItem } from '@/types/api';
import { firstPreviewUrl, previewUrls } from '@/utils/assistant';
import { canSendWithImage, chooseAssistantImage } from '@/utils/assistant-image';
import { DOC_EXTS, docStatusLabel, formatDocSize, validateDocFile } from '@/utils/doc';
import { formatRelative } from '@/utils/format';

const { themeVars } = useAppTheme();
const { requireAuth } = useAuthGuard();
const store = useAssistantStore();

const draft = ref('');
const sessionsVisible = ref(false);
const docsVisible = ref(false);
const scrollTarget = ref('');
/** 视频全屏播放地址（MP24 覆盖层；null 关闭） */
const videoPreviewUrl = ref<string | null>(null);
/** 分叉进行中（防重复提交） */
const forking = ref(false);

const messages = computed(() => store.messages);
const sending = computed(() => store.sending);
const attachedDocs = computed(() => store.attachedDocs);
const docUploading = computed(() => store.docUploading);
const attachedImage = computed(() => store.attachedImage);
const canSend = computed(
  () => draft.value.trim() !== '' && !sending.value && canSendWithImage(attachedImage.value),
);
/** 仅末尾错误 assistant 气泡展示重试（store.retry 只摘末尾错误气泡重发） */
const lastMessageId = computed(() => messages.value[messages.value.length - 1]?.id ?? '');

/** 当前会话草稿回填（切换会话/重进页面时调用） */
function restoreDraft() {
  draft.value = store.loadDraft();
}

onShow(() => {
  if (!requireAuth()) return;
  void store.refreshSessions();
  restoreDraft();
});

/** 页面隐藏前把防抖窗口内的草稿落盘（防 <300ms 快速切走丢稿） */
onHide(() => {
  store.flushDraft();
});

/** 输入变化 → 防抖持久化到当前会话草稿键 */
watch(draft, (value) => {
  store.saveDraft(value);
});

/** 滚动锚点：消息数或最后一条文本增长时到底部 */
watch(
  () => [messages.value.length, messages.value[messages.value.length - 1]?.text.length] as const,
  async () => {
    await nextTick();
    const last = messages.value[messages.value.length - 1];
    scrollTarget.value = '';
    await nextTick();
    scrollTarget.value = last ? `msg-${last.id}` : '';
  },
);

function send() {
  if (!canSend.value) return;
  const text = draft.value;
  draft.value = '';
  store.send(text);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onInput(e: any) {
  draft.value = e?.detail?.value ?? '';
}

/** uni textarea confirm（Enter）发送；小程序 confirm-type="send" */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function onConfirm(e: any) {
  draft.value = e?.detail?.value ?? draft.value;
  send();
}

function resolveUrl(path: string): string {
  return mediaUrl(path);
}

/** 图片产物点击 → uni.previewImage 整组预览（current 定位到点按张） */
function previewImage(media: ChatMedia, index: number) {
  uni.previewImage({
    urls: previewUrls(media, resolveUrl),
    current: index,
  });
}

/** 视频产物点击 → 全屏覆盖层播放（跨端一致：H5/小程序均为页内 video controls） */
function openVideoPreview(media: ChatMedia) {
  videoPreviewUrl.value = firstPreviewUrl(media, resolveUrl);
}

function closeVideoPreview() {
  videoPreviewUrl.value = null;
}

function mediaLabel(type: string): string {
  if (type === 'audio') return '音频';
  if (type === 'model3d') return '3D 模型';
  return '附件';
}

function mediaIcon(type: string): string {
  if (type === 'audio') return 'music';
  if (type === 'model3d') return 'box';
  return 'image';
}

// ── 分叉会话（MP24）──

/** 分叉公共路径：全量（无 atMessageId）/ 截断；成功跳新会话并回填其草稿 */
async function runFork(sid: string, atMessageId?: number) {
  if (forking.value || sending.value) return;
  forking.value = true;
  store.flushDraft(); // 当前会话草稿先落盘，跳走后回来仍在
  try {
    await store.forkSession(sid, atMessageId);
    sessionsVisible.value = false;
    restoreDraft();
    uni.showToast({ title: '已创建分叉会话', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '分叉失败，请重试',
      icon: 'none',
    });
  } finally {
    forking.value = false;
  }
}

/** 会话列表项「分叉副本」：全量 fork → 跳新会话 */
function forkSessionCopy(sid: string) {
  void runFork(sid);
}

/** 气泡长按「从此分叉」：截断 fork 到该消息（含）；仅回放消息（backendId 非空）出入口 */
function offerForkFrom(msg: ChatMessage) {
  const sid = store.sessionId;
  if (!sid || msg.backendId === null || sending.value || forking.value) return;
  uni.showActionSheet({
    itemList: ['从此分叉'],
    success: (res) => {
      if (res.tapIndex === 0) void runFork(sid, msg.backendId ?? undefined);
    },
  });
}

// ── 会话抽屉 ──
function openSessions() {
  sessionsVisible.value = true;
  void store.refreshSessions();
}

async function pickSession(sid: string) {
  if (sending.value) return;
  store.flushDraft(); // 切走前当前会话草稿落盘
  sessionsVisible.value = false;
  try {
    await store.openSession(sid);
    restoreDraft();
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '加载失败',
      icon: 'none',
    });
  }
}

function newChat() {
  store.flushDraft();
  sessionsVisible.value = false;
  store.newChat();
  restoreDraft(); // 新会话（__new__）草稿回填
}

function confirmRemove(sid: string, title: string) {
  uni.showModal({
    title: '删除会话',
    content: `「${title || '未命名'}」及其全部消息将被删除`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return;
      store.removeSession(sid).catch((err: unknown) => {
        uni.showToast({
          title: err instanceof Error ? err.message : '删除失败',
          icon: 'none',
        });
      });
    },
  });
}

// ── 用户附图（MP30）──

/**
 * 图片钮：showActionSheet（拍照/相册）→ chooseImage → 选图即传（chip 内转 loading）
 * 已有 chip 再选 = 替换（单图契约，不确认）；流式中禁用（对齐输入框 busy 语义）；
 * 上传失败 store 清 chip 抛错，此处 toast 人话
 */
async function chooseAttachedImage() {
  if (sending.value) return;
  const filePath = await chooseAssistantImage();
  if (!filePath) return; // 用户取消不提示
  try {
    await store.attachAndUploadImage(filePath);
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '上传失败，请重试',
      icon: 'none',
    });
  }
}

// ── 文档挂载（MP20）──

function openDocs() {
  docsVisible.value = true;
  void store.loadDocs();
}

function isAttached(id: string): boolean {
  return store.attachedDocs.some((d) => d.id === id);
}

/** 上传并挂载：先验后传（扩展名按原始文件名判定，H5 blob: URL 无扩展名） */
async function pickAndUpload(filePath: string, name: string, size?: number) {
  if (!filePath) return;
  const invalid = validateDocFile(name, size);
  if (invalid) {
    uni.showToast({ title: invalid, icon: 'none' });
    return;
  }
  try {
    await store.uploadAndAttach(filePath);
    uni.showToast({ title: '已上传并挂载', icon: 'none' });
  } catch (err) {
    uni.showToast({
      title: err instanceof Error ? err.message : '上传失败，请重试',
      icon: 'none',
    });
  }
}

/** 选文档：MP-WEIXIN 仅会话文件（chooseMessageFile），H5/APP 走 chooseFile（同 ref-audio-field 模式） */
function chooseDoc() {
  if (store.docUploading) return;
  // #ifdef MP-WEIXIN
  uni.chooseMessageFile({
    count: 1,
    type: 'file',
    extension: DOC_EXTS,
    success: (res) => {
      const f = res.tempFiles[0];
      if (!f) return;
      void pickAndUpload(f.path, f.name, f.size);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
  // #endif
  // #ifndef MP-WEIXIN
  uni.chooseFile({
    count: 1,
    type: 'all',
    extension: DOC_EXTS,
    success: (res) => {
      const paths = Array.isArray(res.tempFilePaths) ? res.tempFilePaths : [res.tempFilePaths];
      // tempFiles 声明为单/数组/File 联合类型，归一化后取首项（count:1）
      const rawFiles = res.tempFiles as unknown;
      const files = Array.isArray(rawFiles) ? rawFiles : rawFiles ? [rawFiles] : [];
      const f = files[0] as { path?: string; name?: string; size?: number } | undefined;
      const filePath = f?.path ?? paths[0] ?? '';
      const name = f?.name ?? filePath.split('/').pop() ?? 'doc';
      void pickAndUpload(filePath, name, f?.size);
    },
    fail: () => {
      // 用户取消不提示
    },
  });
  // #endif
}

function confirmRemoveDoc(doc: DocItem) {
  uni.showModal({
    title: '删除文档',
    content: `「${doc.filename}」及其索引将被删除`,
    confirmText: '删除',
    cancelText: '取消',
    success: (res) => {
      if (!res.confirm) return;
      store.removeDoc(doc.id).catch((err: unknown) => {
        uni.showToast({
          title: err instanceof Error ? err.message : '删除失败',
          icon: 'none',
        });
      });
    },
  });
}
</script>

<template>
  <view
    class="assistant"
    :style="themeVars"
  >
    <NavBar
      title="助手"
      show-back
    >
      <template #right>
        <view class="assistant__nav-actions">
          <view
            class="assistant__nav-btn"
            hover-class="assistant__nav-btn--pressed"
            @tap="newChat"
          >
            <Icon
              name="plus"
              :size="44"
              color="var(--color-text)"
            />
          </view>
          <view
            class="assistant__nav-btn"
            hover-class="assistant__nav-btn--pressed"
            @tap="openSessions"
          >
            <Icon
              name="history"
              :size="44"
              color="var(--color-text)"
            />
          </view>
        </view>
      </template>
    </NavBar>

    <scroll-view
      scroll-y
      class="assistant__scroll"
      :scroll-into-view="scrollTarget"
      scroll-with-animation
    >
      <view
        v-if="messages.length === 0"
        class="assistant__empty"
      >
        <Empty
          icon="message-square"
          title="和 ToIV 聊聊"
          description="描述你想要的画面、视频或 3D，助手会调用创作引擎直接生成并展示结果"
        />
      </view>

      <view
        v-for="msg in messages"
        :id="`msg-${msg.id}`"
        :key="msg.id"
        class="assistant__row"
        :class="`assistant__row--${msg.role}`"
      >
        <view
          class="assistant__bubble"
          :class="`assistant__bubble--${msg.role}`"
          @longpress="offerForkFrom(msg)"
        >
          <!-- 工具活动条（流式中） -->
          <view
            v-if="msg.toolActivity && msg.streaming"
            class="assistant__tool"
          >
            <view class="assistant__tool-spinner">
              <Icon
                name="loader-circle"
                :size="28"
                color="var(--color-accent)"
              />
            </view>
            <text class="assistant__tool-label">
              {{ toolActivityLabel(msg.toolActivity) }}
            </text>
          </view>

          <!-- 用户附图留痕（MP30，仅本地轮次；回放无图为后端契约现状） -->
          <image
            v-if="msg.image"
            class="assistant__msg-image"
            :src="msg.image.previewUri"
            mode="aspectFill"
          />

          <!-- 文本 -->
          <text
            v-if="msg.text"
            class="assistant__text"
            user-select
          >
            {{ msg.text }}
          </text>
          <!-- 流式占位光标：无文本无媒体时的等待态 -->
          <view
            v-else-if="msg.streaming && !msg.toolActivity && msg.media.length === 0 && !msg.error"
            class="assistant__thinking"
          >
            <text class="assistant__thinking-dot" />
            <text class="assistant__thinking-dot" />
            <text class="assistant__thinking-dot" />
          </view>

          <!-- 挂载文档留痕（MP20，仅 user 气泡；后端不回放文档引用，本地轮次展示） -->
          <view
            v-if="msg.docs.length > 0"
            class="assistant__docs"
          >
            <view
              v-for="doc in msg.docs"
              :key="doc.id"
              class="assistant__doc-ref"
            >
              <Icon
                name="file-text"
                :size="24"
                color="rgba(255, 255, 255, 0.85)"
              />
              <text class="assistant__doc-ref-name">
                {{ doc.filename }}
              </text>
            </view>
          </view>

          <!-- 媒体结果 -->
          <view
            v-for="(media, mi) in msg.media"
            :key="mi"
            class="assistant__media"
          >
            <view
              v-if="media.type === 'image'"
              class="assistant__media-grid"
            >
              <image
                v-for="(url, ui) in media.urls"
                :key="ui"
                class="assistant__media-image"
                :src="resolveUrl(url)"
                mode="aspectFill"
                @tap="previewImage(media, ui)"
              />
            </view>
            <!-- 视频产物：封面卡点击 → 全屏覆盖层播放（MP24；小程序原生 video 层级最高，不内联） -->
            <view
              v-else-if="media.type === 'video' && media.urls[0]"
              class="assistant__media-video-card"
              hover-class="assistant__media-video-card--pressed"
              @tap="openVideoPreview(media)"
            >
              <view class="assistant__media-video-play">
                <Icon
                  name="play"
                  :size="44"
                  color="#FFFFFF"
                />
              </view>
              <text class="assistant__media-video-label">
                视频 · 点击播放
              </text>
            </view>
            <view
              v-else
              class="assistant__media-chip"
            >
              <Icon
                :name="mediaIcon(media.type)"
                :size="32"
                color="var(--color-accent)"
              />
              <text class="assistant__media-chip-label">
                {{ mediaLabel(media.type) }}已生成
              </text>
            </view>
          </view>

          <!-- 错误内联（末尾 assistant 错误气泡附重试，复用上轮挂载） -->
          <view
            v-if="msg.error"
            class="assistant__error"
          >
            <Icon
              name="circle-alert"
              :size="28"
              color="var(--color-danger)"
            />
            <text class="assistant__error-text">
              {{ msg.error }}
            </text>
            <view
              v-if="msg.role === 'assistant' && !msg.streaming && msg.id === lastMessageId"
              class="assistant__retry"
              hover-class="assistant__retry--pressed"
              @tap="store.retry()"
            >
              <Icon
                name="refresh-cw"
                :size="24"
                color="var(--color-danger)"
              />
              <text class="assistant__retry-text">
                重试
              </text>
            </view>
          </view>
        </view>
      </view>

      <!-- 底栏占位 -->
      <view class="assistant__input-gap" />
    </scroll-view>

    <!-- 输入栏（MP20：chips 行 + 文档钮 + 输入行，纵向叠放） -->
    <view class="assistant__inputbar">
      <!-- 附图 chip / 挂载文档 chips 行（X 可移除；发送后清空转移到 user 气泡） -->
      <scroll-view
        v-if="attachedImage || attachedDocs.length > 0"
        scroll-x
        class="assistant__chips"
        :show-scrollbar="false"
      >
        <!-- 附图 chip（MP30：缩略预览 + 上传中 loading 遮罩 + X 移除） -->
        <view
          v-if="attachedImage"
          class="assistant__chip assistant__imgchip"
        >
          <view class="assistant__imgchip-thumb-wrap">
            <image
              class="assistant__imgchip-thumb"
              :src="attachedImage.previewUri"
              mode="aspectFill"
            />
            <view
              v-if="attachedImage.status === 'uploading'"
              class="assistant__imgchip-loading"
            >
              <Icon
                name="loader-circle"
                :size="28"
                color="var(--color-accent)"
                class="assistant__imgchip-spin"
              />
            </view>
          </view>
          <view
            class="assistant__chip-x"
            hover-class="assistant__chip-x--pressed"
            @tap="store.detachImage()"
          >
            <Icon
              name="x"
              :size="22"
              color="var(--color-text-secondary)"
            />
          </view>
        </view>
        <view
          v-for="doc in attachedDocs"
          :key="doc.id"
          class="assistant__chip"
        >
          <Icon
            name="file-text"
            :size="24"
            color="var(--color-accent)"
          />
          <text class="assistant__chip-name">
            {{ doc.filename }}
          </text>
          <view
            class="assistant__chip-x"
            hover-class="assistant__chip-x--pressed"
            @tap="store.detachDoc(doc.id)"
          >
            <Icon
              name="x"
              :size="22"
              color="var(--color-text-secondary)"
            />
          </view>
        </view>
      </scroll-view>

      <view class="assistant__inputrow">
        <!-- 文档面板开关（面板开或有挂载时 accent 高亮，对齐 Web 激活态） -->
        <view
          class="assistant__docbtn"
          hover-class="assistant__docbtn--pressed"
          @tap="openDocs"
        >
          <Icon
            name="paperclip"
            :size="38"
            :color="docsVisible || attachedDocs.length > 0 ? 'var(--color-accent)' : 'var(--color-text-secondary)'"
          />
        </view>
        <!-- 图片钮（MP30：ghost 对齐文档钮；有附图 accent 高亮；流式中禁用） -->
        <view
          class="assistant__docbtn assistant__imgbtn"
          :class="{ 'assistant__imgbtn--disabled': sending }"
          hover-class="assistant__docbtn--pressed"
          @tap="chooseAttachedImage"
        >
          <Icon
            name="image"
            :size="38"
            :color="attachedImage ? 'var(--color-accent)' : 'var(--color-text-secondary)'"
          />
        </view>
        <textarea
          class="assistant__textarea"
          :value="draft"
          placeholder="描述你的想法…"
          placeholder-class="assistant__textarea-placeholder"
          auto-height
          :maxlength="32000"
          confirm-type="send"
          :hold-keyboard="true"
          @input="onInput"
          @confirm="onConfirm"
        />
        <view
          v-if="sending"
          class="assistant__send assistant__send--stop"
          hover-class="assistant__send--pressed"
          @tap="store.stop()"
        >
          <Icon
            name="square"
            :size="32"
            color="#FFFFFF"
          />
        </view>
        <view
          v-else
          class="assistant__send"
          :class="{ 'assistant__send--disabled': !canSend }"
          hover-class="assistant__send--pressed"
          @tap="send"
        >
          <Icon
            name="send"
            :size="32"
            color="#FFFFFF"
          />
        </view>
      </view>
    </view>

    <!-- 会话抽屉 -->
    <Sheet
      :visible="sessionsVisible"
      title="历史会话"
      @close="sessionsVisible = false"
    >
      <view
        v-if="store.sessions.length === 0 && !store.sessionsLoading"
        class="assistant__sessions-empty"
      >
        <text class="assistant__sessions-empty-text">
          {{ store.sessionsError || '还没有历史会话' }}
        </text>
      </view>
      <view
        v-for="session in store.sessions"
        :key="session.id"
        class="assistant__session"
        hover-class="assistant__session--pressed"
        @tap="pickSession(session.id)"
      >
        <view class="assistant__session-main">
          <text class="assistant__session-title">
            {{ session.title || '未命名会话' }}
          </text>
          <text class="assistant__session-meta">
            {{ formatRelative(session.updated_at) }} · {{ session.message_count }} 条
          </text>
        </view>
        <view
          class="assistant__session-fork"
          hover-class="assistant__session-action--pressed"
          @tap.stop="forkSessionCopy(session.id)"
        >
          <Icon
            name="copy"
            :size="36"
            color="var(--color-text-secondary)"
          />
        </view>
        <view
          class="assistant__session-delete"
          hover-class="assistant__session-action--pressed"
          @tap.stop="confirmRemove(session.id, session.title)"
        >
          <Icon
            name="trash-2"
            :size="36"
            color="var(--color-text-secondary)"
          />
        </view>
      </view>
    </Sheet>

    <!-- 文档面板（MP20：上传/挂载切换/删除；挂载随下一条消息上行） -->
    <Sheet
      :visible="docsVisible"
      title="文档挂载"
      @close="docsVisible = false"
    >
      <text class="assistant__docs-hint">
        挂载后随下一条消息发送，助手可引用文档内容回答（已挂载 {{ attachedDocs.length }}/{{ ATTACHED_DOCS_MAX }}）
      </text>

      <!-- 上传入口（先验扩展名/尺寸，上传中防重复） -->
      <view
        class="assistant__doc-upload"
        :class="{ 'assistant__doc-upload--disabled': docUploading }"
        hover-class="assistant__doc-upload--pressed"
        @tap="chooseDoc"
      >
        <Icon
          :name="docUploading ? 'loader-circle' : 'upload'"
          :size="34"
          color="var(--color-accent)"
          :class="{ 'assistant__doc-upload-spin': docUploading }"
        />
        <text class="assistant__doc-upload-text">
          {{ docUploading ? '上传中…' : '上传文档（pdf / docx / txt / md ≤50MB）' }}
        </text>
      </view>

      <!-- 空态 / 错误态（失败不阻塞对话，可重开面板重试） -->
      <view
        v-if="store.docList.length === 0 && !store.docListLoading"
        class="assistant__docs-empty"
      >
        <text class="assistant__docs-empty-text">
          {{ store.docListError || '还没有文档，先上传一份吧' }}
        </text>
      </view>

      <!-- 文档列表：点按挂载/卸载，右侧删除 -->
      <view
        v-for="doc in store.docList"
        :key="doc.id"
        class="assistant__doc"
        hover-class="assistant__doc--pressed"
        @tap="store.toggleAttachDoc(doc)"
      >
        <Icon
          name="file-text"
          :size="38"
          :color="isAttached(doc.id) ? 'var(--color-accent)' : 'var(--color-text-secondary)'"
        />
        <view class="assistant__doc-main">
          <text class="assistant__doc-name">
            {{ doc.filename }}
          </text>
          <text class="assistant__doc-meta">
            {{ docStatusLabel(doc.status) }} · {{ formatDocSize(doc.size) }} · {{ doc.chunk_count }} 段
          </text>
        </view>
        <view
          v-if="isAttached(doc.id)"
          class="assistant__doc-check"
        >
          <Icon
            name="check"
            :size="34"
            color="var(--color-accent)"
          />
        </view>
        <view
          class="assistant__doc-delete"
          @tap.stop="confirmRemoveDoc(doc)"
        >
          <Icon
            name="trash-2"
            :size="34"
            color="var(--color-text-secondary)"
          />
        </view>
      </view>
    </Sheet>

    <!-- 视频全屏预览覆盖层（MP24）：backdrop 点击 / 右上 X 关闭；层级高于 sheet(90) -->
    <view
      v-if="videoPreviewUrl"
      class="assistant__video-preview"
      @tap="closeVideoPreview"
    >
      <video
        class="assistant__video-preview-player"
        :src="videoPreviewUrl"
        controls
        autoplay
        :show-fullscreen-btn="false"
        @tap.stop
      />
      <view
        class="assistant__video-preview-close"
        hover-class="assistant__video-preview-close--pressed"
        @tap="closeVideoPreview"
      >
        <Icon
          name="x"
          :size="40"
          color="#FFFFFF"
        />
      </view>
    </view>
  </view>
</template>

<style scoped lang="scss">
.assistant {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--color-bg);

  &__nav-actions {
    display: flex;
    flex-direction: row;
    align-items: center;
  }

  &__nav-btn {
    min-width: 72rpx;
    min-height: 72rpx;
    display: flex;
    align-items: center;
    justify-content: center;

    &--pressed {
      opacity: 0.6;
    }
  }

  &__scroll {
    flex: 1;
    height: 0; // flex 子项高度收敛，scroll-view 自适应
  }

  &__empty {
    padding-top: 120rpx;
  }

  &__row {
    display: flex;
    padding: var(--space-2) var(--space-4);

    &--user {
      justify-content: flex-end;
    }

    &--assistant {
      justify-content: flex-start;
    }
  }

  &__bubble {
    max-width: 82%;
    padding: var(--space-3) var(--space-4);
    border-radius: var(--radius-lg, 24rpx);
    display: flex;
    flex-direction: column;
    gap: var(--space-3);

    &--user {
      background: var(--color-accent);
      border-bottom-right-radius: 8rpx;
    }

    &--assistant {
      background: var(--color-surface);
      border: 1rpx solid var(--color-border);
      border-bottom-left-radius: 8rpx;
    }
  }

  &__text {
    font-size: var(--font-body);
    line-height: 1.7;
    color: var(--color-text);
    word-break: break-word;

    .assistant__bubble--user & {
      color: #ffffff;
    }
  }

  &__tool {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
  }

  &__tool-spinner {
    animation: assistant-spin 1.2s linear infinite;
    display: flex;
  }

  &__tool-label {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__thinking {
    display: flex;
    flex-direction: row;
    gap: 8rpx;
    padding: 8rpx 0;
  }

  &__thinking-dot {
    width: 12rpx;
    height: 12rpx;
    border-radius: 50%;
    background: var(--color-text-secondary);
    opacity: 0.4;
    animation: assistant-blink 1.2s ease-in-out infinite;

    &:nth-child(2) {
      animation-delay: 0.2s;
    }

    &:nth-child(3) {
      animation-delay: 0.4s;
    }
  }

  &__media-grid {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  &__media-image {
    width: 320rpx;
    height: 320rpx;
    border-radius: var(--radius-md, 16rpx);
    background: var(--color-bg);
  }

  &__media-video-card {
    width: 480rpx;
    height: 270rpx;
    border-radius: var(--radius-md, 16rpx);
    background: rgba(0, 0, 0, 0.72);
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);

    &--pressed {
      opacity: 0.8;
    }
  }

  &__media-video-play {
    width: 88rpx;
    height: 88rpx;
    border-radius: 50%;
    background: rgba(255, 255, 255, 0.18);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__media-video-label {
    font-size: var(--font-caption);
    color: rgba(255, 255, 255, 0.85);
  }

  &__media-chip {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
    border-radius: var(--radius-md, 16rpx);
    background: var(--color-accent-soft);
  }

  &__media-chip-label {
    font-size: var(--font-caption);
    color: var(--color-accent);
  }

  &__error {
    display: flex;
    flex-direction: row;
    align-items: flex-start;
    gap: var(--space-2);
  }

  &__error-text {
    flex: 1;
    font-size: var(--font-caption);
    color: var(--color-danger);
    line-height: 1.5;
  }

  &__retry {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 6rpx;
    padding: 4rpx 12rpx;
    border: 1rpx solid var(--color-danger);
    border-radius: var(--radius-md, 16rpx);
    flex-shrink: 0;

    &--pressed {
      opacity: 0.6;
    }
  }

  &__retry-text {
    font-size: var(--font-caption);
    color: var(--color-danger);
  }

  &__docs {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }

  &__doc-ref {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-2);
    padding: 6rpx var(--space-2);
    border-radius: var(--radius-md, 16rpx);
    background: rgba(255, 255, 255, 0.16);
  }

  &__doc-ref-name {
    font-size: var(--font-caption);
    color: rgba(255, 255, 255, 0.85);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    max-width: 360rpx;
  }

  &__input-gap {
    // 含 chips 行余量：挂载时输入栏加高一行，避免遮挡末条消息
    height: calc(220rpx + env(safe-area-inset-bottom));
  }

  &__inputbar {
    position: fixed;
    left: 0;
    right: 0;
    bottom: 0;
    // 层叠约定：页面级 fixed 栏必须低于 ui-sheet 遮罩（90），否则抽屉内点击被拦（MP13 同因）
    z-index: 50;
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    padding-bottom: calc(var(--space-3) + env(safe-area-inset-bottom));
    background: var(--color-surface);
    border-top: 1rpx solid var(--color-border);
  }

  &__chips {
    white-space: nowrap;
  }

  &__chip {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    gap: 6rpx;
    max-width: 400rpx;
    padding: 6rpx 6rpx 6rpx var(--space-2);
    margin-right: var(--space-2);
    border-radius: var(--radius-md, 16rpx);
    background: var(--color-accent-soft);
  }

  &__chip-name {
    font-size: var(--font-caption);
    color: var(--color-accent);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__chip-x {
    min-width: 44rpx;
    min-height: 44rpx;
    display: flex;
    align-items: center;
    justify-content: center;

    &--pressed {
      opacity: 0.6;
    }
  }

  // ── 附图 chip / 气泡附图（MP30）──

  &__msg-image {
    width: 320rpx;
    height: 320rpx;
    border-radius: var(--radius-md, 16rpx);
    background: rgba(255, 255, 255, 0.16);
  }

  &__imgchip {
    padding-left: 6rpx;
  }

  &__imgchip-thumb-wrap {
    position: relative;
    width: 64rpx;
    height: 64rpx;
    flex-shrink: 0;
  }

  &__imgchip-thumb {
    width: 64rpx;
    height: 64rpx;
    border-radius: var(--radius-sm, 12rpx);
  }

  &__imgchip-loading {
    position: absolute;
    inset: 0;
    border-radius: var(--radius-sm, 12rpx);
    background: rgba(255, 255, 255, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__imgchip-spin {
    animation: assistant-spin 1.2s linear infinite;
  }

  &__imgbtn--disabled {
    opacity: 0.4;
  }

  &__inputrow {
    display: flex;
    flex-direction: row;
    align-items: flex-end;
    gap: var(--space-3);
  }

  &__docbtn {
    width: 80rpx;
    height: 80rpx;
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;

    &--pressed {
      opacity: 0.6;
    }
  }

  &__textarea {
    flex: 1;
    min-height: 72rpx;
    max-height: 240rpx;
    padding: 18rpx var(--space-3);
    font-size: var(--font-body);
    line-height: 1.5;
    color: var(--color-text);
    background: var(--color-bg);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-lg, 24rpx);
  }

  &__textarea-placeholder {
    color: var(--color-text-secondary);
  }

  &__send {
    width: 80rpx;
    height: 80rpx;
    border-radius: 50%;
    background: var(--color-accent);
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;

    &--stop {
      background: var(--color-danger);
    }

    &--disabled {
      opacity: 0.4;
    }

    &--pressed {
      opacity: 0.7;
    }
  }

  &__sessions-empty {
    padding: var(--space-8);
    display: flex;
    justify-content: center;
  }

  &__sessions-empty-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__session {
    display: flex;
    flex-direction: row;
    align-items: center;
    padding: var(--space-4);
    border-bottom: 1rpx solid var(--color-border);

    &--pressed {
      opacity: 0.7;
    }
  }

  &__session-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6rpx;
    min-width: 0;
  }

  &__session-title {
    font-size: var(--font-body);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__session-meta {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__session-fork,
  &__session-delete {
    min-width: 80rpx;
    min-height: 80rpx;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__session-action--pressed {
    opacity: 0.6;
  }

  // ── 视频全屏预览覆盖层（MP24）──

  &__video-preview {
    position: fixed;
    inset: 0;
    z-index: 100; // 高于 inputbar(50) 与 ui-sheet(90)
    background: rgba(0, 0, 0, 0.92);
    display: flex;
    align-items: center;
    justify-content: center;
  }

  &__video-preview-player {
    width: 100%;
    max-height: 80vh;
  }

  &__video-preview-close {
    position: absolute;
    top: calc(var(--space-4) + env(safe-area-inset-top));
    right: var(--space-4);
    min-width: 72rpx;
    min-height: 72rpx;
    display: flex;
    align-items: center;
    justify-content: center;

    &--pressed {
      opacity: 0.6;
    }
  }

  // ── 文档面板（MP20）──

  &__docs-hint {
    display: block;
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    line-height: 1.5;
    padding: var(--space-2) 0 var(--space-3);
  }

  &__doc-upload {
    display: flex;
    flex-direction: row;
    align-items: center;
    justify-content: center;
    gap: var(--space-2);
    padding: var(--space-3);
    margin-bottom: var(--space-3);
    border: 1rpx dashed var(--color-accent);
    border-radius: var(--radius-md, 16rpx);
    background: var(--color-accent-soft);

    &--pressed {
      opacity: 0.7;
    }

    &--disabled {
      opacity: 0.6;
    }
  }

  &__doc-upload-spin {
    animation: assistant-spin 1.2s linear infinite;
  }

  &__doc-upload-text {
    font-size: var(--font-caption);
    color: var(--color-accent);
  }

  &__docs-empty {
    padding: var(--space-8);
    display: flex;
    justify-content: center;
  }

  &__docs-empty-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__doc {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-3) 0;
    border-bottom: 1rpx solid var(--color-border);

    &--pressed {
      opacity: 0.7;
    }
  }

  &__doc-main {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 6rpx;
    min-width: 0;
  }

  &__doc-name {
    font-size: var(--font-body);
    color: var(--color-text);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  &__doc-meta {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__doc-check {
    display: flex;
    align-items: center;
    flex-shrink: 0;
  }

  &__doc-delete {
    min-width: 72rpx;
    min-height: 72rpx;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
  }
}

@keyframes assistant-spin {
  from {
    transform: rotate(0deg);
  }

  to {
    transform: rotate(360deg);
  }
}

@keyframes assistant-blink {
  0%,
  100% {
    opacity: 0.3;
  }

  50% {
    opacity: 0.8;
  }
}
</style>
