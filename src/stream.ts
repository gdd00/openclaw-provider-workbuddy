/**
 * WorkBuddy stream wrapper for OpenClaw.
 *
 * Wraps OpenClaw's built-in `openai-completions` `streamSimple` transport with
 * WorkBuddy's wire protocol:
 *  - `onPayload`: forces `stream: true`, rewrites `developer` -> `system`,
 *    prepends fallback system prompt if missing, neutralizes channel
 *    fingerprints, and flattens `tool_choice`.
 *  - `headers`: injects fresh per-request `X-Conversation-*` UUIDs, Bearer
 *    access token, `X-User-Id` / `X-Enterprise-Id` / `X-Domain`, and CLI UA.
 *  - `fetch`: routes to the WorkBuddy regional gateway (`/v2/chat/completions`),
 *    classifies upstream errors (`model_queue`, `hard_credit`, `session_dead`,
 *    etc.), and passes the SSE stream through `DsmlStreamBuffer` to recover
 *    DSML tool calls into native `delta.tool_calls`.
 */

import { streamSimple } from 'openclaw/plugin-sdk/llm'
import type { ProviderWrapStreamFnContext } from 'openclaw/plugin-sdk/plugin-entry'

import {
  WorkBuddyUpstreamClient,
  prepareChatBody,
  failureMessage,
  KIND_STATUS,
  type UpstreamErrorKind,
} from './client.ts'
import { DsmlStreamBuffer } from './dsml.ts'
import type { WorkBuddyCredential } from './store.ts'
import { chatHeadersFor, upstreamBaseFor } from './wire.ts'
import type { WorkBuddyRegion } from './upstream.ts'

export type CredentialResolver = () => Promise<WorkBuddyCredential>

const ENCODER = new TextEncoder()

interface ToolLike {
  name?: string
  parameters?: {
    required?: unknown
    properties?: Record<string, unknown>
  }
}

function buildDsmlBuffer(tools: unknown): DsmlStreamBuffer | undefined {
  if (!Array.isArray(tools) || tools.length === 0) return undefined
  const gateNames = new Set<string>()
  const requiredParameters = new Map<string, readonly string[]>()
  const acceptedParameters = new Map<string, ReadonlySet<string>>()

  for (const raw of tools) {
    if (typeof raw !== 'object' || raw === null) continue
    const tool = raw as ToolLike
    const name = typeof tool.name === 'string' ? tool.name.trim() : ''
    if (name === '') continue
    gateNames.add(name)
    const params = tool.parameters
    requiredParameters.set(
      name,
      Array.isArray(params?.required)
        ? params.required.filter((entry): entry is string => typeof entry === 'string')
        : [],
    )
    acceptedParameters.set(
      name,
      new Set(Object.keys(params?.properties ?? {})),
    )
  }

  if (gateNames.size === 0) return undefined
  return new DsmlStreamBuffer({
    declaredNames: gateNames,
    requiredParameters,
    acceptedParameters,
  })
}

export function createWorkBuddyStreamWrapper(
  region: WorkBuddyRegion,
  resolveCredential: CredentialResolver,
): (ctx: ProviderWrapStreamFnContext) => (model: any, context: any, options?: any) => Promise<any> {
  return (ctx) => {
    const underlying = ctx.streamFn ?? streamSimple
    return async (model, context, options) => {
      const credential = await resolveCredential()
      const headers = chatHeadersFor(credential)
      const base = `${upstreamBaseFor(credential)}/v2`
      const upstream = new WorkBuddyUpstreamClient()
      const buffer = buildDsmlBuffer((context as { tools?: unknown } | undefined)?.tools)

      const wrappedModel = {
        ...model,
        api: 'openai-completions',
        baseUrl: base,
      }

      const existingOnPayload = options?.onPayload
      const innerOptions = {
        ...options,
        apiKey: 'workbuddy-managed',
        headers,
        onPayload: (payload: unknown) => {
          const transformed = typeof existingOnPayload === 'function'
            ? existingOnPayload(payload)
            : payload
          if (typeof transformed === 'object' && transformed !== null && !Array.isArray(transformed)) {
            ;(transformed as Record<string, unknown>)['stream'] = true
          }
          return transformed
        },
        fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
          const bodyJson = typeof init?.body === 'string' ? init.body : ''
          const prepared = prepareChatBody(bodyJson)
          const signal = init?.signal ?? options?.signal
          const result = await upstream.chatStream(credential, prepared, signal)
          if (!result.ok) {
            const kind: UpstreamErrorKind = result.kind ?? 'server'
            const status = KIND_STATUS[kind]
            const message = failureMessage(kind, result.status, result.message ?? '')
            const error = new Error(message) as Error & { status?: number; headers?: Headers }
            error.status = status
            const responseHeaders = new Headers()
            if (kind === 'model_queue') {
              responseHeaders.set('x-should-retry', 'false')
            }
            error.headers = responseHeaders
            throw error
          }
          if (buffer === undefined || result.response === undefined) {
            return result.response ?? new Response(null, { status: 200 })
          }
          return transformSse(result.response, buffer)
        }) as typeof fetch,
      }

      void region
      return underlying(wrappedModel, context, innerOptions)
    }
  }
}

/**
 * Pass an upstream SSE response through a DSML recovery buffer, rewriting
 * `delta.content` frames: recovered calls leave as real `delta.tool_calls`
 * deltas; markup that failed the gates leaves verbatim.
 */
export function transformSse(response: Response, buffer: DsmlStreamBuffer): Response {
  const decoder = new TextDecoder()
  let carry = ''
  const reader = response.body!.getReader()

  const textStream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          const flushed = buffer.flush()
          if (flushed.text !== '') {
            controller.enqueue(encodeFrame(contentDeltaFrame(flushed.text)))
          }
          controller.enqueue(ENCODER.encode('data: [DONE]\n\n'))
          controller.close()
          return
        }
        carry += decoder.decode(value, { stream: true })
        let newline: number
        while ((newline = carry.indexOf('\n\n')) !== -1) {
          const frame = carry.slice(0, newline + 2)
          carry = carry.slice(newline + 2)
          for (const rewritten of processFrame(frame, buffer)) {
            controller.enqueue(encodeFrame(rewritten))
          }
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel(reason) {
      return reader.cancel(reason)
    },
  })

  return new Response(textStream, {
    status: response.status,
    headers: response.headers,
  })
}

function encodeFrame(frame: string): Uint8Array {
  return ENCODER.encode(
    frame.endsWith('\n\n') ? frame : frame.endsWith('\n') ? `${frame}\n` : `${frame}\n\n`,
  )
}

function contentDeltaFrame(text: string): string {
  const chunk = {
    choices: [{ index: 0, delta: { content: text }, finish_reason: null }],
  }
  return `data: ${JSON.stringify(chunk)}\n\n`
}

export function processFrame(frame: string, buffer: DsmlStreamBuffer): string[] {
  if (!frame.startsWith('data:')) return [frame]
  const payload = frame.slice(5).trim()
  if (payload === '' || payload === '[DONE]') return [frame]
  let parsed: unknown
  try {
    parsed = JSON.parse(payload)
  } catch {
    return [frame]
  }
  if (typeof parsed !== 'object' || parsed === null) return [frame]
  const chunk = parsed as Record<string, unknown>
  const choices = chunk['choices']
  if (!Array.isArray(choices) || choices.length === 0) return [frame]
  const choice = choices[0] as Record<string, unknown>
  const delta = typeof choice['delta'] === 'object' && choice['delta'] !== null
    ? choice['delta'] as Record<string, unknown>
    : undefined
  if (delta === undefined) return [frame]

  const content = delta['content']
  if (typeof content !== 'string' || content === '') {
    return [frame]
  }

  const outcome = buffer.add(content)
  delta['content'] = outcome.text

  if (outcome.calls !== undefined && outcome.calls.length > 0) {
    delta['tool_calls'] = outcome.calls.map((call, index) => ({
      index,
      id: call.id,
      type: 'function',
      function: { name: call.name, arguments: call.arguments },
    }))
  }

  return [`data: ${JSON.stringify(chunk)}\n\n`]
}
