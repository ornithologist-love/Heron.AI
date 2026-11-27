// Anchor: Docs/architecture/extensions.md#google-connector
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { googleWorkspaceTools } from '../tools.mjs'

const token = 'mock-oauth-credential'
const paragraph = (text, namedStyleType) => ({
  paragraph: { elements: [{ textRun: { content: text + '\n' } }], paragraphStyle: { namedStyleType } },
})
const tab = (tabId, title, content, childTabs = []) => ({
  tabProperties: { tabId, title }, documentTab: { body: { content } }, childTabs,
})
const document = {
  documentId: 'demo-doc', title: 'Fixture document',
  tabs: [tab('t.main', 'Main', [paragraph('Alpha Alpha', 'HEADING_1')], [
    tab('t.child', 'Child', [{ table: { tableRows: [{ tableCells: [{ content: [paragraph('Alpha AlphaBeta')] }] }] } }]),
  ])],
}
const replacements = [{ find: 'Alpha', replace: 'Beta' }, { find: 'Beta', replace: 'Done' }]
const writeResponse = { documentId: 'demo-doc', replies: [{ replaceAllText: { occurrencesChanged: 1 } }] }
const bodyData = value => ({ data: Buffer.from(value).toString('base64url') })

function client(respond = () => ({})) {
  const calls = []
  const access = []
  const tools = googleWorkspaceTools({
    accessToken: options => { access.push(options); return token },
    async fetch(url, options) {
      const body = options.body === undefined ? undefined : JSON.parse(options.body)
      const call = { url, options, body }
      calls.push(call)
      const result = await respond(call)
      return result instanceof Response ? result : Response.json(result)
    },
  })
  const execute = (name, input, execution) => {
    const tool = tools.find(item => item.name === 'google_' + name)
    assert.ok(tool, name)
    return tool.execute(input, execution).then(result => result.output)
  }
  return { tools, execute, calls, access }
}

test('all fourteen tool contracts dispatch to the official Google REST endpoints', async () => {
  const { calls, access, tools, execute } = client(({ url }) => {
    if (url.pathname === '/v1/documents/demo-doc') return document
    if (url.pathname === '/v1/presentations/demo-slides') return { title: 'Fixture', slides: [{ objectId: 'slide1' }] }
    return {}
  })
  const cases = [
    ['drive_search', { title: 'Demo' }, 'www.googleapis.com/drive/v3/files'],
    ['drive_info', { file_id: 'demo-file' }, 'www.googleapis.com/drive/v3/files/demo-file'],
    ['docs_list_tabs', { document_id: 'demo-doc' }, 'docs.googleapis.com/v1/documents/demo-doc'],
    ['docs_read', { document_id: 'demo-doc', include_comments: false }, 'docs.googleapis.com/v1/documents/demo-doc'],
    ['docs_append', { document_id: 'demo-doc', text: 'Append' }, 'docs.googleapis.com/v1/documents/demo-doc:batchUpdate', 'POST'],
    ['docs_replace_text', { document_id: 'demo-doc', replacements }, 'docs.googleapis.com/v1/documents/demo-doc:batchUpdate', 'POST'],
    ['sheets_info', { spreadsheet_id: 'demo-sheet' }, 'sheets.googleapis.com/v4/spreadsheets/demo-sheet'],
    ['sheets_read', { spreadsheet_id: 'demo-sheet', range: "'My/Sheet'!A1:C3" }, "sheets.googleapis.com/v4/spreadsheets/demo-sheet/values/'My%2FSheet'!A1%3AC3"],
    ['slides_list_slides', { presentation_id: 'demo-slides' }, 'slides.googleapis.com/v1/presentations/demo-slides'],
    ['slides_read', { presentation_id: 'demo-slides', slide_id: 'slide1' }, 'slides.googleapis.com/v1/presentations/demo-slides'],
    ['calendar_list', {}, 'www.googleapis.com/calendar/v3/users/me/calendarList'],
    ['calendar_events', { calendar_id: 'test+calendar@example.invalid' }, 'www.googleapis.com/calendar/v3/calendars/test%2Bcalendar%40example.invalid/events'],
    ['gmail_search', { query: 'is:unread' }, 'gmail.googleapis.com/gmail/v1/users/me/messages'],
    ['gmail_read', { message_id: 'demo-message' }, 'gmail.googleapis.com/gmail/v1/users/me/messages/demo-message'],
  ]
  assert.equal(tools.length, cases.length)
  for (const [name, input, target, method = 'GET'] of cases) {
    await execute(name, input)
    const { url, options } = calls.at(-1)
    assert.equal(url.host + url.pathname, target, name)
    assert.equal(url.protocol, 'https:')
    assert.equal(options.method, method)
    assert.equal(options.headers.Authorization, 'Bearer ' + token)
    assert.equal(options.redirect, 'error')
    assert.equal(options.signal, access.at(-1).signal)
  }
  assert.equal(calls.length, cases.length)
})

test('Drive quotes titles and rejects invalid IDs, ranges, dates and edits before authorization', async () => {
  const { calls, access, execute } = client()
  await assert.rejects(execute('drive_info', { file_id: '../demo' }), /Invalid file ID/)
  await assert.rejects(execute('sheets_read', { spreadsheet_id: 'demo', range: 'A1:M500' }), /5000/)
  await assert.rejects(execute('calendar_events', { date: '2025-02-29' }), /YYYY-MM-DD/)
  await assert.rejects(execute('docs_replace_text', { document_id: 'demo', replacements: [{ find: '', replace: 'x' }] }), /Invalid text to find/)
  assert.equal(calls.length, 0)
  assert.equal(access.length, 0)
  await execute('drive_search', { title: "O'Brien\\files", folder_id: 'parent', exact: true, limit: 4 })
  assert.equal(calls[0].url.searchParams.get('q'), "trashed = false and name = 'O\\'Brien\\\\files' and 'parent' in parents")
  assert.equal(calls[0].url.searchParams.get('pageSize'), '4')
})

test('Docs reads nested tabs and only adds requested open document comments', async () => {
  const { calls, access, execute } = client(({ url }) => {
    if (url.hostname === 'docs.googleapis.com') return document
    if (url.searchParams.has('pageToken')) return { comments: [{ content: 'second', author: { displayName: 'Reviewer' } }] }
    return { nextPageToken: 'page-2', comments: [{ content: 'resolved', resolved: true }, { content: 'first' }] }
  })
  assert.deepEqual(JSON.parse(await execute('docs_list_tabs', { document_id: 'demo-doc' })).tabs.map(item => item.tabId),
    ['t.main', 't.child'])
  assert.equal(await execute('docs_read', { document_id: 'demo-doc', tab_id: 't.child', include_comments: false }), 'Alpha AlphaBeta')
  assert.equal(calls.length, 2)
  const result = await execute('docs_read', { document_id: 'demo-doc' })
  assert.match(result, /# Alpha Alpha/)
  assert.match(result, /Document comments[\s\S]*first[\s\S]*second/)
  assert.doesNotMatch(result, /resolved/)
  assert.equal(calls[2].url.searchParams.get('includeTabsContent'), 'true')
  assert.equal(calls[3].url.pathname, '/drive/v3/files/demo-doc/comments')
  assert.equal(access.length, 3)
  assert.ok(access.at(-1).scopes.includes('https://www.googleapis.com/auth/drive.readonly'))
})

test('Docs preview reads only the targeted tabs and applies replacements in order', async () => {
  const { calls, execute } = client(({ options }) => options.method === 'POST' ? writeResponse : document)
  const options = { document_id: 'demo-doc', replacements }
  const scoped = JSON.parse(await execute('docs_replace_text', { ...options, tab_id: 't.child', dry_run: true }))
  assert.deepEqual(scoped.replacements.map(item => item.occurrencesChanged), [2, 3])
  const all = JSON.parse(await execute('docs_replace_text', { ...options, dry_run: true }))
  assert.deepEqual(all.replacements.map(item => item.occurrencesChanged), [4, 5])
  assert.deepEqual(calls.map(item => item.options.method), ['GET', 'GET'])
  assert.equal(calls[0].body, undefined)
  await execute('docs_replace_text', { ...options, tab_id: 't.child' })
  assert.deepEqual(calls[2].body.requests[0], {
    replaceAllText: { containsText: { text: 'Alpha', matchCase: true, searchByRegex: false }, replaceText: 'Beta', tabsCriteria: { tabIds: ['t.child'] } },
  })
  await execute('docs_replace_text', options)
  assert.equal(calls[3].body.requests[0].replaceAllText.tabsCriteria, undefined)
  await execute('docs_append', { document_id: 'demo-doc', tab_id: 't.child', text: 'Append' })
  assert.deepEqual(calls[4].body.requests, [{ insertText: { text: 'Append', endOfSegmentLocation: { tabId: 't.child' } } }])
})

test('Calendar day queries use DST-aware calendar midnights and Gmail reads inline text', async () => {
  const { calls, execute } = client(({ url }) => url.pathname === '/calendar/v3/calendars/primary'
    ? { timeZone: 'America/Los_Angeles' }
    : { id: 'demo-message', payload: { mimeType: 'multipart/alternative', headers: [{ name: 'Subject', value: 'Fixture' }],
      parts: [{ mimeType: 'text/plain', body: bodyData('Decoded text ✓') }, { mimeType: 'text/html', body: bodyData('<b>Duplicate</b>') }] } })
  await execute('calendar_events', { date: '2026-03-08' })
  const query = calls[1].url.searchParams
  assert.equal(query.get('timeMin'), '2026-03-08T08:00:00.000Z')
  assert.equal(query.get('timeMax'), '2026-03-09T07:00:00.000Z')
  assert.equal(query.get('singleEvents'), 'true')
  const message = JSON.parse(await execute('gmail_read', { message_id: 'demo-message' }))
  assert.equal(calls[2].url.searchParams.get('format'), 'full')
  assert.equal(message.body, 'Decoded text ✓')
  assert.equal(message.bodyHtml, undefined)
})

test('Google errors redact provider bodies, network errors and echoed credentials', async () => {
  const upstream = client(() => Response.json({ error: token }, { status: 403 }))
  await assert.rejects(upstream.execute('drive_info', { file_id: 'demo' }), { message: 'Google Workspace request failed (HTTP 403).' })
  const network = client(() => { throw new Error(token) })
  await assert.rejects(network.execute('drive_info', { file_id: 'demo' }), { message: 'Google Workspace request failed to connect.' })
  const echo = client(() => ({ detail: token }))
  assert.deepEqual(JSON.parse(await echo.execute('drive_info', { file_id: 'demo' })), { detail: '[redacted]' })
  const controller = new AbortController()
  const abort = client(({ options }) => { controller.abort(); options.signal.throwIfAborted() })
  await assert.rejects(abort.execute('drive_info', { file_id: 'demo' }, { signal: controller.signal }), { name: 'AbortError' })
})
