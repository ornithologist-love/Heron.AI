import { googleServices } from './services.mjs'

const apiRoots = {
  drive: 'https://www.googleapis.com/drive/v3/',
  docs: 'https://docs.googleapis.com/v1/',
  sheets: 'https://sheets.googleapis.com/v4/',
  slides: 'https://slides.googleapis.com/v1/',
  calendar: 'https://www.googleapis.com/calendar/v3/',
  gmail: 'https://gmail.googleapis.com/gmail/v1/',
}
const servicesByToolset = new Map(googleServices.map(service => [`google.${service.id}`, service]))
const driveFields = 'id,name,mimeType,webViewLink,description,parents,createdTime,modifiedTime,size,driveId'
const maxOutputBytes = 2 * 1024 * 1024

const documentId = { type: 'string', description: 'Google Docs document ID.', pattern: '^[A-Za-z0-9_-]+$', maxLength: 160 }
const fileId = { ...documentId, description: 'Google Drive file or folder ID.' }
const tabId = { ...documentId, description: 'Optional Google Docs tab ID.', pattern: '^[A-Za-z0-9._-]+$' }
const spreadsheetId = { ...documentId, description: 'Google Sheets spreadsheet ID.' }
const presentationId = { ...documentId, description: 'Google Slides presentation ID.' }
const slideId = { ...tabId, description: 'Optional slide object ID from google_slides_list_slides.' }
const messageId = { ...documentId, description: 'Gmail message ID from google_gmail_search.' }
const string = (description, maxLength, minLength = 1) => ({ type: 'string', description, maxLength, minLength })
const bool = description => ({ type: 'boolean', description })
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false })
const output = {
  schema: object({ output: { type: 'string' } }, ['output']),
  render: (_arguments, result) => [{ type: 'text', text: result.output }],
}

function checkedText(value, name, maxLength, empty = false) {
  if (typeof value !== 'string' || value.length > maxLength || (!empty && !value.length) || value.includes('\0')) {
    throw new Error(`Invalid ${name}.`)
  }
  return value
}

function checkedId(value, name, pattern = documentId.pattern) {
  if (!new RegExp(pattern).test(checkedText(value, name, 160))) throw new Error(`Invalid ${name}.`)
  return value
}

function checkedFlag(value, name) {
  if (value !== undefined && typeof value !== 'boolean') throw new Error(`Invalid ${name}.`)
  return value === true
}

function checkedTab(input) {
  return input.tab_id === undefined ? undefined : checkedId(input.tab_id, 'tab ID', tabId.pattern)
}

function searchDrive(input, request) {
  const title = checkedText(input.title, 'file title', 512).replaceAll('\\', '\\\\').replaceAll("'", "\\'")
  const operator = checkedFlag(input.exact, 'exact match setting') ? '=' : 'contains'
  const terms = ['trashed = false', `name ${operator} '${title}'`]
  if (input.folder_id !== undefined) terms.push(`'${checkedId(input.folder_id, 'folder ID')}' in parents`)
  return request('files', {
    q: terms.join(' and '), pageSize: checkedLimit(input.limit, 15), fields: `nextPageToken,incompleteSearch,files(${driveFields})`,
    spaces: 'drive', includeItemsFromAllDrives: true, supportsAllDrives: true,
  })
}

function literalReplacements(replacements) {
  if (!Array.isArray(replacements) || replacements.length < 1 || replacements.length > 10) {
    throw new Error('Use between one and ten replacements.')
  }
  let size = 0
  return replacements.map(item => {
    if (!item || typeof item !== 'object') throw new Error('Invalid replacement.')
    const { find, replace } = item
    checkedText(find, 'text to find', 2000)
    checkedText(replace, 'replacement text', 4000, true)
    if (/^\^?\$?$/.test(find) || /[/\\&\r\n]/.test(find + replace)) {
      throw new Error('Each replacement needs literal single-line text. Slash, backslash, ampersand and stand-alone anchors are unsupported.')
    }
    size += find.length + replace.length
    if (size > 12000) throw new Error('This edit is too large for one batch.')
    return { find, replace }
  })
}

function checkedLimit(value, fallback, max = 50) {
  const limit = value ?? fallback
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new Error(`Result limit must be between 1 and ${max}.`)
  return limit
}

function columnNumber(letters) {
  return [...letters.toUpperCase()].reduce((number, char) => number * 26 + char.charCodeAt(0) - 64, 0)
}

function checkedRange(value) {
  const range = checkedText(value, 'A1 range', 512)
  const cells = range.slice(range.lastIndexOf('!') + 1)
  const match = /^([A-Za-z]{1,3})([1-9]\d{0,6})(?::([A-Za-z]{1,3})([1-9]\d{0,6}))?$/.exec(cells)
  if (!match) throw new Error('Use a bounded A1 range, such as Sheet1!A1:D10.')
  const [, firstCol, firstRow, lastCol = firstCol, lastRow = firstRow] = match
  const columns = columnNumber(lastCol) - columnNumber(firstCol) + 1
  const rows = Number(lastRow) - Number(firstRow) + 1
  if (columns < 1 || rows < 1 || columns * rows > 5000) throw new Error('Choose an A1 range of at most 5000 cells.')
  return range
}

function calendarDayStart(date, timeZone) {
  const midnight = Date.parse(date + 'T00:00:00Z')
  const formatter = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'longOffset' })
  const offsetAt = instant => {
    const offset = formatter.formatToParts(instant).find(part => part.type === 'timeZoneName')?.value
    if (offset === 'GMT') return 0
    const [, sign, hour, minute, second = '0'] = /^GMT([+-])(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(offset) ?? []
    return (sign === '-' ? -1 : 1) * ((Number(hour) * 60 + Number(minute)) * 60 + Number(second)) * 1000
  }
  const first = midnight - offsetAt(midnight)
  return new Date(midnight - offsetAt(first)).toISOString()
}

async function calendarEvents(input, request) {
  const maxResults = checkedLimit(input.limit, 20)
  const id = input.calendar_id === undefined ? 'primary' : checkedText(input.calendar_id, 'calendar ID', 512)
  if (id === '.' || id === '..') throw new Error('Invalid calendar ID.')
  const calendar = 'calendars/' + encodeURIComponent(id)
  const { date, start, end } = input
  let timeMin = start
  let timeMax = end
  if (date !== undefined) {
    checkedText(date, 'calendar date', 10)
    if (start !== undefined || end !== undefined) throw new Error('Choose either a date or a start and end time.')
    const parsed = new Date(date)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) {
      throw new Error('Use YYYY-MM-DD for the calendar date.')
    }
    const { timeZone } = await request(calendar, { fields: 'timeZone' })
    if (!timeZone) throw new Error('Google Calendar did not provide a timezone.')
    parsed.setUTCDate(parsed.getUTCDate() + 1)
    timeMin = calendarDayStart(date, timeZone)
    timeMax = calendarDayStart(parsed.toISOString().slice(0, 10), timeZone)
  } else {
    for (const [key, value] of [['start', start], ['end', end]]) {
      if (value === undefined) continue
      checkedText(value, `calendar ${key} time`, 40)
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
        || !Number.isFinite(Date.parse(value))) throw new Error(`Use RFC3339 with a timezone for the calendar ${key} time.`)
    }
    if (start !== undefined && end !== undefined && Date.parse(start) >= Date.parse(end)) {
      throw new Error('The calendar end time must be after the start time.')
    }
    if (start === undefined && end === undefined) timeMin = new Date().toISOString()
  }
  return request(calendar + '/events', { timeMin, timeMax, maxResults, singleEvents: true, orderBy: 'startTime' })
}

function documentPath(input) {
  return 'documents/' + checkedId(input.document_id, 'document ID')
}

function documentTabs(document) {
  const flatten = tabs => tabs.flatMap(tab => [tab, ...flatten(tab.childTabs ?? [])])
  return document.tabs?.length ? flatten(document.tabs) : [{ documentTab: document }]
}

function selectDocumentTabs(document, tab) {
  const tabs = documentTabs(document)
  if (tab === undefined) return tabs
  const selected = tabs.find(candidate => candidate.tabProperties?.tabId === tab)
  if (!selected) throw new Error('Google Docs tab was not found.')
  return [selected]
}

function documentText(content, formatted = false) {
  return (content ?? []).map(element => {
    if (element.paragraph) {
      const paragraph = element.paragraph
      const text = (paragraph.elements ?? []).map(part => part.textRun?.content ?? '').join('').replace(/\n$/, '')
      if (!formatted || !text) return text
      const heading = /^HEADING_([1-6])$/.exec(paragraph.paragraphStyle?.namedStyleType)?.[1]
      if (heading) return '#'.repeat(Number(heading)) + ' ' + text
      return paragraph.bullet ? '- ' + text : text
    }
    if (element.table) return element.table.tableRows.map(row =>
      row.tableCells.map(cell => documentText(cell.content, formatted)).join(formatted ? ' | ' : '\n')).join('\n')
    return documentText(element.tableOfContents?.content, formatted)
  }).join('\n')
}

async function listDocumentTabs(input, request) {
  const document = await request(documentPath(input), { includeTabsContent: true })
  return { documentId: document.documentId, title: document.title, tabs: documentTabs(document).flatMap(tab =>
    tab.tabProperties ? [tab.tabProperties] : []) }
}

async function readDocument(input, request) {
  const path = documentPath(input)
  const tab = checkedTab(input)
  const includeComments = checkedFlag(input.include_comments ?? true, 'include comments setting')
  const document = await request(path, { includeTabsContent: true })
  const tabs = selectDocumentTabs(document, tab)
  const sections = tabs.map(item => {
    const title = tabs.length > 1 && item.tabProperties?.title ? `## ${item.tabProperties.title}\n\n` : ''
    return title + documentText(item.documentTab?.body?.content, true)
  })
  if (includeComments) {
    const comments = []
    let pageToken
    do {
      const page = await request(path.replace('documents/', 'files/') + '/comments', {
        fields: 'nextPageToken,comments(content,resolved,author(displayName))', pageSize: 100, pageToken,
      }, { service: 'drive' })
      for (const comment of page.comments ?? []) {
        if (!comment.resolved && comment.content) comments.push(comment)
      }
      pageToken = page.nextPageToken
    } while (pageToken)
    if (comments.length) {
      sections.push('## Document comments\n\n' + comments.map((comment, index) =>
        `[^${index + 1}]: ${comment.author?.displayName ?? 'Comment'}: ${comment.content}`).join('\n'))
    }
  }
  return sections.join('\n\n')
}

function previewReplacements(tabs, replacements) {
  const segments = tabs.flatMap(({ documentTab }) => {
    const { body, headers, footers, footnotes } = documentTab ?? {}
    return [body, ...Object.values(headers ?? {}), ...Object.values(footers ?? {}), ...Object.values(footnotes ?? {})]
      .map(segment => documentText(segment?.content))
  })
  return replacements.map(({ find, replace }) => {
    let matches = 0
    for (const [index, text] of segments.entries()) {
      let occurrences = 0
      for (let offset = text.indexOf(find); offset !== -1; offset = text.indexOf(find, offset + find.length)) occurrences++
      if (!occurrences) continue
      if (text.length + occurrences * (replace.length - find.length) > maxOutputBytes) {
        throw new Error('Google Docs preview is too large. Use a narrower replacement.')
      }
      matches += occurrences
      segments[index] = text.replaceAll(find, () => replace)
    }
    return { find, occurrencesChanged: matches }
  })
}

async function replaceDocumentText(input, request) {
  const path = documentPath(input)
  const tab = checkedTab(input)
  const dryRun = checkedFlag(input.dry_run, 'dry run setting')
  const replacements = literalReplacements(input.replacements)
  if (dryRun) {
    const document = await request(path, { includeTabsContent: true })
    return { dry_run: true, replacements: previewReplacements(selectDocumentTabs(document, tab), replacements) }
  }
  return request(path + ':batchUpdate', {}, { body: {
    requests: replacements.map(({ find, replace }) => ({ replaceAllText: {
      containsText: { text: find, matchCase: true, searchByRegex: false }, replaceText: replace,
      ...(tab === undefined ? {} : { tabsCriteria: { tabIds: [tab] } }),
    } })),
  } })
}

function slideText(elements) {
  const content = text => (text?.textElements ?? []).map(element => element.textRun?.content ?? '').join('').trimEnd()
  return (elements ?? []).flatMap(element => [
    content(element.shape?.text) || element.wordArt?.renderedText,
    slideText(element.elementGroup?.children),
    ...(element.table?.tableRows ?? []).map(row => row.tableCells.map(cell => content(cell.text)).join(' | ')),
  ]).filter(Boolean).join('\n')
}

async function readPresentation(input, request) {
  const path = 'presentations/' + checkedId(input.presentation_id, 'presentation ID')
  const slide = input.slide_id === undefined ? undefined : checkedId(input.slide_id, 'slide ID', slideId.pattern)
  const presentation = await request(path, slide === undefined ? { fields: 'title,slides(objectId,pageElements)' } : {})
  if (slide !== undefined) {
    const page = presentation.slides?.find(candidate => candidate.objectId === slide)
    if (!page) throw new Error('Google Slides page was not found.')
    return page
  }
  return [presentation.title, ...(presentation.slides ?? []).map((page, index) =>
    `## Slide ${index + 1} (${page.objectId})\n${slideText(page.pageElements)}`)].filter(Boolean).join('\n\n')
}

function gmailBody(part, mimeType) {
  if (!part || part.filename || (part.headers ?? []).some(header =>
    header.name.toLowerCase() === 'content-disposition' && /^attachment\b/i.test(header.value))) return ''
  if (part.mimeType === mimeType && part.body?.data) {
    const bytes = Buffer.from(part.body.data, 'base64url')
    const contentType = part.headers?.find(header => header.name.toLowerCase() === 'content-type')?.value
    const charset = /\bcharset="?([^";\s]+)/i.exec(contentType)?.[1] ?? 'utf-8'
    try { return new TextDecoder(charset).decode(bytes) }
    catch { return bytes.toString('utf8') }
  }
  return (part.parts ?? []).map(child => gmailBody(child, mimeType)).filter(Boolean).join('\n')
}

async function readGmail(input, request) {
  const message = await request('users/me/messages/' + checkedId(input.message_id, 'message ID'), { format: 'full' })
  const { payload, ...metadata } = message
  const headers = (payload?.headers ?? []).filter(header =>
    /^(?:from|to|cc|subject|date|reply-to)$/i.test(header.name))
  const plain = gmailBody(payload, 'text/plain')
  return { ...metadata, headers, ...(plain ? { body: plain } : { bodyHtml: gmailBody(payload, 'text/html') || undefined }) }
}

const catalog = [
  {
    toolset: 'google.drive',
    name: 'google_drive_search',
    description: 'Find Google Drive files by exact title or title prefix, optionally under a folder. Returns names and file IDs.',
    parameters: object({
      title: string('File title or starting portion of the title.', 512),
      exact: bool('Match the full file title.'),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results, defaults to 15.' },
      folder_id: fileId,
    }, ['title']),
    run: searchDrive,
  },
  {
    toolset: 'google.drive',
    name: 'google_drive_info',
    description: 'Read one Google Drive file’s name, type, link and other metadata using its file ID.',
    parameters: object({ file_id: fileId }, ['file_id']),
    run: (input, request) => request('files/' + checkedId(input.file_id, 'file ID'), { fields: driveFields, supportsAllDrives: true }),
  },
  {
    toolset: 'google.docs',
    name: 'google_docs_list_tabs',
    description: 'List the tabs of a Google Doc so you can target the correct tab before reading or editing.',
    parameters: object({ document_id: documentId }, ['document_id']),
    run: listDocumentTabs,
  },
  {
    toolset: 'google.docs',
    name: 'google_docs_read',
    description: 'Read a Google Doc or one tab as formatted text, with optional comments.',
    parameters: object({
      document_id: documentId,
      tab_id: tabId,
      include_comments: bool('Include open document comments in a separate section. Defaults to true.'),
    }, ['document_id']),
    run: readDocument,
  },
  {
    toolset: 'google.docs',
    name: 'google_docs_append',
    description: 'Append text to the end of a Google Docs tab. Defaults to the first tab.',
    parameters: object({ document_id: documentId, tab_id: tabId, text: string('Text to append.', 8000) },
      ['document_id', 'text']),
    mutates: true,
    run: (input, request) => {
      const path = documentPath(input), tab = checkedTab(input)
      const text = checkedText(input.text, 'appended text', 8000)
      return request(path + ':batchUpdate', {}, { body: {
        requests: [{ insertText: { text, endOfSegmentLocation: tab === undefined ? {} : { tabId: tab } } }],
      } })
    },
  },
  {
    toolset: 'google.docs',
    name: 'google_docs_replace_text',
    description: 'Batch replace literal text in a Google Docs tab. Omit tab_id to target all tabs. Set dry_run to preview.',
    parameters: object({
      document_id: documentId,
      tab_id: tabId,
      dry_run: bool('Preview matches without making changes.'),
      replacements: {
        type: 'array', minItems: 1, maxItems: 10, items: object({
          find: string('Nonempty, single-line literal text to find.', 2000),
          replace: string('Single-line literal replacement. Empty text removes the match.', 4000, 0),
        }, ['find', 'replace']),
      },
    }, ['document_id', 'replacements']),
    mutates: true,
    run: replaceDocumentText,
  },
  {
    toolset: 'google.sheets',
    name: 'google_sheets_info',
    description: 'Read spreadsheet metadata and available sheet names.',
    parameters: object({ spreadsheet_id: spreadsheetId }, ['spreadsheet_id']),
    run: (input, request) => request('spreadsheets/' + checkedId(input.spreadsheet_id, 'spreadsheet ID'), {
      fields: 'spreadsheetId,spreadsheetUrl,properties(title,locale,timeZone),sheets(properties)',
    }),
  },
  {
    toolset: 'google.sheets',
    name: 'google_sheets_read',
    description: 'Read values in an explicit A1 cell range, up to 5000 cells.',
    parameters: object({
      spreadsheet_id: spreadsheetId,
      range: string('A bounded A1 range such as Sheet1!A1:D10.', 512),
    }, ['spreadsheet_id', 'range']),
    run: (input, request) => request('spreadsheets/' + checkedId(input.spreadsheet_id, 'spreadsheet ID')
      + '/values/' + encodeURIComponent(checkedRange(input.range)), { valueRenderOption: 'FORMATTED_VALUE' }),
  },
  {
    toolset: 'google.slides',
    name: 'google_slides_list_slides',
    description: 'List slides and their object IDs for a presentation.',
    parameters: object({ presentation_id: presentationId }, ['presentation_id']),
    run: (input, request) => request('presentations/' + checkedId(input.presentation_id, 'presentation ID'), {
      fields: 'presentationId,title,slides(objectId)',
    }),
  },
  {
    toolset: 'google.slides',
    name: 'google_slides_read',
    description: 'Read presentation text or the details of a single slide.',
    parameters: object({ presentation_id: presentationId, slide_id: slideId }, ['presentation_id']),
    run: readPresentation,
  },
  {
    toolset: 'google.calendar',
    name: 'google_calendar_list',
    description: 'List calendars available to the signed-in Google account.',
    parameters: object({}, []),
    run: (_input, request) => request('users/me/calendarList'),
  },
  {
    toolset: 'google.calendar',
    name: 'google_calendar_events',
    description: 'List upcoming events, events for one date, or events in an explicit time window.',
    parameters: object({
      calendar_id: string('Calendar ID from google_calendar_list. Defaults to the primary calendar.', 512),
      date: string('Specific date as YYYY-MM-DD, used without start and end.', 10),
      start: string('Start in RFC3339 with an explicit timezone.', 40),
      end: string('End in RFC3339 with an explicit timezone.', 40),
      limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Maximum results, defaults to 20.' },
    }, []),
    run: calendarEvents,
  },
  {
    toolset: 'google.gmail',
    name: 'google_gmail_search',
    description: 'Search Gmail with Gmail search syntax to locate messages and their IDs.',
    parameters: object({
      query: string('Gmail search query, for example is:unread.', 512),
      limit: { type: 'integer', minimum: 1, maximum: 30, description: 'Maximum messages, defaults to 10.' },
    }, ['query']),
    run: (input, request) => request('users/me/messages', {
      q: checkedText(input.query, 'Gmail query', 512), maxResults: checkedLimit(input.limit, 10, 30),
    }),
  },
  {
    toolset: 'google.gmail',
    name: 'google_gmail_read',
    description: 'Read a single Gmail message by its exact message ID.',
    parameters: object({ message_id: messageId }, ['message_id']),
    run: readGmail,
  },
]

async function requestGoogle(fetch, service, path, query, body, token, signal) {
  const url = new URL(path, apiRoots[service])
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) url.searchParams.set(key, String(value))
  }
  let response
  try {
    response = await fetch(url, {
      method: body === undefined ? 'GET' : 'POST', signal, redirect: 'error',
      headers: { Authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  } catch {
    signal.throwIfAborted()
    throw new Error('Google Workspace request failed to connect.')
  }
  if (!response.ok) {
    void response.body?.cancel().catch(() => {})
    throw new Error(`Google Workspace request failed (HTTP ${response.status}).`)
  }
  try { return await response.json() }
  catch {
    signal.throwIfAborted()
    throw new Error('Google Workspace returned an invalid response.')
  }
}

/** Tool contracts shared by discovery and execution; credentials stay in the process adapter. */
export function googleWorkspaceTools({ accessToken, fetch = globalThis.fetch }) {
  return catalog.map(({ run, ...tool }) => ({
    ...tool,
    output,
    async execute(input, execution) {
      const service = servicesByToolset.get(tool.toolset)
      const timeout = AbortSignal.timeout(60_000)
      const signal = execution?.signal ? AbortSignal.any([execution.signal, timeout]) : timeout
      signal.throwIfAborted()
      let token
      const result = await run(input, async (path, query = {}, options = {}) => {
        token ??= await accessToken({ scopes: service.scopes, signal })
        if (typeof token !== 'string' || token.length === 0) throw new Error('Connect Google Suite in Heron first.')
        signal.throwIfAborted()
        return requestGoogle(fetch, options.service ?? service.id, path, query, options.body, token, signal)
      })
      const text = typeof result === 'string' ? result : JSON.stringify(result)
      if (Buffer.byteLength(text) > maxOutputBytes) throw new Error('Google Workspace result is too large. Request a smaller result.')
      return { output: text.replaceAll(token, '[redacted]').trimEnd() }
    },
  }))
}
