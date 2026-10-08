import type { AgentConfigV2 } from "../v2/config/schema.js";
import { sensitiveKey } from "../v2/security/redactor.js";
import { resolve } from "./parse.js";
import { convertSchema, validName } from "./schema.js";
import {
  object,
  list,
  reject,
  type Diagnostic,
  type GeneratorOptions,
  type Node,
} from "./types.js";

const methods = [
  "get",
  "head",
  "post",
  "put",
  "patch",
  "delete",
  "options",
  "trace",
];
const reservedHeaders = [
  "host",
  "content-length",
  "connection",
  "transfer-encoding",
  "authorization",
  "cookie",
  "set-cookie",
  "content-type",
];
const own = (n: Node, k: string): unknown =>
  Object.hasOwn(n, k) ? n[k] : undefined;

function serverUrl(
  root: Node,
  item: Node,
  op: Node,
  options: GeneratorOptions,
  path: string,
): string {
  let url = options.baseUrl;
  if (url === undefined) {
    const servers = list(
      Object.hasOwn(op, "servers")
        ? op.servers
        : Object.hasOwn(item, "servers")
          ? item.servers
          : Object.hasOwn(root, "servers")
            ? root.servers
            : [],
      path + "/servers",
    );
    if (servers.length !== 1)
      reject(
        "SERVER_SELECTION_REQUIRED",
        path,
        "Provide baseUrl when servers is missing, empty, or ambiguous.",
      );
    const server = object(servers[0], path + "/servers/0");
    if (typeof server.url !== "string")
      reject("INVALID_SERVER", path, "Server URL must be a string.");
    url = server.url;
    const variables = object(
      server.variables ?? {},
      path + "/servers/0/variables",
    );
    url = url.replace(/\{([^{}]+)\}/g, (_match, name: string) => {
      const variable = object(
        own(variables, name),
        path + "/servers/0/variables/" + name,
      );
      if (typeof variable.default !== "string")
        reject(
          "INVALID_SERVER",
          path,
          "Server variable requires a string default.",
        );
      if (
        variable.enum !== undefined &&
        !list(variable.enum, path).includes(variable.default)
      )
        reject(
          "INVALID_SERVER",
          path,
          "Server variable default must belong to enum.",
        );
      return variable.default;
    });
  }
  try {
    const parsed = new URL(url);
    if (
      !["http:", "https:"].includes(parsed.protocol) ||
      parsed.username ||
      parsed.password ||
      parsed.search ||
      parsed.hash ||
      /[{}\\\s]/.test(url) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(url)
    )
      throw new Error("url");
    return url.replace(/\/+$/, "");
  } catch {
    return reject(
      "INVALID_SERVER",
      path,
      "Provide an absolute HTTP(S) URL without credentials, query, fragment, or unresolved variables.",
    );
  }
}

function auth(
  root: Node,
  op: Node,
  options: GeneratorOptions,
  path: string,
):
  | { type: "none" }
  | { type: "session" }
  | { type: "api-key"; env: string; header: string } {
  const requirements = list(
    Object.hasOwn(op, "security")
      ? op.security
      : Object.hasOwn(root, "security")
        ? root.security
        : [],
    path + "/security",
  );
  if (!requirements.length) return { type: "none" };
  if (requirements.length !== 1)
    reject(
      "UNSUPPORTED_SECURITY",
      path,
      "Alternative security requirements need manual selection.",
    );
  const requirement = object(requirements[0], path + "/security/0");
  const names = Object.keys(requirement);
  if (!names.length) return { type: "none" };
  if (names.length !== 1)
    reject(
      "UNSUPPORTED_SECURITY",
      path,
      "Combined security schemes are unsupported.",
    );
  const name = names[0];
  if (list(requirement[name], path + "/security/0/" + name).length)
    reject("UNSUPPORTED_SECURITY", path, "OAuth scopes are unsupported.");
  const components = object(root.components ?? {}, "#/components");
  const schemes = object(
    components.securitySchemes ?? {},
    "#/components/securitySchemes",
  );
  const scheme = resolve(
    root,
    own(schemes, name),
    "#/components/securitySchemes/" + name,
  );
  if (
    scheme.type === "http" &&
    typeof scheme.scheme === "string" &&
    scheme.scheme.toLowerCase() === "bearer"
  )
    return { type: "session" };
  if (
    scheme.type === "apiKey" &&
    scheme.in === "header" &&
    typeof scheme.name === "string" &&
    /^[A-Za-z0-9-]+$/.test(scheme.name) &&
    !reservedHeaders.includes(scheme.name.toLowerCase())
  ) {
    const env =
      options.apiKeyEnv && Object.hasOwn(options.apiKeyEnv, name)
        ? options.apiKeyEnv[name]
        : undefined;
    if (!env || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(env))
      reject(
        "API_KEY_ENV_REQUIRED",
        path,
        "Provide apiKeyEnv for security scheme " + name + ".",
      );
    return { type: "api-key", env, header: scheme.name };
  }
  return reject(
    "UNSUPPORTED_SECURITY",
    path,
    "Supported authentication: HTTP bearer or API key in a header.",
  );
}

function parameters(root: Node, values: unknown, path: string): Node[] {
  const result = list(values ?? [], path).map((v, i) =>
    resolve(root, v, path + "/" + i),
  );
  const ids = new Set<string>();
  for (const p of result) {
    if (typeof p.name !== "string" || typeof p.in !== "string")
      reject(
        "INVALID_PARAMETER",
        path,
        "Parameter name and in are required strings.",
      );
    const key = p.in + ":" + p.name;
    if (ids.has(key))
      reject(
        "DUPLICATE_PARAMETER",
        path,
        "Duplicate parameter in the same scope.",
      );
    ids.add(key);
  }
  return result;
}

export function mapOperations(
  root: Node,
  options: GeneratorOptions,
  diagnostics: Diagnostic[],
): AgentConfigV2["tools"] {
  const paths = object(root.paths, "#/paths");
  const tools: AgentConfigV2["tools"] = [];
  const ids = new Set<string>();
  for (const route of Object.keys(paths).sort()) {
    if (route.startsWith("x-")) continue;
    const pointer = "#/paths/" + route.replace(/~/g, "~0").replace(/\//g, "~1");
    const item = resolve(root, paths[route], pointer);
    if (
      !route.startsWith("/") ||
      /[?#\\\s]/.test(route) ||
      /(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(route)
    )
      reject(
        "INVALID_PATH",
        pointer,
        "Expected an absolute API path without query, fragment, whitespace, backslash, or dot segments.",
      );
    const inherited = parameters(
      root,
      item.parameters,
      pointer + "/parameters",
    );
    for (const method of methods) {
      if (!Object.hasOwn(item, method)) continue;
      const path = pointer + "/" + method;
      if (["options", "trace"].includes(method))
        reject(
          "UNSUPPORTED_METHOD",
          path,
          "AGENTO does not support this HTTP method.",
        );
      const op = object(item[method], path);
      if (op.callbacks !== undefined)
        reject(
          "UNSUPPORTED_CALLBACKS",
          path,
          "Callbacks require manual modeling.",
        );
      const responses = object(op.responses, path + "/responses");
      if (!Object.keys(responses).length)
        reject(
          "INVALID_OPERATION",
          path,
          "Operation responses cannot be empty.",
        );
      const explicitId = op.operationId;
      if (explicitId !== undefined && typeof explicitId !== "string")
        reject("INVALID_OPERATION_ID", path, "operationId must be a string.");
      const id =
        (explicitId as string | undefined) ??
        method +
          "_" +
          route
            .replace(/[{}]/g, "")
            .replace(/[^A-Za-z0-9_-]+/g, "_")
            .replace(/^_+|_+$/g, "");
      validName(id, path + "/operationId");
      if (ids.has(id))
        reject(
          "DUPLICATE_OPERATION_ID",
          path,
          "Tool ID collision; assign unique operationId values.",
        );
      ids.add(id);
      const props: Node = {};
      const required: string[] = [];
      const map = {
        path: {} as Record<string, string>,
        query: {} as Record<string, string>,
        headers: {} as Record<string, string>,
        body: {} as Record<string, string>,
      };
      const merged = new Map(inherited.map((p) => [p.in + ":" + p.name, p]));
      for (const p of parameters(root, op.parameters, path + "/parameters"))
        merged.set(p.in + ":" + p.name, p);
      for (const p of merged.values()) {
        const name = p.name as string;
        const location = p.in as string;
        const ppath = path + "/parameters/" + location + "/" + name;
        if (!["path", "query", "header"].includes(location))
          reject(
            "UNSUPPORTED_PARAMETER",
            ppath,
            "Only path, query, and header parameters are supported.",
          );
        validName(name, ppath);
        if (
          p.content !== undefined ||
          p.allowReserved === true ||
          p.allowEmptyValue === true
        )
          reject(
            "UNSUPPORTED_SERIALIZATION",
            ppath,
            "Parameter content, allowReserved, and allowEmptyValue require manual mapping.",
          );
        if (p.required !== undefined && typeof p.required !== "boolean")
          reject("INVALID_PARAMETER", ppath, "required must be boolean.");
        if (location === "path" && p.required !== true)
          reject(
            "INVALID_PARAMETER",
            ppath,
            "Path parameters must be required.",
          );
        const schema = convertSchema(root, p.schema, ppath + "/schema");
        const array = schema.type === "array";
        if (
          array
            ? location !== "query" ||
              !["string", "number", "integer", "boolean"].includes(
                String(object(schema.items, ppath).type),
              )
            : !["string", "number", "integer", "boolean"].includes(
                String(schema.type),
              )
        )
          reject(
            "UNSUPPORTED_SERIALIZATION",
            ppath,
            "Parameters must be non-null scalars, or scalar arrays in query.",
          );
        const style = location === "query" ? "form" : "simple";
        if (
          (p.style !== undefined && p.style !== style) ||
          (p.explode !== undefined && typeof p.explode !== "boolean") ||
          (array && p.explode === false)
        )
          reject(
            "UNSUPPORTED_SERIALIZATION",
            ppath,
            "Only simple scalar path/headers and form scalar/repeated query parameters are supported.",
          );
        const group = (location === "header" ? "headers" : location) as
          "path" | "query" | "headers";
        if (
          group === "headers" &&
          (reservedHeaders.includes(name.toLowerCase()) ||
            sensitiveKey(name) ||
            Object.keys(map.headers).some(
              (k) => k.toLowerCase() === name.toLowerCase(),
            ))
        )
          reject(
            "UNSUPPORTED_HEADER",
            ppath,
            "Reserved, credential, or duplicate header; use security schemes for authentication.",
          );
        const groupSchema = (props[group] as Node | undefined) ?? {
          type: "object",
          properties: {},
          required: [],
          additionalProperties: false,
        };
        (groupSchema.properties as Node)[name] = schema;
        if (p.required === true) {
          (groupSchema.required as string[]).push(name);
          if (!required.includes(group)) required.push(group);
        }
        props[group] = groupSchema;
        map[group][name] = "$." + group + "." + name;
      }
      const placeholders = [...route.matchAll(/\{([A-Za-z0-9_-]+)\}/g)].map(
        (m) => m[1],
      );
      if (
        /[{}]/.test(route.replace(/\{[A-Za-z0-9_-]+\}/g, "")) ||
        placeholders.some((p) => !Object.hasOwn(map.path, p)) ||
        Object.keys(map.path).some((p) => !placeholders.includes(p))
      )
        reject(
          "PATH_PARAMETER_MISMATCH",
          path,
          "Path placeholders and declared path parameters must match.",
        );
      if (op.requestBody !== undefined) {
        if (["get", "head"].includes(method))
          reject(
            "UNSUPPORTED_BODY",
            path,
            "GET/HEAD request bodies are unsupported.",
          );
        const body = resolve(root, op.requestBody, path + "/requestBody");
        if (body.required !== undefined && typeof body.required !== "boolean")
          reject("INVALID_BODY", path, "requestBody.required must be boolean.");
        const content = object(body.content, path + "/requestBody/content");
        if (
          Object.keys(content).length !== 1 ||
          !Object.hasOwn(content, "application/json")
        )
          reject(
            "UNSUPPORTED_BODY",
            path,
            "Only a single application/json media type without encoding is supported.",
          );
        const media = object(
          content["application/json"],
          path + "/requestBody/content/application~1json",
        );
        if (media.encoding !== undefined)
          reject(
            "UNSUPPORTED_BODY",
            path,
            "JSON media encoding is unsupported.",
          );
        const schema = convertSchema(
          root,
          media.schema,
          path + "/requestBody/schema",
        );
        if (
          schema.type !== "object" ||
          schema.additionalProperties !== false ||
          !Object.keys(schema.properties as Node).length
        )
          reject(
            "UNSUPPORTED_BODY",
            path,
            "JSON body must be a non-null object with named properties and explicit additionalProperties: false.",
          );
        if (!Array.isArray(schema.required) || !schema.required.length)
          reject(
            "UNSUPPORTED_BODY",
            path,
            "Body schema must require at least one named property; the runtime cannot emit an empty JSON object body.",
          );
        props.body = schema;
        if (body.required === true) required.push("body");
        for (const name of Object.keys(schema.properties as Node))
          map.body[name] = "$.body." + name;
        // The HTTP executor sets content-type only when a JSON body is emitted.
      }
      const authentication = auth(root, op, options, path);
      if (
        authentication.type === "api-key" &&
        Object.keys(map.headers).some(
          (h) => h.toLowerCase() === authentication.header.toLowerCase(),
        )
      )
        reject(
          "UNSUPPORTED_HEADER",
          path,
          "Mapped header conflicts with the API key header.",
        );
      const readOnly = ["get", "head"].includes(method);
      const description =
        typeof op.description === "string" && op.description.trim()
          ? op.description
          : typeof op.summary === "string" && op.summary.trim()
            ? op.summary
            : method.toUpperCase() + " " + route;
      tools.push({
        id,
        tool: {
          ...(typeof op.summary === "string" ? { title: op.summary } : {}),
          description,
          input_schema: {
            type: "object",
            properties: props,
            required,
            additionalProperties: false,
          },
        },
        request: {
          method: method.toUpperCase() as
            "GET" | "HEAD" | "POST" | "PUT" | "PATCH" | "DELETE",
          url: serverUrl(root, item, op, options, path) + route,
          auth: authentication,
          map,
        },
        behavior: {
          effect: readOnly
            ? "read-only"
            : method === "delete"
              ? "destructive"
              : "side-effect",
          confirmation: { required: !readOnly },
        },
      });
    }
  }
  if (!tools.length)
    reject("NO_OPERATIONS", "#/paths", "No supported operations found.");
  diagnostics.push({
    severity: "warning",
    code: "REVIEW_REQUIRED",
    path: "#",
    message:
      "Review descriptions, effects, authentication, response presentation, and workflow dependencies. Response schemas/links, models, routing hints, and dependencies are not inferred.",
  });
  if (root.webhooks !== undefined)
    reject(
      "UNSUPPORTED_WEBHOOKS",
      "#/webhooks",
      "Webhooks require manual modeling.",
    );
  return tools;
}
