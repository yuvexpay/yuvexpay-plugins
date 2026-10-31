# YuvexPay Plugins

Community plugin manifests for the YuvexPay app store.

A plugin is a single declarative JSON file. It maps a YuvexPay event onto an outbound HTTP request. There is no code to write and no code to run — the manifest is data, and YuvexPay executes it.

## How a manifest reaches production

1. You open a pull request.
2. CI validates the JSON Schema and the security rules.
3. A maintainer approves (CODEOWNERS; manifest changes require security review).
4. GitHub auto-merge merges once checks are green and the approval is in.
5. A post-merge workflow publishes every manifest on `main` to production.

The backend **re-validates every manifest server-side** before storing it — schema, egress allowlist and SSRF rules are enforced again there. Repo CI is a fast signal, not the security boundary.

This repository is the single source of truth. A manifest deleted here is disabled in production on the next publish; it is never hard-deleted, so existing installs stop receiving events without erroring.

Installs of the first-party plugins (`utmify`, `meta-capi`, `ga4`) move to the newly published version on publish, unless the merchant turned automatic updates off for that install. Installs of every other plugin stay pinned to the version they installed. A first-party version bump therefore reaches existing merchants immediately, with their current config: never add a required config field to one.

Plugins only receive live-mode events. Sandbox never dispatches.

## Contributing

1. Fork this repository.
2. Add `plugins/<your-plugin-id>.json`. The filename must match the manifest `id`.
3. Open a pull request. CI validates the schema and the security rules.
4. A YuvexPay maintainer reviews and merges.

## Manifest

A manifest without `manifestVersion` is v1: a list of `actions`, each one request per event. `"manifestVersion": 2` keeps everything v1 has and adds `flows` (see below). Any other `manifestVersion` is rejected, and `flows` without `"manifestVersion": 2` is rejected.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "developer": "Your Company",
  "description": "What this plugin does.",
  "configSchema": {
    "type": "object",
    "properties": {
      "apiKey": { "type": "string", "title": "API Key", "secret": true }
    },
    "required": ["apiKey"]
  },
  "events": ["payment.paid"],
  "scopes": ["data"],
  "egress": ["api.example.com"],
  "actions": [
    {
      "on": "payment.paid",
      "request": {
        "method": "POST",
        "url": "https://api.example.com/events",
        "headers": { "authorization": "Bearer {{ config.apiKey }}" },
        "body": {
          "order_id": "{{ event.data.payment.id }}",
          "value": "{{ event.data.payment.amountCents | cents_to_decimal }}"
        }
      }
    }
  ]
}
```

| field | rule |
|---|---|
| `manifestVersion` | absent (v1) or `2` |
| `id` | 2 to 64 chars, lowercase kebab-case, equal to the filename |
| `name`, `developer` | 1 to 80 chars |
| `version` | `MAJOR.MINOR.PATCH` |
| `description` | up to 500 chars |
| `icon` | `https://cdn.yuvexpay.com/...`, up to 500 chars |
| `configSchema` | `type: "object"`; each property has `type` (`string`, `number`, `boolean`) and optional `title` (120), `description` (500), `secret`, `default` |
| `events` | v1: at least 1. v2: optional, at most 20 |
| `scopes` | at least 1, must include `data` |
| `egress` | 1 to 20 entries. v2: at most 2 distinct hosts |
| `actions` | v1: 1 to 20. v2: 0 to 20 |
| `flows` | v2 only, up to 10. v2 needs at least one action or one flow |
| `request.method` | `POST`, `PUT` or `PATCH` |
| `request.url` | absolute `https://` url with a literal host |
| `request.headers` | string values, optional |
| `request.body` | any JSON, nested at most 12 levels |

Config values marked `secret: true` are stored encrypted, and redacted from the delivery log along with any header whose name contains `authorization`, `token`, `secret`, `api-key`, `signature` or `cookie`.

## Events

| event | when |
|---|---|
| `payment.created` | a charge was created, before payment |
| `payment.paid` | a charge was paid |
| `payment.refunded` | a charge was refunded |
| `withdrawal.paid` | a withdrawal settled |
| `med.opened` | a PIX dispute (MED) was opened |

## Scopes

Scopes decide which blocks of the event your plugin actually receives. A block you do not request arrives as `null`. Merchants see the scope list before installing, so request the minimum you need.

| scope | grants |
|---|---|
| `data` | transaction data. Always required. |
| `tracking` | UTMs, click IDs, browser IDs, payer IP and user agent |
| `customer.contact` | customer email and phone |
| `customer.document` | customer CPF/CNPJ |

`event.tracking` carries `utmSource`, `utmMedium`, `utmCampaign`, `utmTerm`, `utmContent`, `src`, `sck`, `fbclid`, `gclid`, `ttclid`, `gaClientId` (GA4 client id, `<digits>.<digits>`), `fbp` (Meta `_fbp`), `fbc` (Meta `_fbc`), `clientIp` and `userAgent`. A field the checkout did not capture is `null`, and the whole block is `null` when nothing was captured.

## Templates

Use `{{ ... }}` to read from `event.*` and `config.*`, and inside a flow also `steps.*`. Values may be piped through a fixed set of functions:

| function | effect |
|---|---|
| `sha256` | SHA-256 hex digest |
| `lower` | lowercase |
| `trim` | strip surrounding whitespace |
| `digits_only` | remove every non-digit |
| `cents_to_decimal` | `4990` becomes the number `49.9` |
| `iso8601` | normalize to an ISO-8601 UTC timestamp |
| `datetime_utc` | `YYYY-MM-DD HH:MM:SS` in UTC |
| `unix_seconds` | integer Unix seconds |
| `not` | boolean negation |
| `value_map:K=V,...` | translate a value to a provider enum, optional `*=fallback` |
| `fallback:pathOrLiteral` | substitute when the value is null or blank |
| `ga_client_id` | normalize a `_ga` cookie, or derive a deterministic client id |

Functions chain left to right: `{{ event.customer.contact.email | trim | lower | sha256 }}`.

Two functions take an argument after a colon. `value_map` maps a value onto the enum a provider accepts, and falls back to `*` when given:

```
{{ event.data.payment.method | value_map:PIX=pix,CARD=credit_card,BOLETO=boleto,*=unknown }}
```

`fallback` substitutes another path — or a literal, when the argument is not rooted at `event` or `config`:

```
{{ event.data.payment.description | fallback:Pagamento YuvexPay }}
```

There are no loops, no conditionals, and no arbitrary expressions. A missing value stays `null` through the whole chain — it is never coerced into a hash of the empty string.

**Numbers stay numbers.** When a whole string is a single expression, the rendered value keeps its native JSON type. `"value": "{{ ... | cents_to_decimal }}"` sends `49.9`, not `"49.9"` — GA4 and Meta reject a stringified monetary value.

**Missing values are sent as `null`.** A whole-string expression that resolves to nothing renders JSON `null`; the key is never omitted. A string that mixes literal text and expressions renders a missing value as an empty string. There is no way to drop a key, so map only fields the provider accepts as `null`.

Limits: a template string is at most 8192 chars with at most 64 expressions of at most 512 chars each, and a rendered value is at most 8192 chars. Every `{{` must be closed by `}}`.

## Skipping an action

An action may declare `requires`, a list of dotted event paths that must be non-null for it to fire:

```json
{
  "on": "payment.created",
  "requires": ["event.customer.name", "event.customer.contact.email"],
  "request": { "...": "..." }
}
```

If any path is null or blank at delivery time, the delivery is recorded as `SKIPPED` and nothing is sent. `SKIPPED` is a terminal status distinct from `FAILED` — it is not an error and does not count as a failure.

This is how a provider with mandatory fields stays correct. On hosted checkout the payer fills in their contact details *after* the charge is created, so `payment.created` has no email yet; the action skips cleanly instead of posting a null and getting a `400`.

`requires` entries start with `event.` or `config.`, have no empty segment, and are 3 to 200 chars.

## Flows (manifestVersion 2)

A flow is a trigger plus an ordered list of steps.

```json
{
  "manifestVersion": 2,
  "flows": [
    {
      "id": "on-paid",
      "trigger": { "type": "event", "event": "payment.paid" },
      "steps": [
        {
          "id": "big-only",
          "type": "condition",
          "when": { "left": "event.data.payment.amountCents", "op": "gte", "right": { "value": 10000 } },
          "onFalse": "stop"
        },
        {
          "id": "lookup",
          "type": "request",
          "request": { "method": "POST", "url": "https://api.example.com/lookup", "body": { "id": "{{ event.data.payment.id }}" } }
        },
        {
          "id": "push",
          "type": "request",
          "requires": ["steps.lookup.response.body.ok"],
          "request": { "method": "POST", "url": "https://api.example.com/push", "body": { "ref": "{{ steps.lookup.response.body.ref }}" } }
        }
      ]
    }
  ]
}
```

Triggers:

| type | fields | fires |
|---|---|---|
| `event` | `event`, which must be declared in `events` | on that event |
| `schedule` | `cron` (5 fields, 9 to 120 chars), `timezone` (only `America/Sao_Paulo`, the default) | at most once every 60 minutes |
| `http` | `id`, unique per manifest | when the install's trigger url is called |

Steps run in order. Step ids are 2 to 48 chars of `a-z`, `0-9`, `-` and `_`, unique within the flow; `stop` is reserved.

- `request` steps take the same `request` and `requires` as an action. `requires` may also name `steps.*` paths. A step reads earlier steps only as `steps.<id>.response.status` and `steps.<id>.response.body.*`; reading a later step, an unknown step, or anything other than `response` is rejected.
- `condition` steps evaluate `when`. True continues with the next step. False jumps to `onFalse`, which is `stop` or the id of a later step; jumping backwards is rejected.

`when` is a comparison `{ "left": path, "op": op, "right": operand }` or a group `{ "all": [...] }` / `{ "any": [...] }` of 1 to 10 predicates, nested at most 4 deep. Operators: `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, `starts_with`, `in`, `exists`. An operand is `{ "value": literal }`, `{ "path": path }` or, for `in` only, `{ "values": [literal, ...] }` with 1 to 50 literals. `exists` takes no operand. Literals are strings up to 500 chars, numbers, booleans or `null`.

Limits: 10 flows per manifest, 12 steps per flow, and 2 distinct hosts across `egress`, actions and steps. The backend reads the last three from `PLUGIN_MAX_STEPS_PER_PLUGIN`, `PLUGIN_MAX_EGRESS_HOSTS` and `PLUGIN_MIN_SCHEDULE_INTERVAL_MINUTES`; this repository checks their defaults.

## Tests

`npm test` renders every manifest against a synthetic canonical event and asserts the output against each provider's documented schema — enum values, required non-null fields, date formats, and numeric-not-string types. It also runs the schema and the security rules against v1 and v2 manifests, valid and invalid.

`scripts/render.mjs`, `scripts/cron.mjs` and `scripts/secret-scan.mjs` are ports of the backend template engine, cron parser and secret scan. Like `scripts/validate.mjs`, they duplicate backend logic on purpose so this repository can be validated on its own; they must be updated when the backend changes.

## Security rules

CI rejects a manifest that breaks any of these, so a merged pull request cannot introduce SSRF:

- Every request URL, in actions and in flow steps, must be `https://` with a **literal** host. Templated hosts are rejected.
- Every request host must appear in the manifest `egress` allowlist.
- `egress` entries must be bare, lowercase, fully-qualified hosts — no scheme, port, or path.
- A v2 manifest reaches at most 2 distinct hosts.
- Private, loopback, link-local and cloud-metadata ranges are rejected, including `169.254.169.254`.
- First-party YuvexPay infrastructure is rejected.
- Only the functions listed above are allowed. `__proto__`, `constructor` and `prototype` path segments are rejected, in `requires` entries as well as in expressions.
- Only published event types are allowed.
- A secret written as a literal (JWT, prefixed API key, long hex or high-entropy run) in a url, header or body is rejected. The backend rejects the same at publish, which fails the whole publish run. Read secrets from `{{ config.<key> }}` with `secret: true`.

## Local checks

```bash
npm ci
npm run validate
npm run validate:schema
```

## License

MIT
