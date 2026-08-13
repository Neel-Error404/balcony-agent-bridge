import { describe, expect, it } from "vitest";

import {
  SecretPolicyError,
  assertSecretSafe,
} from "../../src/security/payload-policy.js";

describe("payload secret policy", () => {
  it("accepts ordinary secret-safe project evidence", () => {
    expect(() =>
      assertSecretSafe({
        summary: "Foundation tests passed",
        evidence: ["tests/foundation/envelope.test.ts"],
      }),
    ).not.toThrow();
  });

  it("rejects credential-shaped field names", () => {
    expect(() =>
      assertSecretSafe({
        result: {
          client_secret: "not-a-real-secret",
        },
      }),
    ).toThrow(SecretPolicyError);
  });

  it("rejects private key material", () => {
    expect(() =>
      assertSecretSafe({
        body: "-----BEGIN PRIVATE KEY-----",
      }),
    ).toThrow(/private key block/);
  });
});
