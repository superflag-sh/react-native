import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreRoot = process.env.SUPERFLAG_CORE_DIR ?? join(dirname(root), "superflag-core")
const temp = mkdtempSync(join(tmpdir(), "superflag-react-native-smoke-"))
const tarball = join(temp, "package.tgz")
const coreTarball = join(temp, "core.tgz")

function run(command, args, cwd = root) {
  return execFileSync(command, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

function pack(sourceRoot, destination) {
  const result = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(temp, ".npm-cache"), "--pack-destination", temp], sourceRoot))
  renameSync(join(temp, result[0].filename), destination)
}

function linkDependency(name) {
  const source = join(root, "node_modules", ...name.split("/"))
  const destination = join(temp, "node_modules", ...name.split("/"))
  mkdirSync(dirname(destination), { recursive: true })
  if (!existsSync(destination)) symlinkSync(source, destination, "junction")
}

try {
  pack(root, tarball)
  pack(coreRoot, coreTarball)
  const entries = run("tar", ["-tzf", tarball]).trim().split("\n")
  const forbidden = entries.filter((entry) => /\/(src|scripts|smoke|__tests__)\//.test(entry))
  if (forbidden.length > 0) throw new Error(`Source-only files leaked into tarball: ${forbidden.join(", ")}`)

  for (const required of [
    "package/dist/esm/index.js",
    "package/dist/cjs/index.js",
    "package/dist/cjs/package.json",
    "package/dist/types/index.d.ts",
  ]) {
    if (!entries.includes(required)) throw new Error(`Missing tarball entry: ${required}`)
  }

  writeFileSync(join(temp, "package.json"), JSON.stringify({ private: true, type: "module" }))
  run(
    "npm",
    ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-package-lock", "--no-audit", "--no-fund", "--cache", join(temp, ".npm-cache"), coreTarball, tarball],
    temp,
  )
  linkDependency("react")
  linkDependency("@types/react")

  writeFileSync(
    join(temp, "smoke-esm.mjs"),
    'import { SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } from "@superflag-sh/react-native";\n' +
      'if (![SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("ESM exports missing");\n',
  )
  writeFileSync(
    join(temp, "smoke-cjs.cjs"),
    'const { SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } = require("@superflag-sh/react-native");\n' +
      'if (![SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("CJS exports missing");\n',
  )
  writeFileSync(
    join(temp, "consumer.tsx"),
    'import { SuperflagProvider, createTypedHooks, useFlag, useFlagDetails, type DiagnosticEvent, type StorageAdapter } from "@superflag-sh/react-native";\n' +
      'declare const storage: StorageAdapter;\n' +
      'type Flags = { enabled: boolean };\n' +
      'const flags = createTypedHooks<Flags>();\n' +
      'const Child = () => <>{String(useFlag("enabled", false))}{String(useFlagDetails("enabled", false)?.reason)}{String(flags.useFlag("enabled", false))}</>;\n' +
      'const diagnostic = (_event: DiagnosticEvent) => {};\n' +
      'export const App = () => <SuperflagProvider clientKey="pub_prod_smoke" storage={storage} targetingKey="person" attributes={{ plan: "pro" }} onDiagnostic={diagnostic}><Child /></SuperflagProvider>;\n',
  )

  run("node", ["smoke-esm.mjs"], temp)
  run("node", ["smoke-cjs.cjs"], temp)
  run(
    join(root, "node_modules", ".bin", "tsc"),
    ["--noEmit", "--skipLibCheck", "--jsx", "react-jsx", "--target", "ES2019", "--module", "NodeNext", "--moduleResolution", "NodeNext", "consumer.tsx"],
    temp,
  )

  const manifest = JSON.parse(readFileSync(join(temp, "node_modules", "@superflag-sh", "react-native", "package.json"), "utf8"))
  if (manifest.dependencies?.["@superflag-sh/core"] !== "^0.1.0") {
    throw new Error("Published manifest must use the semver core dependency ^0.1.0")
  }
  if (/^(?:file|link):/.test(manifest.dependencies["@superflag-sh/core"])) {
    throw new Error("Published manifest leaked a local core dependency")
  }
  console.log(`tarball: ${entries.length} files, source-only entries: 0`)
  console.log(`runtime imports: ESM and CommonJS ok (${manifest.name}@${manifest.version})`)
  console.log("consumer declarations: NodeNext TSX ok")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
