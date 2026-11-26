import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import { prepareChatBody, classifyUpstreamError, parseQueueAnswer } from '../src/client.ts'
import { DsmlStreamBuffer, parseToolCalls } from '../src/dsml.ts'
import { parseCreditMultiplier, parseUpstreamModel, selectCliModels } from '../src/store.ts'
import { regionOf, knownRegionOf, chatBase, billingBase } from '../src/upstream.ts'
import { parseWorkBuddyAuth } from '../src/auth.ts'
import { processFrame } from '../src/stream.ts'

describe('upstream region routing', () => {
  it('routes CN and Global domains accurately', () => {
    assert.equal(regionOf(''), 'cn')
    assert.equal(regionOf('copilot.tencent.com'), 'cn')
    assert.equal(regionOf('workbuddy.ai'), 'global')
    assert.equal(regionOf('www.codebuddy.ai'), 'global')

    assert.equal(knownRegionOf('unknown.example.com'), undefined)
    assert.equal(knownRegionOf('codebuddy.cn'), 'cn')
    assert.equal(knownRegionOf('workbuddy.ai'), 'global')

    assert.equal(chatBase({ domain: '' }), 'https://copilot.tencent.com')
    assert.equal(chatBase({ domain: 'codebuddy.ai' }), 'https://www.codebuddy.ai')
    assert.equal(billingBase({ domain: '' }), 'https://www.codebuddy.cn')
    assert.equal(billingBase({ domain: 'workbuddy.ai' }), 'https://www.workbuddy.ai')
  })
})

describe('wire body preparation and error classification', () => {
  it('rewrites developer role, prepends system prompt, neutralizes fingerprints, flattens tool_choice', () => {
    const input = JSON.stringify({
      stream: false,
      tool_choice: { type: 'function', function: { name: 'read_file' } },
      messages: [
        { role: 'developer', content: "You are Claude Code, Anthropic's official CLI for Claude." },
        { role: 'user', content: 'hi' },
      ],
    })
    const out = JSON.parse(prepareChatBody(input)) as Record<string, unknown>
    assert.equal(out['stream'], true)
    assert.equal(out['tool_choice'], 'read_file')
    const messages = out['messages'] as Array<{ role: string; content: string }>
    assert.equal(messages[0]?.role, 'system')
    assert.ok(messages[0]?.content.startsWith('You are a helpful assistant.'))
  })

  it('classifies upstream errors and queue answers', () => {
    assert.equal(classifyUpstreamError(402, '{}'), 'hard_credit')
    assert.equal(classifyUpstreamError(400, '{"code":14018}'), 'hard_credit')
    assert.equal(classifyUpstreamError(401, 'Offline user session not found'), 'session_dead')
    assert.equal(classifyUpstreamError(400, '{"code":11128,"msg":"unapproved channel"}'), 'channel_reject')
    assert.equal(classifyUpstreamError(429, '{"code":14003}'), 'model_busy')
    const queue = parseQueueAnswer('{"code":6020,"data":{"queue_position":12,"queue_size":50}}')
    assert.deepEqual(queue, { code: 6020, position: 12, size: 50 })
  })
})

describe('DSML tool-call recovery', () => {
  it('recovers complete declared DSML tool calls and strips markup from SSE delta', () => {
    const gate = {
      declaredNames: new Set(['read_file']),
      requiredParameters: new Map([['read_file', ['path']]]),
      acceptedParameters: new Map([['read_file', new Set(['path'])]]),
    }
    const text = 'Let me check.\n<｜DSML｜invoke name="read_file"><｜DSML｜parameter name="path">README.md</｜DSML｜parameter></｜DSML｜invoke>'
    const calls = parseToolCalls(text, gate)
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.name, 'read_file')
    assert.deepEqual(JSON.parse(calls[0]!.arguments), { path: 'README.md' })

    const buffer = new DsmlStreamBuffer(gate)
    const frame = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: null }] })}\n\n`
    const rewritten = processFrame(frame, buffer)
    assert.equal(rewritten.length, 1)
    const payload = JSON.parse(rewritten[0]!.slice(5).trim()) as {
      choices: Array<{ delta: { content: string; tool_calls?: Array<{ function: { name: string } }> } }>
    }
    assert.equal(payload.choices[0]?.delta.content, 'Let me check.\n')
    assert.equal(payload.choices[0]?.delta.tool_calls?.[0]?.function.name, 'read_file')
  })
})

describe('catalog and auth parsing', () => {
  it('parses credit multipliers and CLI models', () => {
    assert.equal(parseCreditMultiplier('x0.79 credits'), 0.79)
    assert.equal(parseCreditMultiplier('invalid'), undefined)

    const model = parseUpstreamModel({
      id: 'glm-5.3',
      name: 'GLM-5.3',
      maxInputTokens: 1000000,
      maxOutputTokens: 48000,
      credits: 'x0.79 credits',
    })
    assert.equal(model?.id, 'glm-5.3')
    assert.equal(model?.creditMultiplier, 0.79)

    const selected = selectCliModels(
      [
        { id: 'auto', name: 'Auto', maxInputTokens: 1000, maxOutputTokens: 1000 },
        { id: 'glm-5.3', name: 'GLM-5.3', maxInputTokens: 1000000, maxOutputTokens: 48000 },
      ],
      [{ name: 'cli', models: ['auto', 'glm-5.3'] }],
    )
    assert.deepEqual(selected.map(m => m.id), ['glm-5.3'])
  })

  it('parses nested WorkBuddy desktop auth JSON', () => {
    const parsed = parseWorkBuddyAuth(
      JSON.stringify({
        auth: { accessToken: 'tok_123', refreshToken: 'ref_456', expiresAt: 1800000000, domain: 'workbuddy.ai' },
        account: { uid: 'u1', nickname: 'Alice' },
      }),
      'desktop',
      '/tmp/workbuddy-desktop.info',
    )
    assert.equal(parsed?.accessToken, 'tok_123')
    assert.equal(parsed?.domain, 'workbuddy.ai')
    assert.equal(parsed?.expiresAtMs, 1800000000 * 1000)
    assert.equal(parsed?.nickname, 'Alice')
  })
})
