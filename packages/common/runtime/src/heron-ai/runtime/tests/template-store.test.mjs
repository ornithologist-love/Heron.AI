// Anchor: Docs/architecture/extensions.md#功能模板
// Template catalogs are validated on load; a prompt file cannot escape its catalog directory.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { TemplateStore } from '../template-store.mjs'

function templateDirectory() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-templates-'))
  fs.writeFileSync(path.join(directory, 'weekly.md'), '周报 {member_name}')
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify({
    version: 1,
    templates: [{
      id: 'weekly', name: '周报', agent_id: 'agent-1', agent_name: 'Heron.AI',
      prompt_file: 'weekly.md', lock_model: true,
      fields: [{ name: 'member_name', label: 'NT 账号', placeholder: 'zhangsan', required: true }],
    }],
  }))
  return directory
}

test('valid catalog loads with prompt content and placeholders validated', async () => {
  const store = new TemplateStore(templateDirectory())
  const catalog = await store.read()
  assert.equal(catalog.templates.length, 1)
  assert.equal(catalog.templates[0].prompt, '周报 {member_name}')
})

test('path traversal in prompt_file is rejected', async () => {
  const directory = templateDirectory()
  const catalog = JSON.parse(fs.readFileSync(path.join(directory, 'index.json'), 'utf8'))
  catalog.templates[0].prompt_file = '../outside.md'
  fs.writeFileSync(path.join(directory, 'index.json'), JSON.stringify(catalog))
  const store = new TemplateStore(directory)
  await assert.rejects(() => store.read(), /prompt_file/)
})
