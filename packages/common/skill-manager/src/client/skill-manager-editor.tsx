/**
 * Skill Manager file editor — a fixed full-viewport window rendered inside
 * the owning panel. It can display read-only files and edit writable files.
 */

import React from 'react'
import { IconCheckOutlineRegular, IconCloseOutlineRegular, IconCodeOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotSelectorHook, Translate } from '@deepseek-ai/dsh-client-ui-slots'
import type { SkillManagerKey } from './locales.ts'
import type { SkillManagerController, SkillManagerState } from './store.ts'
import styles from './skill-manager-editor.module.css'

/** The services passed in by the Skills tab. */
export interface SkillManagerEditorInjected {
  /** Wire operations through the host endpoints. */
  controller: SkillManagerController
  /** uSES hook over the shared page state. */
  usePanel: SnapshotSelectorHook<SkillManagerState>
  /** Page copy. */
  t: Translate<SkillManagerKey>
}

/** Props delivered by the Skills panel. */
export type SkillManagerEditorProps = Partial<SkillManagerEditorInjected>

/**
 * Render the file editor as an overlay window.
 * @param props - services from the Skills panel.
 * @returns the editor window, or null while no file is open.
 */
export function SkillManagerEditor({ usePanel, controller, t }: SkillManagerEditorProps) {
  if (usePanel === undefined || controller === undefined || t === undefined) return null
  const editor = usePanel(s => s.editor)
  if (editor === null) return null

  const dirty = editor.content !== editor.saved
  return (
    <div className={styles.mask} role="presentation" onClick={() => controller.closeEditor()}>
      <div
        className={styles.window}
        role="dialog"
        aria-modal="true"
        aria-label={editor.name}
        onClick={event => event.stopPropagation()}
      >
        <header className={styles.header}>
          <div className={styles.heading}>
            <IconCodeOutlineRegular size={16} />
            <span className={styles.fileName}>{editor.name}</span>
          </div>
          <div className={styles.meta}>
            {editor.writable ? null : <span className={styles.badge} data-badge="readonly">{t('readOnly')}</span>}
            {dirty && <span className={styles.dirty}>{t('dirty')}</span>}
          </div>
          <div className={styles.actions}>
            {editor.writable && (
              <button
                type="button"
                className={styles.actionButton}
                disabled={!dirty || editor.saving}
                onClick={() => { void controller.saveFile() }}
              >
                <IconCheckOutlineRegular size={14} />
                <span>{editor.saving ? t('saving') : t('save')}</span>
              </button>
            )}
            <button
              type="button"
              className={styles.closeButton}
              aria-label={t('close')}
              onClick={() => controller.closeEditor()}
            >
              <IconCloseOutlineRegular size={14} />
              <span>{t('close')}</span>
            </button>
          </div>
        </header>
        {editor.saveError !== null && <p className={styles.error}>{t('error', { message: editor.saveError })}</p>}
        <textarea
          className={styles.textarea}
          value={editor.content}
          readOnly={!editor.writable}
          spellCheck={false}
          onChange={event => controller.editContent(event.target.value)}
        />
      </div>
    </div>
  )
}
