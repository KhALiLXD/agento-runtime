import { sensitiveKey } from "../v2/security/redactor.js";
import { resolve } from "./parse.js";
import { object, list, reject, type Node } from "./types.js";

const annotations = new Set([
  "title",
  "description",
  "example",
  "examples",
  "deprecated",
  "xml",
  "externalDocs",
  "readOnly",
  "writeOnly",
]);
const scalarKeywords = new Set([
  "enum",
  "const",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);
const formats = new Set([
  "date",
  "time",
  "date-time",
  "duration",
  "uri",
  "uri-reference",
  "uri-template",
  "url",
  "email",
  "hostname",
  "ipv4",
  "ipv6",
  "regex",
  "uuid",
  "json-pointer",
  "relative-json-pointer",
]);

export function validName(name: string, path: string): void {
  if (
    !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(name) ||
    ["__proto__", "constructor", "prototype"].includes(name) ||
    sensitiveKey(name)
  )
    reject(
      "UNSUPPORTED_NAME",
      path,
      "Name cannot be represented safely in an AGENTO mapping/input schema.",
    );
}

/** Supported schema subset normalized to draft-07 for AGENTO's existing validator. */
export function convertSchema(
  root: Node,
  input: unknown,
  path: string,
  ancestors: Node[] = [],
): Node {
  const source = resolve(root, input, path);
  if (ancestors.includes(source) || ancestors.length >= 64)
    reject(
      "CYCLIC_REFERENCE",
      path,
      "Recursive or excessively deep schemas are unsupported.",
    );
  const next = [...ancestors, source];
  const out: Node = {};
  if (source.readOnly === true)
    reject(
      "UNSUPPORTED_SCHEMA",
      path,
      "readOnly input properties require a request-specific schema.",
    );
  for (const key of Object.keys(source)) {
    if (annotations.has(key) || key.startsWith("x-")) continue;
    if (
      ![
        "type",
        "properties",
        "required",
        "items",
        "additionalProperties",
        "nullable",
        "format",
        ...scalarKeywords,
      ].includes(key)
    )
      reject(
        "UNSUPPORTED_SCHEMA",
        path,
        "Unsupported schema keyword: " + key + ".",
      );
  }
  const types = Array.isArray(source.type) ? source.type : [source.type];
  if (String(root.openapi).startsWith("3.0.") && Array.isArray(source.type))
    reject(
      "INVALID_SCHEMA",
      path,
      "OpenAPI 3.0 requires a single schema type; use nullable for null.",
    );
  if (
    !types.length ||
    types.some(
      (t) =>
        ![
          "string",
          "number",
          "integer",
          "boolean",
          "object",
          "array",
          "null",
        ].includes(String(t)),
    )
  )
    reject(
      "UNSUPPORTED_SCHEMA",
      path,
      "An explicit supported schema type is required.",
    );
  out.type = source.type;
  if (
    (!types.includes("object") &&
      ["properties", "required", "additionalProperties"].some(
        (key) => source[key] !== undefined,
      )) ||
    (!types.includes("array") && source.items !== undefined)
  )
    reject(
      "INVALID_SCHEMA",
      path,
      "Object/array keywords require the corresponding explicit type.",
    );
  if (source.nullable !== undefined) {
    if (
      !String(root.openapi).startsWith("3.0.") ||
      typeof source.nullable !== "boolean" ||
      Array.isArray(source.type)
    )
      reject(
        "UNSUPPORTED_SCHEMA",
        path,
        "nullable is supported only with a single type in OpenAPI 3.0.",
      );
    if (source.nullable) out.type = [source.type, "null"];
  }
  if (source.description !== undefined) out.description = source.description;
  for (const key of scalarKeywords)
    if (source[key] !== undefined) out[key] = source[key];
  if (String(root.openapi).startsWith("3.0.")) {
    for (const [exclusive, bound] of [
      ["exclusiveMinimum", "minimum"],
      ["exclusiveMaximum", "maximum"],
    ]) {
      if (typeof source[exclusive] === "boolean") {
        delete out[exclusive];
        if (source[exclusive]) {
          if (typeof source[bound] !== "number")
            reject(
              "INVALID_SCHEMA",
              path,
              "Exclusive bounds need a numeric bound.",
            );
          out[exclusive] = source[bound];
          delete out[bound];
        }
      }
    }
  }
  if (source.format !== undefined) {
    if (typeof source.format !== "string")
      reject("INVALID_SCHEMA", path, "format must be a string.");
    if (formats.has(source.format)) out.format = source.format;
    else if (!["int32", "int64", "float", "double"].includes(source.format))
      reject(
        "UNSUPPORTED_SCHEMA",
        path,
        "Unsupported format: " + source.format + ".",
      );
  }
  if (types.includes("object")) {
    const props = object(source.properties ?? {}, path + "/properties");
    out.properties = Object.fromEntries(
      Object.entries(props).map(([key, value]) => {
        validName(key, path + "/properties/" + key);
        return [
          key,
          convertSchema(root, value, path + "/properties/" + key, next),
        ];
      }),
    );
    if (source.required !== undefined) {
      const required = list(source.required, path + "/required");
      if (
        required.some((k) => typeof k !== "string" || !Object.hasOwn(props, k))
      )
        reject(
          "INVALID_SCHEMA",
          path,
          "Required fields must exist in properties.",
        );
      out.required = required;
    }
    out.additionalProperties =
      source.additionalProperties === undefined
        ? true
        : typeof source.additionalProperties === "boolean"
          ? source.additionalProperties
          : convertSchema(
              root,
              source.additionalProperties,
              path + "/additionalProperties",
              next,
            );
  }
  if (types.includes("array"))
    out.items = convertSchema(root, source.items, path + "/items", next);
  return out;
}
