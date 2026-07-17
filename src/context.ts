import { createContext } from "react";
import type {
	DiagnosticEvent,
	EvaluationEvent,
	ExposureEvent,
	SuperflagClient,
	SuperflagState,
} from "./types.js";
import type { EvaluationReader } from "./evaluation.js";

const noopRefresh = async (): Promise<void> => {};

export const initialState: SuperflagState = {
	config: null,
	flags: {},
	status: "idle",
	source: "none",
	error: null,
	fetchedAt: null,
	configVersion: null,
	age: null,
	stale: false,
	refresh: noopRefresh,
	evaluationContext: { targetingKey: "" },
	appId: null,
	environment: null,
	version: null,
	etag: null,
};

export interface SuperflagContextValue extends SuperflagState {
	evaluationReader: EvaluationReader | null;
	emitEvaluation(event: EvaluationEvent, exposed: boolean): void;
	emitExposure(event: ExposureEvent): void;
	emitDiagnostic(event: DiagnosticEvent): void;
	track: SuperflagClient["track"];
	flush: SuperflagClient["flush"];
	shutdown: SuperflagClient["shutdown"];
}

export const SuperflagContext: React.Context<SuperflagContextValue | null> =
	createContext<SuperflagContextValue | null>(null);
