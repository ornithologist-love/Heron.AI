<script setup lang="ts">
import { CloseIcon } from 'tdesign-icons-vue-next'
const props = defineProps<{ credential: { label: string; placeholder?: string; help_url?: string; help_label?: string }; modelValue: string; saving: boolean; canSave: boolean; error?: string; saveLabel?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: string]; close: []; save: []; focus: [event: FocusEvent] }>()
// The host opens external links from its WebView2 NewWindowRequested handler,
// which receives window.open() calls but not this anchor's own navigation.
const openHelp = () => { if (props.credential.help_url) window.open(props.credential.help_url, '_blank', 'noopener,noreferrer') }
</script>
<template>
  <Teleport to="body"><div class="credential-overlay" role="presentation" @mousedown.self="!saving && emit('close')">
    <section class="credential-dialog" role="dialog" aria-modal="true" :aria-label="`配置 ${credential.label}`">
      <div class="credential-heading"><div><strong>配置 {{ credential.label }}</strong><p>Token 仅保存在本机，不会在界面中回显。</p></div><button class="icon-button" aria-label="关闭 Token 配置" :disabled="saving" @click="emit('close')"><CloseIcon /></button></div>
      <label><span>Token</span><input :value="modelValue" type="password" :aria-label="credential.label" :placeholder="credential.placeholder" autocomplete="off" autocapitalize="off" spellcheck="false" :disabled="saving" @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)" @focus="emit('focus', $event)" @keydown.enter="canSave && !saving && emit('save')" /></label>
      <p v-if="credential.help_url" class="credential-help">没有 Token？前往 <a :href="credential.help_url" target="_blank" rel="noreferrer" @click.prevent="openHelp">{{ credential.help_label || 'Token 管理页' }}</a> 获取。</p>
      <p v-if="error" role="alert">{{ error }}</p>
      <div class="credential-actions"><button class="dialog-secondary" :disabled="saving" @click="emit('close')">取消</button><button class="dialog-primary" :disabled="!canSave || saving" @click="emit('save')">{{ saving ? '保存中…' : saveLabel || '保存 Token' }}</button></div>
    </section>
  </div></Teleport>
</template>
