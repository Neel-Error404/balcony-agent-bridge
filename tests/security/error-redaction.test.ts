import { describe, expect, it } from "vitest";

import {
  normalizeErrorCode,
  safeBridgeErrorMessage,
  safeErrorCode,
  sanitizeErrorMessage,
} from "../../src/security/sanitize-error.js";

describe("Azure error redaction", () => {
  it("redacts endpoints, identifiers, credentials, tokens, and paths", () => {
    const unsafe = new Error(
      [
        "Failure at https://bridge-example.servicebus.windows.net/topic",
        "for 12345678-1234-4234-9234-123456789abc",
        "SharedAccessKey=top-secret;",
        "Bearer abc.def-123",
        "certificate C:\\ProgramData\\Balcony\\private\\sys-a.pem",
      ].join(" "),
    );

    const result = sanitizeErrorMessage(unsafe);

    expect(result).toContain("[REDACTED_ENDPOINT]");
    expect(result).toContain("[REDACTED_IDENTIFIER]");
    expect(result).toContain("[REDACTED_CREDENTIAL]");
    expect(result).toContain("Bearer [REDACTED_TOKEN]");
    expect(result).toContain("[REDACTED_PATH]");
    expect(result).not.toContain("bridge-example");
    expect(result).not.toContain("top-secret");
    expect(result).not.toContain("12345678-1234");
    expect(result).not.toContain("ProgramData");
  });

  it("keeps ordinary actionable error text", () => {
    expect(
      sanitizeErrorMessage(new Error("Service busy; retry later")),
    ).toBe("Service busy; retry later");
  });

  it("reduces operational failures to stable allowlisted codes", () => {
    expect(
      safeErrorCode(
        Object.assign(
          new Error(
            "Message body at \\\\private-host\\share and /subscriptions/private",
          ),
          { code: "ServiceTimeout" },
        ),
      ),
    ).toBe("ServiceTimeout");
    expect(
      safeErrorCode({ code: "https://private-host/sensitive" }),
    ).toBe("UNKNOWN_TRANSPORT_ERROR");
    expect(normalizeErrorCode("UnauthorizedAccess")).toBe(
      "UnauthorizedAccess",
    );
  });

  it("returns fixed MCP messages without caller identifiers", () => {
    expect(safeBridgeErrorMessage("STATE_TRANSITION_ERROR")).toBe(
      "The requested bridge state transition is invalid.",
    );
    expect(
      safeBridgeErrorMessage("unknown-private-identifier"),
    ).toBe("The bridge rejected the request.");
  });
});
