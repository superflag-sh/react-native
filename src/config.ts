import { migrateLegacyFlags, parseConfig } from "@superflag-sh/core"
import type {
  ConfigResponse,
  FlagConfig,
  LegacyConfigDocument,
} from "./types.js"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isConfigResponse(value: unknown): value is ConfigResponse {
  return (
    isRecord(value) &&
    typeof value.appId === "string" &&
    value.appId.length > 0 &&
    typeof value.env === "string" &&
    value.env.length > 0 &&
    Number.isSafeInteger(value.version) &&
    (value.version as number) >= 0 &&
    isRecord(value.doc) &&
    isRecord(value.doc.flags)
  )
}

function isCoreDocument(doc: ConfigResponse["doc"]): doc is FlagConfig {
  return "schemaVersion" in doc
}

function convertLegacyDocument(
  doc: LegacyConfigDocument,
  appId: string,
  environment: string,
  version: number,
): FlagConfig {
  return migrateLegacyFlags(doc.flags, {
    source: { app: appId, environment },
    configVersion: version,
    defaults: {
      description: "Imported legacy public-config flag",
      tags: [],
      owner: "legacy",
      lifecycle: "active",
    },
  })
}

/** Normalize both canonical and legacy public-config payloads into the core contract. */
export function normalizeConfigResponse(response: ConfigResponse): FlagConfig {
  const config = isCoreDocument(response.doc)
    ? {
        ...response.doc,
        source: response.doc.source ?? { app: response.appId, environment: response.env },
        configVersion: response.doc.configVersion ?? response.version,
      }
    : convertLegacyDocument(response.doc, response.appId, response.env, response.version)

  if (
    config.source.app !== response.appId ||
    config.source.environment !== response.env ||
    config.configVersion !== response.version
  ) {
    throw new Error("Config document identity does not match its authenticated response")
  }

  // Core parsing is the single schema authority.
  return parseConfig(config)
}

/** Parse an untrusted persisted document through the core schema Interface. */
export function parseCachedConfig(config: unknown): FlagConfig | null {
  try {
    return parseConfig(config)
  } catch {
    return null
  }
}
