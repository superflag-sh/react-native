import { useState, useEffect } from "react"
import type { SuperflagProviderProps, SuperflagState } from "./types"
import { SuperflagContext, initialState } from "./context"
import { createClient } from "./client"

/**
 * Provides Superflag context to the component tree.
 *
 * @example
 * ```tsx
 * import { SuperflagProvider } from '@superflag-sh/react-native'
 *
 * export default function App() {
 *   return (
 *     <SuperflagProvider clientKey="pub_prod_abc123">
 *       <MyApp />
 *     </SuperflagProvider>
 *   )
 * }
 * ```
 */
export function SuperflagProvider({
  clientKey: propKey,
  ttlSeconds = 60,
  children,
}: SuperflagProviderProps): JSX.Element {
  // Try to get key from props or environment
  const clientKey = propKey ?? (typeof process !== "undefined" ? process.env.EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY : undefined)

  const [state, setState] = useState<SuperflagState>(() => {
    // If no client key, start in error state instead of throwing
    if (!clientKey) {
      return {
        ...initialState,
        status: "error",
        error: "Missing clientKey prop or EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY",
      }
    }
    return initialState
  })

  useEffect(() => {
    if (!clientKey) return

    try {
      const client = createClient({
        clientKey,
        ttlSeconds,
        onStateChange: setState,
      })

      client.initialize().catch(() => {
        // Initialization errors are handled inside initialize()
      })

      return () => {
        client.destroy()
      }
    } catch {
      // Client creation failed
      setState({
        ...initialState,
        status: "error",
        error: "Failed to create client",
      })
    }
  }, [clientKey, ttlSeconds])

  return (
    <SuperflagContext.Provider value={state}>
      {children}
    </SuperflagContext.Provider>
  )
}
