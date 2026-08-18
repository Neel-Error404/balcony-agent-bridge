import { describe, expect, it } from "vitest";

import {
  ChildTurnResultSchema,
  EvidenceBundleSchema,
} from "../../src/contracts/evidence.js";

const bundle = {
  schema_version: "1.0" as const,
  project: "balcony-agent-bridge",
  generated_at_utc: "2026-08-17T10:00:00.000Z",
  total_bytes: 12,
  items: [
    {
      path: "README.md",
      source: "local_project" as const,
      content: "Bridge docs.",
      sha256:
        "c5b7309e673e355bec13f73a7614c16943ff206b1fc923df2a129158d435ab5b",
      byte_length: 12,
      modified_at_utc: "2026-08-17T09:59:00.000Z",
    },
  ],
};

describe("evidence and child-turn contracts", () => {
  it("accepts a bounded evidence bundle", () => {
    expect(EvidenceBundleSchema.parse(bundle)).toEqual(bundle);
  });

  it("accepts a completed child turn with evidence citations", () => {
    expect(
      ChildTurnResultSchema.parse({
        schema_version: "1.0",
        outcome: "completed",
        answer: "The bridge documentation identifies the project.",
        evidence_paths: ["README.md"],
      }),
    ).toMatchObject({
      outcome: "completed",
      evidence_paths: ["README.md"],
    });
  });

  it("accepts an explicit needs_information child turn", () => {
    expect(
      ChildTurnResultSchema.parse({
        schema_version: "1.0",
        outcome: "needs_information",
        reason: "The current architecture evidence was not supplied.",
        requested_evidence: ["docs/architecture.md"],
        evidence_paths: [],
      }),
    ).toMatchObject({
      outcome: "needs_information",
      requested_evidence: ["docs/architecture.md"],
    });
  });

  it("rejects incomplete or contradictory child-turn outcomes", () => {
    expect(() =>
      ChildTurnResultSchema.parse({
        schema_version: "1.0",
        outcome: "completed",
        evidence_paths: [],
      }),
    ).toThrow(/answer/);

    expect(() =>
      ChildTurnResultSchema.parse({
        schema_version: "1.0",
        outcome: "needs_information",
        reason: "More evidence is needed.",
        requested_evidence: [],
        evidence_paths: [],
      }),
    ).toThrow(/requested_evidence/);
  });

  it("rejects evidence bundles with false integrity metadata", () => {
    expect(() =>
      EvidenceBundleSchema.parse({
        ...bundle,
        total_bytes: 11,
      }),
    ).toThrow(/total_bytes/);

    expect(() =>
      EvidenceBundleSchema.parse({
        ...bundle,
        items: [
          {
            ...bundle.items[0],
            sha256: "0".repeat(64),
          },
        ],
      }),
    ).toThrow(/sha256/);
  });

  it("rejects non-canonical evidence paths", () => {
    for (const invalidPath of [
      "../README.md",
      "./README.md",
      "docs//state.md",
      "C:README.md",
      "C:\\private\\README.md",
    ]) {
      expect(() =>
        ChildTurnResultSchema.parse({
          schema_version: "1.0",
          outcome: "needs_information",
          reason: "More evidence is required.",
          requested_evidence: [invalidPath],
          evidence_paths: [],
        }),
      ).toThrow(/canonical relative/);
    }
  });
});
