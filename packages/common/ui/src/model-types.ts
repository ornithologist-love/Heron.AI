// ACP model metadata consumed by the migrated HeronAI model picker.
export interface ConfigOption { id: string; name: string; value: string; options: { label: string; value: string }[] }

export interface PublicAiAllowance {
  provider: string; model: string; configured: boolean
  unlimited?: boolean; limit_tokens?: number | null; remaining_tokens?: number | null
  used_tokens?: number; reserved_tokens?: number; input_tokens?: number; output_tokens?: number
  calls?: number; unsettled_calls?: number; error?: string
}
