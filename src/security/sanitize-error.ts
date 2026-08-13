const REDACTIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [
    /\b(?:https?|sb):\/\/[^\s"'<>]+/giu,
    "[REDACTED_ENDPOINT]",
  ],
  [
    /\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.servicebus\.windows\.net\b/giu,
    "[REDACTED_SERVICEBUS_HOST]",
  ],
  [
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/giu,
    "[REDACTED_IDENTIFIER]",
  ],
  [
    /\b(?:Endpoint|SharedAccessKeyName|SharedAccessKey|Signature|sig|token|client_secret)\s*=\s*[^;\s]+/giu,
    "[REDACTED_CREDENTIAL]",
  ],
  [
    /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/giu,
    "Bearer [REDACTED_TOKEN]",
  ],
  [
    /\b[A-Za-z]:\\(?:[^\\/:*?"<>|\r\n]+\\)*[^\\/:*?"<>|\r\n]*/gu,
    "[REDACTED_PATH]",
  ],
];

export function sanitizeErrorMessage(
  error: unknown,
  maximumLength = 1000,
): string {
  const original =
    error instanceof Error ? error.message : String(error);
  const sanitized = REDACTIONS.reduce(
    (value, [pattern, replacement]) =>
      value.replace(pattern, replacement),
    original,
  );
  return sanitized.slice(0, maximumLength);
}

export function safeErrorCode(error: unknown): string {
  const candidate =
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
      ? error.code
      : error instanceof Error
        ? error.name
        : "UNKNOWN_TRANSPORT_ERROR";
  return normalizeErrorCode(candidate);
}

export function normalizeErrorCode(code: string): string {
  const trimmed = code.trim();
  return /^[A-Za-z][A-Za-z0-9_.-]{0,79}$/u.test(trimmed)
    ? trimmed
    : "UNKNOWN_TRANSPORT_ERROR";
}

export function safeBridgeErrorMessage(code: string): string {
  switch (code) {
    case "CONFIGURATION_ERROR":
      return "The bridge configuration is invalid.";
    case "IDEMPOTENCY_CONFLICT":
      return "The idempotency key conflicts with an existing message.";
    case "STATE_TRANSITION_ERROR":
      return "The requested bridge state transition is invalid.";
    default:
      return "The bridge rejected the request.";
  }
}
