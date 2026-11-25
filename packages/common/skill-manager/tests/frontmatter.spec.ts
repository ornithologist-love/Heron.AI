/**
 * Save-time frontmatter validation.
 *
 * The reason this exists: this plugin reads SKILL.md with a lenient line regex,
 * while the Harness's skill loader parses the same file as strict YAML and drops
 * the entire skill on any error, logging only to the host's stdout. A skill file
 * whose `description` contained `github: ` therefore looked perfectly fine in
 * this editor while being invisible to every agent's catalog. The validator below
 * mirrors the loader (`@deepseek-ai/dsh-skill-filesystem`) using the same `yaml`
 * parser, so the two can no longer disagree at the moment of saving.
 */

import { describe, expect, it } from 'vitest'
import { validateSkillDocument } from '../src/index.ts'

/** Build a SKILL.md from a frontmatter body. */
const doc = (body: string, tail = '\n# Title\n'): string => `---\n${body}\n---${tail}`

describe('validateSkillDocument', () => {
  it('accepts a document the Harness would load', () => {
    expect(validateSkillDocument(doc('name: demo\ndescription: Use when demonstrating.'))).toEqual([])
  })

  it('accepts a quoted description that contains a colon+space', () => {
    const body = 'name: demo\ndescription: "Use when a github: plugin install fails."'
    expect(validateSkillDocument(doc(body))).toEqual([])
  })

  it('accepts a block scalar description that contains a colon+space', () => {
    const body = 'name: demo\ndescription: >-\n  Use when a link: plugin fails to mount.'
    expect(validateSkillDocument(doc(body))).toEqual([])
  })

  it('rejects the exact shape that made a real skill disappear', () => {
    const problems = validateSkillDocument(doc('name: publishing\ndescription: Use when a github: plugin install fails.'))
    expect(problems.join(' ')).toContain('不是合法 YAML')
    // The message must name the cause and the fix, not just fail.
    expect(problems.join(' ')).toContain('冒号+空格')
    expect(problems.join(' ')).toContain('双引号')
  })

  it('rejects an unquoted link: value too', () => {
    const problems = validateSkillDocument(doc('name: dock-plugin-development\ndescription: Use when adding a link: plugin.'))
    expect(problems.join(' ')).toContain('不是合法 YAML')
  })

  it('requires a name and a description', () => {
    expect(validateSkillDocument(doc('description: d')).join(' ')).toContain('缺少 name')
    expect(validateSkillDocument(doc('name: demo')).join(' ')).toContain('缺少 description')
  })

  it('rejects a name the Harness would refuse', () => {
    expect(validateSkillDocument(doc('name: Demo Skill\ndescription: d')).join(' ')).toContain('不合法')
    expect(validateSkillDocument(doc('name: demo_skill\ndescription: d')).join(' ')).toContain('不合法')
  })

  it('rejects frontmatter that is not a mapping, and a missing closing fence', () => {
    expect(validateSkillDocument('---\n- a\n- b\n---\n').join(' ')).toContain('键值映射')
    expect(validateSkillDocument('---\nname: demo\n').join(' ')).toContain('缺少结束的 `---` 行')
    expect(validateSkillDocument('# no frontmatter\n').join(' ')).toContain('必须以单独一行')
  })

  it('agrees with the Harness loader on a table of documents', async () => {
    // Parity check against the loader's own parser: every document this validator
    // accepts must parse to an object with a usable name/description, and every
    // document it rejects must throw in the loader's parser.
    const { parse } = await import('yaml')
    const cases = [
      doc('name: demo\ndescription: plain text'),
      doc('name: demo\ndescription: "quoted: text"'),
      doc('name: demo\ndescription: a github: plugin'),
      doc('name: demo\ndescription: a link: plugin'),
      doc('name: demo\ndescription: text # not a comment\n'),
    ]
    for (const content of cases) {
      const accepted = validateSkillDocument(content).length === 0
      const firstLineEnd = content.indexOf('\n')
      const rest = content.slice(firstLineEnd + 1)
      const block = rest.slice(0, rest.indexOf('\n---'))
      let parsed: unknown = undefined
      let threw = false
      try {
        parsed = parse(block)
      } catch {
        threw = true
      }
      const loaderAccepts = !threw
        && typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        && typeof (parsed as Record<string, unknown>).name === 'string'
        && typeof (parsed as Record<string, unknown>).description === 'string'
      // Acceptance implies the loader parses it; rejection may be a field-rule
      // rejection (the loader's own rules), so only the implication is asserted.
      if (accepted) expect(loaderAccepts, content).toBe(true)
      if (threw) expect(accepted, content).toBe(false)
    }
  })
})
