/**
 * openclaw-provider-workbuddy — connect Tencent WorkBuddy (CN + Global)
 * accounts and credits to OpenClaw.
 *
 * Registers two providers, one per region:
 *   - `workbuddy`        → domestic gateway (copilot.tencent.com)
 *   - `workbuddy-global` → international gateway (www.workbuddy.ai / www.codebuddy.ai)
 *
 * Ported from `lorlike/pi-provider-workbuddy` for OpenClaw's Plugin SDK.
 */

import {
  definePluginEntry,
  type OpenClawPluginApi,
  type ProviderAuthContext,
  type ProviderAuthResult,
  type ProviderPlugin,
} from 'openclaw/plugin-sdk/plugin-entry'

import { clearStoredCredentials } from './auth-io.ts'
import { workbuddyAccountId } from './auth.ts'
import { fallbackModelsFor, nativeImageInput, REFUSES_OFF_MODEL_IDS } from './catalog.ts'
import {
  beijingDay,
  describeCheckinToday,
  runDailyCheckin,
  saveCheckinRecord,
} from './checkin.ts'
import { WorkBuddyUpstreamClient } from './client.ts'
import { oauthPoll, oauthStart, regionOfOAuthAccount } from './oauth.ts'
import { WorkBuddyCredentialStore, type WorkBuddyUpstreamModel } from './store.ts'
import { createWorkBuddyStreamWrapper } from './stream.ts'
import { CN_CHAT_BASE, GLOBAL_BASE, type WorkBuddyRegion } from './upstream.ts'

const PROVIDER_IDS: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'workbuddy',
  global: 'workbuddy-global',
}

const PROVIDER_NAMES: Readonly<Record<WorkBuddyRegion, string>> = {
  cn: 'WorkBuddy (CN)',
  global: 'WorkBuddy AI (Global)',
}

const REGIONS: readonly WorkBuddyRegion[] = ['cn', 'global']
const CATALOG_REFRESH_MS = 10 * 60 * 1000

const stores = new Map<WorkBuddyRegion, WorkBuddyCredentialStore>()
const catalogs = new Map<WorkBuddyRegion, readonly WorkBuddyUpstreamModel[]>()
const catalogFetchedAt = new Map<WorkBuddyRegion, number>()
const syntheticAuthCache = new Map<WorkBuddyRegion, { apiKey: string; source: string } | null>()

function storeFor(region: WorkBuddyRegion): WorkBuddyCredentialStore {
  let store = stores.get(region)
  if (store === undefined) {
    store = new WorkBuddyCredentialStore(
      region,
      message => console.warn(`[openclaw-provider-workbuddy] ${message}`),
    )
    stores.set(region, store)
  }
  return store
}

function workBuddyDisplayName(info: WorkBuddyUpstreamModel): string {
  return info.creditMultiplier === undefined
    ? info.name
    : `${info.name} · x${info.creditMultiplier.toFixed(2)}`
}

function thinkingLevelMapFor(info: WorkBuddyUpstreamModel): Record<string, string | null> | undefined {
  const supported = info.reasoning?.supportedEfforts?.filter(effort =>
    ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(effort))
  if (supported === undefined || supported.length === 0) return undefined
  const map: Record<string, string | null> = {}
  for (const level of ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const) {
    map[level] = supported.includes(level) ? level : null
  }
  map['off'] = info.reasoning?.canDisableThinking === true && !REFUSES_OFF_MODEL_IDS.has(info.id)
    ? 'off'
    : null
  return map
}

function toModelConfigs(models: readonly WorkBuddyUpstreamModel[]): Array<Record<string, unknown>> {
  return models.map((info) => {
    const image = nativeImageInput(info.id)
    const thinkingLevelMap = thinkingLevelMapFor(info)
    return {
      id: info.id,
      name: workBuddyDisplayName(info),
      reasoning: thinkingLevelMap !== undefined,
      ...(thinkingLevelMap === undefined ? {} : { thinkingLevelMap }),
      input: image === true ? ['text', 'image'] : ['text'],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: info.contextWindow,
      maxTokens: info.maxTokens,
      compat: {
        supportsDeveloperRole: false,
        supportsReasoningEffort: thinkingLevelMap !== undefined,
        maxTokensField: 'max_tokens',
        supportsStore: false,
      },
    }
  })
}

async function fetchCatalog(
  region: WorkBuddyRegion,
  force = false,
): Promise<readonly WorkBuddyUpstreamModel[]> {
  const fetchedAt = catalogFetchedAt.get(region) ?? 0
  const cached = catalogs.get(region)
  if (!force && cached !== undefined && Date.now() - fetchedAt < CATALOG_REFRESH_MS) {
    return cached
  }

  const store = storeFor(region)
  try {
    const credential = await store.resolve()
    const client = new WorkBuddyUpstreamClient()
    const models = await client.fetchModels(credential)
    if (models.length > 0) {
      catalogs.set(region, models)
      catalogFetchedAt.set(region, Date.now())
      return models
    }
  } catch (error) {
    console.warn(
      `[openclaw-provider-workbuddy] ${region} catalog refresh failed:`,
      error instanceof Error ? error.message : error,
    )
  }

  if (cached !== undefined) return cached
  const fallback = fallbackModelsFor(region)
  catalogs.set(region, fallback)
  catalogFetchedAt.set(region, Date.now())
  return fallback
}

async function runOAuthLogin(
  region: WorkBuddyRegion,
  ctx: ProviderAuthContext,
): Promise<ProviderAuthResult> {
  const started = await oauthStart(region)
  if ('error' in started) {
    throw new Error(started.error)
  }

  await ctx.prompter.note(
    `请在浏览器中打开以下链接并登录 ${PROVIDER_NAMES[region]}（国内版扫码，国际版网页登录）：\n${started.verificationUri}`,
    PROVIDER_NAMES[region],
  )
  try {
    await ctx.openUrl(started.verificationUri)
  } catch {
    // Non-fatal in headless / remote environments; URL was already shown in note.
  }

  const progress = ctx.prompter.progress('等待在浏览器中完成 WorkBuddy 登录…')
  try {
    const deadline = Date.now() + started.expiresIn * 1000
    while (Date.now() < deadline) {
      if (ctx.signal?.aborted) {
        throw new Error('登录已取消')
      }
      await new Promise(resolve => setTimeout(resolve, 2000))
      const polled = await oauthPoll(started.loginId, region)
      if (!polled.done) continue
      if ('error' in polled) throw new Error(polled.error)

      const account = polled.account
      const credentialRegion = regionOfOAuthAccount(account)
      if (credentialRegion !== region) {
        throw new Error(
          `该账号属于${credentialRegion === 'global' ? '国际版' : '国内版'}，请使用对应的 ${PROVIDER_IDS[credentialRegion]} 登录入口`,
        )
      }

      const store = storeFor(region)
      const savedCredential = {
        accessToken: account.accessToken,
        refreshToken: account.refreshToken,
        expiresAtMs: account.expiresAtMs,
        domain: account.domain,
        uid: account.uid,
        ...(account.nickname === undefined ? {} : { nickname: account.nickname }),
        ...(account.uin === undefined ? {} : { uin: account.uin }),
        ...(account.enterpriseId === undefined ? {} : { enterpriseId: account.enterpriseId }),
        source: 'oauth' as const,
        filePath: '(oauth)',
      }
      store.acceptOAuthCredential(savedCredential)
      syntheticAuthCache.set(region, { apiKey: account.accessToken, source: 'oauth' })

      const models = await fetchCatalog(region, true)
      const providerId = PROVIDER_IDS[region]
      const accountKey = workbuddyAccountId(savedCredential)
      const defaultModelId = models[0]?.id

      progress.stop('WorkBuddy 登录成功')
      return {
        profiles: [
          {
            profileId: `${providerId}:${accountKey}`,
            credential: {
              type: 'oauth',
              provider: providerId,
              access: account.accessToken,
              refresh: account.refreshToken,
              expires: account.expiresAtMs,
            },
          },
        ],
        ...(defaultModelId === undefined ? {} : { defaultModel: `${providerId}/${defaultModelId}` }),
        notes: [
          `已登录 ${PROVIDER_NAMES[region]}${account.nickname ? `（${account.nickname}）` : ''}，已加载 ${models.length} 个模型。`,
        ],
      }
    }
    throw new Error('登录超时，请重试')
  } catch (error) {
    progress.stop('登录未完成')
    throw error
  }
}

function buildRegionProvider(region: WorkBuddyRegion): ProviderPlugin {
  const providerId = PROVIDER_IDS[region]
  const label = PROVIDER_NAMES[region]
  const baseUrl = `${region === 'cn' ? CN_CHAT_BASE : GLOBAL_BASE}/v2`
  const streamWrapper = createWorkBuddyStreamWrapper(region, async () => storeFor(region).resolve())

  return {
    id: providerId,
    label,
    envVars: ['WORKBUDDY_AUTH_FILE', 'WORKBUDDY_PLUGIN_AUTH_FILE'],
    auth: [
      {
        id: 'oauth',
        label: `${label} 浏览器 / 扫码登录`,
        hint: region === 'cn' ? '微信扫码登录国内版 WorkBuddy' : '浏览器登录国际版 WorkBuddy AI',
        kind: 'oauth',
        run: ctx => runOAuthLogin(region, ctx),
      },
    ],
    catalog: {
      order: 'simple',
      run: async () => {
        const store = storeFor(region)
        const status = await store.status()
        if (!status.signedIn) return null
        const models = await fetchCatalog(region, false)
        return {
          provider: {
            baseUrl,
            api: 'openai-completions',
            models: toModelConfigs(models),
          },
        }
      },
    },
    staticCatalog: {
      order: 'simple',
      run: async () => ({
        provider: {
          baseUrl,
          api: 'openai-completions',
          models: toModelConfigs(fallbackModelsFor(region).slice(0, 3)),
        },
      }),
    },
    prepareSyntheticAuth: async () => {
      const store = storeFor(region)
      const status = await store.status()
      if (!status.signedIn) {
        syntheticAuthCache.set(region, null)
        return null
      }
      try {
        const credential = await store.resolve()
        const result = { apiKey: credential.accessToken, source: status.source ?? 'desktop' }
        syntheticAuthCache.set(region, result)
        return result
      } catch {
        syntheticAuthCache.set(region, null)
        return null
      }
    },
    resolveSyntheticAuth: () => syntheticAuthCache.get(region) ?? null,
    refreshOAuth: async (cred) => {
      const store = storeFor(region)
      store.invalidate()
      const credential = await store.resolve()
      return {
        type: 'oauth',
        provider: providerId,
        access: credential.accessToken,
        refresh: credential.refreshToken || cred.refresh,
        expires: credential.expiresAtMs || (Date.now() + 3600 * 1000),
      }
    },
    prepareRuntimeAuthV2: async (ctx) => {
      const store = storeFor(region)
      try {
        const credential = await store.resolve()
        return {
          apiKey: credential.accessToken,
          baseUrl: `${region === 'cn' ? CN_CHAT_BASE : GLOBAL_BASE}/v2`,
          ...(ctx.model.headers ? { request: { headers: ctx.model.headers } } : {}),
        }
      } catch {
        return {
          apiKey: ctx.apiKey,
          baseUrl,
          ...(ctx.model.headers ? { request: { headers: ctx.model.headers } } : {}),
        }
      }
    },
    wrapStreamFn: streamWrapper,
    wrapSimpleCompletionStreamFn: streamWrapper,
    resolveUsageAuth: async (ctx) => {
      try {
        const credential = await storeFor(region).resolve()
        return { token: credential.accessToken }
      } catch {
        return await ctx.resolveOAuthToken()
      }
    },
    fetchUsageSnapshot: async () => {
      const credential = await storeFor(region).resolve()
      const client = new WorkBuddyUpstreamClient()
      const credits = await client.fetchCredits(credential)
      return {
        provider: providerId,
        displayName: label,
        windows: [
          {
            label: credits.total !== undefined ? `剩余积分: ${credits.total}` : '积分未知',
            usedPercent: 0,
          },
        ],
      }
    },
  }
}

function registerCommands(api: OpenClawPluginApi): void {
  api.registerCommand({
    name: 'workbuddy-status',
    description: '查看 WorkBuddy 国内版/国际版登录状态、积分余额与今日签到状态',
    handler: async () => {
      const lines: string[] = []
      for (const region of REGIONS) {
        const store = storeFor(region)
        const status = await store.status()
        const label = PROVIDER_NAMES[region]
        if (!status.signedIn) {
          lines.push(`${label}: 未登录（可运行 openclaw models auth login --provider ${PROVIDER_IDS[region]}，或先登录 WorkBuddy 桌面端）`)
          for (const candidate of status.candidates) {
            lines.push(`  · ${candidate.path}: ${candidate.reason}`)
          }
          continue
        }
        lines.push(`${label}: ${status.label ?? '已登录'}（来源 ${status.source}）`)
        if (status.expiresAtMs !== undefined && status.expiresAtMs > 0) {
          const minutes = Math.round((status.expiresAtMs - Date.now()) / 60000)
          lines.push(`  token ${minutes >= 0 ? `${minutes} 分钟后过期` : '已过期，将在下次请求时刷新'}`)
        }
        let credential: Awaited<ReturnType<typeof store.resolve>> | undefined
        try {
          credential = await store.resolve()
          const client = new WorkBuddyUpstreamClient()
          const credits = await client.fetchCredits(credential)
          if (credits.total !== undefined) {
            lines.push(`  积分余额: ${credits.total}`)
          }
        } catch (error) {
          lines.push(`  积分查询失败: ${error instanceof Error ? error.message : String(error)}`)
        }
        if (region === 'cn' && credential !== undefined) {
          lines.push(`  ${await describeCheckinToday(region, credential)}`)
        }
      }
      return { text: lines.join('\n') }
    },
  })

  api.registerCommand({
    name: 'workbuddy-sign',
    description: 'WorkBuddy（国内版）每日签到，领取今日积分',
    acceptsArgs: true,
    handler: async (ctx) => {
      const target = (ctx.args ?? '').trim().toLowerCase()
      if (target === 'global') {
        return { text: '国际版没有每日签到活动，无需签到（积分来自套餐与一次性 trial）。' }
      }
      if (target !== '' && target !== 'cn') {
        return { text: '用法：/workbuddy-sign [cn]（目前只有国内版有签到活动）' }
      }
      const store = storeFor('cn')
      const status = await store.status()
      if (!status.signedIn) {
        return { text: `${PROVIDER_NAMES['cn']}: 未登录，请先运行 openclaw models auth login --provider ${PROVIDER_IDS['cn']}` }
      }
      try {
        const credential = await store.resolve()
        const day = beijingDay()
        const result = await runDailyCheckin(credential)
        if (result.outcome !== 'failed') {
          saveCheckinRecord('cn', credential, {
            day,
            at: Date.now(),
            outcome: result.outcome,
            ...(result.credit === undefined ? {} : { credit: result.credit }),
            ...(result.streakDays === undefined ? {} : { streakDays: result.streakDays }),
            ...(result.message === '' ? {} : { message: result.message }),
          })
        }
        return { text: `WorkBuddy (CN) 签到（北京时间 ${day}）：${result.message}` }
      } catch (error) {
        return {
          text: `WorkBuddy (CN) 签到失败：${error instanceof Error ? error.message : String(error)}`,
        }
      }
    },
  })

  api.registerCommand({
    name: 'workbuddy-refresh',
    description: '从上游刷新 WorkBuddy 模型目录',
    handler: async () => {
      const parts: string[] = []
      for (const region of REGIONS) {
        const models = await fetchCatalog(region, true)
        parts.push(`${PROVIDER_NAMES[region]}: ${models.length} 个模型`)
      }
      return { text: parts.join('\n') }
    },
  })

  api.registerCommand({
    name: 'workbuddy-logout',
    description: '清除插件本地保存的 WorkBuddy 凭据（cn | global，默认全部）',
    acceptsArgs: true,
    handler: async (ctx) => {
      const target = (ctx.args ?? '').trim().toLowerCase()
      const regions = target === 'cn' ? (['cn'] as const)
        : target === 'global' ? (['global'] as const)
        : REGIONS
      for (const region of regions) {
        clearStoredCredentials(region)
        stores.get(region)?.invalidate()
        catalogs.delete(region)
        syntheticAuthCache.delete(region)
      }
      return {
        text: `已清除 ${regions.map(region => PROVIDER_IDS[region]).join(', ')} 的本地凭据（不影响桌面端登录）。`,
      }
    },
  })
}

export default definePluginEntry({
  id: 'openclaw-provider-workbuddy',
  name: 'WorkBuddy Provider',
  description: 'Connect Tencent WorkBuddy (CN + Global) accounts and credits to OpenClaw',
  register(api) {
    for (const region of REGIONS) {
      api.registerProvider(buildRegionProvider(region))
    }
    registerCommands(api)
  },
})
