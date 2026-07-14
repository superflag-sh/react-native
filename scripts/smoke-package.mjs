import { execFileSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreRoot = process.env.SUPERFLAG_CORE_DIR ?? join(root, "node_modules", "@superflag-sh", "core")
const temp = mkdtempSync(join(tmpdir(), "superflag-react-native-smoke-"))
const tarball = join(temp, "package.tgz")
const coreTarball = join(temp, "core.tgz")

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
        "@superflag-sh/core": `file:${coreTarball}`,
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
    'import { SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } from "@superflag-sh/react-native";\n' +
      'if (![SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("ESM exports missing");\n',
  )
  writeFileSync(
    join(consumer, "smoke-cjs.cjs"),
    'const { SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } = require("@superflag-sh/react-native");\n' +
      'if (![SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("CJS exports missing");\n',
  )
  writeFileSync(
    join(consumer, "consumer.tsx"),
    'import { SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, type DiagnosticEvent, type StorageAdapter } from "@superflag-sh/react-native";\n' +
      'declare const storage: StorageAdapter;\n' +
      'type Flags = { enabled: boolean };\n' +
      'const flags = createTypedHooks<Flags>();\n' +
      'const Child = () => <>{String(useFlag("enabled", false))}{String(useFlagDetails("enabled", false)?.reason)}{String(flags.useFlag("enabled", false))}</>;\n' +
      'const diagnostic = (_event: DiagnosticEvent) => {};\n' +
      'export const App = () => <SuperflagProvider clientKey="pub_prod_smoke" storage={storage} targetingKey="person" attributes={{ plan: "pro" }} onDiagnostic={diagnostic}><Child /></SuperflagProvider>;\n',
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

  run("node", ["smoke-esm.mjs"], consumer)
  run("node", ["smoke-cjs.cjs"], consumer)
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
  pack(coreRoot, coreTarball)
  const entries = run("tar", ["-tzf", tarball]).trim().split("\n")
  const forbidden = entries.filter((entry) => /\/(src|scripts|smoke|__tests__)\//.test(entry))
  if (forbidden.length > 0) throw new Error(`Source-only files leaked into tarball: ${forbidden.join(", ")}`)
  for (const required of ["package/dist/esm/index.js", "package/dist/cjs/index.js", "package/dist/cjs/package.json", "package/dist/types/index.d.ts"]) {
    if (!entries.includes(required)) throw new Error(`Missing tarball entry: ${required}`)
  }

  smokeConsumer("18.3.1", "18.3.28")
  smokeConsumer("19.2.0", "19.2.14")

  const manifest = JSON.parse(readFileSync(join(temp, "react-19", "node_modules", "@superflag-sh", "react-native", "package.json"), "utf8"))
  if (manifest.dependencies?.["@superflag-sh/core"] !== "^0.1.0") throw new Error("Published manifest must use the semver core dependency ^0.1.0")
  if (/^(?:file|link):/.test(manifest.dependencies["@superflag-sh/core"])) throw new Error("Published manifest leaked a local core dependency")
  console.log(`tarball: ${entries.length} files, source-only entries: 0`)
  console.log(`runtime imports: ESM and CommonJS ok (${manifest.name}@${manifest.version})`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
