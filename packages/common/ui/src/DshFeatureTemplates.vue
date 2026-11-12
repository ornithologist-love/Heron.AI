<script setup lang="ts">
import { computed } from 'vue'
import FeatureTemplateMenu from './FeatureTemplateMenu.vue'
import FeatureTemplateFields from './FeatureTemplateFields.vue'
import { fitMenuWidth } from './menu-width'
const props = defineProps<{ part: string; templates: any[]; selected: any; values: Record<string,string>; busy: boolean; error: string; select: (id: string) => Promise<void>; clear: () => Promise<void>; change: (values: Record<string,string>) => void }>()
const options = computed(() => [...props.templates.map(item => ({ content: item.name, value: item.id })), { content: '高级设置', value: '$advanced', children: [{ content: '查看内置模板目录', value: '$open' }, { content: '刷新模板', value: '$reload' }] }])
const width = computed(() => fitMenuWidth(options.value.flatMap((item: { content: string; children?: { content: string }[] }) => [item.content, ...(item.children?.map(child => child.content) ?? [])])))
</script>
<template>
  <span v-if="part === 'menu'" class="template-control"><FeatureTemplateMenu :selected="selected" :options="options" :width="width" :disabled="busy" @select="option => select((option as any).value)" @clear="clear" /><span v-if="error" role="alert">{{ error }}</span></span>
  <template v-else-if="selected"><FeatureTemplateFields :fields="selected.fields" :model-value="values" :disabled="busy" @update:model-value="change" /><span v-if="error" role="alert">{{ error }}</span></template>
</template>
