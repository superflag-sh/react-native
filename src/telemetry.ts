import {
  createEvaluationEvent,
  createNumericOutcomeEvent,
  exposureDedupeKey,
  parseFeatureEvent,
} from "@superflag-sh/core"
import type {
  ExposureEvent as CanonicalExposureEvent,
  FeatureEvent,
  PseudonymousSubject,
  TelemetryAbortSignal,
  TelemetryEnqueueResult,
  TelemetryDiagnostic,
  TelemetryFlushResult,
  TelemetryItemResult,
  TelemetryShutdownResult,
  TelemetryTransport,
} from "@superflag-sh/core"
import { createCacheScope, sha256 } from "./cache.js"
import type {
  DiagnosticEvent,
  EvaluationContext,
  EvaluationEvent,
  ExposureEvent,
  FlagConfig,
  HostedTelemetryResponse,
  StorageAdapter,
  SuperflagHostedTelemetryOptions,
  SuperflagTelemetryOptions,
  SuperflagTrackResult,
  TrackOptions,
} from "./types.js"

const TELEMETRY_SCHEMA_VERSION = 1 as const
const SDK = {
  name: "@superflag-sh/react-native",
  version: "0.3.0",
  platform: "react-native",
} as const
const MAX_EXPOSURE_KEYS = 10_000

interface PersistedEntry {
  event: FeatureEvent
  attempts: number
  readyAt: number
}

interface PersistedTelemetry {
  schemaVersion: typeof TELEMETRY_SCHEMA_VERSION
  salt: string
  entries: PersistedEntry[]
  deliveredExposureKeys: string[]
}

interface TelemetryRuntimeOptions {
  clientKey: string
  configUrl: string
  storage: StorageAdapter
  options?: SuperflagTelemetryOptions
  now: () => number
  getContext: () => EvaluationContext
  getConfig: () => FlagConfig | null
  emitDiagnostic: (event: Omit<DiagnosticEvent, "timestamp">) => void
}

function boundedInteger(value: number | undefined, fallback: number, maximum: number): number {
  return Number.isSafeInteger(value) && (value as number) > 0
    ? Math.min(value as number, maximum)
    : fallback
}

function boundedDelay(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.min(value, 2_147_483_647)
    : fallback
}

function telemetryEndpoint(url: string | undefined, configUrl: string): string {
  let base = (url ?? configUrl).trim().replace(/\/+$/, "")
  if (/\/api\/v1\/events\/batch$/i.test(base)) return base
  base = base.replace(/\/api\/v1\/(?:public-)?config$/i, "")
  base = base.replace(/\/api\/v1$/i, "")
  return `${base}/api/v1/events/batch`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseItem(value: unknown): TelemetryItemResult | null {
  if (!isRecord(value) || typeof value.eventId !== "string") return null
  if (value.status === "accepted" || value.status === "duplicate") {
    return { eventId: value.eventId, status: value.status }
  }
  if (value.status === "permanent_error" && typeof value.code === "string") {
    return {
      eventId: value.eventId,
      status: value.status,
      code: value.code,
      ...(typeof value.message === "string" ? { message: value.message } : {}),
    }
  }
  if (value.status === "retryable_error") {
    return {
      eventId: value.eventId,
      status: value.status,
      ...(typeof value.code === "string" ? { code: value.code } : {}),
      ...(typeof value.retryAfterMs === "number" &&
      Number.isFinite(value.retryAfterMs) &&
      value.retryAfterMs >= 0
        ? { retryAfterMs: value.retryAfterMs }
        : {}),
    }
  }
  return null
}

async function parseBatchResponse(response: HostedTelemetryResponse): Promise<{ items: TelemetryItemResult[] }> {
  const payload = (await response.json()) as unknown
  if (
    !isRecord(payload) ||
    payload.apiVersion !== 1 ||
    payload.schemaVersion !== 1 ||
    !Array.isArray(payload.items)
  ) {
    throw new Error("Telemetry endpoint returned an invalid envelope")
  }
  const items = payload.items.map(parseItem)
  if (items.some((item) => item === null)) {
    throw new Error("Telemetry endpoint returned an invalid item result")
  }
  return { items: items as TelemetryItemResult[] }
}

function requestController(): { signal: AbortSignal; abort(): void } {
  if (typeof AbortController !== "undefined") return new AbortController()
  return {
    signal: {
      aborted: false,
      onabort: null,
      reason: undefined,
      throwIfAborted() {},
      addEventListener() {},
      removeEventListener() {},
      dispatchEvent: () => true,
    } as unknown as AbortSignal,
    abort() {},
  }
}

export interface HostedTelemetryTransportOptions extends SuperflagHostedTelemetryOptions {
  clientKey: string
}

/** Creates the opt-in first-party transport without importing a native module. */
export function createHostedTelemetryTransport(
  options: HostedTelemetryTransportOptions,
): TelemetryTransport {
  const endpoint = telemetryEndpoint(options.baseUrl, "https://superflag.sh")
  return {
    async send(events, { signal }) {
      const request = {
        method: "POST",
        headers: {
          ...options.headers,
          Authorization: `Bearer ${options.clientKey}`,
          "Content-Type": "application/json",
          "X-Request-ID": `batch_${events[0]?.id ?? Date.now().toString(36)}`,
        },
        body: JSON.stringify({ schemaVersion: 1, events }),
        signal,
      } as const
      const response = options.fetch
        ? await options.fetch(endpoint, request)
        : typeof globalThis.fetch === "function"
          ? await globalThis.fetch(endpoint, {
              ...request,
              signal: nativeSignal(signal),
            })
          : (() => { throw new Error("Global fetch is unavailable") })()

      if (response.status === 429) {
        try {
          return await parseBatchResponse(response)
        } catch {
          // Older/self-hosted endpoints may not yet return item-level 429 results.
        }
      }

      if (!response.ok) {
        const retryable = response.status === 408 || response.status === 425 || response.status === 429 || response.status >= 500
        const retryAfter = Number(response.headers.get("Retry-After"))
        return {
          items: events.map((event) =>
            retryable
              ? {
                  eventId: event.id,
                  status: "retryable_error" as const,
                  code: `HTTP_${response.status}`,
                  ...(Number.isFinite(retryAfter) && retryAfter >= 0
                    ? { retryAfterMs: retryAfter * 1_000 }
                    : {}),
                }
              : {
                  eventId: event.id,
                  status: "permanent_error" as const,
                  code: `HTTP_${response.status}`,
                },
          ),
        }
      }

      return parseBatchResponse(response)
    },
  }
}

function nativeSignal(signal: TelemetryAbortSignal): AbortSignal | undefined {
  if (typeof AbortController === "undefined") return undefined
  if ("throwIfAborted" in signal && "dispatchEvent" in signal) {
    return signal as AbortSignal
  }
  const controller = new AbortController()
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener("abort", () => controller.abort(signal.reason), { once: true })
  return controller.signal
}

function randomSalt(): string {
  const bytes = new Uint8Array(24)
  try {
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(bytes)
    } else {
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Math.floor(Math.random() * 256)
      }
    }
  } catch {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256)
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function emptyFlush(queueSize = 0): TelemetryFlushResult {
  return {
    sent: 0,
    accepted: 0,
    duplicates: 0,
    permanent: 0,
    retryScheduled: 0,
    queueSize,
  }
}

function mergeResult(target: TelemetryFlushResult, source: TelemetryFlushResult): void {
  target.sent += source.sent
  target.accepted += source.accepted
  target.duplicates += source.duplicates
  target.permanent += source.permanent
  target.retryScheduled += source.retryScheduled
  target.queueSize = source.queueSize
}

export class ReactNativeTelemetry {
  private readonly storage: StorageAdapter
  private readonly options?: SuperflagTelemetryOptions
  private readonly transport?: TelemetryTransport
  private readonly key: string
  private readonly maxQueueSize: number
  private readonly batchSize: number
  private readonly flushIntervalMs: number
  private readonly maxAttempts: number
  private readonly retryBaseMs: number
  private readonly retryMaxMs: number
  private readonly shutdownTimeoutMs: number
  private readonly retryJitterRatio: number
  private readonly maxExposureKeys: number
  private readonly entries: PersistedEntry[] = []
  private readonly deliveredExposureKeys: string[] = []
  private readonly exposureKeys = new Set<string>()
  private readonly latestExposure = new Map<string, CanonicalExposureEvent>()
  private salt = ""
  private initialized?: Promise<void>
  private serial: Promise<unknown> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | null = null
  private eventCounter = 0
  private closing = false
  private closed = false

  constructor(private readonly runtime: TelemetryRuntimeOptions) {
    this.options = runtime.options
    this.storage = runtime.options?.storage ?? runtime.storage
    const scope = createCacheScope(runtime.configUrl, runtime.clientKey)
    this.key = `superflag:telemetry:v${TELEMETRY_SCHEMA_VERSION}:${scope.endpointFingerprint}:${scope.clientKeyFingerprint}`
    this.maxQueueSize = boundedInteger(runtime.options?.maxQueueSize, 1_000, 10_000)
    this.batchSize = Math.min(
      boundedInteger(runtime.options?.batchSize, 50, 100),
      this.maxQueueSize,
    )
    this.flushIntervalMs = boundedDelay(runtime.options?.flushIntervalMs, 10_000)
    this.maxAttempts = boundedInteger(runtime.options?.maxAttempts, 5, 20)
    this.retryBaseMs = boundedDelay(runtime.options?.retryBaseMs, 500)
    this.retryMaxMs = Math.max(this.retryBaseMs, boundedDelay(runtime.options?.retryMaxMs, 30_000))
    this.retryJitterRatio = Math.min(
      1,
      typeof runtime.options?.retryJitterRatio === "number" &&
        Number.isFinite(runtime.options.retryJitterRatio) &&
        runtime.options.retryJitterRatio >= 0
        ? runtime.options.retryJitterRatio
        : 0.2,
    )
    this.maxExposureKeys = boundedInteger(
      runtime.options?.maxExposureDedupeEntries,
      MAX_EXPOSURE_KEYS,
      100_000,
    )
    this.shutdownTimeoutMs = boundedDelay(runtime.options?.shutdownTimeoutMs, 5_000)
    const hosted = runtime.options?.hosted
    this.transport = runtime.options?.transport ??
      (hosted
        ? createHostedTelemetryTransport({
            ...(typeof hosted === "object" ? hosted : {}),
            baseUrl:
              typeof hosted === "object" && hosted.baseUrl
                ? hosted.baseUrl
                : runtime.configUrl,
            clientKey: runtime.clientKey,
          })
        : undefined)
  }

  private diagnostic(code: DiagnosticEvent["code"], message: string, error?: unknown): void {
    this.runtime.emitDiagnostic({ code, message, ...(error !== undefined ? { error } : {}) })
    const callback = this.options?.onDiagnostic
    if (!callback) return
    const telemetryCode: TelemetryDiagnostic["code"] =
      code === "telemetry_callback_failed"
        ? "callback_error"
        : code === "telemetry_event_dropped"
          ? "queue_overflow"
          : code === "telemetry_invalid" || code === "telemetry_subject_failed"
            ? "invalid_event"
            : code === "telemetry_retry_scheduled"
              ? "retry_scheduled"
              : "transport_error"
    try {
      Promise.resolve(callback({
        code: telemetryCode,
        message,
        queueSize: this.entries.length,
      })).catch(() => {})
    } catch {
      // Telemetry diagnostics are a final error boundary.
    }
  }

  private runExclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.serial.then(operation, operation)
    this.serial = next.then(
      () => undefined,
      () => undefined,
    )
    return next
  }

  private async persist(): Promise<void> {
    if (!this.transport) return
    try {
      const state: PersistedTelemetry = {
        schemaVersion: TELEMETRY_SCHEMA_VERSION,
        salt: this.salt,
        entries: this.entries,
        deliveredExposureKeys: this.deliveredExposureKeys,
      }
      await this.storage.setItem(this.key, JSON.stringify(state))
    } catch (error) {
      this.diagnostic("telemetry_storage_failed", "Could not persist telemetry queue", error)
    }
  }

  initialize(): Promise<void> {
    if (this.initialized) return this.initialized
    this.initialized = this.runExclusive(async () => {
      if (!this.options) {
        this.salt = randomSalt()
        return
      }
      if (!this.transport) {
        this.salt = randomSalt()
        return
      }
      let raw: string | null = null
      try {
        raw = await this.storage.getItem(this.key)
      } catch (error) {
        this.diagnostic("telemetry_storage_failed", "Could not read telemetry queue", error)
      }

      if (raw) {
        try {
          const parsed = JSON.parse(raw) as Partial<PersistedTelemetry>
          if (
            parsed.schemaVersion !== TELEMETRY_SCHEMA_VERSION ||
            typeof parsed.salt !== "string" ||
            !/^[a-f0-9]{48}$/.test(parsed.salt)
          ) {
            throw new TypeError("Unsupported telemetry cache schema")
          }
          this.salt = parsed.salt
          for (const item of parsed.entries ?? []) {
            if (
              typeof item !== "object" ||
              item === null ||
              !Number.isSafeInteger(item.attempts) ||
              item.attempts < 0 ||
              item.attempts >= this.maxAttempts ||
              typeof item.readyAt !== "number" ||
              !Number.isFinite(item.readyAt)
            ) continue
            const event = parseFeatureEvent(item.event, {
              allowedDimensions: this.options?.allowedAttributes,
              ...(this.options?.maxEventPayloadBytes !== undefined
                ? { maxPayloadBytes: this.options.maxEventPayloadBytes }
                : {}),
            })
            if (this.entries.some((entry) => entry.event.id === event.id)) continue
            this.entries.push({ event, attempts: item.attempts, readyAt: item.readyAt })
            if (event.kind === "exposure") this.exposureKeys.add(exposureDedupeKey(event))
          }
          if (this.entries.length > this.maxQueueSize) {
            const keep = this.options?.backpressure === "drop-newest"
              ? this.entries.slice(0, this.maxQueueSize)
              : this.entries.slice(-this.maxQueueSize)
            this.entries.splice(0, this.entries.length, ...keep)
            this.exposureKeys.clear()
            for (const entry of this.entries) {
              if (entry.event.kind === "exposure") {
                this.exposureKeys.add(exposureDedupeKey(entry.event))
              }
            }
            this.diagnostic("telemetry_event_dropped", "Persisted telemetry exceeded the queue bound")
          }
          for (const key of parsed.deliveredExposureKeys ?? []) {
            if (/^exposure_[a-f0-9]{16}$/.test(key) && !this.deliveredExposureKeys.includes(key)) {
              this.deliveredExposureKeys.push(key)
              this.exposureKeys.add(key)
            }
          }
          if (this.deliveredExposureKeys.length > this.maxExposureKeys) {
            this.deliveredExposureKeys.splice(
              0,
              this.deliveredExposureKeys.length - this.maxExposureKeys,
            )
            const retained = new Set(this.deliveredExposureKeys)
            for (const key of this.exposureKeys) {
              if (
                !retained.has(key) &&
                !this.entries.some((entry) =>
                  entry.event.kind === "exposure" && exposureDedupeKey(entry.event) === key)
              ) this.exposureKeys.delete(key)
            }
          }
        } catch (error) {
          this.diagnostic("telemetry_invalid", "Discarded an invalid telemetry queue", error)
          this.salt = ""
          this.entries.splice(0)
          this.deliveredExposureKeys.splice(0)
          this.exposureKeys.clear()
          try {
            await this.storage.removeItem(this.key)
          } catch {}
        }
      }
      if (!this.salt) {
        this.salt = randomSalt()
        await this.persist()
      }
      this.schedule()
    })
    return this.initialized
  }

  private schedule(): void {
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    if (!this.transport || this.closing || this.closed || this.entries.length === 0) return
    const nextReadyAt = Math.min(...this.entries.map((entry) => entry.readyAt))
    const untilReady = Math.max(0, nextReadyAt - this.runtime.now())
    const delay = Math.min(this.flushIntervalMs, untilReady || this.flushIntervalMs)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.flush()
    }, delay)
  }

  private eventId(prefix: "dec" | "exp" | "out"): string {
    this.eventCounter += 1
    return `${prefix}_${this.runtime.now().toString(36)}_${this.eventCounter.toString(36)}_${Math.floor(Math.random() * 0xffffffff).toString(36)}`
  }

  private async subject(context: EvaluationContext, source: FlagConfig["source"]): Promise<PseudonymousSubject> {
    await this.initialize()
    const readableNamespace = `${source.app}:${source.environment}`
    const namespace = readableNamespace.length <= 96
      ? readableNamespace
      : `scope_${sha256(readableNamespace)}`
    const identity = context.targetingKey || "anonymous"
    const state = this.options?.subjectState ?? (context.targetingKey ? "authenticated" : "anonymous")
    if (this.options?.pseudonymize) {
      return this.options.pseudonymize({
        targetingKey: identity,
        namespace,
        appId: source.app,
        environment: source.environment,
        state,
      })
    }
    return {
      id: `psn_${sha256(`${this.salt}:${namespace}:${identity}`).slice(0, 32)}`,
      namespace,
      revision: this.options?.subjectRevision ?? 1,
      state,
    }
  }

  private invokeEvent(event: FeatureEvent): boolean {
    const callback = this.options?.onEvent
    if (!callback) return false
    try {
      Promise.resolve(callback(event)).catch((error) => {
        this.diagnostic("telemetry_callback_failed", "Telemetry event callback failed", error)
      })
      return true
    } catch (error) {
      this.diagnostic("telemetry_callback_failed", "Telemetry event callback failed", error)
      return false
    }
  }

  private removeExposureKeyIfUndelivered(event: FeatureEvent): void {
    if (event.kind !== "exposure") return
    const key = exposureDedupeKey(event)
    if (!this.deliveredExposureKeys.includes(key) &&
      !this.entries.some((entry) => entry.event.kind === "exposure" && exposureDedupeKey(entry.event) === key)) {
      this.exposureKeys.delete(key)
    }
  }

  private rememberDeliveredExposure(event: FeatureEvent): void {
    if (event.kind !== "exposure") return
    const key = exposureDedupeKey(event)
    if (!this.deliveredExposureKeys.includes(key)) this.deliveredExposureKeys.push(key)
    while (this.deliveredExposureKeys.length > this.maxExposureKeys) {
      const removed = this.deliveredExposureKeys.shift()
      if (removed && !this.entries.some((entry) =>
        entry.event.kind === "exposure" && exposureDedupeKey(entry.event) === removed)) {
        this.exposureKeys.delete(removed)
      }
    }
  }

  private async enqueue(input: FeatureEvent): Promise<TelemetryEnqueueResult> {
    await this.initialize()
    let event: FeatureEvent
    try {
      event = parseFeatureEvent(input, {
        allowedDimensions: this.options?.allowedAttributes,
        ...(this.options?.maxEventPayloadBytes !== undefined
          ? { maxPayloadBytes: this.options.maxEventPayloadBytes }
          : {}),
      })
    } catch (error) {
      this.diagnostic("telemetry_invalid", "Telemetry event failed canonical validation", error)
      return { status: "dropped", reason: "invalid_event", queueSize: this.entries.length }
    }
    return this.runExclusive(async () => {
      if (this.closing || this.closed) {
        return { status: "dropped", reason: "closed", queueSize: this.entries.length }
      }
      if (this.entries.some((entry) => entry.event.id === event.id)) {
        return { status: "duplicate", queueSize: this.entries.length }
      }
      if (event.kind === "exposure") {
        const key = exposureDedupeKey(event)
        if (this.exposureKeys.has(key)) return { status: "duplicate", queueSize: this.entries.length }
        this.exposureKeys.add(key)
      }
      const callbackDelivered = this.invokeEvent(event)
      if (!this.transport) {
        return callbackDelivered
          ? { status: "callback_only", queueSize: 0 }
          : { status: "disabled", queueSize: 0 }
      }

      if (this.entries.length >= this.maxQueueSize) {
        if (this.options?.backpressure === "drop-newest") {
          this.removeExposureKeyIfUndelivered(event)
          this.diagnostic("telemetry_event_dropped", "Telemetry queue is full; newest event was dropped")
          return { status: "dropped", reason: "queue_overflow", queueSize: this.entries.length }
        }
        const dropped = this.entries.shift()
        if (dropped) this.removeExposureKeyIfUndelivered(dropped.event)
        this.diagnostic("telemetry_event_dropped", "Telemetry queue is full; oldest event was dropped")
      }
      this.entries.push({ event, attempts: 0, readyAt: this.runtime.now() })
      await this.persist()
      if (this.entries.length >= this.batchSize) void this.flush()
      else this.schedule()
      return { status: "queued", queueSize: this.entries.length }
    })
  }

  recordEvaluation(evaluation: EvaluationEvent, exposed: boolean): void {
    if (!this.options) return
    void (async () => {
      try {
        const subject = await this.subject(evaluation.context, evaluation.details.source)
        const event = createEvaluationEvent({
          id: this.eventId(exposed ? "exp" : "dec"),
          kind: exposed ? "exposure" : "decision",
          details: evaluation.details,
          sdk: SDK,
          subject,
        })
        const result = await this.enqueue(event)
        if (
          event.kind === "exposure" &&
          result.status !== "dropped" &&
          result.status !== "disabled"
        ) {
          this.latestExposure.set(`${subject.id}:${event.flagKey}`, event)
        }
      } catch (error) {
        this.diagnostic("telemetry_subject_failed", "Could not create a private exposure event", error)
      }
    })()
  }

  recordExposure(exposure: ExposureEvent): void {
    this.recordEvaluation(exposure, true)
  }

  async track(
    flagKey: string,
    metricKey: string,
    value: number,
    options: TrackOptions = {},
  ): Promise<SuperflagTrackResult> {
    if (!this.options) return { status: "disabled", queueSize: 0 }
    const config = this.runtime.getConfig()
    if (!config) return { status: "dropped", reason: "invalid_outcome", queueSize: this.entries.length }
    const context = this.runtime.getContext()
    if (!context.targetingKey) {
      return { status: "dropped", reason: "missing_identity", queueSize: this.entries.length }
    }
    try {
      const subject = await this.subject(context, config.source)
      const exposure = this.latestExposure.get(`${subject.id}:${flagKey}`)
      if (!exposure) {
        return { status: "dropped", reason: "missing_exposure", queueSize: this.entries.length }
      }
      const event = createNumericOutcomeEvent({
        id: this.eventId("out"),
        source: config.source,
        flagKey,
        variation: exposure?.variation ?? "unknown",
        configVersion: exposure?.configVersion ?? config.configVersion,
        reason: exposure?.reason ?? "DEFAULT",
        timestamp: new Date(this.runtime.now()).toISOString(),
        sdk: SDK,
        subject,
        exposureId: exposure.id,
        metric: { key: metricKey, revision: options.revision ?? 1 },
        value,
        ...(options.attributes ? { attributes: options.attributes } : {}),
        ...(this.options.allowedAttributes
          ? { allowedAttributes: this.options.allowedAttributes }
          : {}),
      })
      return await this.enqueue(event)
    } catch (error) {
      this.diagnostic("telemetry_invalid", "Outcome event was rejected before enqueue", error)
      return { status: "dropped", reason: "invalid_outcome", queueSize: this.entries.length }
    }
  }

  private retry(entry: PersistedEntry, result: TelemetryFlushResult, retryAfterMs?: number): void {
    entry.attempts += 1
    if (entry.attempts >= this.maxAttempts) {
      result.permanent += 1
      this.removeExposureKeyIfUndelivered(entry.event)
      this.diagnostic("telemetry_event_dropped", "Telemetry event exhausted its retry budget")
      return
    }
    const exponential = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (entry.attempts - 1))
    const jitter = exponential * this.retryJitterRatio * (Math.random() * 2 - 1)
    const jittered = Math.max(0, Math.round(exponential + jitter))
    const delay = Math.max(
      jittered,
      typeof retryAfterMs === "number" && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? Math.min(retryAfterMs, this.retryMaxMs)
        : 0,
    )
    entry.readyAt = this.runtime.now() + delay
    this.entries.push(entry)
    result.retryScheduled += 1
    this.diagnostic("telemetry_retry_scheduled", `Telemetry retry scheduled in ${delay}ms`)
  }

  private async deliverBatch(force: boolean, timeoutMs?: number): Promise<TelemetryFlushResult> {
    const result = emptyFlush(this.entries.length)
    if (!this.transport) return result
    const now = this.runtime.now()
    const batch: PersistedEntry[] = []
    for (let index = 0; index < this.entries.length && batch.length < this.batchSize;) {
      const entry = this.entries[index]
      if (force || entry.readyAt <= now) {
        batch.push(entry)
        this.entries.splice(index, 1)
      } else index += 1
    }
    if (batch.length === 0) return result
    result.sent = batch.length

    try {
      const controller = requestController()
      const delivery = this.transport.send(
        batch.map((entry) => entry.event),
        { signal: controller.signal },
      )
      void delivery.catch(() => {})
      let timeout: ReturnType<typeof setTimeout> | undefined
      const response = timeoutMs === undefined
        ? await delivery
        : await Promise.race([
            delivery,
            new Promise<never>((_resolve, reject) => {
              timeout = setTimeout(() => {
                controller.abort()
                reject(new Error("Telemetry delivery timed out"))
              }, Math.max(0, timeoutMs))
            }),
          ]).finally(() => {
            if (timeout !== undefined) clearTimeout(timeout)
          })
      if (
        response.items.length !== batch.length ||
        response.items.some((item, index) => item.eventId !== batch[index]?.event.id)
      ) {
        throw new TypeError("Telemetry transport returned an unordered or incomplete result set")
      }
      const byId = new Map(response.items.map((item) => [item.eventId, item]))
      for (const entry of batch) {
        const item = byId.get(entry.event.id)
        if (!item || item.status === "retryable_error") {
          this.retry(entry, result, item?.retryAfterMs)
        } else if (item.status === "accepted") {
          result.accepted += 1
          this.rememberDeliveredExposure(entry.event)
        } else if (item.status === "duplicate") {
          result.duplicates += 1
          this.rememberDeliveredExposure(entry.event)
        } else {
          result.permanent += 1
          this.removeExposureKeyIfUndelivered(entry.event)
        }
      }
    } catch (error) {
      this.diagnostic("telemetry_transport_failed", "Telemetry transport failed", error)
      for (const entry of batch) this.retry(entry, result)
    }
    await this.persist()
    result.queueSize = this.entries.length
    return result
  }

  async flush(): Promise<TelemetryFlushResult> {
    await this.initialize()
    return this.runExclusive(async () => {
      if (this.closed || !this.transport) return emptyFlush(this.entries.length)
      const result = emptyFlush(this.entries.length)
      while (this.entries.some((entry) => entry.readyAt <= this.runtime.now())) {
        const batch = await this.deliverBatch(false)
        mergeResult(result, batch)
        if (batch.sent === 0) break
      }
      this.schedule()
      return result
    })
  }

  async shutdown(
    options: { flush?: boolean; timeoutMs?: number } = {},
  ): Promise<TelemetryShutdownResult> {
    await this.initialize()
    this.closing = true
    if (this.timer !== null) clearTimeout(this.timer)
    this.timer = null
    const timeoutMs = boundedDelay(options.timeoutMs, this.shutdownTimeoutMs)
    const deadline = Date.now() + timeoutMs
    const result: TelemetryShutdownResult = { ...emptyFlush(this.entries.length), timedOut: false, dropped: 0 }

    await this.runExclusive(async () => {
      if (options.flush !== false && this.transport) {
        while (this.entries.length > 0 && Date.now() <= deadline) {
          const batch = await this.deliverBatch(true, Math.max(0, deadline - Date.now()))
          mergeResult(result, batch)
          if (batch.sent === 0) break
        }
      }
      if (this.entries.length > 0) {
        result.timedOut = options.flush !== false && Date.now() >= deadline
        result.dropped = this.entries.length
        await this.persist()
      }
      result.queueSize = this.entries.length
      this.closed = true
    })
    return result
  }
}

export function createReactNativeTelemetry(options: TelemetryRuntimeOptions): ReactNativeTelemetry {
  return new ReactNativeTelemetry(options)
}
