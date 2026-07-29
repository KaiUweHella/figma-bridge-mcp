// Local change history (figma_history) — the Safe-Mode take on component
// changelogs. There is no Figma REST access in this build (no PAT), but every
// write this machine performs flows through the audit log, so the log IS the
// design history. Optionally merged with `git log` of generated code files for
// a combined design+code changelog.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { AUDIT_LOG_PATH } from "./config.js";
import { extractNodeIds } from "./figma-cli.js";

/**
 * Parse audit-log JSONL text into entries, silently skipping malformed lines
 * (a truncated last line must never break the whole history).
 * @param {string} text
 * @returns {object[]}
 */
export function parseAuditLines(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const entry = JSON.parse(trimmed);
      if (entry && typeof entry === "object" && entry.ts) entries.push(entry);
    } catch {
      // skip malformed line
    }
  }
  return entries;
}

/**
 * Node ids an entry touched. Entries written before the enrichment lack a
 * `nodes` field — re-extract from `args` at read time (back-compat shim).
 * @param {object} entry
 * @returns {string[]}
 */
export function entryNodes(entry) {
  if (Array.isArray(entry.nodes)) return entry.nodes;
  return extractNodeIds(Array.isArray(entry.args) ? entry.args : []);
}

/**
 * Filter audit entries: newest first, optionally only those touching nodeId.
 * @param {object[]} entries
 * @param {{nodeId?: string, limit?: number}} [opts]
 * @returns {object[]}
 */
export function filterHistory(entries, { nodeId, limit = 20 } = {}) {
  let result = [...entries].reverse();
  if (nodeId) {
    result = result.filter((e) => entryNodes(e).includes(nodeId));
  }
  return result.slice(0, limit);
}

/**
 * Git commit history for generated code files. Graceful degradation: any
 * failure (git missing, not a repo, bad path) returns a warning instead of
 * throwing — the design history must still be delivered.
 * @param {{repoPath: string, paths: string[], limit?: number}} opts
 * @returns {{entries: object[], warning: string|null}}
 */
export function gitHistory({ repoPath, paths, limit = 20 }) {
  const entries = [];
  const warnings = [];
  for (const p of paths) {
    try {
      const out = execFileSync(
        "git",
        ["log", "--follow", "--max-count", String(limit), "--format=%aI%x09%s", "--", p],
        { cwd: repoPath, encoding: "utf8", timeout: 5000, stdio: "pipe" },
      );
      for (const line of out.split("\n")) {
        const tab = line.indexOf("\t");
        if (tab === -1) continue;
        entries.push({
          ts: line.slice(0, tab),
          label: line.slice(tab + 1),
          source: "code",
          ref: p,
        });
      }
    } catch (err) {
      const detail = (err.stderr || err.message || "git failed").toString().trim().split("\n")[0];
      warnings.push(`git history unavailable for ${p}: ${detail}`);
    }
  }
  return { entries, warning: warnings.length ? warnings.join("; ") : null };
}

function truncate(s, max) {
  return s.length > max ? s.slice(0, max - 1) + "…" : s;
}

// Every cell value is attacker-influenced (labels via the `label` param,
// args/refs via tool input) — collapse newlines and escape pipes so a crafted
// value cannot break out of its table cell and inject markdown lines that a
// later agent session would read as content.
function cell(value, max = 120) {
  return truncate(String(value).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim(), max);
}

function designLabel(entry) {
  if (entry.label) return entry.label;
  const args = Array.isArray(entry.args) ? entry.args : [];
  const head = args.slice(0, 4).map((a) => truncate(String(a), 40)).join(" ");
  return args.length > 4 ? `${head} …` : head;
}

function nodesCell(entry) {
  if (entry.source === "code") return cell(entry.ref || "");
  const nodes = entryNodes(entry);
  if (!nodes.length) return "";
  const shown = nodes.slice(0, 6).join(", ");
  return cell(nodes.length > 6 ? `${shown} +${nodes.length - 6}` : shown);
}

/**
 * Format merged history entries.
 * @param {object[]} entries
 * @param {{format?: "markdown"|"json"}} [opts]
 * @returns {string}
 */
export function formatHistory(entries, { format = "markdown" } = {}) {
  if (format === "json") return JSON.stringify(entries, null, 2);
  if (!entries.length) return "No history entries found.";
  const lines = [
    "| Time | Source | Command / label | Nodes / file |",
    "| --- | --- | --- | --- |",
  ];
  for (const e of entries) {
    const source = e.source === "code" ? "code" : "design";
    const label = cell(e.source === "code" ? e.label : designLabel(e));
    lines.push(`| ${cell(e.ts, 40)} | ${source} | ${label} | ${nodesCell(e)} |`);
  }
  return lines.join("\n");
}

/**
 * Build the combined design(+code) history text.
 * @param {{auditPath?: string, nodeId?: string, limit?: number,
 *          format?: "markdown"|"json", gitPaths?: string[], repoPath?: string}} opts
 * @returns {string}
 */
export function buildHistory({
  auditPath = AUDIT_LOG_PATH,
  nodeId,
  limit = 20,
  format = "markdown",
  gitPaths,
  repoPath = process.cwd(),
} = {}) {
  let text = "";
  try {
    text = fs.readFileSync(auditPath, "utf8");
  } catch {
    // no audit log yet — may still have git history below
  }

  const design = filterHistory(parseAuditLines(text), { nodeId, limit }).map((e) => ({
    ...e,
    source: "design",
  }));

  let merged = design;
  const notes = [];
  if (Array.isArray(gitPaths) && gitPaths.length) {
    const { entries: code, warning } = gitHistory({ repoPath, paths: gitPaths, limit });
    if (warning) notes.push(warning);
    // Parse timestamps for the sort: audit lines are UTC ("...Z") while git
    // %aI carries a local offset ("+02:00") — string comparison would misorder
    // them around the offset boundary.
    const time = (e) => {
      const t = Date.parse(e.ts);
      return Number.isNaN(t) ? 0 : t;
    };
    merged = [...design, ...code]
      .sort((a, b) => time(b) - time(a))
      .slice(0, limit);
  }

  if (!merged.length && !notes.length) {
    return "No history yet. History is recorded locally as figma_run/figma_render commands execute (pass `label` to annotate entries).";
  }

  let out = formatHistory(merged, { format });
  if (nodeId && format === "markdown") {
    out = `History for node ${nodeId} (local, this machine only):\n\n${out}`;
  }
  if (notes.length && format === "markdown") {
    out += `\n\n_Note: ${notes.join("; ")}_`;
  }
  return out;
}
