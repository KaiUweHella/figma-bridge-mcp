#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const ZERO_SHA = /^0+$/;

const TOKEN_RULES = [
  ["private key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g],
  [
    "GitHub token",
    /\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
  ],
  ["npm token", /\bnpm_[A-Za-z0-9]{30,}\b/g],
  ["Figma personal access token", /\bfigd_[A-Za-z0-9_-]{32,}\b/g],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{24,}\b/g],
  ["Anthropic API key", /\bsk-ant-[A-Za-z0-9_-]{24,}\b/g],
  ["AWS access key", /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g],
  ["Stripe secret key", /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{20,}\b/g],
  [
    "credential embedded in URL",
    /\b[a-z][a-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/gi,
  ],
];

const SENSITIVE_ASSIGNMENT =
  /(?:api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret|password|passwd)\s*[:=]\s*["']([^"'\n]{16,})["']/gi;
const SAFE_VALUE_MARKERS =
  /(?:test|example|placeholder|fixture|dummy|fake|secret[_ -]?value|<[^>]+>)/i;
const FIGMA_URL =
  /https?:\/\/(?:www\.)?figma\.com\/(?:design|file|board|proto|slides)\/([A-Za-z0-9_-]{8,})(?:\/([^\s?#"')]+))?/gi;
const SAFE_FIGMA_KEY = /^[A-Z]*PLACEHOLDER[A-Z]*$/;
const LEGACY_FIXTURE_KEYS = new Set([
  "EXPLICITFILEKEY",
  "ARGUMENTFILEKEY",
  "BOARDFILEKEY",
]);
const SAFE_FIGMA_NAME = /^(?:FILE_NAME|FILE-NAME)$/;
const ABSOLUTE_PATHS = [
  /(?:^|[\s("'`])\/Users\/[^/\s"'`]+\/[^\s"'`)]+/gm,
  /(?:^|[\s("'`])\/home\/[^/\s"'`]+\/[^\s"'`)]+/gm,
  /(?:^|[\s("'`])[A-Za-z]:\\Users\\[^\\\s"'`]+\\[^\s"'`)]+/gm,
];

function git(args, { cwd = ROOT, encoding = "utf8" } = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding,
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function nulList(value) {
  return value.split("\0").filter(Boolean);
}

function lineAt(text, index) {
  return text.slice(0, index).split("\n").length;
}

function addMatch(findings, kind, path, text, index, revision) {
  findings.push({ kind, path, line: lineAt(text, index), revision });
}

function hasCredentialShape(value) {
  if (SAFE_VALUE_MARKERS.test(value)) return false;
  const classes = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((rule) =>
    rule.test(value)
  ).length;
  return classes >= 3 || (classes >= 2 && value.length >= 28);
}

export function sensitivePathReason(path) {
  const name = basename(path).toLowerCase();
  if (
    name === ".env" ||
    (name.startsWith(".env.") && name !== ".env.example")
  ) {
    return "environment file";
  }
  if (name === ".npmrc") return "npm credentials file";
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519)$/.test(name))
    return "private key file";
  if (/\.(?:key|pem|p12|pfx)$/i.test(name)) return "credential file";
  if (/\.(?:gif|jpe?g|mov|mp4|pdf|png|webp|zip)$/i.test(name)) {
    return "binary artifact requiring public review";
  }
  if (/^(?:credentials|service-account)(?:\.[^.]+)?\.json$/i.test(name)) {
    return "credentials file";
  }
  return null;
}

export function scanText(
  text,
  { path = "<text>", denylist = [], revision = null, scanPath = true } = {}
) {
  const findings = [];
  if (scanPath) {
    const pathReason = sensitivePathReason(path);
    if (pathReason)
      findings.push({ kind: pathReason, path, line: 1, revision });
  }

  for (const [kind, rule] of TOKEN_RULES) {
    rule.lastIndex = 0;
    for (const match of text.matchAll(rule)) {
      addMatch(findings, kind, path, text, match.index, revision);
    }
  }

  SENSITIVE_ASSIGNMENT.lastIndex = 0;
  for (const match of text.matchAll(SENSITIVE_ASSIGNMENT)) {
    if (hasCredentialShape(match[1])) {
      addMatch(
        findings,
        "hard-coded credential",
        path,
        text,
        match.index,
        revision
      );
    }
  }

  FIGMA_URL.lastIndex = 0;
  for (const match of text.matchAll(FIGMA_URL)) {
    const keyIsPlaceholder =
      SAFE_FIGMA_KEY.test(match[1]) || LEGACY_FIXTURE_KEYS.has(match[1]);
    const nameIsPlaceholder = !match[2] || SAFE_FIGMA_NAME.test(match[2]);
    if (!keyIsPlaceholder || !nameIsPlaceholder) {
      addMatch(
        findings,
        "non-placeholder Figma file URL",
        path,
        text,
        match.index,
        revision
      );
    }
  }

  for (const rule of ABSOLUTE_PATHS) {
    rule.lastIndex = 0;
    for (const match of text.matchAll(rule)) {
      addMatch(
        findings,
        "personal absolute path",
        path,
        text,
        match.index,
        revision
      );
    }
  }

  const lowerText = text.toLocaleLowerCase("en-US");
  const lowerPath = path.toLocaleLowerCase("en-US");
  for (const term of denylist) {
    const index = lowerText.indexOf(term);
    if (index !== -1) {
      addMatch(findings, "private denylist term", path, text, index, revision);
    } else if (scanPath && lowerPath.includes(term)) {
      findings.push({
        kind: "private denylist term in filename",
        path,
        line: 1,
        revision,
      });
    }
  }

  return findings;
}

export function loadDenylist(root = ROOT) {
  const path = resolve(root, ".public-safety-denylist");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim().toLocaleLowerCase("en-US"))
    .filter((line) => line && !line.startsWith("#"));
}

function scanEntry(entry, denylist, findings) {
  const buffer = Buffer.isBuffer(entry.content)
    ? entry.content
    : Buffer.from(entry.content);
  const entryFindings = scanText(buffer.toString("utf8"), {
    path: entry.path,
    denylist,
    revision: entry.revision,
    scanPath: entry.scanPath,
  });
  const lineOffset = entry.lineOffset || 1;
  for (const finding of entryFindings) finding.line += lineOffset - 1;
  findings.push(...entryFindings);
}

function trackedEntries() {
  return nulList(git(["ls-files", "-z"]))
    .filter((path) => existsSync(resolve(ROOT, path)))
    .map((path) => ({
      path,
      content: readFileSync(resolve(ROOT, path)),
      revision: "working tree",
    }));
}

function stagedEntries() {
  const paths = nulList(
    git(["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"])
  );
  return paths.map((path) => ({
    path,
    content: git(["show", `:${path}`], { encoding: null }),
    revision: "staged",
  }));
}

export function parsePatchEntries(patch) {
  const entries = [];
  let revision = "unknown";
  let path = null;
  let newLine = 1;
  let inHunk = false;

  for (const line of patch.split("\n")) {
    if (line.startsWith("PUBLIC_SAFETY_COMMIT ")) {
      revision = line.slice("PUBLIC_SAFETY_COMMIT ".length).trim();
      path = null;
      inHunk = false;
      continue;
    }
    if (line.startsWith("diff --git ")) {
      path = null;
      inHunk = false;
      continue;
    }
    if (!inHunk && line.startsWith("+++ ")) {
      const candidate = line.slice(4);
      path = candidate === "/dev/null" ? null : candidate.replace(/^b\//, "");
      if (path) {
        entries.push({
          path,
          content: "",
          revision,
          scanPath: true,
        });
      }
      continue;
    }
    if (line.startsWith("@@ ")) {
      const match = line.match(/\+(\d+)/);
      newLine = match ? Number(match[1]) : 1;
      inHunk = true;
      continue;
    }
    if (!inHunk || !path) continue;
    if (line.startsWith("+")) {
      entries.push({
        path,
        content: line.slice(1),
        revision,
        lineOffset: newLine,
        scanPath: false,
      });
      newLine += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      newLine += 1;
      continue;
    }
    if (!line.startsWith("-") && line !== "\\ No newline at end of file") {
      inHunk = false;
    }
  }
  return entries;
}

function patchEntries(commits = null) {
  const common = [
    "--root",
    "--format=PUBLIC_SAFETY_COMMIT %H",
    "-p",
    "--text",
    "--no-ext-diff",
    "--unified=0",
    "--no-renames",
  ];
  const args = commits
    ? ["-c", "core.quotePath=false", "show", ...common, ...commits]
    : ["-c", "core.quotePath=false", "log", "--all", ...common];
  if (commits && commits.length === 0) return [];
  return parsePatchEntries(git(args));
}

function outgoingCommits(input, remoteName) {
  const commits = new Set();
  for (const line of input.trim().split("\n")) {
    if (!line.trim()) continue;
    const [, localSha, , remoteSha] = line.trim().split(/\s+/);
    if (!localSha || ZERO_SHA.test(localSha)) continue;
    const args =
      !remoteSha || ZERO_SHA.test(remoteSha)
        ? ["rev-list", localSha, `--not`, `--remotes=${remoteName || "origin"}`]
        : ["rev-list", `${remoteSha}..${localSha}`];
    for (const commit of git(args).trim().split("\n").filter(Boolean))
      commits.add(commit);
  }
  return [...commits];
}

async function stdinText() {
  if (process.stdin.isTTY) return "";
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function printFailure(findings) {
  console.error(
    `Public-safety check failed with ${findings.length} finding(s):`
  );
  for (const finding of findings) {
    const revision = finding.revision
      ? ` [${finding.revision.slice(0, 12)}]`
      : "";
    console.error(
      `- ${finding.kind}: ${finding.path}:${finding.line}${revision}`
    );
  }
  console.error("Matched values are deliberately redacted from this output.");
  console.error(
    "Replace private data with explicit placeholders. Put private names in " +
      ".public-safety-denylist (gitignored), never in a public allowlist."
  );
}

export async function main(args = process.argv.slice(2)) {
  const denylist = loadDenylist();
  let entries;
  let label;

  if (args.includes("--staged")) {
    entries = stagedEntries();
    label = "staged files";
  } else if (args.includes("--history")) {
    entries = patchEntries();
    label = "complete Git history";
  } else if (args.includes("--pre-push")) {
    const input = await stdinText();
    const commits = outgoingCommits(
      input,
      args.find((arg) => !arg.startsWith("--"))
    );
    entries = patchEntries(commits);
    label = `${commits.length} outgoing commit(s)`;
  } else {
    entries = trackedEntries();
    label = "tracked files";
  }

  const findings = [];
  for (const entry of entries) scanEntry(entry, denylist, findings);
  if (findings.length) {
    printFailure(findings);
    return 1;
  }
  const localTerms = denylist.length
    ? `; ${denylist.length} local denylist term(s)`
    : "";
  console.log(`Public-safety check passed: ${label}${localTerms}.`);
  return 0;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = await main();
}
