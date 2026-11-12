<script setup lang="ts">
import { ref, watch } from 'vue'
import { KeyIcon } from 'tdesign-icons-vue-next'
import ProviderTokenDialog from './ProviderTokenDialog.vue'
import type { PublicAiAllowance } from './model-types'
const props = defineProps<{ providers: any[]; busy: boolean; error: string; reload: () => Promise<void>; saveToken: (provider: string, token: string) => Promise<void>; dialogOnly?: boolean; requestedProvider?: string; requestError?: string; saveLabel?: string; dismiss?: () => void }>()
const active = ref<any>(null), token = ref(''), saving = ref(false), error = ref('')
function allowance(value?: PublicAiAllowance) {
  if (!value?.configured) return value?.error ?? '公共模型服务尚未配置'
  return value.unlimited ? '构建机不限累计用量' : `公共 Token 剩余 ${Number(value.remaining_tokens ?? 0).toLocaleString('zh-CN')} / ${Number(value.limit_tokens).toLocaleString('zh-CN')}`
}
function edit(provider: any) { active.value = provider; token.value = ''; error.value = '' }
function close() { if (!saving.value) { active.value = null; token.value = ''; props.dismiss?.() } }
async function save() { if (!active.value || !token.value.trim()) return; saving.value = true; error.value = ''; try { await props.saveToken(active.value.id, token.value.trim()); active.value = null; token.value = ''; props.dismiss?.() } catch (failure) { error.value = String((failure as Error).message) } finally { saving.value = false } }
watch(() => props.requestedProvider, id => { const provider = props.providers.find(item => item.id === id); if (provider?.credential) { edit(provider); error.value = props.requestError ?? '' } else active.value = null }, { immediate: true })
</script>
<template>
  <section v-if="!dialogOnly" class="provider-settings">
    <h2>AI Provider</h2><p>在此配置模型渠道的 Token。已有对话保留原后端；新的配置用于下一次连接。</p>
    <button class="provider-action" :disabled="busy" @click="reload">{{ busy ? '检测中…' : '刷新运行环境' }}</button>
    <p v-if="props.error" role="alert">{{ props.error }}</p><p v-if="error" role="alert">{{ error }}</p>
    <article v-for="provider in providers" :key="provider.id" class="provider-card">
      <header><strong>{{ provider.name }}</strong><span>{{ provider.public ? allowance(provider.allowance) : provider.credential ? (provider.credential_configured ? 'Token 已配置' : 'Token 未配置') : provider.state === 'Ready' ? '已检测到运行环境' : '需要安装或配置' }}</span></header>
      <p>{{ provider.detail }}</p>
      <button v-if="provider.credential" class="provider-action" :disabled="busy" @click="edit(provider)"><KeyIcon />{{ provider.credential_configured ? '更新' : '配置' }} {{ provider.credential.label }}</button>
    </article>
  </section>
    <ProviderTokenDialog v-if="active" v-model="token" :credential="active.credential" :saving="saving" :can-save="!!token.trim()" :error="error" :save-label="saveLabel" @close="close" @save="save" />
</template>
<style scoped>
.provider-settings{color:var(--shell-text);font-size:13px;line-height:1.6}.provider-settings h2{font-size:18px}.provider-settings p{color:var(--shell-text-muted)}.provider-card{padding:16px 0;border-bottom:1px solid var(--shell-border)}.provider-card header{display:flex;align-items:center;justify-content:space-between;gap:12px}.provider-card header strong{font-size:15px}.provider-card header span{color:var(--shell-text-faint);font-size:12px}.provider-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}.provider-card label{display:block;margin:10px 0;color:var(--shell-text-muted)}.provider-card input{display:block;box-sizing:border-box;width:100%;max-width:580px;margin-top:4px;padding:8px 10px;border:1px solid var(--shell-border-strong);border-radius:8px;background:var(--shell-surface);color:var(--shell-text);font:inherit}
.provider-action {
  box-sizing: border-box;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 28px;
  padding: 0 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.provider-action:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); }
.provider-action:focus-visible { outline: 2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary)); outline-offset: 2px; }
.provider-action svg { width: 16px; height: 16px; flex: none; }
</style>
