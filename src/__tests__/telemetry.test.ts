import { describe, expect, test } from "bun:test"
import type { FeatureEvent } from "@superflag-sh/core/events"
import type { TelemetryTransport } from "@superflag-sh/core/telemetry"
import { evaluateWithCore } from "../evaluation.js"
import { createHostedTelemetryTransport, createReactNativeTelemetry } from "../telemetry.js"
import type {
  DiagnosticEvent,
  EvaluationContext,
  ExposureEvent,
  FlagConfig,
  StorageAdapter,
} from "../types.js"

class MemoryStorage implements StorageAdapter {
  readonly values = new Map<string, string>()

  async getItem(key: string): Promise<string | null> {
    return this.values.get(key) ?? null
  }

  async setItem(key: string, value: string): Promise<void> {
    this.values.set(key, value)
  }

  async removeItem(key: string): Promise<void> {
    this.values.delete(key)
  }
}

const config: FlagConfig = {
  schemaVersion: 1,
  source: { app: "checkout-app", environment: "production" },
  configVersion: 9,
  flags: {
    checkout: {
      type: "boolean",
      description: "Checkout",
      tags: ["experiment"],
      owner: "growth",
      lifecycle: "active",
      enabled: true,
      variations: { off: { value: false }, on: { value: true } },
      offVariation: "off",
      fallthrough: { variation: "on" },
      visibility: "client",
    },
  },
}

const context: EvaluationContext = {
  targetingKey: "raw-user-123",
  attributes: { plan: "pro", email: "person@example.com" },
}

function exposure(): ExposureEvent<boolean> {
  return {
    key: "checkout",
    context,
    details: evaluateWithCore(config, context, "checkout", false, {
      now: "2026-07-14T12:00:00.000Z",
    }),
    timestamp: Date.parse("2026-07-14T12:00:00.000Z"),
  }
}

function setup(options: {
  storage?: MemoryStorage
  transport?: TelemetryTransport
  now?: () => number
  allowedAttributes?: readonly string[]
  onEvent?: (event: FeatureEvent) => void
} = {}) {
  const storage = options.storage ?? new MemoryStorage()
  const diagnostics: DiagnosticEvent[] = []
  const telemetry = createReactNativeTelemetry({
    clientKey: "pub_production_test",
    configUrl: "https://superflag.sh/api/v1/public-config",
    storage,
    options: {
      transport: options.transport,
      allowedAttributes: options.allowedAttributes,
      onEvent: options.onEvent,
      retryBaseMs: 10,
      retryMaxMs: 10,
      flushIntervalMs: 60_000,
    },
    now: options.now ?? (() => Date.parse("2026-07-14T12:00:00.000Z")),
    getContext: () => context,
    getConfig: () => config,
    emitDiagnostic: (event) => diagnostics.push({
      ...event,
      timestamp: Date.parse("2026-07-14T12:00:00.000Z"),
    }),
  })
  return { telemetry, storage, diagnostics }
}

async function settle(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe("React Native telemetry", () => {
  test("uses the hosted envelope and preserves ordered item-level 429 results", async () => {
    let request: Request | undefined
    const transport = createHostedTelemetryTransport({
      clientKey: "pub_production_test",
      baseUrl: "https://example.com/api/v1/public-config",
      fetch: async (input, init) => {
        request = new Request(input, init)
        return Response.json({
          apiVersion: 1,
          schemaVersion: 1,
          requestId: "request-1",
          items: [
            {
              eventId: "event-1",
              status: "retryable_error",
              code: "rate_limited",
              retryAfterMs: 2_000,
            },
          ],
        }, { status: 429 })
      },
    })
    const event = {
      schemaVersion: 1,
      id: "event-1",
      kind: "exposure",
      source: config.source,
      flagKey: "checkout",
      variation: "on",
      configVersion: 9,
      reason: "FALLTHROUGH",
      timestamp: "2026-07-14T12:00:00.000Z",
      sdk: { name: "test", version: "1", platform: "react-native" },
      subject: {
        id: "psn_0123456789abcdef",
        namespace: "checkout-app:production",
        revision: 1,
        state: "authenticated",
      },
    } as const
    const result = await transport.send([event], { signal: new AbortController().signal })

    expect(request?.url).toBe("https://example.com/api/v1/events/batch")
    expect(request?.headers.get("Authorization")).toBe("Bearer pub_production_test")
    expect(await request?.json()).toEqual({ schemaVersion: 1, events: [event] })
    expect(result.items).toEqual([{
      eventId: "event-1",
      status: "retryable_error",
      code: "rate_limited",
      retryAfterMs: 2_000,
    }])
  })

  test("emits the canonical cross-SDK envelope without raw context", async () => {
    const delivered: FeatureEvent[] = []
    const callbackEvents: FeatureEvent[] = []
    const transport: TelemetryTransport = {
      async send(events) {
        delivered.push(...events)
        return { items: events.map((event) => ({ eventId: event.id, status: "accepted" as const })) }
      },
    }
    const { telemetry, storage } = setup({
      transport,
      onEvent: (event) => callbackEvents.push(event),
    })

    telemetry.recordExposure(exposure())
    telemetry.recordExposure(exposure())
    await settle()
    await telemetry.flush()

    expect(delivered).toHaveLength(1)
    expect(callbackEvents).toHaveLength(1)
    expect(delivered[0]).toMatchObject({
      schemaVersion: 1,
      kind: "exposure",
      source: { app: "checkout-app", environment: "production" },
      flagKey: "checkout",
      variation: "on",
      configVersion: 9,
      reason: "FALLTHROUGH",
      timestamp: "2026-07-14T12:00:00.000Z",
      sdk: {
        name: "@superflag-sh/react-native",
        version: "0.3.0",
        platform: "react-native",
      },
      subject: {
        namespace: "checkout-app:production",
        revision: 1,
        state: "authenticated",
      },
    })
    expect(delivered[0]?.subject.id).toMatch(/^psn_[a-f0-9]{32}$/)
    const serialized = JSON.stringify([...storage.values, delivered])
    expect(serialized).not.toContain("raw-user-123")
    expect(serialized).not.toContain("person@example.com")
  })

  test("persists an offline bounded queue and drains it after restart", async () => {
    const storage = new MemoryStorage()
    let now = 1_000
    const offline = setup({
      storage,
      now: () => now,
      transport: { send: async () => { throw new Error("offline") } },
    })
    offline.telemetry.recordExposure(exposure())
    await settle()
    const failed = await offline.telemetry.flush()
    expect(failed.retryScheduled).toBe(1)
    expect(JSON.stringify([...storage.values])).not.toContain("raw-user-123")

    const delivered: FeatureEvent[] = []
    now += 20
    const online = setup({
      storage,
      now: () => now,
      transport: {
        async send(events) {
          delivered.push(...events)
          return { items: events.map((event) => ({ eventId: event.id, status: "accepted" as const })) }
        },
      },
    })
    await online.telemetry.initialize()
    const result = await online.telemetry.flush()
    expect(result.accepted).toBe(1)
    expect(delivered).toHaveLength(1)
  })

  test("reapplies queue bounds when restoring offline state", async () => {
    const storage = new MemoryStorage()
    const offline = setup({
      storage,
      now: () => 1_000,
      transport: { send: async () => { throw new Error("offline") } },
    })
    offline.telemetry.recordEvaluation(exposure(), false)
    offline.telemetry.recordEvaluation(exposure(), false)
    offline.telemetry.recordEvaluation(exposure(), false)
    await settle()
    await offline.telemetry.flush()

    const delivered: FeatureEvent[] = []
    const diagnostics: DiagnosticEvent[] = []
    const restored = createReactNativeTelemetry({
      clientKey: "pub_production_test",
      configUrl: "https://superflag.sh/api/v1/public-config",
      storage,
      options: {
        maxQueueSize: 1,
        transport: {
          async send(events) {
            delivered.push(...events)
            return {
              items: events.map((event) => ({ eventId: event.id, status: "accepted" as const })),
            }
          },
        },
      },
      now: () => 2_000,
      getContext: () => context,
      getConfig: () => config,
      emitDiagnostic: (event) => diagnostics.push({ ...event, timestamp: 2_000 }),
    })
    await restored.initialize()
    await restored.flush()

    expect(delivered).toHaveLength(1)
    expect(diagnostics.some((event) => event.code === "telemetry_event_dropped")).toBeTrue()
  })

  test("tracks only feature-scoped numeric outcomes with allow-listed attributes", async () => {
    const delivered: FeatureEvent[] = []
    const { telemetry, diagnostics } = setup({
      allowedAttributes: ["surface"],
      transport: {
        async send(events) {
          delivered.push(...events)
          return { items: events.map((event) => ({ eventId: event.id, status: "accepted" as const })) }
        },
      },
    })
    telemetry.recordExposure(exposure())
    await settle()
    const tracked = await telemetry.track("checkout", "purchase", 42, {
      revision: 2,
      attributes: { surface: "cart" },
    })
    expect(tracked.status).toBe("queued")
    await telemetry.flush()

    const outcome = delivered.find((event) => event.kind === "outcome")
    expect(outcome).toMatchObject({
      kind: "outcome",
      flagKey: "checkout",
      metric: { key: "purchase", revision: 2 },
      value: 42,
      dimensions: { surface: "cart" },
    })

    const rejected = await telemetry.track("checkout", "purchase", 5, {
      attributes: { email: "not-allowed" },
    })
    expect(rejected).toMatchObject({ status: "dropped", reason: "invalid_outcome" })
    expect(diagnostics.some((event) => event.code === "telemetry_invalid")).toBeTrue()
  })

  test("does not create events during initialization or bulk state reads", async () => {
    const events: FeatureEvent[] = []
    const { telemetry } = setup({ onEvent: (event) => events.push(event) })
    await telemetry.initialize()
    expect(events).toEqual([])
  })

  test("records detail reads as decisions without inventing an exposure", async () => {
    const events: FeatureEvent[] = []
    const { telemetry } = setup({ onEvent: (event) => events.push(event) })
    telemetry.recordEvaluation(exposure(), false)
    await settle()

    expect(events).toHaveLength(1)
    expect(events[0]?.kind).toBe("decision")
    expect(await telemetry.track("checkout", "purchase", 1)).toMatchObject({
      status: "dropped",
      reason: "missing_exposure",
    })
  })

  test("bounds shutdown when a mobile transport ignores cancellation", async () => {
    const { telemetry } = setup({
      transport: {
        send: async () => new Promise(() => {}),
      },
    })
    telemetry.recordExposure(exposure())
    await settle()
    const result = await telemetry.shutdown({ timeoutMs: 5 })

    expect(result.timedOut).toBeTrue()
    expect(result.dropped).toBe(1)
  })
})
