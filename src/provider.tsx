import { useState, useEffect } from "react"
import type { SuperflagProviderProps, SuperflagState } from "./types"
import { SuperflagContext, initialState } from "./context"
import { createClient } from "./client"


/**
 * Provides Superflag context to the component tree.
 */
export function SuperflagProvider({
  clientKey: propKey,
  ttlSeconds = 60,
  userId,
  children,
}: SuperflagProviderProps): JSX.Element {
  const [state, setState] = useState<SuperflagState>(initialState)

  useEffect(() => {
    const clientKey = propKey ?? (typeof process !== "undefined" ? process.env.EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY : undefined)

    if (!clientKey) {
      setState({
        ...initialState,
        status: "error",
        error: "Missing clientKey",
      })
      return
    }

    let destroyed = false

    const init = async () => {
      try {
        const client = createClient({
          clientKey,
          ttlSeconds,
          userId,
          onStateChange: (s) => {
            if (!destroyed) setState(s)
          },
        })

        await client.initialize()

        return () => {
          destroyed = true
          client.destroy()
        }
      } catch (err) {
        if (!destroyed) {
          setState({
            ...initialState,
            status: "error",
            error: err instanceof Error ? err.message : "Init failed",
          })
        }
      }
    }

    let cleanup: (() => void) | undefined

    init().then((c) => {
      cleanup = c
    })

    return () => {
      destroyed = true
      cleanup?.()
    }
  }, [propKey, ttlSeconds, userId])

  return (
    <SuperflagContext.Provider value={state}>
      {children}
    </SuperflagContext.Provider>
  )
}
