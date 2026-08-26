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
    pattern: /-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY(?: BLOCK)?-----/u,
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
      /(?:^|[^A-Za-z0-9_])["']?(?:AZURE_CLIENT_SECRET|client[_-]?secret)["']?\s*[:=]\s*["']?[A-Za-z0-9._~-]{16,}/iu,
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

// These immutable historical blobs contain synthetic detector fixtures. A new
// or modified blob does not inherit the allowance and must be reviewed again.
const historicalFixtureBlobAllowances = new Map([
  [
    "250738e496d5461114d02a8dfcdac872486a9a3b",
    new Set(["client-secret-assignment", "private-key"]),
  ],
  ["76138c04447c986beef0f3c6fc44dd3009d6a624", new Set(["private-key"])],
  ["4dac2d90bcbbdc1b712cce70ff4014bd19ca66ec", new Set(["private-key"])],
  ["4d087093196fe9c7d3f0547ae600387adffbbbdc", new Set(["private-key"])],
  ["76f73615abbf414ac155645105050274c7037eb7", new Set(["private-key"])],
  ["6fc545c78446aac5046418ba39526f2d5157ab69", new Set(["private-key"])],
  ["ee952b6d3f3fd8d3670763a1b8bf21345c5fd79c", new Set(["private-key"])],
  ["997ba9f2dcf8163cf32d424e02fa356aae866890", new Set(["private-key"])],
  ["d4251fd5eb5ed29e8990f8bffb53595ac55088c9", new Set(["private-key"])],
  ["764943292f1245c6ec4128b843aa0120542d04ed", new Set(["private-key"])],
  ["735670ec6ddf98ef6bdd21122ac0c451a8726ebb", new Set(["private-key"])],
  ["f5a541f316ee4ba4a2c3e7ab8503f79039ce65ad", new Set(["private-key"])],
  ["4d5d1f8c72a8375b5f396fb30e4b0ba51be31b0d", new Set(["private-key"])],
  ["4adf91c34c2a5f94094b385f5c0502a27e8b39b3", new Set(["private-key"])],
  [
    "27a9bad20447e8ef655a8a09efbdb579318e9e3c",
    new Set(["client-secret-assignment", "private-key"]),
  ],
  [
    "f0ccf74fe5e279bf381861a5ba85c459e3d46cff",
    new Set(["client-secret-assignment"]),
  ],
  [
    "ea88c4a769e7d67e754caa6b62f6dfd1d0960467",
    new Set(["client-secret-assignment"]),
  ],
  [
    "99d34ee74b456460a4882bc6d273d6beab23b921",
    new Set(["client-secret-assignment"]),
  ],
  [
    "b8ade6251f28f816d6ec99eb1f9f1c21160f5580",
    new Set(["client-secret-assignment"]),
  ],
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
    findings.push({ rule: "binary-file", location: file });
    continue;
  }
  scan(content.toString("utf8"), file);
}

if (includeHistory) {
  const historicalPathChanges = runGit([
    "log",
    "HEAD",
    "--format=",
    "--name-status",
    "--find-renames",
    "--find-copies",
  ]).stdout;
  const historicalPaths = historicalPathChanges
    .split(/\r?\n/u)
    .flatMap((line) => line.split("\t").slice(1))
    .map(normalize)
    .filter(Boolean);
  forbiddenFiles.push(...historicalPaths.filter(isForbiddenFile));

  scanHistoryObjects();
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
      !isHistoricalFixtureBlobAllowance(location, detector.name)
    ) {
      findings.push({ rule: detector.name, location });
    }
  }
}

function isHistoricalFixtureBlobAllowance(location, rule) {
  const match = /^([0-9a-f]+):/u.exec(location);
  return match
    ? historicalFixtureBlobAllowances.get(match[1])?.has(rule) ?? false
    : false;
}

function scanHistoryObjects() {
  const objects = runGit(["rev-list", "--objects", "HEAD"]).stdout
    .split(/\r?\n/u)
    .map((line) => {
      const match = /^([0-9a-f]+) (.+)$/u.exec(line);
      return match ? { objectId: match[1], file: normalize(match[2]) } : undefined;
    })
    .filter(Boolean);
  const batch = runGitBuffer(
    ["cat-file", "--batch"],
    objects.map(({ objectId }) => objectId).join("\n") + "\n",
  );
  let offset = 0;
  for (const { objectId, file } of objects) {
    const headerEnd = batch.indexOf(0x0a, offset);
    if (headerEnd < 0) {
      throw new Error("git cat-file returned a truncated object header");
    }
    const header = batch.subarray(offset, headerEnd).toString("utf8");
    const match = /^[0-9a-f]+ ([a-z]+) ([0-9]+)$/u.exec(header);
    if (!match) {
      throw new Error("git cat-file returned an invalid object header");
    }
    const size = Number.parseInt(match[2], 10);
    const contentStart = headerEnd + 1;
    const contentEnd = contentStart + size;
    if (contentEnd >= batch.length) {
      throw new Error("git cat-file returned a truncated object body");
    }
    const content = batch.subarray(contentStart, contentEnd);
    offset = contentEnd + 1;
    if (match[1] !== "blob") {
      continue;
    }
    const location = `${objectId}:${file}`;
    if (content.includes(0)) {
      findings.push({ rule: "binary-file", location });
    } else {
      scan(content.toString("utf8"), location);
    }
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

function runGitBuffer(args, input) {
  const result = spawnSync("git", args, {
    cwd: repositoryRoot,
    input,
    maxBuffer: 128 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`git failed to start: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `git ${args.join(" ")} exited ${String(result.status)}: ${result.stderr.toString("utf8").trim()}`,
    );
  }
  return result.stdout;
}

function normalize(filePath) {
  return filePath.replaceAll("\\", "/");
}
