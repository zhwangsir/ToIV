<script setup lang="ts">
/**
 * 引擎参数抽屉：按 EngineParam.type 动态渲染
 * 支持：text/textarea/number/select/switch/loras（H3 LoRA 多选+强度）；
 * images/video/audio 由创作页直渲（参考媒体须在主视野）
 * 其余暂不支持类型显式降级提示（不静默吞掉）
 */
import { computed } from 'vue';

import LorasField from '@/components/business/loras-field.vue';
import Sheet from '@/components/ui/sheet.vue';
import { useAppTheme } from '@/composables/use-app-theme';
import type { EngineParam } from '@/types/api';

const { palette } = useAppTheme();

const props = defineProps<{
  visible: boolean;
  params: EngineParam[];
  modelValue: Record<string, unknown>;
}>();

const emit = defineEmits<{
  close: [];
  'update:modelValue': [value: Record<string, unknown>];
}>();

/** 抽屉内可编辑的参数类型 */
const EDITABLE = ['text', 'textarea', 'number', 'select', 'switch', 'loras'];

const editableParams = computed(() => props.params.filter((p) => EDITABLE.includes(p.type)));
const MEDIA_TYPES = ['images', 'video', 'audio'];
const unsupportedParams = computed(() =>
  props.params.filter((p) => !EDITABLE.includes(p.type) && !MEDIA_TYPES.includes(p.type)),
);

function setValue(key: string, value: unknown) {
  emit('update:modelValue', { ...props.modelValue, [key]: value });
}

function onNumberInput(key: string, e: { detail: { value: string } }) {
  const raw = e.detail.value;
  setValue(key, raw === '' ? '' : Number(raw));
}

function onSwitch(key: string, e: { detail: { value: boolean } }) {
  setValue(key, e.detail.value);
}

function displayValue(key: string): string {
  const v = props.modelValue[key];
  return v === null || v === undefined ? '' : String(v);
}

function isSwitchOn(key: string): boolean {
  return props.modelValue[key] === true;
}
</script>

<template>
  <Sheet
    :visible="visible"
    title="生成参数"
    @close="emit('close')"
  >
    <view class="param-sheet">
      <view
        v-for="param in editableParams"
        :key="param.key"
        class="param"
      >
        <view class="param__head">
          <text class="param__label">
            {{ param.label }}
          </text>
          <text
            v-if="param.hint"
            class="param__hint"
          >
            {{ param.hint }}
          </text>
        </view>

        <!-- 文本 -->
        <input
          v-if="param.type === 'text'"
          class="param__input"
          :value="displayValue(param.key)"
          :placeholder="`请输入${param.label}`"
          placeholder-class="param__placeholder"
          @input="(e: any) => setValue(param.key, e.detail.value)"
        >

        <!-- 多行文本 -->
        <textarea
          v-else-if="param.type === 'textarea'"
          class="param__textarea"
          :value="displayValue(param.key)"
          :placeholder="`请输入${param.label}`"
          placeholder-class="param__placeholder"
          auto-height
          @input="(e: any) => setValue(param.key, e.detail.value)"
        />

        <!-- 数字 -->
        <input
          v-else-if="param.type === 'number'"
          class="param__input"
          type="digit"
          :value="displayValue(param.key)"
          :placeholder="
            param.min !== undefined && param.max !== undefined
              ? `${param.min} ~ ${param.max}`
              : `请输入${param.label}`
          "
          placeholder-class="param__placeholder"
          @input="(e: any) => onNumberInput(param.key, e)"
        >

        <!-- 单选 -->
        <view
          v-else-if="param.type === 'select'"
          class="param__options"
        >
          <view
            v-for="opt in param.options ?? []"
            :key="opt.value"
            class="param__option"
            :class="{ 'param__option--active': modelValue[param.key] === opt.value }"
            hover-class="param__option--pressed"
            @tap="setValue(param.key, opt.value)"
          >
            <text
              class="param__option-text"
              :class="{ 'param__option-text--active': modelValue[param.key] === opt.value }"
            >
              {{ opt.label }}
            </text>
          </view>
        </view>

        <!-- 开关 -->
        <switch
          v-else-if="param.type === 'switch'"
          :checked="isSwitchOn(param.key)"
          :color="palette.accent"
          @change="(e: any) => onSwitch(param.key, e)"
        />

        <!-- LoRA 叠加（多选 + 单项强度，H3 引擎） -->
        <LorasField
          v-else-if="param.type === 'loras'"
          :param="param"
          :model-value="modelValue[param.key]"
          @change="(v) => setValue(param.key, v)"
        />
      </view>

      <view
        v-if="unsupportedParams.length > 0"
        class="param-sheet__unsupported"
      >
        <text class="param-sheet__unsupported-text">
          以下参数请在 Web/App 端配置：{{ unsupportedParams.map((p) => p.label).join('、') }}
        </text>
      </view>

      <view class="param-sheet__bottom-gap" />
    </view>
  </Sheet>
</template>

<style scoped lang="scss">
.param-sheet {
  display: flex;
  flex-direction: column;
  gap: var(--space-5);
  padding-top: var(--space-3);

  &__unsupported {
    padding: var(--space-3) var(--space-4);
    background: var(--color-accent-soft);
    border-radius: var(--radius-md);
  }

  &__unsupported-text {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
  }

  &__bottom-gap {
    height: var(--space-8);
  }
}

.param {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);

  &__head {
    display: flex;
    flex-direction: row;
    align-items: baseline;
    gap: var(--space-2);
  }

  &__label {
    font-size: var(--font-caption);
    font-weight: 500;
    color: var(--color-text-secondary);
  }

  &__hint {
    font-size: var(--font-caption);
    color: var(--color-text-secondary);
    opacity: 0.75;
  }

  &__input {
    height: 88rpx;
    padding: 0 var(--space-4);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--font-body);
  }

  &__textarea {
    min-height: 140rpx;
    padding: var(--space-3) var(--space-4);
    border: 1rpx solid var(--color-border);
    border-radius: var(--radius-md);
    background: var(--color-bg);
    color: var(--color-text);
    font-size: var(--font-body);
    width: auto;
  }

  &__placeholder {
    color: var(--color-text-secondary);
  }

  &__options {
    display: flex;
    flex-direction: row;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  &__option {
    min-height: 64rpx;
    padding: 0 var(--space-4);
    border-radius: var(--radius-md);
    border: 1rpx solid var(--color-border);
    display: flex;
    align-items: center;

    &--active {
      border-color: var(--color-accent);
      background: var(--color-accent-soft);
    }

    &--pressed {
      opacity: 0.8;
    }
  }

  &__option-text {
    font-size: var(--font-caption);
    color: var(--color-text);

    &--active {
      color: var(--color-accent);
      font-weight: 500;
    }
  }
}
</style>
