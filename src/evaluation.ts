import { createEvaluator } from "@superflag-sh/core";
import type {
	EvaluationContext,
	EvaluationDetails,
	EvaluationOptions,
	FlagConfig,
	FlagValue,
} from "./types.js";

export function resolveEvaluationContext(input: {
	context?: EvaluationContext;
	targetingKey?: string;
	attributes?: EvaluationContext["attributes"];
	userId?: string;
}): EvaluationContext {
	if (input.context) return input.context;
	return {
		// Missing identity is intentionally represented as empty. The core
		// evaluator then returns the caller's typed fallback with INVALID_CONTEXT
		// instead of assigning every unidentified device to one rollout bucket.
		targetingKey: input.targetingKey ?? input.userId ?? "",
		...(input.attributes ? { attributes: input.attributes } : {}),
	};
}

export function evaluateWithCore<T extends FlagValue = FlagValue>(
	config: FlagConfig,
	context: EvaluationContext,
	key: string,
	fallback: T,
	options?: EvaluationOptions,
): EvaluationDetails<T> {
	const evaluator = createEvaluator(config);
	return evaluator.evaluate(
		key,
		context,
		fallback,
		options,
	) as EvaluationDetails<T>;
}
