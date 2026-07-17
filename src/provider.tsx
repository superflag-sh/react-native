import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react"
import { stableJsonSignature } from "@superflag-sh/core"
import { createClient } from "./client.js"
import { SuperflagContext, initialState } from "./context.js"
import { createEvaluationReader, resolveEvaluationContext } from "./evaluation.js"
import type {
  DiagnosticEvent,
  EvaluationEvent,
  ExposureEvent,
  SuperflagClient,
  SuperflagProviderProps,
  SuperflagState,
  SuperflagTelemetryOptions,
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
  const resolvedEvaluationContext = resolveEvaluationContext({
    context,
    targetingKey,
    attributes,
    userId,
  })
  const evaluationAttributesSignature = stableJsonSignature(
    resolvedEvaluationContext.attributes,
  )
  const evaluationContext = useMemo(
    () => resolvedEvaluationContext,
    [resolvedEvaluationContext.targetingKey, evaluationAttributesSignature],
  )
  const optionsRef = useRef({ telemetry })
  optionsRef.current = { telemetry }
  const hostedOptions =
    typeof telemetry?.hosted === "object" ? telemetry.hosted : undefined
  const hostedHeadersSignature = stableJsonSignature(hostedOptions?.headers)
  const allowedAttributesSignature = stableJsonSignature(
    [...(telemetry?.allowedAttributes ?? [])].sort(),
  )
  const stableRetry = useMemo(
    () => (retry ? { ...retry } : undefined),
    [retry?.maxRetries, retry?.baseDelayMs, retry?.maxDelayMs],
  )
  const stableTelemetry = useMemo<SuperflagTelemetryOptions | undefined>(
    () =>
      telemetry
        ? {
            ...telemetry,
            ...(telemetry.transport
              ? {
                  transport: {
                    send: (events, options) => {
                      const current = optionsRef.current.telemetry?.transport
                      return current
                        ? current.send(events, options)
                        : Promise.reject(new Error("Telemetry transport was removed"))
                    },
                  },
                }
              : {}),
            ...(hostedOptions
              ? {
                  hosted: {
                    ...hostedOptions,
                    ...(hostedOptions.fetch
                      ? {
                          fetch: (input, init) => {
                            const current =
                              typeof optionsRef.current.telemetry?.hosted === "object"
                                ? optionsRef.current.telemetry.hosted.fetch
                                : undefined
                            return current
                              ? current(input, init)
                              : Promise.reject(new Error("Hosted telemetry fetch was removed"))
                          },
                        }
                      : {}),
                    ...(hostedOptions.headers
                      ? { headers: { ...hostedOptions.headers } }
                      : {}),
                  },
                }
              : {}),
            ...(telemetry.pseudonymize
              ? {
                  pseudonymize: (input) => {
                    const current = optionsRef.current.telemetry?.pseudonymize
                    return current
                      ? current(input)
                      : Promise.reject(new Error("Telemetry pseudonymizer was removed"))
                  },
                }
              : {}),
            ...(telemetry.onEvent
              ? { onEvent: (event) => optionsRef.current.telemetry?.onEvent?.(event) }
              : {}),
            ...(telemetry.onDiagnostic
              ? {
                  onDiagnostic: (diagnostic) =>
                    optionsRef.current.telemetry?.onDiagnostic?.(diagnostic),
                }
              : {}),
            ...(telemetry.allowedAttributes
              ? { allowedAttributes: [...telemetry.allowedAttributes] }
              : {}),
          }
        : undefined,
    [
      telemetry !== undefined,
      telemetry?.transport !== undefined,
      telemetry?.storage,
      telemetry?.hosted === true,
      hostedOptions?.baseUrl,
      hostedOptions?.fetch !== undefined,
      hostedHeadersSignature,
      telemetry?.pseudonymize !== undefined,
      telemetry?.subjectState,
      telemetry?.subjectRevision,
      allowedAttributesSignature,
      telemetry?.onEvent !== undefined,
      telemetry?.onDiagnostic !== undefined,
      telemetry?.maxQueueSize,
      telemetry?.batchSize,
      telemetry?.flushIntervalMs,
      telemetry?.backpressure,
      telemetry?.maxAttempts,
      telemetry?.retryBaseMs,
      telemetry?.retryMaxMs,
      telemetry?.retryJitterRatio,
      telemetry?.maxExposureDedupeEntries,
      telemetry?.maxEventPayloadBytes,
      telemetry?.shutdownTimeoutMs,
    ],
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
      retry: stableRetry,
      appState,
      network,
      telemetry: stableTelemetry,
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
  }, [
    propKey,
    configUrl,
    ttlSeconds,
    maxStaleAgeSeconds,
    storage,
    stableRetry,
    appState,
    network,
    stableTelemetry,
  ])

  useEffect(() => {
    clientRef.current?.setContext(evaluationContext, userId)
    setState((current) => ({
      ...current,
      evaluationContext,
      userId,
    }))
  }, [evaluationContext, userId])

  const track = useCallback(
    (...args: Parameters<SuperflagClient["track"]>) =>
      clientRef.current?.track(...args) ??
      Promise.resolve({ status: "disabled" as const, queueSize: 0 }),
    [],
  )
  const flush = useCallback(
    () => clientRef.current?.flush() ?? Promise.resolve({
      sent: 0,
      accepted: 0,
      duplicates: 0,
      permanent: 0,
      retryScheduled: 0,
      queueSize: 0,
    }),
    [],
  )
  const shutdown = useCallback(
    (options?: Parameters<SuperflagClient["shutdown"]>[0]) =>
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
    [],
  )
  const evaluationReader = useMemo(
    () => (state.config ? createEvaluationReader(state.config) : null),
    [state.config],
  )

  const value = useMemo(
    () => ({
      ...state,
      evaluationReader,
      emitDiagnostic,
      emitEvaluation,
      emitExposure,
      track,
      flush,
      shutdown,
    }),
    [
      state,
      evaluationReader,
      emitDiagnostic,
      emitEvaluation,
      emitExposure,
      track,
      flush,
      shutdown,
    ],
  )

  return <SuperflagContext.Provider value={value}>{children}</SuperflagContext.Provider>
}
