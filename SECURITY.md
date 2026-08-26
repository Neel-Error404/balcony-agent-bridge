# Security Policy

## Supported Versions

Balcony Agent Bridge has not yet published a supported release. The project is
licensed under Apache-2.0, but the current `0.1.0` package remains private while
public-release review is in progress.

## Reporting A Vulnerability

Do not open a public issue containing credentials, private endpoints, message
contents, exploit details, or identifying deployment information.

When the public repository is created, use its private vulnerability-reporting
channel. If that channel is unavailable, contact the maintainers privately
through the repository owner's published security contact. A concrete security
contact must be added before the first public release.

Include the affected version or commit, impact, reproduction conditions, and
whether any credentials or live systems may have been exposed. Do not test
against infrastructure you do not own or have explicit permission to assess.

## Security Boundaries

- Credentials and machine configuration stay outside Git and npm artifacts.
- Azure-hosted workers use managed identity.
- An explicitly approved physical host may use a dedicated Entra application
  with a machine-local client certificate.
- Client secrets, shared access keys, SAS tokens, Azure CLI credentials, and
  chained credential fallbacks are prohibited.
- Production broker messages require a whole-envelope Ed25519 signature under
  an explicit local network membership policy. Broker authorization alone is
  not treated as sender identity.
- The private signing key is loaded only by the bridge service. It is not
  stored in the MCP profile, dispatcher environment, SQLite envelope, broker
  message, public enrollment JSON, repository, or package.
- Production Service Bus has no unsigned compatibility mode. The local fake
  transport is intentionally unsigned and must not be exposed as a remote
  transport.
- MCP output and logs do not expose message bodies unless an authorized caller
  explicitly reads an inbox item.
- The bridge provides at-least-once delivery; it does not claim exactly-once
  execution.

The source repository's `docs/threat-model.md` and
`docs/message-authentication.md` define the implemented boundary, residual
risks, membership procedure, rotation, revocation, and incident response.
