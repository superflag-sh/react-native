import type {
  EvaluationContext,
  EvaluationDetails,
  EvaluationOptions,
  FlagConfig,
  FlagKey,
  FlagValue,
  FlagValueFor,
  JsonValue,
  FeatureEvent,
  FeatureEventDimension,
  PseudonymousSubject,
  TelemetryBackpressurePolicy,
  TelemetryDiagnostic,
  TelemetryEnqueueResult,
  TelemetryFlushResult,
  TelemetryShutdownResult,
  TelemetryTransport,
} from "@superflag-sh/core"

export type {
  EvaluationContext,
  EvaluationDetails,
  EvaluationOptions,
  FlagConfig,
  FlagKey,
  FlagValue,
  FlagValueFor,
  JsonValue,
  FeatureEvent,
  FeatureEventDimension,
  PseudonymousSubject,
  TelemetryBackpressurePolicy,
  TelemetryDiagnostic,
  TelemetryEnqueueResult,
  TelemetryFlushResult,
  TelemetryShutdownResult,
  TelemetryTransport,
}

export type SuperflagTrackResult =
  | TelemetryEnqueueResult
  | {
      status: "dropped"
      reason: "invalid_outcome" | "missing_exposure" | "missing_identity"
      queueSize: number
    }

/** Legacy value-only flag shape accepted from older public-config responses. */
export interface LegacyFlagValue {
  type: "bool" | "string" | "number" | "json"
  value: Exclude<JsonValue, null>
  rollout?: { percentage: number }
  variants?: Array<{
    value: Exclude<JsonValue, null>
    weight: number
    name?: string
  }>
  clientEnabled?: boolean
}

/** @deprecated Use FlagConfig["flags"] from @superflag-sh/core. */
export type Flags = FlagConfig["flags"]

export type SuperflagStatus =
  | "idle"
  | "loading"
  | "ready"
  | "refreshing"
  | "error"
  | "rate-limited"

export type SuperflagSource = "none" | "cache" | "network"

export type RefreshReason = "initialize" | "manual" | "ttl" | "foreground" | "reconnect"

export interface SuperflagState {
  config: FlagConfig | null
  /** Compatibility view of config.flags. */
  flags: Flags
  status: SuperflagStatus
  source: SuperflagSource
  error: string | null
  fetchedAt: number | null
  configVersion: number | null
  /** Cache/config age in seconds at the latest lifecycle transition. */
  age: number | null
  stale: boolean
  refresh: () => Promise<void>
  evaluationContext: EvaluationContext
  appId: string | null
  environment: string | null
  /** @deprecated Use configVersion. */
  version: number | null
  etag: string | null
  /** @deprecated Use evaluationContext.targetingKey. */
  userId?: string
}

export interface RetryOptions {
  /** Number of retries after the first request. @default 2 */
  maxRetries: number
  /** Initial exponential-backoff delay. @default 250 */
  baseDelayMs: number
  /** Upper bound for a retry delay. @default 2000 */
  maxDelayMs: number
}

export interface AppStateSubscription {
  remove(): void
}

export interface AppStateAdapter {
  currentState?: string | null
  addEventListener(
    event: "change",
    listener: (state: string) => void,
  ): AppStateSubscription | (() => void)
}

export interface NetworkAdapter {
  subscribe(listener: (connected: boolean) => void): AppStateSubscription | (() => void)
}

export type DiagnosticCode =
  | "cache_read_failed"
  | "cache_write_failed"
  | "cache_invalid"
  | "config_invalid"
  | "fetch_failed"
  | "retry_scheduled"
  | "refresh_triggered"
  | "callback_failed"
  | "native_integration_unavailable"
  | "telemetry_callback_failed"
  | "telemetry_event_dropped"
  | "telemetry_invalid"
  | "telemetry_retry_scheduled"
  | "telemetry_storage_failed"
  | "telemetry_subject_failed"
  | "telemetry_transport_failed"

export interface DiagnosticEvent {
  code: DiagnosticCode
  message: string
  timestamp: number
  error?: unknown
  reason?: RefreshReason
  attempt?: number
}

export interface EvaluationEvent<T extends FlagValue = FlagValue> {
  key: string
  context: EvaluationContext
  details: EvaluationDetails<T>
}

export interface ExposureEvent<T extends FlagValue = FlagValue> extends EvaluationEvent<T> {
  timestamp: number
}

export interface SuperflagTelemetryIdentityInput {
  targetingKey: string
  namespace: string
  appId: string
  environment: string
  state: PseudonymousSubject["state"]
}

export interface SuperflagTelemetryQueueOptions {
  maxQueueSize?: number
  batchSize?: number
  flushIntervalMs?: number
  backpressure?: TelemetryBackpressurePolicy
  maxAttempts?: number
  retryBaseMs?: number
  retryMaxMs?: number
  retryJitterRatio?: number
  maxExposureDedupeEntries?: number
  maxEventPayloadBytes?: number
  shutdownTimeoutMs?: number
}

export interface SuperflagTelemetryOptions extends SuperflagTelemetryQueueOptions {
  /** Opt in to Superflag-hosted ingestion. Ignored when transport is supplied. */
  hosted?: boolean | SuperflagHostedTelemetryOptions
  /** Custom delivery transport. Providing one opts telemetry in. */
  transport?: TelemetryTransport
  /** Override the config cache storage for the telemetry queue. */
  storage?: StorageAdapter
  /** Optional application-provided pseudonymizer. Raw context is never persisted or sent. */
  pseudonymize?: (
    input: SuperflagTelemetryIdentityInput,
  ) => PseudonymousSubject | Promise<PseudonymousSubject>
  subjectState?: PseudonymousSubject["state"]
  subjectRevision?: number
  /** Canonical event callback. Existing onEvaluation/onExposure callbacks remain supported. */
  onEvent?: (event: FeatureEvent) => void
  onDiagnostic?: (diagnostic: TelemetryDiagnostic) => void
  /** Outcome attributes must be named here before they may enter an event. */
  allowedAttributes?: readonly string[]
}

export interface SuperflagHostedTelemetryOptions {
  /** Control-plane base URL. `/api/v1/events/batch` is appended safely. */
  baseUrl?: string
  headers?: Readonly<Record<string, string>>
  fetch?: HostedTelemetryFetch
}

export interface HostedTelemetryResponse {
  ok: boolean
  status: number
  headers: { get(name: string): string | null }
  json(): Promise<unknown>
}

export type HostedTelemetryFetch = (
  input: string,
  init: {
    method: "POST"
    headers: Readonly<Record<string, string>>
    body: string
    signal: unknown
  },
) => Promise<HostedTelemetryResponse>

export interface SuperflagTrackOptions {
  /** Metric definition revision. @default 1 */
  revision?: number
  attributes?: Readonly<Record<string, FeatureEventDimension>>
}

/** @deprecated Use SuperflagTrackOptions. */
export type TrackOptions = SuperflagTrackOptions

export interface SuperflagProviderProps {
  clientKey?: string
  configUrl?: string
  /** Freshness TTL. @default 60 */
  ttlSeconds?: number
  /** Oldest cached config that may be served. @default 86400 */
  maxStaleAgeSeconds?: number
  storage?: StorageAdapter
  targetingKey?: string
  attributes?: EvaluationContext["attributes"]
  context?: EvaluationContext
  /** @deprecated Use targetingKey. */
  userId?: string
  retry?: Partial<RetryOptions>
  /** Inject for tests/custom hosts. Pass null to disable the guarded React Native integration. */
  appState?: AppStateAdapter | null
  /** Optional connectivity source, for example a guarded NetInfo adapter. */
  network?: NetworkAdapter | null
  telemetry?: SuperflagTelemetryOptions
  onReady?: (state: SuperflagState) => void | Promise<void>
  onDiagnostic?: (event: DiagnosticEvent) => void | Promise<void>
  onEvaluation?: (event: EvaluationEvent) => void | Promise<void>
  onExposure?: (event: ExposureEvent) => void | Promise<void>
  children: React.ReactNode
}

export interface LegacyConfigDocument {
  flags: Record<string, LegacyFlagValue>
  overrides?: Record<string, unknown>
  rules?: Record<string, unknown>
}

export interface ConfigResponse {
  appId: string
  env: string
  version: number
  doc: FlagConfig | LegacyConfigDocument
  ttlSeconds?: number
}

export interface CachedConfig {
  schemaVersion: 3
  endpointFingerprint: string
  clientKeyFingerprint: string
  appId: string
  environment: string
  /** Compatibility projection retained by the shared identity-bound cache contract. */
  flags: Flags
  /** Compatibility alias for config.configVersion. */
  version: number
  config: FlagConfig
  etag: string
  fetchedAt: number
}

export interface ClientConfig {
  clientKey: string
  configUrl?: string
  ttlSeconds: number
  maxStaleAgeSeconds?: number
  onStateChange: (state: SuperflagState) => void
  storage?: StorageAdapter
  evaluationContext: EvaluationContext
  userId?: string
  retry?: Partial<RetryOptions>
  appState?: AppStateAdapter | null
  network?: NetworkAdapter | null
  telemetry?: SuperflagTelemetryOptions
  onReady?: SuperflagProviderProps["onReady"]
  onDiagnostic?: SuperflagProviderProps["onDiagnostic"]
  /** Test-only clock injection; production callers should omit it. */
  now?: () => number
}

export interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export interface SuperflagClient {
  initialize(): Promise<void>
  destroy(): void
  refresh(reason?: RefreshReason): Promise<void>
  /** @deprecated Use refresh. */
  refetch(): Promise<void>
  setContext(context: EvaluationContext, userId?: string): void
  recordEvaluation(event: EvaluationEvent, exposed: boolean): void
  track(
    flagKey: string,
    metricKey: string,
    value: number,
    options?: SuperflagTrackOptions,
  ): Promise<SuperflagTrackResult>
  flush(): Promise<TelemetryFlushResult>
  shutdown(options?: {
    flush?: boolean
    timeoutMs?: number
  }): Promise<TelemetryShutdownResult>
  getState(): SuperflagState
}

export type ObjectFlagValue = Exclude<JsonValue, string | number | boolean | null>

/** Accept either a generated value map or a literal core FlagConfig type. */
export type TypedFlagValues<T> = T extends FlagConfig
  ? { [K in FlagKey<T>]: FlagValueFor<T, K> }
  : T

export type TypedEvaluationDetails<T> = T extends FlagValue ? EvaluationDetails<T> : never

export interface TypedSuperflagClient<T extends object> {
  getFlag<K extends Extract<keyof TypedFlagValues<T>, string>>(
    name: K,
    fallback: TypedFlagValues<T>[K],
  ): TypedFlagValues<T>[K]
  getFlagDetails<K extends Extract<keyof TypedFlagValues<T>, string>>(
    name: K,
    fallback: TypedFlagValues<T>[K],
  ): TypedEvaluationDetails<TypedFlagValues<T>[K]> | undefined
  track<K extends Extract<keyof TypedFlagValues<T>, string>>(
    flagKey: K,
    metricKey: string,
    value: number,
    options?: SuperflagTrackOptions,
  ): Promise<SuperflagTrackResult>
  flush(): Promise<TelemetryFlushResult>
  shutdown(options?: {
    flush?: boolean
    timeoutMs?: number
  }): Promise<TelemetryShutdownResult>
  refresh(): Promise<void>
}

export interface TypedSuperflagHooks<T extends object> {
  useFlag<K extends Extract<keyof TypedFlagValues<T>, string>>(
    name: K,
    fallback: TypedFlagValues<T>[K],
  ): TypedFlagValues<T>[K]
  useFlagDetails<K extends Extract<keyof TypedFlagValues<T>, string>>(
    name: K,
    fallback: TypedFlagValues<T>[K],
  ): TypedEvaluationDetails<TypedFlagValues<T>[K]> | undefined
  useClient(): TypedSuperflagClient<T>
}
