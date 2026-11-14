// Anchor: Docs/architecture/extensions.md#身份与模型通道集成
import assert from 'node:assert/strict'
import test from 'node:test'
import { createModelGateway } from '../model-gateway.mjs'

const mockContext = () => ({ on() {} })

test('a host without a gateway address is not managed', () => {
  assert.equal(createModelGateway(mockContext(), undefined), undefined)
})

test('gateway addresses may sit below a public prefix but never carry credentials or leave TLS', () => {
  for (const address of ['https://gateway.example/api/model-gateway/', 'https://gateway.example/orchard/api/model-gateway/', 'http://127.0.0.1:9/api/model-gateway/'])
    assert.ok(createModelGateway(mockContext(), address), address)
  for (const address of ['http://gateway.example/api/model-gateway/', 'https://user:pass@gateway.example/api/model-gateway/',
    'https://gateway.example/api/model-gateway/?x=1', 'https://gateway.example/api/model-gateway', 'https://gateway.example/api/other/'])
    assert.throws(() => createModelGateway(mockContext(), address), /Invalid model gateway URL/, address)
})
