# ADR 0003: Secret-Safe Messages

## Status

Accepted for initial implementation.

## Decision

Messages use allowlisted fields and typed payloads. The bridge rejects obvious
credential material and never stores Azure credentials. Managed identity is
the only supported production authentication method.

## Consequences

Secret scanning is a guardrail rather than proof. Callers remain responsible
for referencing durable evidence instead of embedding private configuration,
tokens, endpoints, or large logs.
