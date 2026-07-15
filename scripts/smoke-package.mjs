import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), "superflag-react-native-smoke-"))
const tarball = join(temp, "package.tgz")

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
  })
}

function pack(sourceRoot, destination) {
  const result = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(temp, ".npm-cache"), "--pack-destination", temp], sourceRoot))
  renameSync(join(temp, result[0].filename), destination)
}

function smokeConsumer(reactVersion, reactTypesVersion) {
  const consumer = join(temp, `react-${reactVersion.split(".")[0]}`)
  mkdirSync(consumer)
  writeFileSync(
    join(consumer, "package.json"),
    JSON.stringify({
      private: true,
      type: "module",
      dependencies: {
        "@superflag-sh/react-native": `file:${tarball}`,
        react: reactVersion,
        "@types/react": reactTypesVersion,
        typescript: "5.9.3",
      },
    }),
  )
  run("npm", ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--package-lock=false", "--cache", join(temp, ".npm-cache")], consumer)

  writeFileSync(
    join(consumer, "smoke-esm.mjs"),
    'import { SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } from "@superflag-sh/react-native";\n' +
      'if (![SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("ESM exports missing");\n',
  )
  writeFileSync(
    join(consumer, "smoke-cjs.cjs"),
    'const { SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } = require("@superflag-sh/react-native");\n' +
      'if (![SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("CJS exports missing");\n',
  )
  writeFileSync(
    join(consumer, "consumer.tsx"),
    'import { SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, type DiagnosticEvent, type FeatureEvent, type StorageAdapter } from "@superflag-sh/react-native";\n' +
      'declare const storage: StorageAdapter;\n' +
      'type Flags = { enabled: boolean };\n' +
      'const flags = createTypedHooks<Flags>();\n' +
      'const Child = () => { const client = flags.useClient(); void client.track("enabled", "conversion"); void client.track("enabled", "revenue", 1); return <>{String(useFlag("enabled", false))}{String(useFlagDetails("enabled", false)?.reason)}{String(flags.useFlag("enabled", false))}</>; };\n' +
      'const diagnostic = (_event: DiagnosticEvent) => {};\n' +
      'const featureEvent = (_event: FeatureEvent) => {};\n' +
      'export const App = () => <SuperflagProvider clientKey="pub_prod_smoke" storage={storage} targetingKey="person" attributes={{ plan: "pro" }} onDiagnostic={diagnostic} telemetry={{ hosted: { baseUrl: "https://superflag.sh" }, onEvent: featureEvent }}><Child /></SuperflagProvider>;\n',
  )
  writeFileSync(
    join(consumer, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        noEmit: true,
        strict: true,
        jsx: "react-jsx",
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022"],
        types: ["react"],
      },
      include: ["consumer.tsx"],
    }),
  )

  writeFileSync(
    join(consumer, "telemetry-behavior.mjs"),
    `import { createSuperflagClient } from "@superflag-sh/react-native";
const values = new Map();
const storage = {
  async getItem(key) { return values.get(key) ?? null; },
  async setItem(key, value) { values.set(key, value); },
  async removeItem(key) { values.delete(key); },
};
const listeners = new Set();
const appState = {
  currentState: "active",
  addEventListener(_event, listener) {
    listeners.add(listener);
    return { remove() { listeners.delete(listener); } };
  },
  emit(state) { for (const listener of listeners) listener(state); },
};
const flagConfig = {
  schemaVersion: 1,
  source: { app: "smoke-app", environment: "production" },
  configVersion: 1,
  flags: {
    checkout: {
      type: "boolean", description: "Checkout", tags: [], owner: "smoke",
      lifecycle: "active", enabled: true,
      variations: { off: { value: false }, on: { value: true } },
      offVariation: "off", fallthrough: { variation: "on" }, visibility: "client",
    },
  },
};
globalThis.fetch = async () => Response.json(
  { appId: "smoke-app", env: "production", version: 1, doc: flagConfig, ttlSeconds: 60 },
  { headers: { ETag: '"1"' } },
);
let online = false;
let attempts = 0;
let clock = Date.parse("2026-07-14T12:00:00.000Z");
const delivered = [];
const acceptedIds = new Set();
const transport = {
  async send(events) {
    attempts += 1;
    if (!online) throw new Error("offline");
    return { items: events.map((event) => {
      if (acceptedIds.has(event.id)) return { eventId: event.id, status: "duplicate" };
      acceptedIds.add(event.id);
      delivered.push(event);
      return { eventId: event.id, status: "accepted" };
    }) };
  },
};
function makeClient() {
  return createSuperflagClient({
    clientKey: "pub_prod_smoke",
    configUrl: "https://superflag.sh/api/v1/public-config",
    ttlSeconds: 60,
    storage,
    evaluationContext: {
      targetingKey: "raw-cold-user",
      attributes: { email: "cold@example.com" },
    },
    appState,
    retry: { maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0 },
    now: () => clock,
    telemetry: {
      transport,
      retryBaseMs: 10_000,
      retryMaxMs: 10_000,
      flushIntervalMs: 60_000,
    },
    onStateChange() {},
  });
}
const first = makeClient();
await first.initialize();
if (delivered.length !== 0) throw new Error("Initialization created a false exposure");
first.recordEvaluation({
  key: "checkout",
  context: { targetingKey: "raw-cold-user", attributes: { email: "cold@example.com" } },
  details: {
    value: true,
    variation: "on",
    reason: "FALLTHROUGH",
    flagKey: "checkout",
    source: flagConfig.source,
    configVersion: 1,
    timestamp: "2026-07-14T12:00:00.000Z",
  },
}, true);
await new Promise((resolve) => setTimeout(resolve, 0));
const converted = await first.track("checkout", "converted");
if (converted.status !== "queued") throw new Error("Binary outcome was not queued");
appState.emit("background");
await new Promise((resolve) => setTimeout(resolve, 5));
if (attempts < 1) throw new Error("Background lifecycle did not flush telemetry");
const persisted = JSON.stringify([...values]);
if (persisted.includes("raw-cold-user") || persisted.includes("cold@example.com")) {
  throw new Error("Persistent telemetry leaked raw targeting context");
}
const offlineQueue = [...values.values()].map((value) => { try { return JSON.parse(value); } catch { return null; } }).find((value) => value?.schemaVersion === 1 && Array.isArray(value.entries));
if (offlineQueue?.entries.length !== 2) throw new Error("Expected exposure and binary outcome in persisted offline queue: " + JSON.stringify(offlineQueue));
await first.shutdown({ flush: false });
first.destroy();
online = true;
clock += 20_000;
const second = makeClient();
await second.initialize();
const beforeExplicitFlush = delivered.length;
const explicitFlush = await second.flush();
if (delivered.length !== 2 || delivered[0].kind !== "exposure" || delivered[1].kind !== "outcome" || delivered[1].value !== true) {
  throw new Error("Persistent exposure and binary outcome did not drain after restart: " + JSON.stringify({ delivered, attempts, beforeExplicitFlush, explicitFlush, values: [...values] }));
}
await second.shutdown();
second.destroy();
console.log("packed telemetry: private persistence, binary outcome restart drain, and AppState flush ok");
`,
  )

  run("node", ["smoke-esm.mjs"], consumer)
  run("node", ["smoke-cjs.cjs"], consumer)
  run("node", ["telemetry-behavior.mjs"], consumer)
  run(join(consumer, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], consumer)

  const react = JSON.parse(readFileSync(join(consumer, "node_modules", "react", "package.json"), "utf8"))
  const reactTypes = JSON.parse(readFileSync(join(consumer, "node_modules", "@types", "react", "package.json"), "utf8"))
  if (react.version !== reactVersion || reactTypes.version !== reactTypesVersion) {
    throw new Error(`React matrix drift: react ${react.version}, @types/react ${reactTypes.version}`)
  }
  console.log(`consumer declarations: React ${react.version} / @types/react ${reactTypes.version} without skipLibCheck`)
}

try {
  pack(root, tarball)
  const entries = run("tar", ["-tzf", tarball]).trim().split("\n")
  const forbidden = entries.filter((entry) => /\/(src|scripts|smoke|__tests__)\//.test(entry))
  if (forbidden.length > 0) throw new Error(`Source-only files leaked into tarball: ${forbidden.join(", ")}`)
  for (const required of ["package/dist/esm/index.js", "package/dist/cjs/index.js", "package/dist/cjs/package.json", "package/dist/types/index.d.ts"]) {
    if (!entries.includes(required)) throw new Error(`Missing tarball entry: ${required}`)
  }

  smokeConsumer("18.3.1", "18.3.28")
  smokeConsumer("19.2.0", "19.2.14")

  const manifest = JSON.parse(readFileSync(join(temp, "react-19", "node_modules", "@superflag-sh", "react-native", "package.json"), "utf8"))
  if (manifest.dependencies?.["@superflag-sh/core"] !== "0.2.1") throw new Error("Published manifest must use exact @superflag-sh/core 0.2.1")
  if (/^(?:file|link):/.test(manifest.dependencies["@superflag-sh/core"])) throw new Error("Published manifest leaked a local core dependency")
  console.log(`tarball: ${entries.length} files, source-only entries: 0`)
  console.log(`runtime imports: ESM and CommonJS ok (${manifest.name}@${manifest.version})`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
