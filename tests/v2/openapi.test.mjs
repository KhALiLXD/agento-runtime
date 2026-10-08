import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readFileSync,
  readdirSync,
  mkdtempSync,
  writeFileSync,
  existsSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { stringify, parse } from "yaml";
import { generateConfig } from "agento-runtime/openapi";
import { compileConfig } from "../../dist/v2/config/compiler.js";
import { prepareRequest } from "../../dist/v2/execution/mapper.js";
import { AgentRuntime } from "agento-runtime";

const fixture = JSON.parse(
  readFileSync(
    new URL("../../examples/openapi/catalog.json", import.meta.url),
    "utf8",
  ),
);
const spec = () => ({
  openapi: "3.0.3",
  info: { title: "Test", version: "1" },
  servers: [{ url: "https://api.example.com/v1" }],
  paths: {
    "/items": {
      get: {
        operationId: "listItems",
        responses: { 200: { description: "OK" } },
      },
    },
  },
});
const operation = (doc) => doc.paths["/items"].get;
const generate = (doc, options) => generateConfig(JSON.stringify(doc), options);
const success = (result) => {
  assert.equal(result.ok, true, JSON.stringify(result.diagnostics));
  assert.deepEqual(parse(result.yaml), result.config);
  return result;
};
const failure = (doc, code, options) => {
  const result = generate(doc, options);
  assert.equal(result.ok, false);
  assert.equal(result.diagnostics.at(-1).code, code);
  assert.equal("config" in result, false);
  assert.equal("yaml" in result, false);
  assert.ok(result.diagnostics.at(-1).path.startsWith("#"));
};

test("JSON/YAML generate the same native config and local refs resolve", () => {
  const json = success(generate(fixture));
  assert.equal(
    json.yaml,
    readFileSync(
      new URL("../../examples/openapi/config.yml", import.meta.url),
      "utf8",
    ),
  );
  const yaml = success(generateConfig(stringify(fixture)));
  assert.deepEqual(json, yaml);
  assert.equal(json.config.version, "2");
  const compiled = compileConfig(json.yaml);
  assert.equal(compiled.tools.size, 3);
  const request = prepareRequest(compiled.executions.get("getItem").config, {
    input: {
      path: { id: "item 12" },
      query: { locale: "ar", fields: ["name", "details"] },
    },
    session: {},
    dependencies: {},
  });
  assert.equal(
    request.url,
    "https://api.example.com/v1/items/item%2012?fields=name&fields=details&locale=ar",
  );
  assert.equal(request.body, undefined);
  assert.equal(
    compiled.executions.get("deleteItem").config.behavior.effect,
    "destructive",
  );
});

test("deterministic ordering, stable fallback IDs, and no document mutation", () => {
  const doc = spec();
  delete operation(doc).operationId;
  doc.paths["/a/{id}"] = {
    get: {
      parameters: [
        { in: "path", name: "id", required: true, schema: { type: "integer" } },
      ],
      responses: { 200: { description: "OK" } },
    },
  };
  const before = structuredClone(doc);
  const a = success(generate(doc));
  doc.paths = Object.fromEntries(Object.entries(doc.paths).reverse());
  assert.equal(success(generate(doc)).yaml, a.yaml);
  assert.deepEqual(
    a.config.tools.map((t) => t.id),
    ["get_a_id", "get_items"],
  );
  assert.deepEqual(before.paths["/a/{id}"], doc.paths["/a/{id}"]);
});

test("operation parameters override inherited parameters by location and name", () => {
  const doc = spec();
  doc.paths["/items"].parameters = [
    { name: "q", in: "query", required: true, schema: { type: "integer" } },
  ];
  operation(doc).parameters = [
    { name: "q", in: "query", schema: { type: "string" } },
    { name: "q", in: "header", required: true, schema: { type: "string" } },
  ];
  const result = success(generate(doc));
  const input = result.config.tools[0].tool.input_schema;
  assert.equal(input.properties.query.properties.q.type, "string");
  assert.deepEqual(input.required, ["headers"]);
  assert.equal(input.properties.headers.properties.q.type, "string");
});

test("server precedence, variables, and explicit URL override preserve base paths", () => {
  const doc = spec();
  doc.paths["/items"].servers = [{ url: "https://path.example.com/base" }];
  operation(doc).servers = [
    {
      url: "https://{region}.example.com/{version}",
      variables: {
        region: { default: "eu" },
        version: { default: "v2", enum: ["v2"] },
      },
    },
  ];
  assert.equal(
    success(generate(doc)).config.tools[0].request.url,
    "https://eu.example.com/v2/items",
  );
  assert.equal(
    success(generate(doc, { baseUrl: "http://localhost:8080/test/" })).config
      .tools[0].request.url,
    "http://localhost:8080/test/items",
  );
  delete operation(doc).servers;
  assert.equal(
    success(generate(doc)).config.tools[0].request.url,
    "https://path.example.com/base/items",
  );
});

test("OpenAPI 3.0 nullable and exclusive bounds normalize to draft-07", () => {
  const doc = structuredClone(fixture);
  const props = doc.components.schemas.NewItem.properties;
  props.note = { type: "string", nullable: true };
  props.price = { type: "number", minimum: 0, exclusiveMinimum: true };
  const result = success(generate(doc));
  const schema = result.config.tools.find((t) => t.id === "createItem").tool
    .input_schema.properties.body.properties;
  assert.deepEqual(schema.note.type, ["string", "null"]);
  assert.equal(schema.price.minimum, undefined);
  assert.equal(schema.price.exclusiveMinimum, 0);
});

test("OpenAPI 3.1 supported schema subset compiles", () => {
  const doc = structuredClone(fixture);
  doc.openapi = "3.1.1";
  doc.components.schemas.NewItem.properties.note = { type: ["string", "null"] };
  success(generate(doc));
});

test("optional JSON body stays absent unless supplied", () => {
  const doc = structuredClone(fixture);
  delete doc.paths["/items"].post.requestBody.required;
  const compiled = compileConfig(success(generate(doc)).yaml);
  const tool = compiled.executions.get("createItem").config;
  assert.equal(
    prepareRequest(tool, { input: {}, session: {}, dependencies: {} }).body,
    undefined,
  );
  assert.deepEqual(tool.request.map.headers, {});
  assert.equal(
    prepareRequest(tool, {
      input: { body: { name: "Item" } },
      session: {},
      dependencies: {},
    }).body,
    '{"name":"Item"}',
  );
});

test("schema type mismatches and unsupported defaults fail explicitly", () => {
  for (const [schema, code] of [
    [{ type: ["string", "null"] }, "INVALID_SCHEMA"],
    [{ type: "string", properties: {} }, "INVALID_SCHEMA"],
    [{ type: "string", default: "value" }, "UNSUPPORTED_SCHEMA"],
  ]) {
    const doc = spec();
    operation(doc).parameters = [{ name: "q", in: "query", schema }];
    failure(doc, code);
  }
});

test("encoded dot segments and malformed server definitions fail without URL normalization", () => {
  const doc = spec();
  doc.servers[0].url = "https://example.com/base/%2e%2e/v1";
  failure(doc, "INVALID_SERVER");
  doc.servers[0].url = "https://example.com/v1";
  doc.paths["/a/%2e%2e/items"] = doc.paths["/items"];
  delete doc.paths["/items"];
  failure(doc, "INVALID_PATH");
  const nullServer = spec();
  operation(nullServer).servers = null;
  failure(nullServer, "INVALID_DOCUMENT");
});

test("bearer and API key map to runtime credentials, never model inputs or secret values", () => {
  const doc = spec();
  doc.components = {
    securitySchemes: {
      Bearer: { type: "http", scheme: "bearer" },
      Key: { type: "apiKey", in: "header", name: "X-API-Key" },
    },
  };
  doc.security = [{ Bearer: [] }];
  assert.deepEqual(success(generate(doc)).config.tools[0].request.auth, {
    type: "session",
  });
  operation(doc).security = [];
  assert.deepEqual(success(generate(doc)).config.tools[0].request.auth, {
    type: "none",
  });
  operation(doc).security = [{ Key: [] }];
  failure(doc, "API_KEY_ENV_REQUIRED");
  const result = success(
    generate(doc, { apiKeyEnv: { Key: "CATALOG_API_KEY" } }),
  );
  assert.deepEqual(result.config.tools[0].request.auth, {
    type: "api-key",
    env: "CATALOG_API_KEY",
    header: "X-API-Key",
  });
  assert.equal(result.yaml.includes("generator-validation-only"), false);
  assert.deepEqual(result.config.tools[0].tool.input_schema.properties, {});
  compileConfig(result.yaml, { CATALOG_API_KEY: "real-value-only-at-runtime" });
});

for (const [method, effect, confirmation] of [
  ["get", "read-only", false],
  ["head", "read-only", false],
  ["post", "side-effect", true],
  ["put", "side-effect", true],
  ["patch", "side-effect", true],
  ["delete", "destructive", true],
]) {
  test(`${method.toUpperCase()} has conservative effect and confirmation`, () => {
    const doc = spec();
    const op = operation(doc);
    doc.paths["/items"] = { [method]: op };
    const tool = success(generate(doc)).config.tools[0];
    assert.equal(tool.behavior.effect, effect);
    assert.equal(tool.behavior.confirmation.required, confirmation);
  });
}

const errorCases = [
  [
    "Swagger 2",
    "UNSUPPORTED_VERSION",
    (d) => {
      delete d.openapi;
      d.swagger = "2.0";
    },
  ],
  [
    "3.2",
    "UNSUPPORTED_VERSION",
    (d) => {
      d.openapi = "3.2.0";
    },
  ],
  [
    "missing paths",
    "INVALID_DOCUMENT",
    (d) => {
      delete d.paths;
    },
  ],
  [
    "empty paths",
    "NO_OPERATIONS",
    (d) => {
      d.paths = {};
    },
  ],
  [
    "ambiguous servers",
    "SERVER_SELECTION_REQUIRED",
    (d) => {
      d.servers.push({ url: "https://other.example.com" });
    },
  ],
  [
    "relative servers",
    "INVALID_SERVER",
    (d) => {
      d.servers[0].url = "/v1";
    },
  ],
  [
    "unsafe servers",
    "INVALID_SERVER",
    (d) => {
      d.servers[0].url = "https://user:password@example.com";
    },
  ],
  [
    "duplicate operation IDs",
    "DUPLICATE_OPERATION_ID",
    (d) => {
      d.paths["/other"] = { get: structuredClone(operation(d)) };
    },
  ],
  [
    "invalid ID",
    "UNSUPPORTED_NAME",
    (d) => {
      operation(d).operationId = "list.items";
    },
  ],
  [
    "external ref",
    "UNSUPPORTED_REFERENCE",
    (d) => {
      d.paths["/items"] = { $ref: "https://example.com/spec.json#/item" };
    },
  ],
  [
    "missing local ref",
    "UNRESOLVED_REFERENCE",
    (d) => {
      d.paths["/items"] = { $ref: "#/missing" };
    },
  ],
  [
    "cyclic ref",
    "CYCLIC_REFERENCE",
    (d) => {
      d.paths["/items"] = { $ref: "#/paths/~1items" };
    },
  ],
  [
    "validation ref sibling",
    "UNSUPPORTED_REFERENCE",
    (d) => {
      d.paths["/other"] = { $ref: "#/paths/~1items", parameters: [] };
    },
  ],
  [
    "path mismatch",
    "PATH_PARAMETER_MISMATCH",
    (d) => {
      d.paths["/items/{id}"] = d.paths["/items"];
      delete d.paths["/items"];
    },
  ],
  [
    "cookie parameter",
    "UNSUPPORTED_PARAMETER",
    (d) => {
      operation(d).parameters = [
        { name: "tracking", in: "cookie", schema: { type: "string" } },
      ];
    },
  ],
  [
    "deepObject",
    "UNSUPPORTED_SERIALIZATION",
    (d) => {
      operation(d).parameters = [
        {
          name: "filter",
          in: "query",
          style: "deepObject",
          schema: { type: "object" },
        },
      ];
    },
  ],
  [
    "non-exploded query array",
    "UNSUPPORTED_SERIALIZATION",
    (d) => {
      operation(d).parameters = [
        {
          name: "q",
          in: "query",
          explode: false,
          schema: { type: "array", items: { type: "string" } },
        },
      ];
    },
  ],
  [
    "credential input",
    "UNSUPPORTED_NAME",
    (d) => {
      operation(d).parameters = [
        { name: "access_token", in: "query", schema: { type: "string" } },
      ];
    },
  ],
  [
    "null security",
    "INVALID_DOCUMENT",
    (d) => {
      operation(d).security = null;
    },
  ],
  [
    "combined security",
    "UNSUPPORTED_SECURITY",
    (d) => {
      d.security = [{ A: [], B: [] }];
    },
  ],
  [
    "alternative security",
    "UNSUPPORTED_SECURITY",
    (d) => {
      d.security = [{ A: [] }, {}];
    },
  ],
  [
    "OPTIONS",
    "UNSUPPORTED_METHOD",
    (d) => {
      d.paths["/items"].options = operation(d);
    },
  ],
  [
    "callbacks",
    "UNSUPPORTED_CALLBACKS",
    (d) => {
      operation(d).callbacks = {};
    },
  ],
  [
    "webhooks",
    "UNSUPPORTED_WEBHOOKS",
    (d) => {
      d.webhooks = {};
    },
  ],
  [
    "unsupported schema",
    "UNSUPPORTED_SCHEMA",
    (d) => {
      operation(d).parameters = [
        {
          name: "q",
          in: "query",
          schema: { type: "string", oneOf: [{ type: "string" }] },
        },
      ];
    },
  ],
  [
    "invalid constraints",
    "CONFIG_VALIDATION_FAILED",
    (d) => {
      operation(d).parameters = [
        { name: "q", in: "query", schema: { type: "string", minLength: -1 } },
      ];
    },
  ],
];
for (const [name, code, mutate] of errorCases)
  test(`fails without partial config: ${name}`, () => {
    const doc = spec();
    mutate(doc);
    failure(doc, code);
  });

test("invalid YAML, duplicate keys, and excessive aliases are rejected", () => {
  for (const text of [
    "[unterminated",
    "openapi: 3.0.3\nopenapi: 3.1.1",
    "a: &a [1,2]\nb: &b [*a,*a,*a,*a,*a,*a,*a,*a,*a,*a]\nc: [*b,*b,*b,*b,*b,*b,*b,*b,*b,*b]",
  ]) {
    const result = generateConfig(text);
    assert.equal(result.ok, false);
    assert.equal(result.diagnostics.at(-1).code, "PARSE_ERROR");
  }
});

test("recursive component schemas and unsafe property names fail with diagnostics", () => {
  const doc = structuredClone(fixture);
  doc.components.schemas.NewItem.properties.child = {
    $ref: "#/components/schemas/NewItem",
  };
  failure(doc, "CYCLIC_REFERENCE");
  delete doc.components.schemas.NewItem.properties.child;
  doc.components.schemas.NewItem.properties.constructor = { type: "string" };
  failure(doc, "UNSUPPORTED_NAME");
});

test("bodies that cannot be represented by current mapper fail explicitly", () => {
  for (const edit of [
    (s) => {
      delete s.additionalProperties;
    },
    (s) => {
      s.type = "array";
      s.items = { type: "string" };
    },
    (s) => {
      s.required = [];
    },
    (s) => {
      s.properties.name.readOnly = true;
    },
  ]) {
    const doc = structuredClone(fixture);
    edit(doc.components.schemas.NewItem);
    assert.equal(generate(doc).ok, false);
  }
  const doc = structuredClone(fixture);
  const body = doc.paths["/items"].post.requestBody;
  body.content = { "multipart/form-data": body.content["application/json"] };
  assert.equal(generate(doc).ok, false);
});

test("CLI writes reviewable YAML, refuses overwrite, and leaves no file on failure", () => {
  const dir = mkdtempSync(join(tmpdir(), "agento-openapi-"));
  const cli = fileURLToPath(
    new URL("../../dist/openapi/cli.js", import.meta.url),
  );
  try {
    const input = join(dir, "openapi.yaml");
    const output = join(dir, "config.yml");
    writeFileSync(input, stringify(fixture));
    execFileSync(process.execPath, [cli, input, "--output", output], {
      stdio: "pipe",
    });
    compileConfig(readFileSync(output, "utf8"));
    const before = readFileSync(output, "utf8");
    const repeat = spawnSync(
      process.execPath,
      [cli, input, "--output", output],
      { encoding: "utf8" },
    );
    assert.equal(repeat.status, 1);
    assert.match(repeat.stderr, /EEXIST/);
    assert.equal(readFileSync(output, "utf8"), before);
    writeFileSync(input, "openapi: nope");
    const failedOutput = join(dir, "failed.yml");
    assert.equal(
      spawnSync(process.execPath, [cli, input, "--output", failedOutput])
        .status,
      1,
    );
    assert.equal(existsSync(failedOutput), false);
    assert.equal(
      spawnSync(process.execPath, [
        cli,
        input,
        "--output",
        failedOutput,
        "--unknown",
        "x",
      ]).status,
      1,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runtime source does not import the generator; root export does not expose it", async () => {
  const root = await import("agento-runtime");
  assert.equal(root.generateConfig, undefined);
  const walk = (dir) =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(join(dir, e.name)) : [join(dir, e.name)],
    );
  for (const file of walk(
    fileURLToPath(new URL("../../src/v2", import.meta.url)),
  ))
    assert.doesNotMatch(
      readFileSync(file, "utf8"),
      /(?:from|import\()\s*["'][^"']*openapi/,
    );
});

test("generated YAML executes against a real HTTP server and POST waits for confirmation", async () => {
  const requests = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push({
      method: req.method,
      url: req.url,
      body,
      contentType: req.headers["content-type"],
    });
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  let runtime;
  try {
    const doc = structuredClone(fixture);
    delete doc.paths["/items/{id}"].delete;
    const result = success(
      generate(doc, {
        baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
      }),
    );
    runtime = await AgentRuntime.create({ config: result.yaml });
    const get = await runtime.invoke({
      sessionId: "read",
      tool: "getItem",
      arguments: {
        path: { id: "abc" },
        query: { fields: ["name", "details"] },
      },
    });
    assert.equal(get.status, "completed");
    assert.equal(requests[0].url, "/v1/items/abc?fields=name&fields=details");
    const missing = await runtime.invoke({
      sessionId: "missing",
      tool: "createItem",
      arguments: {},
    });
    assert.equal(missing.status, "needs_input");
    const post = await runtime.invoke({
      sessionId: "write",
      tool: "createItem",
      arguments: { body: { name: "Test", details: { active: true } } },
    });
    assert.equal(post.status, "needs_confirmation");
    assert.equal(requests.length, 1);
    const confirmed = await runtime.confirm({
      sessionId: "write",
      confirmationId: post.confirmation.id,
    });
    assert.equal(confirmed.status, "completed");
    assert.equal(requests.length, 2);
    assert.equal(requests[1].method, "POST");
    assert.deepEqual(JSON.parse(requests[1].body), {
      name: "Test",
      details: { active: true },
    });
    assert.equal(requests[1].contentType, "application/json");
  } finally {
    runtime?.dispose();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});
