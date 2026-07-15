import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { createClient } from "./client.js"
import { SuperflagContext, initialState } from "./context.js"
import { resolveEvaluationContext } from "./evaluation.js"
import type {
  DiagnosticEvent,
  EvaluationEvent,
  ExposureEvent,
  SuperflagClient,
  SuperflagProviderProps,
  SuperflagState,
} from "./types.js"

function invokeSafely<T>(
  callback: ((value: T) => void | Promise<void>) | undefined,
  value: T,
  onFailure: (error: unknown) => void,
): void {
  if (!callback) return
  try {
    Promise.resolve(callback(value)).catch(onFailure)
  } catch (error) {
    onFailure(error)
  }
}

export function SuperflagProvider({
  clientKey: propKey,
  configUrl,
  ttlSeconds = 60,
  maxStaleAgeSeconds = 86_400,
  storage,
  targetingKey,
  attributes,
  context,
  userId,
  retry,
  appState,
  network,
  telemetry,
  onReady,
  onDiagnostic,
  onEvaluation,
  onExposure,
  children,
}: SuperflagProviderProps): ReactElement {
  const evaluationContext = useMemo(
    () => resolveEvaluationContext({ context, targetingKey, attributes, userId }),
    [context, targetingKey, attributes, userId],
  )
  const [state, setState] = useState<SuperflagState>({
    ...initialState,
    evaluationContext,
    ...(userId ? { userId } : {}),
  })
  const clientRef = useRef<SuperflagClient | null>(null)
  const callbackRef = useRef({ onReady, onDiagnostic, onEvaluation, onExposure })
  callbackRef.current = { onReady, onDiagnostic, onEvaluation, onExposure }

  const emitDiagnostic = useCallback((event: DiagnosticEvent): void => {
    invokeSafely(callbackRef.current.onDiagnostic, event, () => {})
  }, [])

  const callbackFailure = useCallback((name: string, error: unknown): void => {
    emitDiagnostic({
      code: "callback_failed",
      message: `${name} callback failed`,
      timestamp: Date.now(),
      error,
    })
  }, [emitDiagnostic])

  const emitEvaluation = useCallback((event: EvaluationEvent, exposed: boolean): void => {
    clientRef.current?.recordEvaluation(event, exposed)
    invokeSafely(callbackRef.current.onEvaluation, event, (error) =>
      callbackFailure("onEvaluation", error),
    )
  }, [callbackFailure])

  const emitExposure = useCallback((event: ExposureEvent): void => {
    invokeSafely(callbackRef.current.onExposure, event, (error) =>
      callbackFailure("onExposure", error),
    )
  }, [callbackFailure])

  useEffect(() => {
    const clientKey =
      propKey ??
      (typeof process !== "undefined"
        ? process.env.EXPO_PUBLIC_SUPERFLAG_CLIENT_KEY
        : undefined)

    if (!clientKey) {
      setState((current) => ({
        ...initialState,
        evaluationContext: current.evaluationContext,
        ...(current.userId ? { userId: current.userId } : {}),
        status: "error",
        error: "Missing clientKey",
      }))
      return
    }

    const client = createClient({
      clientKey,
      configUrl,
      ttlSeconds,
      maxStaleAgeSeconds,
      storage,
      evaluationContext,
      userId,
      retry,
      appState,
      network,
      telemetry,
      onStateChange: setState,
      onReady: (readyState) =>
        invokeSafely(callbackRef.current.onReady, readyState, (error) =>
          callbackFailure("onReady", error),
        ),
      onDiagnostic: emitDiagnostic,
    })
    clientRef.current = client
    void client.initialize()

    return () => {
      clientRef.current = null
      client.destroy()
    }
  }, [propKey, configUrl, ttlSeconds, maxStaleAgeSeconds, storage, retry, appState, network, telemetry])

  useEffect(() => {
    clientRef.current?.setContext(evaluationContext, userId)
    setState((current) => ({
      ...current,
      evaluationContext,
      userId,
    }))
  }, [evaluationContext, userId])

  const value = useMemo(
    () => ({
      ...state,
      emitDiagnostic,
      emitEvaluation,
      emitExposure,
      track: (...args: Parameters<SuperflagClient["track"]>) =>
        clientRef.current?.track(...args) ?? Promise.resolve({ status: "disabled", queueSize: 0 }),
      flush: () => clientRef.current?.flush() ?? Promise.resolve({
        sent: 0,
        accepted: 0,
        duplicates: 0,
        permanent: 0,
        retryScheduled: 0,
        queueSize: 0,
      }),
      shutdown: (options?: Parameters<SuperflagClient["shutdown"]>[0]) =>
        clientRef.current?.shutdown(options) ?? Promise.resolve({
          sent: 0,
          accepted: 0,
          duplicates: 0,
          permanent: 0,
          retryScheduled: 0,
          queueSize: 0,
          timedOut: false,
          dropped: 0,
        }),
    }),
    [state, emitDiagnostic, emitEvaluation, emitExposure],
  )

  return <SuperflagContext.Provider value={value}>{children}</SuperflagContext.Provider>
}
