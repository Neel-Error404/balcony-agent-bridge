# ADR 0001: Separate MCP And Bridge Processes

## Status

Accepted for initial implementation.

## Decision

Run a short-lived stdio MCP server separately from a long-lived background
bridge service. Both use the same local SQLite database, while only the bridge
service can access Azure.

## Rationale

This keeps MCP standard output protocol-clean, allows agents to enqueue work
while Azure is unavailable, avoids giving every MCP process Azure access, and
provides one owner for broker connections and settlement.
