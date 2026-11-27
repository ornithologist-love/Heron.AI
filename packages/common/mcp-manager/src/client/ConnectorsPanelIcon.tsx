import type { ReactNode } from 'react'

/** Cable plug for connector navigation and unbranded connectors. */
export function ConnectorsPanelIcon({ size = 16 }: { size?: number }): ReactNode {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.35}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M6 2v3m4-3v3M4 5h8v2a4 4 0 0 1-8 0V5Zm4 6v1a2 2 0 0 0 2 2h3" />
    </svg>
  )
}
