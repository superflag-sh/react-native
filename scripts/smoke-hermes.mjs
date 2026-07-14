import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const coreRoot = process.env.SUPERFLAG_CORE_DIR ?? join(root, "node_modules", "@superflag-sh", "core")
const temp = mkdtempSync(join(tmpdir(), "superflag-expo-hermes-"))
const tarball = join(temp, "package.tgz")
const coreTarball = join(temp, "core.tgz")
const bundle = join(temp, "index.bundle.js")
const bytecode = join(temp, "index.bundle.hbc")

function run(command, args, cwd = root) {
  return execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    env: { ...process.env, NODE_PATH: "" },
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
  })
}

function pack(sourceRoot, destination) {
  const result = JSON.parse(run("npm", ["pack", "--ignore-scripts", "--json", "--cache", join(temp, ".npm-cache"), "--pack-destination", temp], sourceRoot))
  renameSync(join(temp, result[0].filename), destination)
}

try {
  pack(root, tarball)
  pack(coreRoot, coreTarball)
  writeFileSync(
    join(temp, "package.json"),
    JSON.stringify({
      name: "superflag-expo-hermes-fixture",
      version: "1.0.0",
      private: true,
      type: "module",
      dependencies: {
        "@react-native-async-storage/async-storage": "2.2.0",
        "@superflag-sh/core": "file:./core.tgz",
        "@superflag-sh/react-native": "file:./package.tgz",
        expo: "55.0.18",
        react: "19.2.0",
        "react-native": "0.83.1",
      },
    }),
  )
  writeFileSync(join(temp, "app.json"), JSON.stringify({ expo: { name: "SuperflagSmoke", slug: "superflag-smoke", jsEngine: "hermes" } }))
  writeFileSync(
    join(temp, "metro.config.cjs"),
    'const { getDefaultConfig } = require("expo/metro-config");\nmodule.exports = getDefaultConfig(__dirname);\n',
  )
  writeFileSync(
    join(temp, "index.js"),
    'import { SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag } from "@superflag-sh/react-native";\n' +
      "const exportsUnderTest = [SuperflagProvider, createTypedHooks, useBooleanFlag, useBooleanFlagDetails, useFlag, useFlagDetails, useFlags, useNumberFlag, useNumberFlagDetails, useObjectFlag, useObjectFlagDetails, useStringFlag, useStringFlagDetails, useSuperflagClient, useTypedFlag];\n" +
      'if (!exportsUnderTest.every((value) => typeof value === "function")) throw new Error("SDK startup exports missing");\n' +
      'globalThis.__SUPERFLAG_HERMES_SMOKE__ = "ok";\n',
  )

  run(
    "npm",
    ["install", "--ignore-scripts", "--legacy-peer-deps", "--no-audit", "--no-fund", "--package-lock=false"],
    temp,
  )
  run(process.execPath, ["index.js"], temp)

  const expo = join(temp, "node_modules", ".bin", "expo")
  run(
    expo,
    [
      "export:embed",
      "--entry-file", "index.js",
      "--platform", "ios",
      "--dev", "false",
      "--minify",
      "--bundle-output", bundle,
      "--assets-dest", join(temp, "assets"),
    ],
    temp,
  )

  const hermesDirectory = process.platform === "darwin" ? "osx-bin" : "linux64-bin"
  const hermesc = join(temp, "node_modules", "hermes-compiler", "hermesc", hermesDirectory, "hermesc")
  if (!existsSync(hermesc)) throw new Error(`Hermes compiler missing from fixture dependencies: ${hermesc}`)
  run(hermesc, ["-emit-binary", "-out", bytecode, bundle], temp)
  run(hermesc, ["-dump-bytecode", bytecode], temp)

  const header = readFileSync(bytecode).subarray(0, 8).toString("hex")
  if (header !== "c61fbc03c103191f") throw new Error(`Unexpected Hermes bytecode header: ${header}`)
  if (statSync(bytecode).size < 1024) throw new Error("Hermes bytecode output is unexpectedly small")

  console.log("clean Expo fixture install: packed SDK plus declared dependencies only")
  console.log("runtime package import/startup assertion: ok")
  console.log("Expo Metro resolution and Hermes bytecode validation: ok")
} finally {
  rmSync(temp, { recursive: true, force: true })
}
