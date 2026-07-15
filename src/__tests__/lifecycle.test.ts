import { afterEach, describe, expect, test } from "bun:test"
import type { FlagConfig } from "@superflag-sh/core"
import type { FeatureEvent } from "@superflag-sh/core/events"
import { createCacheKey, createCacheScope, createPersistedCacheBinding } from "../cache.js"
import { createClient } from "../client.js"
import { evaluateWithCore } from "../evaluation.js"
import type {
  AppStateAdapter,
  AppStateSubscription,
  CachedConfig,
  DiagnosticEvent,
  NetworkAdapter,
  StorageAdapter,
  SuperflagState,
  SuperflagTelemetryOptions,
} from "../types.js"

const originalFetch = globalThis.fetch
const CONFIG_URL = "https://superflag.sh/api/v1/public-config"

class MemoryStorage implements StorageAdapter {
  readonly values = new Map<string, string>()
  readonly removed: string[] = []

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.removed.push(key)
    this.values.delete(key)
  }
}

class FakeAppState implements AppStateAdapter {
  currentState: string | null = "active"
  listener: ((state: string) => void) | null = null
  removes = 0

  addEventListener(_event: "change", listener: (state: string) => void): AppStateSubscription {
    this.listener = listener
    return {
      remove: () => {
        this.removes += 1
        this.listener = null
      },
    }
  }

  emit(state: string): void {
    this.listener?.(state)
  }
}

class FakeNetwork implements NetworkAdapter {
  listener: ((connected: boolean) => void) | null = null
  removes = 0

  subscribe(listener: (connected: boolean) => void): () => void {
    this.listener = listener
    return () => {
      this.removes += 1
      this.listener = null
    }
  }

  emit(connected: boolean): void {
    this.listener?.(connected)
  }
}

function flagConfig(version = 1, enabled = true): FlagConfig {
  return {
    schemaVersion: 1,
    source: { app: "app-a", environment: "production" },
    configVersion: version,
    flags: {
      checkout: {
        type: "boolean",
        description: "Checkout",
        tags: ["test"],
        owner: "sdk",
        lifecycle: "active",
        enabled: true,
        variations: { off: { value: false }, on: { value: enabled } },
        offVariation: "off",
        fallthrough: { variation: "on" },
        visibility: "client",
      },
    },
  }
}

function response(version = 1, enabled = true): Response {
  return Response.json(
    {
      appId: "app-a",
      env: "production",
      version,
      doc: flagConfig(version, enabled),
      ttlSeconds: 60,
    },
    { headers: { ETag: `"${version}"` } },
  )
}

function seedCache(storage: MemoryStorage, clientKey: string, fetchedAt: number, version = 1): void {
  const scope = createCacheScope(CONFIG_URL, clientKey)
  const binding = createPersistedCacheBinding(scope, {
    appId: "app-a",
    environment: "production",
  })
  const config = flagConfig(version)
  const cached: CachedConfig = {
    schemaVersion: 3,
    endpointFingerprint: scope.endpointFingerprint,
    clientKeyFingerprint: scope.clientKeyFingerprint,
    appId: binding.appId,
    environment: binding.environment,
    flags: config.flags,
    version,
    config,
    etag: `"${version}"`,
    fetchedAt,
  }
  storage.values.set(scope.bindingKey, JSON.stringify(binding))
  storage.values.set(createCacheKey(scope, binding), JSON.stringify(cached))
}

function setup(options: {
  now?: () => number
  storage?: MemoryStorage
  appState?: AppStateAdapter | null
  network?: NetworkAdapter | null
  onReady?: (state: SuperflagState) => void | Promise<void>
  onDiagnostic?: (event: DiagnosticEvent) => void | Promise<void>
  maxStaleAgeSeconds?: number
  retries?: number
  telemetry?: SuperflagTelemetryOptions
} = {}) {
  const storage = options.storage ?? new MemoryStorage()
  const states: SuperflagState[] = []
  const client = createClient({
    clientKey: "pub_production_test",
    configUrl: CONFIG_URL,
    ttlSeconds: 60,
    maxStaleAgeSeconds: options.maxStaleAgeSeconds ?? 3_600,
    storage,
    evaluationContext: { targetingKey: "person", attributes: { plan: "pro" } },
    retry: { maxRetries: options.retries ?? 0, baseDelayMs: 0, maxDelayMs: 0 },
    appState: options.appState ?? null,
    network: options.network,
    telemetry: options.telemetry,
    now: options.now ?? (() => 100_000),
    onReady: options.onReady,
    onDiagnostic: options.onDiagnostic,
    onStateChange: (state) => states.push(state),
  })
  return { client, states, storage }
}

async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe("cache and refresh lifecycle", () => {
  test("serves a fresh cache first without fetching and cleans up listeners", async () => {
    const storage = new MemoryStorage()
    seedCache(storage, "pub_production_test", 90_000)
    const appState = new FakeAppState()
    const network = new FakeNetwork()
    let fetches = 0
    globalThis.fetch = async () => {
      fetches += 1
      return response()
    }
    const { client, states } = setup({ storage, appState, network })

    await client.initialize()
    expect(fetches).toBe(0)
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      source: "cache",
      age: 10,
      stale: false,
    })
    expect(client.getState().age).toBe(10)

    client.destroy()
    expect(appState.removes).toBe(1)
    expect(network.removes).toBe(1)
    expect(appState.listener).toBeNull()
    expect(network.listener).toBeNull()
  })

  test("serves stale cache while offline and bounds retries", async () => {
    const storage = new MemoryStorage()
    seedCache(storage, "pub_production_test", 1_000)
    let fetches = 0
    globalThis.fetch = async () => {
      fetches += 1
      throw new Error("offline")
    }
    const { client, states } = setup({ storage, retries: 2 })

    await client.initialize()
    expect(fetches).toBe(3)
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      source: "cache",
      stale: true,
      error: "offline",
    })
    client.destroy()
  })

  test("does not spin when stale-cache revalidation fails", async () => {
    const storage = new MemoryStorage()
    seedCache(storage, "pub_production_test", 1_000)
    let fetches = 0
    globalThis.fetch = async () => {
      fetches += 1
      throw new Error("offline")
    }
    const { client } = setup({ storage })

    await client.initialize()
    await new Promise((resolve) => setTimeout(resolve, 25))
    expect(fetches).toBe(1)
    client.destroy()
  })

  test("deduplicates concurrent manual refreshes", async () => {
    let resolveResponse: ((value: Response) => void) | null = null
    let fetches = 0
    globalThis.fetch = () => {
      fetches += 1
      return new Promise<Response>((resolve) => {
        resolveResponse = resolve
      })
    }
    const { client } = setup()
    const initializing = client.initialize()
    const first = client.refresh()
    const second = client.refresh()

    expect(first).toBe(second)
    expect(fetches).toBe(1)
    resolveResponse?.(response())
    await Promise.all([initializing, first, second])
    client.destroy()
  })

  test("refreshes on foreground and reconnect transitions", async () => {
    const appState = new FakeAppState()
    const network = new FakeNetwork()
    let fetches = 0
    globalThis.fetch = async () => response(++fetches)
    const { client } = setup({ appState, network })
    await client.initialize()

    appState.emit("background")
    appState.emit("active")
    await flush()
    expect(fetches).toBe(2)

    network.emit(false)
    network.emit(true)
    await flush()
    expect(fetches).toBe(3)
    client.destroy()
  })

  test("flushes telemetry on background/foreground without creating initialization exposures", async () => {
    const appState = new FakeAppState()
    const events: FeatureEvent[] = []
    globalThis.fetch = async () => response()
    const { client } = setup({
      appState,
      telemetry: {
        transport: {
          async send(batch) {
            events.push(...batch)
            return {
              items: batch.map((event) => ({ eventId: event.id, status: "accepted" as const })),
            }
          },
        },
        flushIntervalMs: 60_000,
      },
    })
    await client.initialize()
    expect(events).toEqual([])

    const evaluationContext = { targetingKey: "person", attributes: { plan: "pro" } }
    client.recordEvaluation({
      key: "checkout",
      context: evaluationContext,
      details: evaluateWithCore(flagConfig(), evaluationContext, "checkout", false, {
        now: "2026-07-14T12:00:00.000Z",
      }),
    }, true)
    await flush()
    expect(events).toEqual([])

    appState.emit("background")
    await flush()
    expect(events).toHaveLength(1)
    appState.emit("active")
    await flush()
    expect(events).toHaveLength(1)
    client.destroy()
  })

  test("revalidates a stale cache with 304 and advances fetchedAt", async () => {
    const storage = new MemoryStorage()
    seedCache(storage, "pub_production_test", 1_000, 4)
    let conditional: string | null = null
    globalThis.fetch = async (_input, init) => {
      conditional = new Headers(init?.headers).get("If-None-Match")
      return new Response(null, { status: 304 })
    }
    const { client, states } = setup({ storage })
    await client.initialize()

    expect(conditional).toBe('"4"')
    expect(states.at(-1)).toMatchObject({
      status: "ready",
      source: "network",
      fetchedAt: 100_000,
      configVersion: 4,
      stale: false,
    })
    client.destroy()
  })

  test("drops an over-age cache instead of serving it", async () => {
    const storage = new MemoryStorage()
    seedCache(storage, "pub_production_test", 1_000)
    let fetches = 0
    globalThis.fetch = async () => {
      fetches += 1
      return response(2)
    }
    const { client, states } = setup({ storage, maxStaleAgeSeconds: 10 })
    await client.initialize()

    expect(fetches).toBe(1)
    expect(states.some((state) => state.source === "cache")).toBeFalse()
    expect(states.at(-1)).toMatchObject({ source: "network", configVersion: 2 })
    client.destroy()
  })

  test("identity updates re-evaluate locally without fetching config", async () => {
    let fetches = 0
    globalThis.fetch = async () => {
      fetches += 1
      return response()
    }
    const { client } = setup()
    await client.initialize()
    client.setContext({ targetingKey: "next-person", attributes: { plan: "free" } })

    expect(fetches).toBe(1)
    expect(client.getState().evaluationContext).toEqual({
      targetingKey: "next-person",
      attributes: { plan: "free" },
    })
    client.destroy()
  })

  test("contains synchronous and async callback failures", async () => {
    const diagnostics: DiagnosticEvent[] = []
    globalThis.fetch = async () => response()
    const { client, states } = setup({
      onReady: () => {
        throw new Error("analytics unavailable")
      },
      onDiagnostic: (event) => diagnostics.push(event),
    })

    await client.initialize()
    await flush()
    expect(states.at(-1)?.status).toBe("ready")
    expect(diagnostics.some((event) => event.code === "callback_failed")).toBeTrue()
    client.destroy()

    const throwing = setup({
      onReady: async () => Promise.reject(new Error("async callback failed")),
      onDiagnostic: () => {
        throw new Error("diagnostic callback failed")
      },
    })
    await throwing.client.initialize()
    await flush()
    expect(throwing.states.at(-1)?.status).toBe("ready")
    throwing.client.destroy()
  })
})
