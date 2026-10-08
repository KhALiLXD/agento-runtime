import { parseDocument } from "yaml";
import { object, reject, type Node } from "./types.js";

/** Parse JSON/YAML without I/O, remote resolution, or execution. */
export function parseOpenApi(source: string): Node {
  let value: unknown;
  try {
    const doc = parseDocument(source, { uniqueKeys: true });
    if (doc.errors.length)
      reject("PARSE_ERROR", "#", "Invalid JSON/YAML or duplicate keys.");
    value = doc.toJS({ maxAliasCount: 50 });
  } catch {
    return reject(
      "PARSE_ERROR",
      "#",
      "Invalid JSON/YAML or excessive YAML aliases.",
    );
  }
  const root = object(value, "#");
  if (
    typeof root.openapi !== "string" ||
    !/^3\.(?:0|1)\.\d+$/.test(root.openapi)
  )
    reject(
      "UNSUPPORTED_VERSION",
      "#/openapi",
      "Expected OpenAPI 3.0.x or 3.1.x.",
    );
  const info = object(root.info, "#/info");
  if (
    typeof info.title !== "string" ||
    !info.title.trim() ||
    typeof info.version !== "string"
  )
    reject(
      "INVALID_DOCUMENT",
      "#/info",
      "info.title and info.version are required strings.",
    );
  object(root.paths, "#/paths");
  return root;
}

/** Resolve only local JSON Pointers; chains and schema recursion are bounded. */
export function resolve(
  root: Node,
  value: unknown,
  path: string,
  stack: string[] = [],
): Node {
  const node = object(value, path);
  if (node.$ref === undefined) return node;
  if (typeof node.$ref !== "string" || !node.$ref.startsWith("#/"))
    reject(
      "UNSUPPORTED_REFERENCE",
      path,
      "Only local #/ JSON Pointer references are supported; bundle external references first.",
    );
  const ref = node.$ref;
  if (stack.includes(ref) || stack.length >= 64)
    reject(
      "CYCLIC_REFERENCE",
      path,
      "Recursive references are not supported by this generator.",
    );
  if (
    Object.keys(node).some(
      (k) => k !== "$ref" && k !== "summary" && k !== "description",
    )
  )
    reject(
      "UNSUPPORTED_REFERENCE",
      path,
      "Reference siblings with validation or mapping semantics are unsupported.",
    );
  let target: unknown = root;
  let parts: string[];
  try {
    parts = decodeURIComponent(ref.slice(2))
      .split("/")
      .map((part) => {
        if (/~(?:[^01]|$)/.test(part)) throw new Error("pointer");
        return part.replace(/~1/g, "/").replace(/~0/g, "~");
      });
  } catch {
    return reject("INVALID_REFERENCE", path, "Invalid JSON Pointer encoding.");
  }
  for (const part of parts) {
    if (!target || typeof target !== "object" || !Object.hasOwn(target, part))
      reject(
        "UNRESOLVED_REFERENCE",
        path,
        "Local reference target does not exist.",
      );
    target = (target as Node)[part];
  }
  return resolve(root, target, path, [...stack, ref]);
}
