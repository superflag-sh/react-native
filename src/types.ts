/**
 * Flag value types supported by Superflag
 */
export type FlagType = "bool" | "string" | "number" | "json"

/**
 * A single flag value as returned from the server
 */
export interface FlagValue {
  type: FlagType
  value: boolean | string | number | object
  rollout?: {
    percentage: number
  }
  variants?: Array<{
    value: boolean | string | number | object
    weight: number
    name?: string
  }>
}

/**
 * The flags record type
 */
export type Flags = Record<string, FlagValue>

/**
 * SDK status states
 */
export type SuperflagStatus = "idle" | "loading" | "ready" | "error" | "rate-limited"

/**
 * Internal state managed by the SDK
 */
export interface SuperflagState {
  flags: Flags
  status: SuperflagStatus
  version: number | null
  etag: string | null
  lastFetchedAt: number | null
  error: string | null
  userId?: string
}

/**
 * Props for the SuperflagProvider component
 */
export interface SuperflagProviderProps {
  /**
   * Client key for authentication.
   * Falls back to process.env.EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY if not provided.
   */
  clientKey?: string
  /**
   * Time-to-live in seconds before refetching config.
   * @default 60
   */
  ttlSeconds?: number
  /**
   * User ID for rollout/variant bucketing.
   * Required for flags with rollout percentages or A/B test variants.
   */
  userId?: string
  /**
   * React children
   */
  children: React.ReactNode
}

/**
 * Configuration response from the server
 */
export interface ConfigResponse {
  appId: string
  env: string
  version: number
  doc: {
    flags: Flags
    overrides: Record<string, unknown>
    rules: Record<string, unknown>
  }
  ttlSeconds: number
}

/**
 * Cached config structure stored in storage
 */
export interface CachedConfig {
  flags: Flags
  version: number
  etag: string
  fetchedAt: number
}

/**
 * Client configuration options
 */
export interface ClientConfig {
  clientKey: string
  ttlSeconds: number
  onStateChange: (state: SuperflagState) => void
  userId?: string
}

/**
 * Superflag client interface
 */
export interface SuperflagClient {
  initialize: () => Promise<void>
  destroy: () => void
  refetch: () => Promise<void>
}
