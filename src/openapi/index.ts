import { stringify } from "yaml";
import { compileConfig } from "../v2/config/compiler.js";
import { AgentRuntimeError } from "../v2/errors.js";
import { parseOpenApi } from "./parse.js";
import { mapOperations } from "./map.js";
import {
  GenerationError,
  type Diagnostic,
  type GeneratorOptions,
  type GeneratorResult,
} from "./types.js";
export type { Diagnostic, GeneratorOptions, GeneratorResult } from "./types.js";

/** Pure, deterministic authoring step. No network, file writes, model calls, or runtime changes. */
export function generateConfig(
  source: string,
  options: GeneratorOptions = {},
): GeneratorResult {
  const diagnostics: Diagnostic[] = [];
  try {
    const root = parseOpenApi(source);
    const config = {
      version: "2" as const,
      tools: mapOperations(root, options, diagnostics),
    };
    // Validate using the existing config compiler without reading host secrets.
    // Sentinels validate environment *references* only; they never enter output or execute.
    const env: NodeJS.ProcessEnv = Object.fromEntries(
      config.tools.flatMap((t) =>
        t.request.auth?.type === "api-key"
          ? [[t.request.auth.env, "generator-validation-only"]]
          : [],
      ),
    );
    compileConfig(config, env);
    const yaml =
      "# Generated from OpenAPI. Review before use.\n" +
      stringify(config, { lineWidth: 0, sortMapEntries: true });
    return { ok: true, config, yaml, diagnostics };
  } catch (error) {
    diagnostics.push(
      error instanceof GenerationError
        ? error.diagnostic
        : {
            severity: "error",
            code: "CONFIG_VALIDATION_FAILED",
            path: "#",
            message:
              "Generated configuration failed AGENTO validation" +
              (error instanceof AgentRuntimeError
                ? " (" + error.code + ")"
                : "") +
              ". Review schema constraints, names, URL transport, and mappings.",
          },
    );
    return { ok: false, diagnostics };
  }
}
