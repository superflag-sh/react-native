import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"

const packageName = "@superflag-sh/react-native"
const coreName = "@superflag-sh/core"
const registry = "https://registry.npmjs.org/"
const root = dirname(dirname(fileURLToPath(import.meta.url)))
const temp = mkdtempSync(join(tmpdir(), "superflag-react-native-registry-"))
const npmCache = join(temp, ".npm-cache")
const userConfig = join(temp, "npm-userconfig")
const globalConfig = join(temp, "npm-globalconfig")
const fixture = join(temp, "consumer")
const packed = join(temp, "packed")
writeFileSync(userConfig, "")
writeFileSync(globalConfig, "")

function run(command, args, cwd = fixture) {
  try {
    return execFileSync(command, args, {
      cwd,
      encoding: "utf8",
      env: {
        ...process.env,
        CI: "1",
        NODE_PATH: "",
        npm_config_cache: npmCache,
        npm_config_registry: registry,
        npm_config_userconfig: userConfig,
        npm_config_globalconfig: globalConfig,
      },
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 128 * 1024 * 1024,
    })
  } catch (error) {
    const stdout = error.stdout?.toString().trim()
    const stderr = error.stderr?.toString().trim()
    throw new Error([`${command} ${args.join(" ")} failed`, stdout, stderr].filter(Boolean).join("\n"), { cause: error })
  }
}

function npmJson(args, cwd = fixture) {
  return JSON.parse(run("npm", [...args, "--json", "--registry", registry], cwd))
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })
}

async function registryMetadata(requestedVersion) {
  if (!requestedVersion) return npmJson(["view", `${packageName}@latest`], root)
  assert(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(requestedVersion), `SUPERFLAG_PACKAGE_VERSION must be exact, received: ${requestedVersion}`)
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    try {
      const metadata = npmJson(["view", `${packageName}@${requestedVersion}`], root)
      if (!metadata.dist?.attestations?.url) throw new Error("npm provenance is not available yet")
      return metadata
    } catch (error) {
      if (attempt === 12) throw error
      console.log(`waiting for ${packageName}@${requestedVersion} in npm (${attempt}/12)`)
      await new Promise((resolve) => setTimeout(resolve, 10_000))
    }
  }
}

try {
  mkdirSync(fixture)
  mkdirSync(packed)
  const requestedVersion = process.env.SUPERFLAG_PACKAGE_VERSION?.trim()
  const metadata = await registryMetadata(requestedVersion)
  const version = metadata.version

  assert(typeof version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version), `Registry returned a non-exact version: ${version}`)
  assert(!requestedVersion || version === requestedVersion, `Expected ${packageName}@${requestedVersion}, received ${version}`)
  assert(metadata.dist?.integrity?.startsWith("sha512-"), "Published package is missing sha512 integrity metadata")
  assert(metadata.dist?.tarball?.startsWith(`${registry}@superflag-sh/react-native/-/`), `Unexpected tarball registry: ${metadata.dist?.tarball}`)
  assert(metadata.dist?.attestations?.provenance?.predicateType === "https://slsa.dev/provenance/v1", "Published package is missing npm provenance")
  assert(metadata.repository?.url === "git+https://github.com/superflag-sh/react-native.git", `Unexpected repository metadata: ${metadata.repository?.url}`)
  const attestationResponse = await fetch(metadata.dist.attestations.url)
  assert(attestationResponse.ok, `npm attestation endpoint returned ${attestationResponse.status}`)
  const attestations = (await attestationResponse.json()).attestations
  assert(Array.isArray(attestations) && attestations.some((entry) => entry.predicateType === "https://slsa.dev/provenance/v1"), "npm attestation bundle is missing SLSA provenance")
  assert(attestations.every((entry) => entry.bundle?.mediaType?.startsWith("application/vnd.dev.sigstore.bundle")), "npm returned an unexpected attestation bundle format")
  const provenance = attestations.find((entry) => entry.predicateType === "https://slsa.dev/provenance/v1")
  const statement = JSON.parse(Buffer.from(provenance.bundle.dsseEnvelope.payload, "base64").toString("utf8"))
  const subject = statement.subject?.find((entry) => entry.name === `pkg:npm/%40superflag-sh/react-native@${version}`)
  const expectedSha512 = Buffer.from(metadata.dist.integrity.slice("sha512-".length), "base64").toString("hex")
  assert(subject?.digest?.sha512 === expectedSha512, "SLSA subject does not match the published tarball integrity")
  const workflow = statement.predicate?.buildDefinition?.externalParameters?.workflow
  assert(workflow?.repository === "https://github.com/superflag-sh/react-native", `Unexpected provenance repository: ${workflow?.repository}`)
  assert(workflow?.path === ".github/workflows/publish.yml", `Unexpected provenance workflow: ${workflow?.path}`)
  assert(workflow?.ref === `refs/tags/v${version}`, `Unexpected provenance ref: ${workflow?.ref}`)

  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      name: "superflag-react-native-registry-pack",
      version: "1.0.0",
      private: true,
    }),
  )
  const packedResult = npmJson(["pack", `${packageName}@${version}`, "--ignore-scripts", "--pack-destination", packed], temp)[0]
  const tarball = filesUnder(packed).find((path) => path.endsWith(".tgz"))
  assert(tarball, "npm pack did not produce a registry tarball")
  assert(packedResult.integrity === metadata.dist.integrity, "Packed artifact integrity differs from registry metadata")
  const tarballIntegrity = `sha512-${createHash("sha512").update(readFileSync(tarball)).digest("base64")}`
  assert(tarballIntegrity === metadata.dist.integrity, "Downloaded tarball bytes differ from registry integrity metadata")
  const entries = run("tar", ["-tzf", tarball], temp).trim().split("\n")
  for (const required of [
    "package/dist/esm/index.js",
    "package/dist/cjs/index.js",
    "package/dist/cjs/package.json",
    "package/dist/types/index.d.ts",
  ]) {
    assert(entries.includes(required), `Registry tarball is missing ${required}`)
  }
  const exportTargets = new Set([
    metadata.main,
    metadata.module,
    metadata["react-native"],
    metadata.types,
    ...Object.values(metadata.exports?.["."] ?? {}),
  ].filter((value) => typeof value === "string"))
  for (const target of exportTargets) {
    assert(entries.includes(`package/${target.replace(/^\.\//, "")}`), `Package export target is missing from the registry artifact: ${target}`)
  }
  const leaked = entries.filter((entry) => /(?:^|\/)(?:src|scripts|smoke|__tests__)(?:\/|$)/.test(entry))
  assert(leaked.length === 0, `Registry tarball leaked source-only files: ${leaked.join(", ")}`)

  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify({
      name: "superflag-expo-registry-consumer",
      version: "1.0.0",
      private: true,
      type: "module",
      main: "index.js",
      dependencies: {
        "@react-native-async-storage/async-storage": "2.2.0",
        [packageName]: version,
        expo: "55.0.18",
        react: "19.2.0",
        "react-native": "0.83.1",
      },
      devDependencies: {
        "@types/react": "19.2.14",
        typescript: "5.9.3",
      },
    }),
  )
  writeFileSync(
    join(fixture, "app.json"),
    JSON.stringify({ expo: { name: "Superflag Registry Smoke", slug: "superflag-registry-smoke", jsEngine: "hermes" } }),
  )
  writeFileSync(
    join(fixture, "tsconfig.json"),
    JSON.stringify({
      compilerOptions: {
        strict: true,
        noEmit: true,
        jsx: "react-jsx",
        target: "ES2022",
        module: "ESNext",
        moduleResolution: "bundler",
        lib: ["ES2022"],
        types: ["react"],
      },
      include: ["App.tsx"],
    }),
  )
  writeFileSync(
    join(fixture, "App.tsx"),
    'import { Text } from "react-native";\n' +
      'import { SuperflagProvider, createTypedHooks, useBooleanFlag, useFlagDetails, type DiagnosticEvent } from "@superflag-sh/react-native";\n' +
      'type Flags = { "new-home": boolean };\n' +
      'const flags = createTypedHooks<Flags>();\n' +
      'function Screen() {\n' +
      '  const enabled = useBooleanFlag("new-home", false);\n' +
      '  const details = useFlagDetails("new-home", false);\n' +
      '  const typed = flags.useFlag("new-home", false);\n' +
      '  return <Text>{String(enabled && typed)}:{details?.reason}</Text>;\n' +
      '}\n' +
      'const onDiagnostic = (_event: DiagnosticEvent) => {};\n' +
      'export default function App() {\n' +
      '  return <SuperflagProvider clientKey="pub_prod_registry_smoke" targetingKey="registry-consumer" attributes={{ plan: "pro" }} onDiagnostic={onDiagnostic}><Screen /></SuperflagProvider>;\n' +
      '}\n',
  )
  writeFileSync(
    join(fixture, "index.js"),
    'import { registerRootComponent } from "expo";\nimport App from "./App";\nregisterRootComponent(App);\n',
  )
  writeFileSync(
    join(fixture, "smoke-esm.mjs"),
    'import { SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } from "@superflag-sh/react-native";\n' +
      'if (![SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("ESM exports missing");\n',
  )
  writeFileSync(
    join(fixture, "smoke-cjs.cjs"),
    'const { SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } = require("@superflag-sh/react-native");\n' +
      'if (![SuperflagProvider, createHostedTelemetryTransport, createSuperflagClient, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useEvaluationDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag].every((value) => typeof value === "function")) throw new Error("CommonJS exports missing");\n',
  )

  run("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund"], fixture)

  const lock = JSON.parse(readFileSync(join(fixture, "package-lock.json"), "utf8"))
  const serializedLock = JSON.stringify(lock)
  assert(!/(?:file|link|workspace):/.test(serializedLock), "Cold consumer lockfile contains a local dependency protocol")
  for (const [path, entry] of Object.entries(lock.packages ?? {})) {
    if (!path || entry.link) continue
    assert(typeof entry.resolved === "string" && entry.resolved.startsWith(registry), `Non-registry resolution in lockfile at ${path}: ${entry.resolved}`)
    assert(typeof entry.integrity === "string" && entry.integrity.startsWith("sha512-"), `Missing sha512 integrity in lockfile at ${path}`)
  }

  const installedManifest = JSON.parse(readFileSync(join(fixture, "node_modules", "@superflag-sh", "react-native", "package.json"), "utf8"))
  const coreManifest = JSON.parse(readFileSync(join(fixture, "node_modules", "@superflag-sh", "core", "package.json"), "utf8"))
  assert(installedManifest.version === version, `Installed ${packageName}@${installedManifest.version}; expected ${version}`)
  assert(installedManifest.dependencies?.[coreName] === "0.4.0", `SDK must pin exact ${coreName}@0.4.0, received ${installedManifest.dependencies?.[coreName]}`)
  assert(typeof coreManifest.version === "string" && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(coreManifest.version), `Core did not resolve to an exact registry version: ${coreManifest.version}`)
  assert(!/^(?:file|link|workspace):/.test(installedManifest.dependencies?.[coreName] ?? ""), "Published SDK manifest contains a local core dependency")
  const coreLock = lock.packages?.["node_modules/@superflag-sh/core"]
  assert(coreLock?.version === coreManifest.version, "Installed core and locked core versions differ")
  assert(coreLock?.resolved?.startsWith(`${registry}@superflag-sh/core/-/`), `Core did not resolve from npm: ${coreLock?.resolved}`)
  const fixtureRoot = realpathSync(fixture)
  for (const packagePath of [
    join(fixture, "node_modules", "@superflag-sh", "react-native"),
    join(fixture, "node_modules", "@superflag-sh", "core"),
  ]) {
    assert(realpathSync(packagePath).startsWith(fixtureRoot), `Installed package escaped the isolated fixture: ${packagePath}`)
  }

  run("node", ["smoke-esm.mjs"], fixture)
  run("node", ["smoke-cjs.cjs"], fixture)
  run(join(fixture, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json"], fixture)

  const exportDirectory = join(fixture, "dist")
  run(join(fixture, "node_modules", ".bin", "expo"), ["export", "--platform", "ios", "--output-dir", exportDirectory], fixture)
  const bytecode = filesUnder(exportDirectory).find((path) => path.endsWith(".hbc"))
  assert(bytecode && existsSync(bytecode), "Expo iOS export did not emit a Hermes bytecode bundle")
  assert(statSync(bytecode).size > 1024, `Hermes bytecode bundle is unexpectedly small: ${statSync(bytecode).size} bytes`)
  const header = readFileSync(bytecode).subarray(0, 8).toString("hex")
  assert(header === "c61fbc03c103191f", `Unexpected Hermes bytecode header: ${header}`)
  const hermesDirectory = process.platform === "darwin" ? "osx-bin" : "linux64-bin"
  const hermesc = join(fixture, "node_modules", "hermes-compiler", "hermesc", hermesDirectory, "hermesc")
  assert(existsSync(hermesc), `Hermes compiler is missing: ${hermesc}`)
  run(hermesc, ["-dump-bytecode", bytecode], fixture)

  console.log(`registry package: ${packageName}@${version}`)
  console.log(`registry core: ${coreName}@${coreManifest.version}`)
  console.log(`artifact: ${entries.length} files, sha512 integrity and npm provenance verified`)
  console.log(`cold lockfile: ${Object.keys(lock.packages ?? {}).length - 1} registry packages with integrity; no local protocols`)
  console.log("consumer: ESM, CommonJS, TypeScript, Expo iOS/Metro, and Hermes bytecode verified")
  console.log(`Hermes bundle: ${relative(fixture, bytecode)} (${statSync(bytecode).size} bytes)`)
} finally {
  rmSync(temp, { recursive: true, force: true })
}
