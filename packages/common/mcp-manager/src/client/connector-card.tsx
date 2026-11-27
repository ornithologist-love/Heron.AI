import { useId, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react'
import { StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import { ConnectorsPanelIcon } from './ConnectorsPanelIcon.tsx'
import styles from './connector-card.module.css'
import type { ConnectorTone } from './state.ts'

const statusStates = {
  connected: 'done',
  connecting: 'ongoing',
  error: 'error',
  disconnected: 'idle',
} as const

export interface ConnectorCardProps {
  id: string
  name: string
  icon?: string
  description: string
  status?: string
  tone?: ConnectorTone
  badges?: ReactNode
  actions?: ReactNode
  children?: ReactNode
  onOpen?: () => void
}

export const connectorGrid = styles.grid

const INTERACTIVE_SELECTOR = 'button, input, select, textarea, a, label, [role="switch"]'

export function ConnectorCard({
  id, name, icon, description, status, tone = 'disconnected', badges, actions, children, onOpen,
}: ConnectorCardProps) {
  const headingId = useId()
  const localIcon = icon && /^data:image\/(?:svg\+xml,|png;base64,)/.test(icon) ? icon : undefined

  const handleClick = (event: MouseEvent<HTMLElement>) => {
    if (!onOpen) return
    if ((event.target as HTMLElement | null)?.closest(INTERACTIVE_SELECTOR)) return
    onOpen()
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (!onOpen) return
    if ((event.target as HTMLElement | null)?.closest(INTERACTIVE_SELECTOR)) return
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      onOpen()
    }
  }

  return (
    <article
      className={styles.card}
      data-connector={id}
      data-clickable={onOpen ? '' : undefined}
      aria-labelledby={headingId}
      role={onOpen ? 'button' : undefined}
      tabIndex={onOpen ? 0 : undefined}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
    >
      <header className={styles.header}>
        <span className={styles.icon} data-branded={localIcon ? '' : undefined} aria-hidden="true">
          {localIcon ? <img src={localIcon} alt="" width={22} height={22} /> : <ConnectorsPanelIcon size={20} />}
        </span>
        <div className={styles.identity}>
          <h3 className={styles.name} id={headingId}>{name}</h3>
          {description && <p className={styles.description} title={description}>{description}</p>}
        </div>
      </header>
      {badges}
      {(status || actions) && (
        <div className={styles.controls}>
          {status && (
            <span className={styles.status} role="status">
              <StateDot state={statusStates[tone]} size={8} />
              <span className={styles.statusText}>{status}</span>
            </span>
          )}
          {actions && <div className={styles.actions}>{actions}</div>}
        </div>
      )}
      {children}
    </article>
  )
}
