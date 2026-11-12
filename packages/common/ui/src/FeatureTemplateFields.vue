<script setup lang="ts">
defineProps<{ fields: { name: string; label: string; required?: boolean; multiline?: boolean; placeholder?: string }[]; modelValue: Record<string, string>; disabled: boolean }>()
const emit = defineEmits<{ 'update:modelValue': [values: Record<string, string>] }>()
</script>
<template>
  <div class="weekly-hint"><template v-for="field in fields" :key="field.name"><label :for="`template-${field.name}`">{{ field.label }}{{ field.required ? ' *' : '' }}</label><textarea v-if="field.multiline" :id="`template-${field.name}`" :value="modelValue[field.name]" :disabled="disabled" :placeholder="field.placeholder" rows="4" @input="emit('update:modelValue', { ...modelValue, [field.name]: ($event.target as HTMLTextAreaElement).value })" @paste.stop /><input v-else :id="`template-${field.name}`" :value="modelValue[field.name]" :disabled="disabled" :placeholder="field.placeholder" autocomplete="off" @input="emit('update:modelValue', { ...modelValue, [field.name]: ($event.target as HTMLInputElement).value })" /></template><span>下方可填写补充要求，也可直接发送</span></div>
</template>
