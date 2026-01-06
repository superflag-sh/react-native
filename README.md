# @superflag-sh/react-native

React Native SDK for [Superflag](https://superflag.sh) feature flags.

## Installation

```bash
npm install @superflag-sh/react-native @react-native-async-storage/async-storage
```

## Quick Start

```tsx
import { SuperflagProvider, useFlag } from '@superflag-sh/react-native'

export default function App() {
  return (
    <SuperflagProvider clientKey="pub_prod_xxx">
      <MyApp />
    </SuperflagProvider>
  )
}

function MyApp() {
  const darkMode = useFlag('dark-mode', false)

  return <Text>{darkMode ? 'Dark Mode' : 'Light Mode'}</Text>
}
```

## API

### `<SuperflagProvider>`

Wrap your app to provide flag context.

```tsx
<SuperflagProvider
  clientKey="pub_prod_xxx"  // Required (or set EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY)
  ttlSeconds={60}           // Optional, default 60
>
  {children}
</SuperflagProvider>
```

### `useFlag(name, fallback?)`

Get a single flag value.

```tsx
const enabled = useFlag('feature-enabled', false)
const limit = useFlag<number>('upload-limit', 10)
const config = useFlag<{ theme: string }>('ui-config')
```

### `useFlags()`

Get SDK status.

```tsx
const { ready, loading, status } = useFlags()

if (loading) return <ActivityIndicator />
if (status === 'error') return <ErrorView />
```

## Features

- Instant cached values on app launch
- Background refresh with ETag support
- Offline resilience (keeps serving cached values)
- TypeScript support

## Environment Variables

Instead of passing `clientKey` as a prop, you can set:

```
EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY=pub_prod_xxx
```

## License

MIT
