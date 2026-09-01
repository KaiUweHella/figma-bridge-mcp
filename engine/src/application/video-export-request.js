// Closed request Interface for `export video`.

import { NodeReferenceError, parseNodeReference } from "./node-reference.js";

export const VIDEO_EXPORT_DEFAULT_FORMAT = "MP4";
export const VIDEO_EXPORT_DEFAULT_FPS = 30;
export const VIDEO_EXPORT_DEFAULT_QUALITY = "HIGH";
export const VIDEO_EXPORT_DEFAULT_LOOP_COUNT = 0;
export const MAX_VIDEO_EXPORT_OUTPUT_PATH_CODE_UNITS = 4096;

const FORMATS = new Set(["MP4", "GIF", "WEBM"]);
const QUALITY = new Set(["LOW", "MEDIUM", "HIGH"]);
const VIDEO_FPS = new Set([12, 24, 30, 60]);
const GIF_FPS = new Set([8, 12, 15, 24, 30]);
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;

const fail = (message) =>
  new Error(`Invalid export video command: ${message}.`);

function nodeReference(value) {
  try {
    return parseNodeReference(value);
  } catch (error) {
    if (!(error instanceof NodeReferenceError)) throw error;
    throw fail(
      "nodeId must be a bounded Figma node id or URL containing node-id"
    );
  }
}

function formatValue(value) {
  if (typeof value !== "string" || !FORMATS.has(value.toUpperCase())) {
    throw fail("format must be mp4, gif, or webm");
  }
  return value.toUpperCase();
}

function fpsValue(value, format) {
  if (typeof value === "string" && !value.trim())
    throw fail("fps is required");
  const fps = Number(value);
  const allowed = format === "GIF" ? GIF_FPS : VIDEO_FPS;
  if (!Number.isSafeInteger(fps) || !allowed.has(fps)) {
    throw fail(
      `${format} fps must be one of: ${[...allowed].join(", ")}`
    );
  }
  return fps;
}

function qualityValue(value) {
  if (typeof value !== "string" || !QUALITY.has(value.toUpperCase())) {
    throw fail("quality must be low, medium, or high");
  }
  return value.toUpperCase();
}

function loopValue(value) {
  if (typeof value === "string" && !value.trim())
    throw fail("loop is required");
  const loopCount = Number(value);
  if (
    !Number.isSafeInteger(loopCount) ||
    loopCount < 0 ||
    loopCount > 1000
  ) {
    throw fail("loop must be an integer from 0 to 1000");
  }
  return loopCount;
}

function ignoredOptionValue(value, name) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 256 ||
    UNSAFE_TEXT.test(value)
  ) {
    throw fail(`${name} must be a bounded string when ignored by the format`);
  }
}

function optionValue(args, index, token, names) {
  for (const name of names) {
    if (token === name) {
      const value = args[index + 1];
      if (
        typeof value !== "string" ||
        !value ||
        value === "--" ||
        value.startsWith("-")
      ) {
        throw fail(`${name} requires a value`);
      }
      return { value, consumed: 1 };
    }
    if (token.startsWith(`${name}=`)) {
      const value = token.slice(name.length + 1);
      if (!value) throw fail(`${name} requires a value`);
      return { value, consumed: 0 };
    }
    if (name.length === 2 && token.startsWith(name) && token.length > 2) {
      const value = token.slice(2).replace(/^=/, "");
      if (!value) throw fail(`${name} requires a value`);
      return { value, consumed: 0 };
    }
  }
  return null;
}

function parsed(args) {
  if (
    !Array.isArray(args) ||
    args[0] !== "export" ||
    args[1] !== "video"
  ) {
    throw new Error("Expected an export video command.");
  }
  if (args.some((value) => typeof value !== "string")) {
    throw new TypeError("Video Export arguments must be strings.");
  }
  const values = {
    outputPath: null,
    format: VIDEO_EXPORT_DEFAULT_FORMAT,
    fps: null,
    quality: VIDEO_EXPORT_DEFAULT_QUALITY,
    loopCount: VIDEO_EXPORT_DEFAULT_LOOP_COUNT,
  };
  const seen = new Set();
  const positionals = [];
  let literal = false;
  for (let index = 2; index < args.length; index++) {
    const token = args[index];
    if (!literal && token === "--") {
      literal = true;
      continue;
    }
    if (!literal && token.startsWith("-")) {
      const options = [
        { key: "outputPath", names: ["-o", "--output"] },
        { key: "format", names: ["-f", "--format"] },
        { key: "fps", names: ["--fps"] },
        { key: "quality", names: ["--quality"] },
        { key: "loopCount", names: ["--loop"] },
      ];
      let match = null;
      for (const option of options) {
        const value = optionValue(args, index, token, option.names);
        if (value) {
          match = { ...option, ...value };
          break;
        }
      }
      if (!match) throw fail(`unknown option ${token}`);
      if (seen.has(match.key))
        throw fail(`${match.names.at(-1)} may appear only once`);
      seen.add(match.key);
      values[match.key] = match.value;
      index += match.consumed;
      continue;
    }
    positionals.push(token);
  }
  if (positionals.length === 0) throw fail("nodeId is required");
  if (positionals.length > 1)
    throw fail(`unexpected argument ${positionals[1]}`);
  const node = nodeReference(positionals[0]);
  const format = formatValue(values.format);
  const fps = fpsValue(values.fps ?? VIDEO_EXPORT_DEFAULT_FPS, format);
  let quality = null;
  let loopCount = null;
  if (format === "GIF") {
    if (seen.has("quality")) ignoredOptionValue(values.quality, "quality");
    loopCount = loopValue(values.loopCount);
  } else {
    quality = qualityValue(values.quality);
    if (seen.has("loopCount")) ignoredOptionValue(values.loopCount, "loop");
  }
  if (
    values.outputPath !== null &&
    (values.outputPath.length < 1 ||
      values.outputPath.length > MAX_VIDEO_EXPORT_OUTPUT_PATH_CODE_UNITS)
  ) {
    throw fail(
      `output path must contain 1 to ${MAX_VIDEO_EXPORT_OUTPUT_PATH_CODE_UNITS} code units`
    );
  }
  return {
    node,
    format,
    fps,
    quality,
    loopCount,
    outputPath: values.outputPath || `video.${format.toLowerCase()}`,
  };
}

export function parseVideoExportRequest(args) {
  const input = parsed(args);
  return Object.freeze({
    nodeId: input.node.nodeId,
    warning: input.node.warning,
    format: input.format,
    fps: input.fps,
    quality: input.quality,
    loopCount: input.loopCount,
    outputPath: input.outputPath,
  });
}

export function acceptsVideoExportArgv(args) {
  try {
    parseVideoExportRequest(args);
    return true;
  } catch {
    return false;
  }
}

function typed(request) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new TypeError("Video Export request must be an object.");
  }
  if (typeof request.nodeId !== "string")
    throw fail("nodeId must be a string");
  if (
    request.outputPath != null &&
    (typeof request.outputPath !== "string" || !request.outputPath)
  ) {
    throw fail("outputPath must be a non-empty string");
  }
  const args = ["export", "video", request.nodeId.trim()];
  if (request.outputPath) {
    if (request.outputPath.startsWith("-"))
      args.push(`--output=${request.outputPath}`);
    else args.push("-o", request.outputPath);
  }
  if (request.format != null) args.push("-f", String(request.format));
  if (request.fps != null) args.push("--fps", String(request.fps));
  if (request.quality != null)
    args.push("--quality", String(request.quality));
  if (request.loopCount != null)
    args.push("--loop", String(request.loopCount));
  return parsed(args);
}

function argv(input, planning) {
  const args = [
    "export",
    "video",
    planning ? input.node.planningValue : input.node.nodeId,
  ];
  if (input.format !== VIDEO_EXPORT_DEFAULT_FORMAT)
    args.push("-f", input.format.toLowerCase());
  if (input.fps !== VIDEO_EXPORT_DEFAULT_FPS)
    args.push("--fps", String(input.fps));
  if (
    input.format !== "GIF" &&
    input.quality !== VIDEO_EXPORT_DEFAULT_QUALITY
  ) {
    args.push("--quality", input.quality.toLowerCase());
  }
  if (
    input.format === "GIF" &&
    input.loopCount !== VIDEO_EXPORT_DEFAULT_LOOP_COUNT
  ) {
    args.push("--loop", String(input.loopCount));
  }
  // Keep the owned workspace output last, matching the established canonical
  // export argv shape consumed by plan/report tests and human diagnostics.
  if (input.outputPath.startsWith("-"))
    args.push(`--output=${input.outputPath}`);
  else args.push("-o", input.outputPath);
  return args;
}

export function videoExportArgvFromRequest(request) {
  return argv(typed(request), false);
}

export function videoExportPlanningArgvFromRequest(request) {
  return argv(typed(request), true);
}

export function videoExportFigmaUrlFileKeyFromArgv(args) {
  return parsed(args).node.fileKey;
}
