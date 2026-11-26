/**
 * Minimal ambient type declarations for `openclaw/plugin-sdk/*` so `tsc --noEmit`
 * works standalone without requiring a full `openclaw` monorepo checkout.
 * At runtime, OpenClaw provides the real `openclaw/plugin-sdk/*` modules.
 */

declare module 'openclaw/plugin-sdk/plugin-entry' {
  export interface PluginLogger {
    info?: (message: string) => void
    warn?: (message: string) => void
    error?: (message: string) => void
    debug?: (message: string) => void
  }

  export interface PluginCommandContext {
    senderId?: string
    channel: string
    isAuthorizedSender: boolean
    args?: string
    commandBody: string
    config: Record<string, unknown>
  }

  export interface PluginCommandDefinition {
    name: string
    description: string
    acceptsArgs?: boolean
    requireAuth?: boolean
    handler: (ctx: PluginCommandContext) => Promise<{ text: string }> | { text: string }
  }

  export interface WizardPrompter {
    note: (message: string, title?: string) => Promise<void>
    progress: (message: string) => { update: (msg: string) => void; stop: (msg?: string) => void }
  }

  export interface ProviderAuthContext {
    config: Record<string, unknown>
    env?: NodeJS.ProcessEnv
    prompter: WizardPrompter
    signal?: AbortSignal
    openUrl: (url: string) => Promise<void>
  }

  export interface ProviderAuthResult {
    profiles: Array<{
      profileId: string
      credential: {
        type: 'oauth' | 'token' | 'api_key'
        provider: string
        access?: string
        refresh?: string
        expires?: number
        token?: string
        key?: string
      }
    }>
    defaultModel?: string
    notes?: string[]
  }

  export interface ProviderAuthMethod {
    id: string
    label: string
    hint?: string
    kind: 'oauth' | 'api_key' | 'token' | 'device_code' | 'custom'
    run: (ctx: ProviderAuthContext) => Promise<ProviderAuthResult>
  }

  export interface ProviderCatalogContext {
    config: Record<string, unknown>
    resolveProviderApiKey: (providerId: string) => { apiKey?: string; profileId?: string }
  }

  export interface ProviderWrapStreamFnContext {
    provider: string
    model?: { id?: string; api?: string; baseUrl?: string; provider?: string }
    thinkingLevel?: string
    sourceApi?: string
    streamFn?: (...args: any[]) => any
  }

  export interface ProviderPlugin {
    id: string
    label: string
    docsPath?: string
    aliases?: string[]
    envVars?: string[]
    auth: ProviderAuthMethod[]
    catalog?: {
      order?: 'simple' | 'late' | 'early'
      run: (ctx: ProviderCatalogContext) => Promise<{ provider: Record<string, unknown> } | null>
    }
    staticCatalog?: {
      order?: 'simple' | 'late' | 'early'
      run: () => Promise<{ provider: Record<string, unknown> }>
    }
    refreshOAuth?: (cred: {
      type: 'oauth'
      provider: string
      access: string
      refresh: string
      expires: number
    }) => Promise<{
      type: 'oauth'
      provider: string
      access: string
      refresh: string
      expires: number
    }>
    prepareRuntimeAuthV2?: (ctx: {
      apiKey: string
      env?: NodeJS.ProcessEnv
      model: { id: string; headers?: Record<string, string> }
    }) => Promise<{ apiKey: string; baseUrl?: string; request?: { headers?: Record<string, string> } }>
    prepareSyntheticAuth?: (ctx: {
      env?: NodeJS.ProcessEnv
      signal?: AbortSignal
    }) => Promise<{ apiKey: string; source?: string } | null | undefined>
    resolveSyntheticAuth?: () => { apiKey: string; source?: string } | null | undefined
    wrapStreamFn?: (ctx: ProviderWrapStreamFnContext) => (...args: any[]) => any
    wrapSimpleCompletionStreamFn?: (ctx: ProviderWrapStreamFnContext) => (...args: any[]) => any
    resolveUsageAuth?: (ctx: { resolveOAuthToken: () => Promise<{ token: string } | null> }) => Promise<{ token: string } | null>
    fetchUsageSnapshot?: (ctx: {
      token: string
      timeoutMs?: number
      fetchFn?: typeof fetch
    }) => Promise<Record<string, unknown>>
  }

  export interface OpenClawPluginApi {
    logger?: PluginLogger
    registerProvider: (provider: ProviderPlugin) => void
    registerCommand: (command: PluginCommandDefinition) => void
  }

  export function definePluginEntry(entry: {
    id: string
    name: string
    description: string
    register: (api: OpenClawPluginApi) => void | Promise<void>
  }): unknown
}

declare module 'openclaw/plugin-sdk/llm' {
  export function streamSimple(model: any, context: any, options?: any): any
}
