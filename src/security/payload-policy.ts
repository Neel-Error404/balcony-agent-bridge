const FORBIDDEN_KEY_PATTERN =
  /(?:^|_)(?:api_?key|access_?token|refresh_?token|client_?secret|password|private_?key|connection_?string|sas_?token)(?:$|_)/i;

const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "private key block",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/i,
  },
  {
    label: "Azure Storage connection string",
    pattern: /DefaultEndpointsProtocol=https?;AccountName=/i,
  },
  {
    label: "Azure Service Bus connection string",
    pattern: /Endpoint=sb:\/\/[^;]+;SharedAccessKeyName=/i,
  },
  {
    label: "bearer token",
    pattern: /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/i,
  },
  {
    label: "GitHub token",
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/i,
  },
];

export class SecretPolicyError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "SecretPolicyError";
  }
}

export function assertSecretSafe(value: unknown): void {
  visit(value, "$");
}

function visit(value: unknown, path: string): void {
  if (typeof value === "string") {
    for (const rule of FORBIDDEN_VALUE_PATTERNS) {
      if (rule.pattern.test(value)) {
        throw new SecretPolicyError(
          `Payload contains a forbidden ${rule.label} at ${path}`,
        );
      }
    }
    return;
  }

  if (Array.isArray(value)) {
    value.forEach((item, index) => visit(item, `${path}[${index}]`));
    return;
  }

  if (value && typeof value === "object") {
    for (const [key, item] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (FORBIDDEN_KEY_PATTERN.test(key)) {
        throw new SecretPolicyError(
          `Payload contains a forbidden credential field at ${path}.${key}`,
        );
      }
      visit(item, `${path}.${key}`);
    }
  }
}
