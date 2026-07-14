import { createContext } from "react";
import type {
	DiagnosticEvent,
	EvaluationEvent,
	ExposureEvent,
	SuperflagState,
} from "./types.js";

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
	emitEvaluation(event: EvaluationEvent): void;
	emitExposure(event: ExposureEvent): void;
	emitDiagnostic(event: DiagnosticEvent): void;
}

export const SuperflagContext: React.Context<SuperflagContextValue | null> =
	createContext<SuperflagContextValue | null>(null);
