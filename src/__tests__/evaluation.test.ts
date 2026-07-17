import { describe, expect, test } from "bun:test";
import {
	conformanceConfig,
	conformanceVectors,
	runConformanceVectors,
} from "@superflag-sh/core/conformance";
import { normalizeConfigResponse } from "../config.js";
import {
  createEvaluationReader,
  evaluateWithCore,
  resolveEvaluationContext,
} from "../evaluation.js";
import type { ConfigResponse } from "../types.js";

describe("core evaluation adapter", () => {
	test("passes every canonical core conformance vector", () => {
		const reader = createEvaluationReader(conformanceConfig);
		expect(runConformanceVectors().every((result) => result.pass)).toBeTrue();
		for (const vector of conformanceVectors) {
			const details = reader(
				vector.context,
				vector.flagKey,
				vector.fallback,
				{ now: vector.now },
			);
			expect(details).toMatchObject(vector.expected);
			expect(details.source).toEqual(conformanceConfig.source);
			expect(details.configVersion).toBe(conformanceConfig.configVersion);
		}
	});

	test("normalizes canonical responses without changing their evaluation contract", () => {
		const response: ConfigResponse = {
			appId: conformanceConfig.source.app,
			env: conformanceConfig.source.environment,
			version: conformanceConfig.configVersion,
			doc: conformanceConfig,
		};
		expect(normalizeConfigResponse(response)).toEqual(conformanceConfig);
	});

	test("converts legacy value-only flags and keeps userId as a targetingKey alias", () => {
		const config = normalizeConfigResponse({
			appId: "legacy-app",
			env: "production",
			version: 7,
			doc: {
				flags: {
					message: { type: "string", value: "hello" },
					rollout: { type: "bool", value: true, rollout: { percentage: 100 } },
				},
			},
		});
		const context = resolveEvaluationContext({ userId: "legacy-user" });

		expect(evaluateWithCore(config, context, "message", "fallback").value).toBe(
			"hello",
		);
		expect(
			evaluateWithCore(config, context, "rollout", false).value,
		).toBeTrue();
		expect(context.targetingKey).toBe("legacy-user");
	});

	test("targetingKey and attributes replace userId-only targeting", () => {
		const paid = conformanceVectors[0];
		const details = evaluateWithCore(
			conformanceConfig,
			resolveEvaluationContext({
				targetingKey: paid.context.targetingKey,
				attributes: paid.context.attributes,
			}),
			paid.flagKey,
			paid.fallback,
			{ now: paid.now },
		);
		expect(details).toMatchObject(paid.expected);
	});

	test("missing identity fails closed instead of sharing an anonymous rollout bucket", () => {
		const context = resolveEvaluationContext({});
		const details = evaluateWithCore(
			conformanceConfig,
			context,
			"progressive",
			"fallback",
			{ now: "2026-01-15T00:00:00.000Z" },
		);

		expect(context.targetingKey).toBe("");
		expect(details).toMatchObject({
			value: "fallback",
			reason: "DEFAULT",
			errorCode: "INVALID_CONTEXT",
		});
	});

	test("rejects a document whose embedded source/version changes identity", () => {
		expect(() =>
			normalizeConfigResponse({
				appId: "expected",
				env: "production",
				version: conformanceConfig.configVersion,
				doc: conformanceConfig,
			}),
		).toThrow("identity");
	});
});
