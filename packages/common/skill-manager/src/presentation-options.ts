/** Declarative top-level section rule in the Skill Manager panel. */
export interface SkillSectionRule {
  readonly id: string
  readonly title: string
  readonly hint?: string
  readonly info?: string
  readonly matchPrefixes: readonly string[]
  readonly order?: number
}

/** Presentation-only names; catalog and preset IDs remain unchanged. */
export interface Config {
  presetGroupLabels?: readonly { prefix: string; label: string }[]
  sections?: readonly SkillSectionRule[]
}

declare global {
  interface Window { __DSH_SKILL_MANAGER_OPTIONS__?: Config }
}
