import { describe, expect, test } from "bun:test";
import type { FlagConfig } from "@superflag-sh/core";
import type { SuperflagContextValue } from "../context.js";
import { initialState } from "../context.js";
import {
	createContextClient,
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
});
