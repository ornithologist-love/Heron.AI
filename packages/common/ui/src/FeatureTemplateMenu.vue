<script setup lang="ts">
import { Dropdown } from 'tdesign-vue-next'
import { FileIcon, ChevronDownIcon, CloseIcon } from 'tdesign-icons-vue-next'
defineProps<{ selected?: { name: string } | null; options: any[]; width: string; disabled: boolean }>()
const emit = defineEmits<{ select: [option: unknown]; clear: [] }>()
</script>
<template>
  <Dropdown v-if="!selected" :options="options" trigger="click" placement="top-left" :min-column-width="width" :max-column-width="width" :disabled="disabled" @click="option => emit('select', option)">
    <button class="context-button template-button" :disabled="disabled" aria-label="选择功能模板"><FileIcon /><span>功能模板</span><ChevronDownIcon class="chevron" /></button>
  </Dropdown>
  <button v-else class="context-button template-button active" :disabled="disabled" aria-label="退出功能模板" title="点击退出功能模板" @click="emit('clear')"><FileIcon /><span>{{ selected.name }}</span><CloseIcon class="chevron" /></button>
</template>
