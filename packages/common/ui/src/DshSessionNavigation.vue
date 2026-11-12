<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { Popup } from 'tdesign-vue-next'
import { AddIcon, HistoryIcon, SearchIcon, CheckIcon, CloseIcon, ChevronDownIcon } from 'tdesign-icons-vue-next'

interface SessionRow {
  id: string
  title: string
  workspace: string
  updatedAt: number
  running: boolean
  current: boolean
}

const props = defineProps<{ rows: SessionRow[]; ready: boolean }>()
const emit = defineEmits<{ new: []; open: [id: string] }>()
const visible = ref(false)
const query = ref('')
const search = ref<HTMLInputElement>()
const matches = computed(() => {
  const needle = query.value.trim().toLocaleLowerCase()
  return needle ? props.rows.filter(row => `${row.title} ${row.workspace}`.toLocaleLowerCase().includes(needle)) : props.rows
})
const shown = computed(() => matches.value.slice(0, 100))
watch(visible, async value => {
  if (value) { query.value = ''; await nextTick(); search.value?.focus() }
})
function open(id: string) { visible.value = false; emit('open', id) }
function start() { visible.value = false; emit('new') }
function time(value: number) {
  const date = new Date(value)
  if (!Number.isFinite(date.getTime())) return ''
  const today = date.toDateString() === new Date().toDateString()
  return date.toLocaleString('zh-CN', { ...(today ? {} : { month: 'numeric', day: 'numeric' }), hour: '2-digit', minute: '2-digit' })
}
</script>

<template>
  <nav class="heron-ai-session-nav" aria-label="会话导航">
    <button class="heron-ai-session-nav-button heron-ai-session-nav-new" :disabled="!ready" @click="start">
      <AddIcon /><span>新会话</span>
    </button>
    <Popup v-model:visible="visible" trigger="click" placement="bottom-left"
      :popper-options="{ strategy: 'fixed', modifiers: [{ name: 'preventOverflow', options: { padding: 12, altAxis: true, tether: false, rootBoundary: 'viewport' } }, { name: 'flip', options: { padding: 12 } }] }"
      :overlay-inner-style="{ padding: '0', borderRadius: '12px', maxWidth: 'calc(100vw - 24px)', overflow: 'hidden' }">
      <button class="heron-ai-session-nav-button" :aria-expanded="visible" aria-haspopup="dialog">
        <HistoryIcon /><span>历史对话</span><ChevronDownIcon class="heron-ai-session-nav-chevron" />
      </button>
      <template #content>
        <section class="heron-ai-session-history" role="dialog" aria-label="历史对话" @keydown.esc.stop.prevent="visible = false">
          <header class="heron-ai-session-history-heading">
            <strong>历史对话</strong><span>{{ rows.length }} 个会话</span>
            <button class="heron-ai-session-history-dismiss" aria-label="关闭历史对话" @click="visible = false"><CloseIcon /></button>
          </header>
          <label class="heron-ai-session-history-search">
            <SearchIcon /><input ref="search" v-model="query" aria-label="搜索历史对话" placeholder="搜索对话或工作区" @keydown.enter.prevent="shown[0] && open(shown[0].id)">
          </label>
          <div class="heron-ai-session-history-list">
            <p v-if="!ready" class="heron-ai-session-history-empty" role="status">正在加载历史对话…</p>
            <p v-else-if="!shown.length" class="heron-ai-session-history-empty">{{ query.trim() ? '没有找到匹配的对话' : '还没有历史对话' }}</p>
            <button v-for="row in shown" :key="row.id" class="heron-ai-session-history-row" :class="{ current: row.current }"
              :aria-current="row.current ? 'true' : undefined" :title="row.title" @click="open(row.id)">
              <span class="heron-ai-session-history-content"><span class="heron-ai-session-history-title">{{ row.title }}</span>
                <span class="heron-ai-session-history-meta"><span>{{ row.workspace }}</span><time>{{ time(row.updatedAt) }}</time><span v-if="row.running" class="heron-ai-session-history-running">进行中</span></span>
              </span>
              <CheckIcon v-if="row.current" class="heron-ai-session-history-current" />
            </button>
          </div>
          <footer v-if="matches.length > shown.length" class="heron-ai-session-history-footer">显示最近 100 条，搜索可查找更早的对话</footer>
        </section>
      </template>
    </Popup>
  </nav>
</template>

<style scoped>
:global([data-conversation-header-leading]:has(.heron-ai-session-nav)) {
  grid-column: 1 / -1;
  width: 100%;
  margin-bottom: 8px;
}
.heron-ai-session-nav { display: flex; align-items: center; gap: 6px; width: 100%; -webkit-app-region: no-drag; }
.heron-ai-session-nav-button { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 10px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; background: transparent; color: var(--dsw-alias-label-secondary); font: inherit; font-size: 12px; white-space: nowrap; cursor: pointer; }
.heron-ai-session-nav-button > :deep(svg) { width: 15px; height: 15px; flex: none; }
.heron-ai-session-nav-button .heron-ai-session-nav-chevron { width: 12px; height: 12px; }
.heron-ai-session-nav-new { color: var(--dsw-alias-brand-primary); background: var(--dsw-alias-interactive-bg-active); border-color: transparent; }
.heron-ai-session-nav-button:hover:not(:disabled) { background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary); }
.heron-ai-session-nav-button:disabled { opacity: .5; cursor: default; }
.heron-ai-session-nav-button:focus-visible, .heron-ai-session-history-row:focus-visible, .heron-ai-session-history-dismiss:focus-visible { outline: 2px solid var(--dsw-alias-brand-primary); outline-offset: 2px; }
.heron-ai-session-history { box-sizing: border-box; width: min(380px, calc(100vw - 24px)); color: var(--dsw-alias-label-primary); background: var(--dsw-alias-bg-base); font: inherit; font-size: 13px; }
.heron-ai-session-history-heading { display: flex; align-items: center; gap: 8px; padding: 12px 14px 8px; }
.heron-ai-session-history-heading strong { font-weight: 600; }
.heron-ai-session-history-heading > span { font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.heron-ai-session-history-dismiss { display: flex; align-items: center; justify-content: center; width: 24px; height: 24px; margin-left: auto; padding: 0; border: 0; border-radius: 6px; color: var(--dsw-alias-label-secondary); background: transparent; cursor: pointer; }
.heron-ai-session-history-dismiss:hover { background: var(--dsw-alias-interactive-bg-hover); }
.heron-ai-session-history-search { display: flex; align-items: center; gap: 8px; margin: 0 12px 8px; padding: 0 10px; height: 34px; border: 1px solid var(--dsw-alias-border-l3); border-radius: 8px; color: var(--dsw-alias-label-tertiary); }
.heron-ai-session-history-search:focus-within { border-color: var(--dsw-alias-brand-primary); }
.heron-ai-session-history-search input { width: 100%; min-width: 0; border: 0; outline: none; background: transparent; color: var(--dsw-alias-label-primary); font: inherit; font-size: 12px; }
.heron-ai-session-history-search input::placeholder { color: var(--dsw-alias-label-tertiary); }
.heron-ai-session-history-list { max-height: min(380px, calc(100dvh - 210px)); overflow: auto; overscroll-behavior: contain; scrollbar-width: thin; padding: 2px 6px 8px; }
.heron-ai-session-history-row { box-sizing: border-box; width: 100%; display: flex; align-items: center; gap: 10px; padding: 10px 8px; border: 0; border-radius: 8px; text-align: left; color: inherit; background: transparent; font: inherit; cursor: pointer; }
.heron-ai-session-history-row:hover { background: var(--dsw-alias-interactive-bg-hover); }
.heron-ai-session-history-row.current { background: var(--dsw-alias-interactive-bg-active); }
.heron-ai-session-history-content { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 4px; }
.heron-ai-session-history-title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 13px; line-height: 18px; }
.heron-ai-session-history-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--dsw-alias-label-tertiary); }
.heron-ai-session-history-meta > span:first-child { max-width: 160px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.heron-ai-session-history-meta time { white-space: nowrap; }
.heron-ai-session-history-running, .heron-ai-session-history-current { color: var(--dsw-alias-brand-primary); }
.heron-ai-session-history-current { flex: none; width: 16px; height: 16px; }
.heron-ai-session-history-empty { margin: 0; padding: 32px 12px; text-align: center; font-size: 12px; color: var(--dsw-alias-label-tertiary); }
.heron-ai-session-history-footer { padding: 8px 12px; border-top: 1px solid var(--dsw-alias-border-l3); color: var(--dsw-alias-label-tertiary); font-size: 11px; text-align: center; }
</style>
