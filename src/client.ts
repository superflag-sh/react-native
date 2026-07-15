/**
 * React Native transport/cache/lifecycle adapter.
 * Native modules are lazy and every asynchronous boundary is contained for Expo/Hermes safety.
 */
import type {
  AppStateAdapter,
  AppStateSubscription,
  CachedConfig,
  ClientConfig,
  ConfigResponse,
  DiagnosticEvent,
  EvaluationContext,
  FlagConfig,
  NetworkAdapter,
  RefreshReason,
  RetryOptions,
  StorageAdapter,
  SuperflagClient,
  SuperflagState,
} from "./types.js"
import {
  CACHE_SCHEMA_VERSION,
  LEGACY_CACHE_KEYS,
  createCacheKey,
  createCacheScope,
  createPersistedCacheBinding,
  isCachedConfig,
  isPersistedCacheBinding,
  type PersistedCacheBinding,
} from "./cache.js"
import { isConfigResponse, normalizeConfigResponse } from "./config.js"
import { validateCachedConfig } from "./config.js"
import { initialState } from "./context.js"
import { storage as defaultStorage } from "./storage.js"
import { createReactNativeTelemetry } from "./telemetry.js"

const DEFAULT_CONFIG_URL = "https://superflag.sh/api/v1/public-config"
const DEFAULT_MAX_STALE_AGE_SECONDS = 24 * 60 * 60
const DEFAULT_RETRY: RetryOptions = {
  maxRetries: 2,
  baseDelayMs: 250,
  maxDelayMs: 2_000,
}
const MAX_TIMEOUT_MS = 2_147_483_647

interface ReactNativeModule {
  AppState?: AppStateAdapter
}

function guardedAppState(): AppStateAdapter | null {
  try {
    // Intentionally lazy: static React Native imports can crash before the bridge is ready.
    const native = require("react-native") as ReactNativeModule
    return native.AppState ?? null
  } catch {
    return null
  }
}

function removeSubscription(subscription: AppStateSubscription | (() => void) | null): void {
  try {
    if (typeof subscription === "function") subscription()
    else subscription?.remove()
  } catch {
    // Cleanup must remain idempotent and non-throwing.
  }
}

function errorMessage(error: unknown, fallback = "Network error"): string {
  return error instanceof Error ? error.message : fallback
}

class RetryableResponseError extends Error {
  constructor(readonly status: number) {
    super(`Server error: ${status}`)
    this.name = "RetryableResponseError"
  }
}

export function createClient(config: ClientConfig): SuperflagClient {
  const { clientKey } = config
  const cacheStorage: StorageAdapter = config.storage ?? defaultStorage
  const scope = createCacheScope(config.configUrl ?? DEFAULT_CONFIG_URL, clientKey)
  const now = config.now ?? Date.now
  const ttlMs = Math.max(1_000, config.ttlSeconds * 1_000)
  const maxStaleMs = Math.max(
    0,
    (config.maxStaleAgeSeconds ?? DEFAULT_MAX_STALE_AGE_SECONDS) * 1_000,
  )
  const retry: RetryOptions = {
    maxRetries: Math.max(0, Math.min(10, Math.floor(config.retry?.maxRetries ?? DEFAULT_RETRY.maxRetries))),
    baseDelayMs: Math.max(0, config.retry?.baseDelayMs ?? DEFAULT_RETRY.baseDelayMs),
    maxDelayMs: Math.max(0, config.retry?.maxDelayMs ?? DEFAULT_RETRY.maxDelayMs),
  }

  let state: SuperflagState = {
    ...initialState,
    evaluationContext: config.evaluationContext,
    ...(config.userId ? { userId: config.userId } : {}),
    refresh: () => refresh("manual"),
  }
  let destroyed = false
  let initialized = false
  let readyEmitted = false
  let inFlight: Promise<void> | null = null
  let fetchController: AbortController | null = null
  let activeBinding: PersistedCacheBinding | null = null
  let activeCache: CachedConfig | null = null
  let ttlTimer: ReturnType<typeof setTimeout> | null = null
  let maxStaleTimer: ReturnType<typeof setTimeout> | null = null
  let appStateSubscription: AppStateSubscription | (() => void) | null = null
  let networkSubscription: AppStateSubscription | (() => void) | null = null
  let currentAppState: string | null | undefined
  let connected: boolean | undefined
  const delayTimers = new Map<ReturnType<typeof setTimeout>, () => void>()
  const hasAbortController = typeof AbortController !== "undefined"

  function emitDiagnostic(event: Omit<DiagnosticEvent, "timestamp">): void {
    if (!config.onDiagnostic) return
    try {
      Promise.resolve(config.onDiagnostic({ ...event, timestamp: now() })).catch(() => {})
    } catch {
      // Diagnostic handlers are the last error boundary.
    }
  }

  const telemetry = createReactNativeTelemetry({
    clientKey,
    configUrl: scope.configUrl,
    storage: cacheStorage,
    options: config.telemetry,
    now,
    getContext: () => state.evaluationContext,
    getConfig: () => state.config,
    emitDiagnostic,
  })

  function invokeCallback(
    name: "onReady",
    callback: ClientConfig["onReady"],
    value: SuperflagState,
  ): void {
    if (!callback) return
    try {
      Promise.resolve(callback(value)).catch((error: unknown) => {
        emitDiagnostic({
          code: "callback_failed",
          message: `${name} callback failed`,
          error,
        })
      })
    } catch (error) {
      emitDiagnostic({ code: "callback_failed", message: `${name} callback failed`, error })
    }
  }

  function withDerivedState(next: SuperflagState): SuperflagState {
    const age = next.fetchedAt === null ? null : Math.max(0, now() - next.fetchedAt) / 1_000
    return { ...next, age, stale: age !== null && age >= ttlMs / 1_000 }
  }

  function setState(updates: Partial<SuperflagState>): void {
    if (destroyed) return
    state = withDerivedState({ ...state, ...updates })
    try {
      config.onStateChange(state)
    } catch (error) {
      emitDiagnostic({ code: "callback_failed", message: "onStateChange callback failed", error })
    }

    if (!readyEmitted && state.config && (state.status === "ready" || state.status === "refreshing")) {
      readyEmitted = true
      invokeCallback("onReady", config.onReady, state)
    }
  }

  function clearRefreshTimers(): void {
    if (ttlTimer !== null) clearTimeout(ttlTimer)
    if (maxStaleTimer !== null) clearTimeout(maxStaleTimer)
    ttlTimer = null
    maxStaleTimer = null
  }

  function scheduleConfigTimers(fetchedAt: number, deferRefresh = false): void {
    clearRefreshTimers()
    if (destroyed) return

    const age = Math.max(0, now() - fetchedAt)
    const refreshDelay = Math.min(
      MAX_TIMEOUT_MS,
      deferRefresh ? ttlMs : Math.max(0, ttlMs - age),
    )
    ttlTimer = setTimeout(() => {
      ttlTimer = null
      void refresh("ttl")
    }, refreshDelay)

    const staleDelay = Math.min(MAX_TIMEOUT_MS, Math.max(0, maxStaleMs - age))
    maxStaleTimer = setTimeout(() => {
      maxStaleTimer = null
      if (destroyed || state.fetchedAt !== fetchedAt) return
      void clearActiveCache()
      setState({
        config: null,
        flags: {},
        status: "error",
        source: "none",
        error: "Cached config exceeded maxStaleAgeSeconds",
        fetchedAt: null,
        configVersion: null,
        appId: null,
        environment: null,
        version: null,
        etag: null,
      })
    }, staleDelay)
  }

  async function removeCacheKeys(keys: readonly string[]): Promise<void> {
    for (const key of keys) {
      try {
        await cacheStorage.removeItem(key)
      } catch (error) {
        emitDiagnostic({ code: "cache_write_failed", message: `Could not remove cache key ${key}`, error })
      }
    }
  }

  async function clearActiveCache(binding = activeBinding): Promise<void> {
    activeCache = null
    if (binding) await removeCacheKeys([createCacheKey(scope, binding)])
  }

  async function clearBindingAndCache(): Promise<void> {
    const binding = activeBinding
    activeBinding = null
    await clearActiveCache(binding)
    await removeCacheKeys([scope.bindingKey])
  }

  async function loadFromCache(): Promise<CachedConfig | null> {
    await removeCacheKeys([...LEGACY_CACHE_KEYS, scope.legacyCacheKey])

    let storedBinding: string | null
    try {
      storedBinding = await cacheStorage.getItem(scope.bindingKey)
    } catch (error) {
      emitDiagnostic({ code: "cache_read_failed", message: "Could not read cache binding", error })
      return null
    }
    if (!storedBinding) return null

    let parsedBinding: unknown
    try {
      parsedBinding = JSON.parse(storedBinding)
    } catch (error) {
      emitDiagnostic({ code: "cache_invalid", message: "Cache binding was malformed", error })
      await clearBindingAndCache()
      return null
    }
    if (!isPersistedCacheBinding(parsedBinding, scope)) {
      emitDiagnostic({ code: "cache_invalid", message: "Cache binding failed validation" })
      await clearBindingAndCache()
      return null
    }
    activeBinding = parsedBinding

    const cacheKey = createCacheKey(scope, parsedBinding)
    let cached: string | null
    try {
      cached = await cacheStorage.getItem(cacheKey)
    } catch (error) {
      emitDiagnostic({ code: "cache_read_failed", message: "Could not read cached config", error })
      await clearActiveCache()
      return null
    }
    if (!cached) return null

    let parsedCache: unknown
    try {
      parsedCache = JSON.parse(cached)
    } catch (error) {
      emitDiagnostic({ code: "cache_invalid", message: "Cached config was malformed", error })
      await clearActiveCache()
      return null
    }
    if (!isCachedConfig(parsedCache, scope, parsedBinding)) {
      emitDiagnostic({ code: "cache_invalid", message: "Cached config failed core validation" })
      await clearActiveCache()
      return null
    }

    if (
      !("config" in parsedCache) ||
      !validateCachedConfig(parsedCache.config) ||
      parsedCache.config.source.app !== parsedBinding.appId ||
      parsedCache.config.source.environment !== parsedBinding.environment ||
      parsedCache.config.configVersion !== parsedCache.version
    ) {
      emitDiagnostic({ code: "cache_invalid", message: "Cached config failed core validation" })
      await clearActiveCache()
      return null
    }

    if (Math.max(0, now() - parsedCache.fetchedAt) > maxStaleMs) {
      emitDiagnostic({ code: "cache_invalid", message: "Cached config exceeded max stale age" })
      await clearActiveCache()
      return null
    }

    activeCache = parsedCache
    return parsedCache
  }

  async function establishBinding(appId: string, environment: string): Promise<PersistedCacheBinding> {
    const binding = createPersistedCacheBinding(scope, { appId, environment })
    activeBinding = binding
    try {
      await cacheStorage.setItem(scope.bindingKey, JSON.stringify(binding))
    } catch (error) {
      emitDiagnostic({ code: "cache_write_failed", message: "Could not persist cache binding", error })
    }
    return binding
  }

  async function saveToCache(
    binding: PersistedCacheBinding,
    flagConfig: FlagConfig,
    etag: string,
    fetchedAt: number,
  ): Promise<void> {
    const cache: CachedConfig = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      endpointFingerprint: scope.endpointFingerprint,
      clientKeyFingerprint: scope.clientKeyFingerprint,
      appId: binding.appId,
      environment: binding.environment,
      flags: flagConfig.flags,
      version: flagConfig.configVersion,
      config: flagConfig,
      etag,
      fetchedAt,
    }

    activeCache = cache
    try {
      await cacheStorage.setItem(createCacheKey(scope, binding), JSON.stringify(cache))
    } catch (error) {
      emitDiagnostic({ code: "cache_write_failed", message: "Could not persist config cache", error })
    }
  }

  function getActiveCache(): CachedConfig | null {
    const cache = activeCache
    if (
      activeBinding &&
      cache &&
      cache.appId === activeBinding.appId &&
      cache.environment === activeBinding.environment &&
      state.appId === cache.appId &&
      state.environment === cache.environment &&
      state.configVersion === cache.config.configVersion &&
      state.etag === cache.etag
    ) {
      return cache
    }
    return null
  }

  function applyConfig(
    flagConfig: FlagConfig,
    source: "cache" | "network",
    etag: string,
    fetchedAt: number,
  ): void {
    setState({
      config: flagConfig,
      flags: flagConfig.flags,
      status: "ready",
      source,
      error: null,
      fetchedAt,
      configVersion: flagConfig.configVersion,
      appId: flagConfig.source.app,
      environment: flagConfig.source.environment,
      version: flagConfig.configVersion,
      etag,
    })
    scheduleConfigTimers(fetchedAt)
  }

  function wait(delayMs: number): Promise<void> {
    if (destroyed || delayMs <= 0) return Promise.resolve()
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        delayTimers.delete(timer)
        resolve()
      }, Math.min(MAX_TIMEOUT_MS, delayMs))
      delayTimers.set(timer, resolve)
    })
  }

  function retryDelay(attempt: number): number {
    return Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** attempt)
  }

  async function requestConfig(reason: RefreshReason): Promise<void> {
    if (destroyed) return
    if (typeof fetch !== "function") {
      setState({ status: state.config ? "ready" : "error", error: "fetch is unavailable" })
      emitDiagnostic({ code: "fetch_failed", message: "Global fetch is unavailable", reason })
      return
    }

    if (state.config) setState({ status: "refreshing" })
    else setState({ status: "loading", source: "none" })

    fetchController = hasAbortController ? new AbortController() : null
    let lastError: unknown = null

    try {
      for (let attempt = 0; attempt <= retry.maxRetries; attempt += 1) {
        if (destroyed) return
        try {
          const headers: Record<string, string> = { Authorization: `Bearer ${clientKey}` }
          const requestCache = getActiveCache()
          if (requestCache) headers["If-None-Match"] = requestCache.etag

          const response = await fetch(scope.configUrl, {
            headers,
            ...(fetchController ? { signal: fetchController.signal } : {}),
          })
          if (destroyed) return

          if (response.status === 304) {
            const responseCache = getActiveCache()
            if (!responseCache || !activeBinding) {
              await clearActiveCache()
              if (attempt < retry.maxRetries) continue
              throw new Error("Received 304 without an identity-bound cache entry")
            }
            const fetchedAt = now()
            applyConfig(responseCache.config, "network", responseCache.etag, fetchedAt)
            await saveToCache(activeBinding, responseCache.config, responseCache.etag, fetchedAt)
            return
          }

          if (response.status === 401) {
            let body: { error?: string } = {}
            try {
              body = (await response.json()) as { error?: string }
            } catch {
              // A malformed error body must not escape.
            }
            await clearBindingAndCache()
            clearRefreshTimers()
            setState({
              ...initialState,
              refresh: state.refresh,
              evaluationContext: state.evaluationContext,
              ...(state.userId ? { userId: state.userId } : {}),
              status: "error",
              error: body.error || "Invalid or unauthorized client key",
            })
            return
          }

          if (response.status === 429) {
            setState({ status: "rate-limited", error: "Monthly quota exceeded" })
            if (state.fetchedAt !== null) scheduleConfigTimers(state.fetchedAt, true)
            return
          }

          if (!response.ok) {
            if (response.status >= 500) throw new RetryableResponseError(response.status)
            setState({ status: state.config ? "ready" : "error", error: `Server error: ${response.status}` })
            if (state.fetchedAt !== null) scheduleConfigTimers(state.fetchedAt, true)
            return
          }

          const data: unknown = await response.json()
          if (!isConfigResponse(data)) {
            emitDiagnostic({ code: "config_invalid", message: "Public config response was malformed" })
            throw new Error("Invalid config response")
          }

          let flagConfig: FlagConfig
          try {
            flagConfig = normalizeConfigResponse(data as ConfigResponse)
          } catch (error) {
            emitDiagnostic({ code: "config_invalid", message: "Core rejected the config response", error })
            throw error
          }

          if (
            activeBinding &&
            (activeBinding.appId !== flagConfig.source.app ||
              activeBinding.environment !== flagConfig.source.environment)
          ) {
            await clearBindingAndCache()
            clearRefreshTimers()
            setState({
              ...initialState,
              refresh: state.refresh,
              evaluationContext: state.evaluationContext,
              ...(state.userId ? { userId: state.userId } : {}),
              status: "error",
              error: "Authenticated config identity changed for bound client key",
            })
            return
          }

          const binding =
            activeBinding ??
            (await establishBinding(flagConfig.source.app, flagConfig.source.environment))
          const etag = response.headers.get("ETag") || `"${flagConfig.configVersion}"`
          const fetchedAt = now()
          applyConfig(flagConfig, "network", etag, fetchedAt)
          await saveToCache(binding, flagConfig, etag, fetchedAt)
          return
        } catch (error) {
          if (destroyed) return
          if (error instanceof Error && error.name === "AbortError") return
          lastError = error
          if (attempt >= retry.maxRetries) break
          const delayMs = retryDelay(attempt)
          emitDiagnostic({
            code: "retry_scheduled",
            message: `Refresh retry scheduled in ${delayMs}ms`,
            error,
            reason,
            attempt: attempt + 1,
          })
          await wait(delayMs)
        }
      }

      const message = errorMessage(lastError)
      setState({ status: state.config ? "ready" : "error", error: message })
      emitDiagnostic({ code: "fetch_failed", message, error: lastError, reason })
      if (state.fetchedAt !== null) scheduleConfigTimers(state.fetchedAt, true)
    } finally {
      fetchController = null
    }
  }

  function refresh(reason: RefreshReason = "manual"): Promise<void> {
    if (destroyed) return Promise.resolve()
    if (inFlight) return inFlight
    emitDiagnostic({ code: "refresh_triggered", message: `Refresh triggered by ${reason}`, reason })
    inFlight = requestConfig(reason)
      .catch((error: unknown) => {
        if (!destroyed) {
          const message = errorMessage(error)
          setState({ status: state.config ? "ready" : "error", error: message })
          emitDiagnostic({ code: "fetch_failed", message, error, reason })
        }
      })
      .finally(() => {
        inFlight = null
      })
    return inFlight
  }

  function setupLifecycle(): void {
    const appState: AppStateAdapter | null =
      config.appState === undefined ? guardedAppState() : config.appState
    if (config.appState === undefined && !appState) {
      emitDiagnostic({
        code: "native_integration_unavailable",
        message: "React Native AppState is unavailable; foreground refresh is disabled",
      })
    }
    if (appState) {
      currentAppState = appState.currentState
      try {
        appStateSubscription = appState.addEventListener("change", (nextState) => {
          const wasBackground = currentAppState === "background" || currentAppState === "inactive"
          currentAppState = nextState
          if (nextState === "background" || nextState === "inactive") void telemetry.flush()
          if (wasBackground && nextState === "active") {
            void telemetry.flush()
            void refresh("foreground")
          }
        })
      } catch (error) {
        emitDiagnostic({
          code: "native_integration_unavailable",
          message: "Could not subscribe to React Native AppState",
          error,
        })
      }
    }

    const network: NetworkAdapter | null | undefined = config.network
    if (network) {
      try {
        networkSubscription = network.subscribe((nextConnected) => {
          const reconnected = connected === false && nextConnected
          connected = nextConnected
          if (reconnected) {
            void telemetry.flush()
            void refresh("reconnect")
          }
        })
      } catch (error) {
        emitDiagnostic({
          code: "native_integration_unavailable",
          message: "Could not subscribe to the network adapter",
          error,
        })
      }
    }
  }

  async function initialize(): Promise<void> {
    if (destroyed || initialized) return
    initialized = true
    setupLifecycle()
    try {
      await telemetry.initialize()
      const cached = await loadFromCache()
      if (destroyed) return
      if (cached) {
        applyConfig(cached.config, "cache", cached.etag, cached.fetchedAt)
        if (Math.max(0, now() - cached.fetchedAt) >= ttlMs) await refresh("initialize")
        return
      }
      await refresh("initialize")
    } catch (error) {
      if (!destroyed) {
        const message = errorMessage(error, "Failed to initialize")
        setState({ status: state.config ? "ready" : "error", error: message })
        emitDiagnostic({ code: "fetch_failed", message, error, reason: "initialize" })
      }
    }
  }

  function setContext(evaluationContext: EvaluationContext, userId?: string): void {
    setState({
      evaluationContext,
      userId,
    })
  }

  function destroy(): void {
    if (destroyed) return
    destroyed = true
    clearRefreshTimers()
    removeSubscription(appStateSubscription)
    removeSubscription(networkSubscription)
    appStateSubscription = null
    networkSubscription = null
    if (hasAbortController) fetchController?.abort()
    fetchController = null
    for (const [timer, resolve] of delayTimers) {
      clearTimeout(timer)
      resolve()
    }
    delayTimers.clear()
    inFlight = null
    void telemetry.shutdown()
  }

  return {
    initialize,
    destroy,
    refresh,
    refetch: () => refresh("manual"),
    setContext,
    recordEvaluation: (event, exposed) => telemetry.recordEvaluation(event, exposed),
    track: (flagKey, metricKey, value, options) =>
      telemetry.track(flagKey, metricKey, value, options),
    flush: () => telemetry.flush(),
    shutdown: (options) => telemetry.shutdown(options),
    getState: () => withDerivedState(state),
  }
}
