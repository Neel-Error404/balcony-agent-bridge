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
          [["client", "secret"].join("_")]: "not-a-real-secret",
        },
      }),
    ).toThrow(SecretPolicyError);
  });

  it.each([
    ["PKCS8", ["-----BEGIN ", "PRIVATE KEY-----"].join("")],
    ["encrypted", ["-----BEGIN ", "ENCRYPTED PRIVATE KEY-----"].join("")],
    ["DSA", ["-----BEGIN ", "DSA PRIVATE KEY-----"].join("")],
    ["PGP", ["-----BEGIN ", "PGP PRIVATE KEY BLOCK-----"].join("")],
  ])("rejects %s private key material", (_label, value) => {
    expect(() => assertSecretSafe({ body: value })).toThrow(/private key block/);
  });

  it.each([
    ["AWS", `AKIA${"A".repeat(16)}`],
    ["OpenAI", `sk-${"A".repeat(24)}`],
    ["Slack", `xoxb-${"A".repeat(24)}`],
    ["npm", `npm_${"A".repeat(36)}`],
    ["client secret", `${["client", "secret"].join("_")} = ${"A".repeat(24)}`],
    ["SAS", `https://example.invalid/path?sig=${"A".repeat(24)}`],
    [
      "credentialed URL",
      ["https", "://", "user", ":", "A".repeat(24), "@", "example.invalid"].join(""),
    ],
  ])("rejects %s credential material in string values", (_label, value) => {
    expect(() => assertSecretSafe({ body: value })).toThrow(SecretPolicyError);
  });
});
