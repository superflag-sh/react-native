import type {
  EvaluationContext,
  EvaluationDetails,
  EvaluationOptions,
  FlagConfig,
  FlagKey,
  FlagValue,
  FlagValueFor,
  JsonValue,
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
