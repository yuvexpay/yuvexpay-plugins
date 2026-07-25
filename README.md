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

Installed merchants stay pinned to the plugin version they installed. Publishing a new version does not change behaviour for existing installs.

## Contributing

1. Fork this repository.
2. Add `plugins/<your-plugin-id>.json`. The filename must match the manifest `id`.
3. Open a pull request. CI validates the schema and the security rules.
4. A YuvexPay maintainer reviews and merges.

## Manifest

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
| `tracking` | UTMs, click IDs, payer IP and user agent |
| `customer.contact` | customer email and phone |
| `customer.document` | customer CPF/CNPJ |

## Templates

Use `{{ ... }}` to read from `event.*` and `config.*`. Values may be piped through a fixed set of functions:

| function | effect |
|---|---|
| `sha256` | SHA-256 hex digest |
| `lower` | lowercase |
| `trim` | strip surrounding whitespace |
| `digits_only` | remove every non-digit |
| `cents_to_decimal` | `4990` becomes `"49.90"` |
| `iso8601` | normalize to an ISO-8601 UTC timestamp |

Functions chain left to right: `{{ event.customer.contact.email | trim | lower | sha256 }}`.

There are no loops, no conditionals, and no arbitrary expressions. A missing value stays `null` through the whole chain — it is never coerced into a hash of the empty string.

## Security rules

CI rejects a manifest that breaks any of these, so a merged pull request cannot introduce SSRF:

- Every request URL must be `https://` with a **literal** host. Templated hosts are rejected.
- Every request host must appear in the manifest `egress` allowlist.
- `egress` entries must be bare, lowercase, fully-qualified hosts — no scheme, port, or path.
- Private, loopback, link-local and cloud-metadata ranges are rejected, including `169.254.169.254`.
- First-party YuvexPay infrastructure is rejected.
- Only the six functions above are allowed. `__proto__`, `constructor` and `prototype` path segments are rejected.
- Only published event types are allowed.

## Local checks

```bash
npm ci
npm run validate
npm run validate:schema
```

## License

MIT
