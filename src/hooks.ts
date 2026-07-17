import { useContext, useEffect, useMemo } from "react"
import { SuperflagContext } from "./context.js"
import type { SuperflagContextValue } from "./context.js"
import type {
  EvaluationDetails,
  EvaluationOptions,
  FlagConfig,
  FlagKey,
  FlagValue,
  FlagValueFor,
  ObjectFlagValue,
  TypedEvaluationDetails,
  TypedFlagValues,
  TypedSuperflagClient,
  TypedSuperflagHooks,
  UseFlagsResult,
} from "./types.js"

function useSuperflagContext() {
  const context = useContext(SuperflagContext)
  if (!context) throw new Error("Superflag hooks must be used within a SuperflagProvider")
  return context
}

function useDetails<T extends FlagValue>(
  key: string,
  fallback: T,
  exposed: boolean,
  options?: EvaluationOptions,
): EvaluationDetails<T> | undefined {
  const context = useSuperflagContext()
  const details = useMemo(() => {
    if (!context.evaluationReader) return undefined
    return context.evaluationReader(context.evaluationContext, key, fallback, options)
  }, [context.evaluationReader, context.evaluationContext, key, fallback, options])

  useEffect(() => {
    if (!details) return
    const event = { key, context: context.evaluationContext, details }
    context.emitEvaluation(event, exposed)
    if (exposed) context.emitExposure({ ...event, timestamp: Date.now() })
  }, [context.emitEvaluation, context.emitExposure, context.evaluationContext, details, exposed, key])

  return details
}

/** Compatibility hook. Existing callers may continue using useFlag(name, fallback). */
export function useFlag<T extends FlagValue = FlagValue>(
  name: string,
  fallback?: T,
  options?: EvaluationOptions,
): T | undefined {
  const context = useSuperflagContext()
  const flag = context.config?.flags[name]
  const inferredFallback = flag?.variations[flag.offVariation]?.value as T | undefined
  const safeFallback = fallback ?? inferredFallback
  const details = useDetails(name, safeFallback ?? (false as T), true, options)
  if (!flag && fallback === undefined) return undefined
  return details?.value ?? fallback
}

/** Return the complete core evaluation result for diagnostics and analytics. */
export function useFlagDetails<T extends FlagValue>(
  name: string,
  fallback: T,
  options?: EvaluationOptions,
): EvaluationDetails<T> | undefined {
  return useDetails(name, fallback, false, options)
}

export const useEvaluationDetails: typeof useFlagDetails = useFlagDetails

/** Schema-aware hook for generated or literal core FlagConfig types. */
export function useTypedFlag<C extends FlagConfig, K extends FlagKey<C>>(
  name: K,
  fallback: FlagValueFor<C, K>,
  options?: EvaluationOptions,
): FlagValueFor<C, K> {
  return useFlag(name, fallback, options) as FlagValueFor<C, K>
}

export function useBooleanFlag(
  name: string,
  fallback: boolean,
  options?: EvaluationOptions,
): boolean {
  return useFlag(name, fallback, options) as boolean
}

export function useStringFlag(
  name: string,
  fallback: string,
  options?: EvaluationOptions,
): string {
  return useFlag(name, fallback, options) as string
}

export function useNumberFlag(
  name: string,
  fallback: number,
  options?: EvaluationOptions,
): number {
  return useFlag(name, fallback, options) as number
}

export function useObjectFlag<T extends ObjectFlagValue>(
  name: string,
  fallback: T,
  options?: EvaluationOptions,
): T {
  return useFlag(name, fallback, options) as T
}

export function useBooleanFlagDetails(
  name: string,
  fallback: boolean,
  options?: EvaluationOptions,
): EvaluationDetails<boolean> | undefined {
  return useFlagDetails(name, fallback, options)
}

export function useStringFlagDetails(
  name: string,
  fallback: string,
  options?: EvaluationOptions,
): EvaluationDetails<string> | undefined {
  return useFlagDetails(name, fallback, options)
}

export function useNumberFlagDetails(
  name: string,
  fallback: number,
  options?: EvaluationOptions,
): EvaluationDetails<number> | undefined {
  return useFlagDetails(name, fallback, options)
}

export function useObjectFlagDetails<T extends ObjectFlagValue>(
  name: string,
  fallback: T,
  options?: EvaluationOptions,
): EvaluationDetails<T> | undefined {
  return useFlagDetails(name, fallback, options)
}

/** Build the imperative API from the provider context. */
export function createContextClient<T extends object>(
  context: SuperflagContextValue,
): TypedSuperflagClient<T> {
  const reader = context.evaluationReader
  function evaluate<K extends Extract<keyof TypedFlagValues<T>, string>>(
    name: K,
    fallback: TypedFlagValues<T>[K],
    exposed: boolean,
  ): TypedEvaluationDetails<TypedFlagValues<T>[K]> | undefined {
    if (!reader) return undefined
    const details = reader(
      context.evaluationContext,
      name,
      fallback as FlagValue,
    )
    const event = { key: name, context: context.evaluationContext, details }
    context.emitEvaluation(event, exposed)
    if (exposed) context.emitExposure({ ...event, timestamp: Date.now() })
    return details as TypedEvaluationDetails<TypedFlagValues<T>[K]>
  }

  return {
    getFlag(name, fallback) {
      const details = evaluate(name, fallback, true)
      return (details?.value ?? fallback) as TypedFlagValues<T>[typeof name]
    },
    getFlagDetails(name, fallback) {
      return evaluate(name, fallback, false)
    },
    track: context.track,
    flush: context.flush,
    shutdown: context.shutdown,
    refresh: context.refresh,
  }
}

/** Relevant identities for the imperative client's memoized Interface. */
export type ContextClientDependencies = readonly [
  SuperflagContextValue["evaluationReader"],
  SuperflagContextValue["evaluationContext"],
  SuperflagContextValue["emitEvaluation"],
  SuperflagContextValue["emitExposure"],
  SuperflagContextValue["track"],
  SuperflagContextValue["flush"],
  SuperflagContextValue["shutdown"],
  SuperflagContextValue["refresh"],
]

export function contextClientDependencies(
  context: SuperflagContextValue,
): ContextClientDependencies {
  return [
    context.evaluationReader,
    context.evaluationContext,
    context.emitEvaluation,
    context.emitExposure,
    context.track,
    context.flush,
    context.shutdown,
    context.refresh,
  ] as const
}

/** Imperative evaluation API for callbacks that cannot call hooks themselves. */
export function useSuperflagClient<T extends object = Record<string, FlagValue>>(): TypedSuperflagClient<T> {
  const context = useSuperflagContext()
  return useMemo(
    () => createContextClient<T>(context),
    contextClientDependencies(context),
  )
}

/** Bind a generated value map or literal core FlagConfig once for key/value-safe access. */
export function createTypedHooks<const T extends object>(): TypedSuperflagHooks<T> {
  return {
    useFlag(name, fallback) {
      return useFlag(name, fallback as FlagValue) as TypedFlagValues<T>[typeof name]
    },
    useFlagDetails(name, fallback) {
      return useFlagDetails(name, fallback as FlagValue) as
        | TypedEvaluationDetails<TypedFlagValues<T>[typeof name]>
        | undefined
    },
    useClient() {
      return useSuperflagClient<T>()
    },
  }
}

/** Project provider state into the public useFlags result. */
export function createFlagsResult(context: SuperflagContextValue): UseFlagsResult {
  return {
    ready: context.config !== null,
    loading: context.status === "loading" || context.status === "refreshing",
    status: context.status,
    source: context.source,
    error: context.error,
    fetchedAt: context.fetchedAt,
    configVersion: context.configVersion,
    age: context.age,
    stale: context.stale,
    refresh: context.refresh,
  }
}

export function useFlags(): UseFlagsResult {
  return createFlagsResult(useSuperflagContext())
}
