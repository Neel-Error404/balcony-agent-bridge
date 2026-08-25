const FORBIDDEN_KEY_PATTERN =
  /(?:^|_)(?:api_?key|access_?token|refresh_?token|client_?secret|password|private_?key|connection_?string|sas_?token)(?:$|_)/i;

const FORBIDDEN_VALUE_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  {
    label: "private key block",
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/i,
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
    label: "AWS access key",
    pattern: /\bAKIA[A-Z0-9]{16}\b/,
  },
  {
    label: "GitHub token",
    pattern: /\bgh(?:p|o|u|s|r)_[A-Za-z0-9]{20,}\b/i,
  },
  {
    label: "OpenAI API key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/i,
  },
  {
    label: "Slack token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/i,
  },
  {
    label: "npm token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/i,
  },
  {
    label: "client secret assignment",
    pattern:
      /(?:^|[^A-Za-z0-9_])["']?(?:AZURE_CLIENT_SECRET|client[_-]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._~-]{16,}/i,
  },
  {
    label: "SAS signature",
    pattern: /[?&]sig=[A-Za-z0-9%+/=]{16,}(?:&|$)/i,
  },
  {
    label: "credentialed URL",
    pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/i,
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
