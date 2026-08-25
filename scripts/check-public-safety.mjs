import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
const includeHistory = process.argv.includes("--history");

const detectors = [
  {
    name: "private-key",
    pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u,
  },
  { name: "aws-access-key", pattern: /\bAKIA[A-Z0-9]{16}\b/u },
  {
    name: "github-token",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  },
  {
    name: "openai-api-key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    name: "slack-token",
    pattern: /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  },
  {
    name: "azure-service-bus-connection-string",
    pattern:
      /Endpoint=sb:\/\/[^;\s]+;SharedAccessKeyName=[^;\s]+;SharedAccessKey=[A-Za-z0-9+/=]{16,}/iu,
  },
  {
    name: "azure-storage-connection-string",
    pattern:
      /DefaultEndpointsProtocol=https?;AccountName=[^;\s]+;AccountKey=[A-Za-z0-9+/=]{16,}/iu,
  },
  {
    name: "npm-token",
    pattern: /\bnpm_[A-Za-z0-9]{30,}\b/u,
  },
  {
    name: "bearer-token",
    pattern: /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{20,}/iu,
  },
  {
    name: "client-secret-assignment",
    pattern:
      /\b(?:AZURE_CLIENT_SECRET|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9._~-]{16,}/iu,
  },
  {
    name: "sas-signature",
    pattern: /[?&]sig=[A-Za-z0-9%+/=]{16,}(?:&|$)/iu,
  },
  {
    name: "credentialed-url",
    pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/iu,
  },
];

const fixtureAllowances = new Map([
  ["tests/component/project-evidence-provider.test.ts", new Set(["private-key"])],
  ["tests/component/read-only-dispatcher.test.ts", new Set(["private-key"])],
  ["tests/foundation/envelope.test.ts", new Set(["azure-service-bus-connection-string"])],
  ["tests/integration/mcp-server.test.ts", new Set(["private-key"])],
  ["tests/security/coordination-boundary.test.ts", new Set(["private-key"])],
  ["tests/security/error-redaction.test.ts", new Set(["azure-service-bus-connection-string"])],
  [
    "tests/security/payload-policy.test.ts",
    new Set(["client-secret-assignment", "private-key"]),
  ],
  ["tests/security/source-boundaries.test.ts", new Set(["azure-service-bus-connection-string"])],
]);

const tracked = runGit([
  "ls-files",
  "--cached",
  "--others",
  "--exclude-standard",
  "-z",
]).stdout
  .split("\0")
  .filter(Boolean)
  .map(normalize);

const forbiddenFiles = tracked.filter((file) => {
  return isForbiddenFile(file);
});

const findings = [];
for (const file of tracked) {
  if (file === "scripts/check-public-safety.mjs") {
    continue;
  }
  const absolutePath = path.join(repositoryRoot, ...file.split("/"));
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    continue;
  }
  const content = fs.readFileSync(absolutePath);
  if (content.includes(0)) {
    continue;
  }
  scan(content.toString("utf8"), file);
}

if (includeHistory) {
  const historicalPaths = runGit([
    "log",
    "--all",
    "--format=",
    "--name-only",
    "--diff-filter=A",
  ]).stdout
    .split(/\r?\n/u)
    .map(normalize)
    .filter(Boolean);
  forbiddenFiles.push(...historicalPaths.filter(isForbiddenFile));

  const history = runGit([
    "log",
    "-p",
    "--all",
    "--no-color",
    "--",
    ".",
  ]).stdout;
  scanHistory(history);
}

const uniqueForbiddenFiles = [...new Set(forbiddenFiles)].sort();
const uniqueFindings = [
  ...new Map(
    findings.map((finding) => [
      `${finding.rule}:${finding.location}`,
      finding,
    ]),
  ).values(),
];

if (uniqueForbiddenFiles.length > 0 || uniqueFindings.length > 0) {
  process.stderr.write(
    `${JSON.stringify({
      forbidden_files: uniqueForbiddenFiles,
      findings: uniqueFindings,
    })}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(
    `${JSON.stringify({
      scanned_files: tracked.length,
      scanned_history: includeHistory,
      findings: 0,
    })}\n`,
  );
}

function scan(content, location) {
  for (const detector of detectors) {
    if (
      detector.pattern.test(content) &&
      !isFixtureAllowance(location, detector.name)
    ) {
      findings.push({ rule: detector.name, location });
    }
  }
}

function isFixtureAllowance(location, rule) {
  const file = location.replace(/^[0-9a-f]+:/u, "");
  return fixtureAllowances.get(file)?.has(rule) ?? false;
}

function scanHistory(history) {
  let commit = "unknown";
  let file = "unknown";
  for (const line of history.split(/\r?\n/u)) {
    const commitMatch = /^commit ([0-9a-f]+)$/u.exec(line);
    if (commitMatch) {
      commit = commitMatch[1];
      continue;
    }
    const diffMatch = /^diff --git a\/(.+) b\/(.+)$/u.exec(line);
    if (diffMatch) {
      file = normalize(diffMatch[2]);
      continue;
    }
    if (!line.startsWith("+") || line.startsWith("+++")) {
      continue;
    }
    scan(line.slice(1), `${commit}:${file}`);
  }
}

function isForbiddenFile(file) {
  const base = path.posix.basename(file).toLowerCase();
  if (base === ".env.example") {
    return false;
  }
  return (
    base === ".env" ||
    base.startsWith(".env.") ||
    /\.(?:db|db-shm|db-wal|sqlite|sqlite3|p12|pfx|key)$/u.test(base)
  );
}

function runGit(args) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`git failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${String(result.status)}: ${result.stderr.trim()}`,
    );
  }
  return result;
}

function normalize(filePath) {
  return filePath.replaceAll("\\", "/");
}
