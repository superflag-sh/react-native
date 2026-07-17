# Superflag React Native SDK

This repository is the React Native/Expo adapter over `@superflag-sh/core`. It owns
transport, AsyncStorage persistence, AppState lifecycle, hooks, diagnostics, and
opt-in telemetry queues—not evaluation semantics. In the full workspace, read
`../AGENTS.md`, `../docs/react-native-library-rules.md`,
`../docs/react-native-sdk.md`, and `../docs/package-compatibility.md` first.

## Adapter and platform boundaries

- Reuse core evaluation, privacy, experiment, and canonical event behavior. Keep the
  package JavaScript-only unless a native addition is explicitly designed and tested.
- Keep import-time code safe without DOM globals. Validate Expo, Metro, Hermes,
  CommonJS/ESM, and declaration behavior from the packed artifact.
- Bind persisted caches to schema, endpoint, non-reversible key fingerprint, app,
  and environment. Never persist raw credentials or silently replace identity binding.
- Preserve AppState refresh, stale/fresh/error diagnostics, and age values in seconds.
- Keep the AsyncStorage telemetry queue bounded, opt-in, crash-safe, and unable to
  block evaluation. Design persisted-queue migration explicitly for event-schema
  changes; widen hosted ingestion before new clients emit the shape.
- Keep `@react-native-async-storage/async-storage` and React Native runtime contracts
  as peers; do not bundle app-owned native dependencies.

## Verification and release

Run focused tests first, then:

```bash
bun run release:check
```

The release gate includes cache drift, packed-package, Expo/Metro, and Hermes smoke.
Use `bun run smoke:registry` only after authorized publication of an exact version and
prove no local fallback. Publish the required core version first. Do not commit, push,
publish, or tag without explicit approval.
