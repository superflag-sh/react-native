import { describe, expect, spyOn, test } from "bun:test";
import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { FlagConfig } from "@superflag-sh/core";
import type { SuperflagContextValue } from "../context.js";
import { initialState } from "../context.js";
import { createEvaluationReader } from "../evaluation.js";
import {
	createContextClient,
	contextClientDependencies,
	createFlagsResult,
	createTypedHooks,
	useBooleanFlag,
	useBooleanFlagDetails,
	useNumberFlag,
	useNumberFlagDetails,
	useObjectFlag,
	useObjectFlagDetails,
	useStringFlag,
	useStringFlagDetails,
	useSuperflagClient,
	useFlags,
} from "../hooks.js";

const config: FlagConfig = {
	schemaVersion: 1,
	source: { app: "app-a", environment: "production" },
	configVersion: 7,
	flags: {
		checkout: {
			type: "boolean",
			description: "Checkout",
			tags: ["test"],
			owner: "sdk",
			lifecycle: "active",
			enabled: true,
			variations: { off: { value: false }, on: { value: true } },
			offVariation: "off",
			fallthrough: { variation: "on" },
			visibility: "client",
		},
	},
};

describe("React public API parity", () => {
	test("reports useFlags age in seconds from provider state", () => {
		const result = createFlagsResult({
			...initialState,
			evaluationReader: null,
			fetchedAt: 90_000,
			age: 10,
			emitEvaluation: () => {},
			emitExposure: () => {},
			emitDiagnostic: () => {},
			track: async () => ({ status: "disabled", queueSize: 0 }),
			flush: async () => ({ sent: 0, accepted: 0, duplicates: 0, permanent: 0, retryScheduled: 0, queueSize: 0 }),
			shutdown: async () => ({ sent: 0, accepted: 0, duplicates: 0, permanent: 0, retryScheduled: 0, queueSize: 0, timedOut: false, dropped: 0 }),
		});

		expect(result.fetchedAt).toBe(90_000);
		expect(result.age).toBe(10);
		expect("config" in result).toBeFalse();
		expect("evaluationContext" in result).toBeFalse();
		expect("emitEvaluation" in result).toBeFalse();
	});

	test("exports explicit typed value and details hooks", () => {
		expect(
			[
				useBooleanFlag,
				useBooleanFlagDetails,
				useStringFlag,
				useStringFlagDetails,
				useNumberFlag,
				useNumberFlagDetails,
				useObjectFlag,
				useObjectFlagDetails,
				useSuperflagClient,
			].every((hook) => typeof hook === "function"),
		).toBeTrue();
	});

	test("creates schema-bound hook and client factories", () => {
		type FlagValues = { checkout: boolean };
		const hooks = createTypedHooks<FlagValues>();

		expect(typeof hooks.useFlag).toBe("function");
		expect(typeof hooks.useFlagDetails).toBe("function");
		expect(typeof hooks.useClient).toBe("function");
	});

	test("imperative client evaluates from provider context and preserves exposure semantics", async () => {
		const evaluations: unknown[] = [];
		const exposures: unknown[] = [];
		let refreshes = 0;
		const context: SuperflagContextValue = {
			...initialState,
			config,
			evaluationReader: createEvaluationReader(config),
			flags: config.flags,
			status: "ready",
			source: "network",
			fetchedAt: 1_000,
			configVersion: 7,
			age: 2,
			evaluationContext: { targetingKey: "test-user" },
			refresh: async () => {
				refreshes += 1;
			},
			emitEvaluation: (event) => evaluations.push(event),
			emitExposure: (event) => exposures.push(event),
			emitDiagnostic: () => {},
			track: async () => ({ status: "queued", queueSize: 1 }),
			flush: async () => ({ sent: 1, accepted: 1, duplicates: 0, permanent: 0, retryScheduled: 0, queueSize: 0 }),
			shutdown: async () => ({ sent: 0, accepted: 0, duplicates: 0, permanent: 0, retryScheduled: 0, queueSize: 0, timedOut: false, dropped: 0 }),
		};
		const client = createContextClient<{ checkout: boolean }>(context);

		expect(client.getFlag("checkout", false)).toBeTrue();
		expect(client.getFlagDetails("checkout", false)?.value).toBeTrue();
		expect(evaluations).toHaveLength(2);
		expect(exposures).toHaveLength(1);

		await client.refresh();
		expect(refreshes).toBe(1);
		expect(await client.track("checkout", "purchase", 1)).toEqual({ status: "queued", queueSize: 1 });
		expect((await client.flush()).accepted).toBe(1);
	});

	test("imperative client identity ignores unrelated provider state", () => {
		const context: SuperflagContextValue = {
			...initialState,
			evaluationReader: null,
			emitEvaluation: () => {},
			emitExposure: () => {},
			emitDiagnostic: () => {},
			track: async () => ({ status: "disabled", queueSize: 0 }),
			flush: async () => ({ sent: 0, accepted: 0, duplicates: 0, permanent: 0, retryScheduled: 0, queueSize: 0 }),
			shutdown: async () => ({ sent: 0, accepted: 0, duplicates: 0, permanent: 0, retryScheduled: 0, queueSize: 0, timedOut: false, dropped: 0 }),
		};
		const refreshedState = { ...context, age: 11, status: "refreshing" as const };

		expect(contextClientDependencies(refreshedState)).toEqual(
			contextClientDependencies(context),
		);
	});

	test("provider creates one evaluation reader for multiple hook and imperative consumers", async () => {
		const originalFetch = globalThis.fetch;
		const evaluation = await import("../evaluation.js");
		const readerSpy = spyOn(evaluation, "createEvaluationReader");
		const { SuperflagProvider } = await import("../provider.js");
		const values = new Map<string, string>();
		const storage = {
			async getItem(key: string) { return values.get(key) ?? null; },
			async setItem(key: string, value: string) { values.set(key, value); },
			async removeItem(key: string) { values.delete(key); },
		};
		globalThis.fetch = async () => Response.json({
			appId: "app-a",
			env: "production",
			version: 7,
			doc: config,
			ttlSeconds: 60,
		}, { headers: { ETag: '"7"' } });

		let status = "idle";
		function Consumer() {
			useBooleanFlagDetails("checkout", false);
			useBooleanFlagDetails("checkout", false);
			useSuperflagClient<{ checkout: boolean }>();
			status = useFlags().status;
			return null;
		}
		const renderApp = () => React.createElement(
			SuperflagProvider,
			{
				clientKey: "pub_reader_owner",
				storage,
				appState: null,
				retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
			},
			React.createElement(Consumer),
		);

		let root: ReactTestRenderer | undefined;
		try {
			await act(async () => {
				root = create(renderApp());
				for (let index = 0; index < 12; index += 1) await Promise.resolve();
			});
			expect(status).toBe("ready");
			expect(readerSpy).toHaveBeenCalledTimes(1);

			await act(async () => root?.update(renderApp()));
			expect(readerSpy).toHaveBeenCalledTimes(1);
		} finally {
			await act(async () => root?.unmount());
			readerSpy.mockRestore();
			globalThis.fetch = originalFetch;
		}
	});
});
