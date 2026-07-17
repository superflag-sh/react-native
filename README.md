# @superflag-sh/react-native

React Native and Expo adapter for Superflag. Evaluation, targeting, types, and evaluation details come from `@superflag-sh/core`; this package owns native storage, lifecycle refresh, and React hooks.

## Installation

```bash
npm install @superflag-sh/react-native @react-native-async-storage/async-storage
```

`@superflag-sh/core` is installed as a regular published dependency. The package does not publish local `file:` or `link:` references.

## Quick start

```tsx
import { SuperflagProvider, useFlag } from "@superflag-sh/react-native"

export default function App() {
  return (
    <SuperflagProvider
      clientKey="pub_prod_xxx"
      targetingKey="user-123"
      attributes={{ plan: "pro", appVersion: "2.4.0" }}
    >
      <Home />
    </SuperflagProvider>
  )
}

function Home() {
  const checkout = useFlag("checkout", false)
  return <Text>{checkout ? "New checkout" : "Classic checkout"}</Text>
}
```

`userId` remains supported as a deprecated alias for `targetingKey`. If neither is supplied, evaluation fails closed to the hook's typed fallback with an `INVALID_CONTEXT` diagnostic. Superflag never groups unidentified devices into a shared rollout bucket.

## Provider

```tsx
<SuperflagProvider
  clientKey="pub_prod_xxx"
  configUrl="https://superflag.sh/api/v1/public-config"
  ttlSeconds={60}
  maxStaleAgeSeconds={86_400}
  targetingKey="user-123"
  attributes={{ plan: "pro" }}
  storage={customStorage}
  network={networkAdapter}
  retry={{ maxRetries: 2, baseDelayMs: 250, maxDelayMs: 2_000 }}
  onReady={(state) => console.log(state.configVersion)}
  onDiagnostic={(event) => reportDiagnostic(event)}
  onEvaluation={(event) => recordEvaluation(event.details)}
  onExposure={(event) => recordExposure(event)}
>
  {children}
</SuperflagProvider>
```

The client key may instead come from `EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY`.

The guarded default AppState integration refreshes after `background` or `inactive` transitions to `active`. Pass `appState={null}` to disable it, or inject an `AppStateAdapter` for tests/custom runtimes.

Reconnect refresh is opt-in through a small adapter, avoiding a hard native dependency:

```tsx
import NetInfo from "@react-native-community/netinfo"
import type { NetworkAdapter } from "@superflag-sh/react-native"

const network: NetworkAdapter = {
  subscribe(listener) {
    const subscription = NetInfo.addEventListener((state) =>
      listener(state.isConnected === true),
    )
    return subscription
  },
}

<SuperflagProvider network={network}>{children}</SuperflagProvider>
```

Every user callback is isolated. A thrown or rejected callback never escapes into React Native startup; callback failures are reported to `onDiagnostic` when possible.

## Hooks

### `useFlag(key, fallback?, options?)`

The compatibility value hook:

```tsx
const enabled = useFlag("checkout", false)
const limit = useFlag("upload-limit", 10)
const theme = useFlag("theme", { density: "compact" })
```

### `useFlagDetails(key, fallback, options?)`

Returns the core `EvaluationDetails`, including value, variation, reason, rule, segments, prerequisites, source identity, config version, and errors.

```tsx
const details = useFlagDetails("checkout", false)
console.log(details?.value, details?.reason, details?.variation)
```

`useEvaluationDetails` is an alias. `useTypedFlag<Config, Key>()` preserves key/value relationships from a generated or literal core `FlagConfig` type.

For explicit value types, the React-parity hooks are also available:

```tsx
const checkout = useBooleanFlag("checkout", false)
const title = useStringFlag("checkout-title", "Checkout")
const limit = useNumberFlag("upload-limit", 10)
const theme = useObjectFlag("theme", { density: "compact" })
```

Each has a matching details hook: `useBooleanFlagDetails`, `useStringFlagDetails`,
`useNumberFlagDetails`, and `useObjectFlagDetails`.

Bind a generated value map or literal core `FlagConfig` once for key/value-safe access:

```tsx
import { createTypedHooks } from "@superflag-sh/react-native"
import type { SuperflagFlagValues } from "./superflag.generated"

const flags = createTypedHooks<SuperflagFlagValues>()

function Checkout() {
  const enabled = flags.useFlag("checkout", false)
  const client = flags.useClient()

  return <Button onPress={() => client.getFlag("checkout", false)} title={String(enabled)} />
}
```

`useSuperflagClient()` is the unbound imperative equivalent. It provides `getFlag`,
`getFlagDetails`, `track`, `flush`, `shutdown`, and `refresh` from the current provider context for event handlers and callbacks.

## Feature telemetry

Telemetry is opt-in and never participates in evaluation. Use hosted delivery or inject a transport:

```tsx
<SuperflagProvider
  clientKey="pub_prod_xxx"
  targetingKey="user-123"
  telemetry={{
    hosted: true,
    allowedAttributes: ["surface"],
    maxQueueSize: 1_000,
  }}
>
  {children}
</SuperflagProvider>
```

Value hooks and imperative `getFlag` calls create deduplicated canonical exposures. Details hooks create decision events, while provider initialization and `useFlags()` create neither. Existing `onEvaluation` and `onExposure` callbacks remain available independently of hosted telemetry.

The mobile queue is bounded and persisted through the configured storage seam. It retries after offline delivery failures, flushes on background, foreground, and reconnect transitions, and retains only validated canonical envelopes. Raw targeting keys, targeting attributes, and client keys never enter the queue. The default subject pseudonym is installation-scoped; provide `telemetry.pseudonymize` when an application needs a consented account-level identity across devices.

Record a numeric outcome against the current subject's latest real exposure:

```tsx
const client = useSuperflagClient<{ checkout: boolean }>()

await client.track("checkout", "purchase", 42, {
  revision: 2,
  attributes: { surface: "cart" },
})

await client.flush()
```

Outcome attributes are default-closed and must appear in `allowedAttributes`. `track` returns a structured result for disabled telemetry, missing identity/exposure, validation failure, queueing, or backpressure. `shutdown({ timeoutMs })` performs a bounded best-effort drain.

For non-React integrations and cold-start tests, `createSuperflagClient` exposes the same pure-JavaScript client and lifecycle adapters. `createHostedTelemetryTransport` exposes the first-party batch envelope for custom composition without importing a native module.

### `useFlags()`

```tsx
const {
  ready,
  loading,
  status,
  source,
  error,
  fetchedAt,
  configVersion,
  age,
  stale,
  refresh,
} = useFlags()
```

- `status` is `idle`, `loading`, `ready`, `refreshing`, `error`, or `rate-limited`.
- `source` is `none`, `cache`, or `network`. `none` means no validated config is being served; this intentionally differs from the web SDK's `default` name.
- `fetchedAt` is an epoch timestamp in milliseconds; `age` is seconds.
- `stale` becomes true after `ttlSeconds`.
- `refresh()` is deduplicated with any refresh already in flight.

Production UI should gate on `ready` and may additionally reject `stale` data. Do not infer readiness from `source` or translate RN source/status names into the web vocabulary.

## Cache and refresh behavior

Initialization is cache-first:

1. A fresh cache is returned immediately and revalidated when its TTL expires.
2. A stale cache within `maxStaleAgeSeconds` is returned immediately while revalidation runs.
3. An older cache is rejected and removed.
4. Offline or retryable server failures retain an allowed cached config.
5. ETags are sent only for a validated cache bound to the active endpoint, client-key fingerprint, app, and environment.
6. A same-source response with a lower config version is rejected so delayed cache reads or network responses cannot replace the latest known config.

Refreshes use bounded exponential retry. Manual, TTL, foreground, and reconnect triggers share one in-flight request. Destroying the provider aborts guarded fetches and removes AppState/network listeners plus TTL, max-stale, and retry timers.

## Storage

AsyncStorage is lazy-loaded and every operation is contained for production Expo/Hermes startup safety. A custom adapter implements:

```ts
interface StorageAdapter {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}
```

Cache entries remain schema-versioned and identity-bound. Raw client keys are never persisted. Portable cache identity comes from the shared `@superflag-sh/core/cache` module; this adapter owns AsyncStorage persistence and mobile lifecycle policy.

## Package targets

The package ships ES2019 native ESM (`react-native` and `import`), CommonJS (`require`), and one declaration tree. Release checks pack the SDK and exact installed core into clean consumers, validate ESM/CommonJS/NodeNext imports and telemetry behavior, bundle through Expo Metro, and compile the production bundle to Hermes bytecode. `bun run smoke:registry` separately proves exact npm resolution after publication.

## License

MIT
