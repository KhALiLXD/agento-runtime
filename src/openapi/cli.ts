#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { generateConfig, type GeneratorOptions } from "./index.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) {
    console.log(
      "Usage: agento-openapi <openapi.json|openapi.yaml> --output <config.yml> [--base-url <url>] [--api-key-env <scheme=ENV_NAME>]\nExisting output files are never overwritten. Diagnostics go to stderr.",
    );
    return;
  }
  const input = args.shift();
  if (!input || input.startsWith("-"))
    throw new Error("Provide an OpenAPI input file. See --help.");
  let output: string | undefined;
  const options: GeneratorOptions = {
    apiKeyEnv: Object.create(null) as Record<string, string>,
  };
  while (args.length) {
    const flag = args.shift();
    const value = args.shift();
    if (!value || value.startsWith("--"))
      throw new Error("Each option needs a value.");
    if (flag === "--output" && output === undefined) output = value;
    else if (flag === "--base-url" && options.baseUrl === undefined)
      options.baseUrl = value;
    else if (flag === "--api-key-env") {
      const match = /^([^=]+)=([A-Za-z_][A-Za-z0-9_]*)$/.exec(value);
      if (!match || Object.hasOwn(options.apiKeyEnv!, match[1]))
        throw new Error("Use a unique scheme=ENV_NAME for --api-key-env.");
      options.apiKeyEnv![match[1]] = match[2];
    } else throw new Error("Unknown or duplicate option: " + flag);
  }
  if (!output) throw new Error("Provide --output <config.yml>.");
  const result = generateConfig(await readFile(input, "utf8"), options);
  for (const d of result.diagnostics)
    console.error(`${d.severity} ${d.code} ${d.path}: ${d.message}`);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }
  await writeFile(output, result.yaml, { flag: "wx" });
  console.log("Generated " + output);
}
main().catch((error) => {
  console.error(
    "agento-openapi: " +
      (error instanceof Error ? error.message : "Generation failed."),
  );
  process.exitCode = 1;
});
