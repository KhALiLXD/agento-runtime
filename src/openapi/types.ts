import type { AgentConfigV2 } from "../v2/config/schema.js";

export interface Diagnostic {
  severity: "error" | "warning";
  code: string;
  path: string;
  message: string;
}
export interface GeneratorOptions {
  /** Absolute HTTP(S) server URL; overrides OpenAPI servers. */
  baseUrl?: string;
  /** Security scheme name -> environment variable name, never a secret value. */
  apiKeyEnv?: Record<string, string>;
}
export type GeneratorResult =
  | { ok: true; config: AgentConfigV2; yaml: string; diagnostics: Diagnostic[] }
  | { ok: false; diagnostics: Diagnostic[] };
export type Node = Record<string, unknown>;

export class GenerationError extends Error {
  constructor(public readonly diagnostic: Diagnostic) {
    super(diagnostic.message);
  }
}
export function reject(code: string, path: string, message: string): never {
  throw new GenerationError({ severity: "error", code, path, message });
}
export function object(value: unknown, path: string): Node {
  if (!value || typeof value !== "object" || Array.isArray(value))
    reject("INVALID_DOCUMENT", path, "Expected an object.");
  return value as Node;
}
export function list(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value))
    reject("INVALID_DOCUMENT", path, "Expected an array.");
  return value;
}
