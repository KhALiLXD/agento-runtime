# OpenAPI config generator

`agento-runtime/openapi` is an offline authoring tool. It reads OpenAPI JSON or
YAML and emits the existing AGENTO v2 `config.yml` contract. Review that file,
edit it, and pass it to `AgentRuntime` normally. The runtime never reads OpenAPI,
imports the generator, or resolves OpenAPI references.

## Run it

From a repository checkout:

```bash
npm run build
node dist/openapi/cli.js examples/openapi/catalog.json --output config.yml
```

After installing a package containing this change:

```bash
agento-openapi openapi.yaml --output config.yml
agento-openapi openapi.json --output config.yml --base-url https://api.example.com/v1
agento-openapi openapi.yaml --output config.yml --api-key-env CatalogKey=CATALOG_API_KEY
```

The CLI requires an explicit output path and refuses to overwrite existing files.
Diagnostics go to stderr. Parse, conversion, validation, read, or write failure
exits with status 1. A conversion failure produces no output file.

```js
import { readFile, writeFile } from "node:fs/promises";
import { generateConfig } from "agento-runtime/openapi";

const result = generateConfig(await readFile("openapi.yaml", "utf8"), {
  baseUrl: "https://api.example.com/v1",
  apiKeyEnv: { CatalogKey: "CATALOG_API_KEY" },
});
if (!result.ok) {
  console.error(result.diagnostics);
  process.exitCode = 1;
} else {
  console.error(result.diagnostics);
  await writeFile("config.yml", result.yaml, { flag: "wx" });
}
```

`baseUrl` overrides all server definitions. Otherwise the operation, path, then
document server definition takes precedence. Exactly one server must be available;
relative URLs, missing servers, and multiple servers require `baseUrl`. Server
variables use their declared string defaults. The server's base path is retained.

## Implementation boundaries

| File                    | Responsibility                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `src/openapi/parse.ts`  | Parse JSON/YAML, reject duplicate keys and excessive aliases, check version/structure, resolve local JSON Pointers. |
| `src/openapi/schema.ts` | Normalize a supported schema subset to draft-07; check names and recursion.                                         |
| `src/openapi/map.ts`    | Merge inherited parameters, select server, map operations/authentication/effects to native tools.                   |
| `src/openapi/index.ts`  | Coordinate conversion, validate through the existing config compiler, serialize deterministic YAML.                 |
| `src/openapi/types.ts`  | Public options, result union, and diagnostics.                                                                      |
| `src/openapi/cli.ts`    | Local file reads and exclusive output writes.                                                                       |

No new dependencies are needed. Only the CLI performs file I/O. The generator
does not call models, APIs, or `AgentRuntime`, and does not read process environment
variables. It reuses the existing config compiler to verify the output. API key
environment references are checked with temporary validation sentinels, which are
never serialized or used for requests. Real secrets are supplied at runtime.

## Mapping contract

The result is `{ ok: true, config, yaml, diagnostics }` on success. On failure,
it is `{ ok: false, diagnostics }`, without a partial config or YAML. Conversion
stops at the first error, including its source location when available. A final
config-validation error includes the AGENTO error code. This is a converter for
a documented subset, not a complete OpenAPI validator.

| OpenAPI                   | AGENTO output                                                                                                               |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `operationId`             | `tools[].id`; absent IDs derive from method and path. Invalid IDs or collisions fail.                                       |
| `summary` / `description` | Tool title / description; missing description falls back to method and path.                                                |
| Path parameters           | `input_schema.properties.path`, `request.map.path.id: $.path.id`.                                                           |
| Query parameters          | `input_schema.properties.query`, `request.map.query.q: $.query.q`.                                                          |
| Header parameters         | `input_schema.properties.headers`, `request.map.headers.X-Locale: $.headers.X-Locale`.                                      |
| JSON object body          | `input_schema.properties.body`, one mapping per top-level field, e.g. `name: $.body.name`. Nested JSON values are retained. |
| Required parameters       | Required fields within their group; the group is required when it contains any required field.                              |
| `requestBody.required`    | Makes `body` required. Optional bodies remain absent if no body argument is supplied.                                       |
| GET / HEAD                | `read-only`, confirmation disabled.                                                                                         |
| POST / PUT / PATCH        | `side-effect`, confirmation required.                                                                                       |
| DELETE                    | `destructive`, confirmation required.                                                                                       |
| HTTP bearer               | `request.auth.type: session`; token comes from the host at runtime.                                                         |
| Header API key            | `request.auth: { type: api-key, env, header }`; `apiKeyEnv` supplies the environment variable name.                         |

Location groups prevent collisions when the same name appears in query, path,
headers, or body. Generated root/group schemas reject undeclared input fields.
Operation parameters override path parameters with the same `(in, name)` pair.
Duplicate parameters within one scope fail.

A generated GET tool has this shape:

```yaml
version: "2"
tools:
  - id: getItem
    tool:
      title: Get an item
      description: Get an item
      input_schema:
        type: object
        properties:
          path:
            type: object
            properties:
              id: { type: string, minLength: 1 }
            required: [id]
            additionalProperties: false
        required: [path]
        additionalProperties: false
    request:
      method: GET
      url: https://api.example.com/v1/items/{id}
      auth: { type: none }
      map:
        path: { id: $.path.id }
        query: {}
        headers: {}
        body: {}
    behavior:
      effect: read-only
      confirmation: { required: false }
```

Runtime invocation uses `arguments: { path: { id: "123" } }`. No OpenAPI input is
needed after generation. Add model configuration or supply a model through the
existing runtime API before using natural-language routing.

## Supported scope and failure cases

This first implementation accepts OpenAPI 3.0.x and 3.1.x. Supported schemas have
explicit primitive/object/array types, named object properties, required fields,
enums/const, numeric/string/array/object constraints, recognized standard formats,
and local nonrecursive references. OpenAPI 3.0 `nullable` and boolean exclusive
bounds normalize to draft-07. OpenAPI numeric formats (`int32`, `int64`, `float`,
`double`) are annotations and are omitted; bounds must be explicit. Metadata such
as examples, titles, XML descriptions, and vendor extensions is not copied.

| Failure                                                   | Diagnostic / required action                                                                                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Invalid JSON/YAML, duplicate keys, excessive aliases      | `PARSE_ERROR`; fix source syntax.                                                                                                                                                                                                                                                                                                                                |
| Swagger 2 or another OpenAPI version                      | `UNSUPPORTED_VERSION`; use 3.0 or 3.1.                                                                                                                                                                                                                                                                                                                           |
| External, missing, or recursive reference                 | `UNSUPPORTED_REFERENCE`, `UNRESOLVED_REFERENCE`, `CYCLIC_REFERENCE`; bundle external refs or simplify schemas. Reference validation siblings fail instead of being dropped.                                                                                                                                                                                      |
| Ambiguous or relative server URL                          | `SERVER_SELECTION_REQUIRED` / `INVALID_SERVER`; provide `baseUrl`. Credentials/query/fragment in server URLs fail.                                                                                                                                                                                                                                               |
| Duplicate IDs, unsafe names, unresolved path placeholders | `DUPLICATE_OPERATION_ID`, `UNSUPPORTED_NAME`, `PATH_PARAMETER_MISMATCH`; rename or correct declarations.                                                                                                                                                                                                                                                         |
| Unsupported serialization                                 | `UNSUPPORTED_SERIALIZATION`; only simple scalar path/headers and form scalar/repeated-array query values are supported. No nullable parameter values, object parameters, CSV arrays, `deepObject`, reserved/empty-value overrides, or parameter `content`.                                                                                                       |
| Unsupported request body                                  | `UNSUPPORTED_BODY`; only one `application/json` media type is accepted. The top-level schema must be a non-null object with explicit `additionalProperties: false`, named properties, and at least one required property. This prevents silent field loss and bodies that the current mapper cannot emit. No multipart, form, scalar, array, or GET/HEAD bodies. |
| Unsupported schema semantics                              | `UNSUPPORTED_SCHEMA`; composition, defaults, boolean schemas, `readOnly` inputs, custom formats, and newer dialect keywords require a follow-up implementation. These are rejected rather than weakened.                                                                                                                                                         |
| Unsupported authentication                                | `UNSUPPORTED_SECURITY` / `API_KEY_ENV_REQUIRED`; explicitly supply API key environment names. No Basic/OAuth/OIDC, query/cookie API keys, combined schemes, or alternative schemes. Operation `security: []` disables inherited authentication.                                                                                                                  |
| Credential/reserved/conflicting headers                   | `UNSUPPORTED_HEADER`; use security schemes and runtime-managed transport headers. The executor sets JSON Content-Type.                                                                                                                                                                                                                                           |
| OPTIONS / TRACE, callbacks, webhooks                      | `UNSUPPORTED_METHOD`, `UNSUPPORTED_CALLBACKS`, `UNSUPPORTED_WEBHOOKS`; model separately.                                                                                                                                                                                                                                                                         |
| Invalid native config/schema constraints                  | `CONFIG_VALIDATION_FAILED`; the message identifies the existing AGENTO validation code.                                                                                                                                                                                                                                                                          |

All successful results carry `REVIEW_REQUIRED`. Response schemas/links,
dependencies, selection/navigation, routing hints, assistant identity, and models
are not inferred. Existing runtime defaults handle response presentation until the
generated file is edited. Descriptions and HTTP-method effects still need domain
review; a GET endpoint with application side effects must be configured manually.

## Verification and next extensions

`npm run test:openapi` covers JSON/YAML parity, config compilation, request mapping,
local references, server precedence, parameter overrides, supported schema
normalization, credentials, effects, failure cases, CLI writes, and separation
from runtime exports. A real loopback HTTP test verifies GET requests and POST
body serialization, with no request before confirmation.

The fixture is `examples/openapi/catalog.json`; `examples/openapi/config.yml` is
its reproducible output. Extend schema/serialization conversion only where the
existing native mapping can represent it faithfully. External-ref bundling,
operation allowlists, richer schemas, and response/workflow authoring are suitable
follow-ups. A future whole-body mapping capability would be a separate runtime
feature, not part of OpenAPI support.
