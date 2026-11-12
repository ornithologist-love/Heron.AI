// Loads and validates feature templates (index.json + sibling Markdown prompts).
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME_PATTERN = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/
const FIELD_PATTERN = /\{([a-zA-Z][a-zA-Z0-9_]*)\}/g

export class TemplateStore {
  constructor(directory) {
    this.directory = directory ?? resolveTemplateDirectory()
  }

  async read() {
    const index = path.join(this.directory, 'index.json')
    if (!fs.existsSync(index)) throw new Error('模板索引不存在：' + this.directory)
    if (fs.statSync(index).size > 256 * 1024) throw new Error('模板索引过大')
    let catalog
    try {
      catalog = JSON.parse(await fs.promises.readFile(index, 'utf8'))
    } catch (error) {
      throw new Error('模板索引不是有效 JSON：' + error.message)
    }
    if (!catalog || catalog.version !== 1 || !Array.isArray(catalog.templates) || catalog.templates.length > 100)
      throw new Error('模板索引需要 version=1 和 templates 数组（最多 100 项）')
    const ids = new Set()
    for (const template of catalog.templates) {
      if (!template || !NAME_PATTERN.test(template.id ?? '') || template.id === 'chat' || ids.has(template.id) ||
          !String(template.name ?? '').trim() || !String(template.agent_id ?? '').trim() ||
          !String(template.agent_name ?? '').trim() || !Array.isArray(template.fields) || template.fields.length > 20)
        throw new Error('模板 ID、名称、智能体或输入项无效，ID 不可重复或使用 chat')
      ids.add(template.id)
      const fieldNames = new Set()
      for (const field of template.fields) {
        if (!field || !NAME_PATTERN.test(field.name ?? '') || fieldNames.has(field.name) || !String(field.label ?? '').trim())
          throw new Error(`模板 ${template.id} 输入项无效或重名`)
        fieldNames.add(field.name)
      }
      // Only direct Markdown children are accepted, including no symlink escape.
      const file = template.prompt_file
      if (typeof file !== 'string' || !file.trim() || file !== path.basename(file) || /[\\/:]/.test(file) ||
          !file.toLowerCase().endsWith('.md'))
        throw new Error(`模板 ${template.id} 的 prompt_file 必须是当前目录中的 Markdown 文件名`)
      const promptPath = path.join(this.directory, file)
      let stats
      try {
        stats = fs.lstatSync(promptPath)
      } catch {
        throw new Error(`模板 ${template.id} 的 Markdown 不存在、过大或是链接`)
      }
      if (!stats.isFile() || stats.size > 256 * 1024 || stats.isSymbolicLink())
        throw new Error(`模板 ${template.id} 的 Markdown 不存在、过大或是链接`)
      const prompt = (await fs.promises.readFile(promptPath, 'utf8')).trim()
      if (!prompt) throw new Error(`模板 ${template.id} 的 Prompt 不能为空`)
      template.prompt = prompt
      for (const match of prompt.matchAll(FIELD_PATTERN))
        if (!fieldNames.has(match[1])) throw new Error(`模板 ${template.id} 未定义输入项 ${match[0]}`)
    }
    return catalog
  }
}

export function resolveTemplateDirectory() {
  return fileURLToPath(new URL('../content/templates/', import.meta.url))
}

// Plugins own their content and defaults. Registration lasts only as long as
// the contributing plugin; selected sessions keep their existing prompt snapshot.
export class TemplateCatalog {
  constructor(directory) {
    this.sources = new Map([['local', { store: new TemplateStore(directory) }]])
  }

  registerSource({ id, directory, defaults }) {
    if (typeof id !== 'string' || !id.trim() || this.sources.has(id)) throw Error('模板来源 ID 无效或重复')
    if (typeof directory !== 'string' || !path.isAbsolute(directory)) throw Error('模板来源需要绝对目录')
    if (defaults !== undefined && typeof defaults !== 'function') throw Error('模板默认值提供者必须是函数')
    const source = { store: new TemplateStore(directory), defaults }
    this.sources.set(id, source)
    return () => { if (this.sources.get(id) === source) this.sources.delete(id) }
  }

  async read() {
    const templates = [], ids = new Set()
    for (const [sourceId, source] of this.sources) {
      for (const template of (await source.store.read()).templates) {
        if (ids.has(template.id)) throw Error('不同模板来源存在重复 ID：' + template.id)
        ids.add(template.id)
        const defaults = await source.defaults?.(template) ?? {}
        templates.push({ ...template, sourceId, fields: template.fields.map(field => ({ ...field,
          default_value: field.default_value ?? defaults[field.name] })) })
      }
    }
    return { version: 1, templates }
  }

  async directoryFor(templateId) {
    const catalog = await this.read()
    const template = templateId ? catalog.templates.find(item => item.id === templateId) : catalog.templates[0]
    if (templateId && !template) throw Error('模板已删除，请刷新模板后重新选择')
    return this.sources.get(template?.sourceId ?? 'local').store.directory
  }
}
