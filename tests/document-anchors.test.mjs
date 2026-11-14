// Anchor: AGENTS.md
import assert from 'node:assert/strict'
import test from 'node:test'
import { hasDocumentFragment } from './support/document-anchors.mjs'

test('fragments refer to document targets rather than body mentions or code samples', () => {
  for (const [document, fragment, expected] of [
    ['# Valid title', 'valid-title', true],
    ['## Valid title', 'Valid title', true],
    ['Valid title\n---', 'valid-title', true],
    ['Only body text mentions old-title', 'old-title', false],
    ['```md\n# Hidden title\n```', 'hidden-title', false],
    ['<a id="custom"></a>', 'custom', true],
    ['`<a id="custom"></a>`', 'custom', false],
    ['<!--\n# Hidden title\n-->', 'hidden-title', false],
    ['See L-007 for the rule', 'L-007', true],
    ['See L-0070', 'L-007', false],
  ]) assert.equal(hasDocumentFragment(document, fragment), expected, fragment)
})
