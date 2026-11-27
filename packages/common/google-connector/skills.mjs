import { googleServices } from './services.mjs'

const provider = 'google-connector-skills'
const invocation = Object.freeze({ modelInvocable: false, userInvocable: true })

const guides = {
  drive: 'Use `google_drive_search` to find file IDs by title. Set `exact` for a full title or supply `folder_id` to restrict the search. Use `google_drive_info` for a file’s metadata and link.',
  docs: 'Use `google_docs_list_tabs` to identify the tab, then `google_docs_read` for its text. Set `include_comments` to false if you only need the document body. Use `google_docs_append` to add text or `google_docs_replace_text` for literal replacements. For replacements, `dry_run: true` previews matches. Edits require approval in Heron.',
  sheets: 'Use `google_sheets_info` to find sheet titles, then `google_sheets_read` with a bounded A1 range such as `Sheet1!A1:D10`. Read at most 5000 cells in one call.',
  slides: 'Use `google_slides_list_slides` to identify slide object IDs. Use `google_slides_read` with a `slide_id` to focus on one slide.',
  calendar: 'Use `google_calendar_list` to find calendar IDs. Use `google_calendar_events` to list upcoming events, events on one date, or events in a time window. Use RFC3339 timestamps with explicit timezone offsets for time windows.',
  gmail: 'Use `google_gmail_search` with normal Gmail search syntax such as `is:unread`. Read a specific message by passing its message ID to `google_gmail_read`.',
}

export function registerGoogleSkills(ctx, { isEnabled }) {
  const skills = googleServices.map(({ id, label }) => ({
    id,
    summary: { name: `google-${id}`, description: `Use ${label} through the Google Suite connector.`, invocation, provider, source: 'bundled' },
    content: [
      `Use \`search_mcp_tools\` to discover typed tools in \`google.${id}\`. Heron manages Google authorization.`,
      guides[id],
    ].join('\n\n'),
  }))
  let invalidate
  ctx.skills.registerProvider(control => {
    invalidate = control.invalidate
    return {
      name: provider,
      async list({ signal }) {
        signal?.throwIfAborted()
        return skills.filter(({ id }) => isEnabled(id)).map(({ id, summary }) => ({ ...summary, rank: 600, locator: id }))
      },
      async get(candidate, { signal }) {
        signal?.throwIfAborted()
        const skill = skills.find(({ id }) => id === candidate.locator)
        return skill && isEnabled(skill.id) ? { ...skill.summary, content: skill.content } : undefined
      },
    }
  })
  return invalidate
}
