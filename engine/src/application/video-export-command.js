// Plan-bound export of one top-level animated Figma frame as MP4, GIF or
// WebM. Commander and MCP share request validation, Plugin capture, bounded
// transport validation and Workspace publication through this Application.

import { isFigmaCommandPlan } from "../../../src/capability-catalog.js";
import {
  MAX_PLUGIN_MESSAGE_BYTES,
  MAX_PROTOCOL_VALUE_BYTES,
} from "../lib/protocol-contract.js";
import { NODE_REFERENCE_PATTERN } from "./node-reference.js";
import {
  parseVideoExportRequest,
  videoExportArgvFromRequest,
  videoExportPlanningArgvFromRequest,
} from "./video-export-request.js";

export const VIDEO_EXPORT_OUTPUT_ROLE = "video-output";
export const MAX_VIDEO_EXPORT_BASE64_CODE_UNITS =
  Math.min(MAX_PROTOCOL_VALUE_BYTES, MAX_PLUGIN_MESSAGE_BYTES) - 64 * 1024;
export const MAX_VIDEO_EXPORT_BYTES =
  Math.floor(MAX_VIDEO_EXPORT_BASE64_CODE_UNITS / 4) * 3;

const APPLICATION_ID = "export.video";
const MAX_NAME_CODE_UNITS = 1024;
const MAX_NODE_ID_CODE_UNITS = 512;
const MAX_GEOMETRY = 100_000_000;
const UNSAFE_TEXT = /[\u0000-\u001f\u007f-\u009f\u2028-\u202e\u2066-\u2069]/;
const MP4_BRANDS = new Set([
  "M4V ",
  "MSNV",
  "avc1",
  "dash",
  "iso2",
  "iso3",
  "iso4",
  "iso5",
  "iso6",
  "isom",
  "mp41",
  "mp42",
]);

export { videoExportArgvFromRequest, videoExportPlanningArgvFromRequest };

function exact(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function validString(value, maximum = MAX_NAME_CODE_UNITS, { empty = false } = {}) {
  return (
    typeof value === "string" &&
    (empty || value.length > 0) &&
    value.length <= maximum &&
    !UNSAFE_TEXT.test(value)
  );
}

function validId(value) {
  return (
    validString(value, MAX_NODE_ID_CODE_UNITS) &&
    NODE_REFERENCE_PATTERN.test(value)
  );
}

function validGeometry(value) {
  return Number.isFinite(value) && value > 0 && value <= MAX_GEOMETRY;
}

function decodeCanonicalBase64(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > MAX_VIDEO_EXPORT_BASE64_CODE_UNITS ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      value
    )
  ) {
    throw new Error("Video Export returned invalid bounded Base64 data.");
  }
  const bytes = Buffer.from(value, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > MAX_VIDEO_EXPORT_BYTES ||
    bytes.toString("base64") !== value
  ) {
    throw new Error(
      "Video Export returned non-canonical or oversized Base64 data."
    );
  }
  return bytes;
}

function inspectMp4(bytes) {
  if (bytes.length < 32) {
    throw new Error("Video Export returned incomplete MP4 data.");
  }
  const types = [];
  let offset = 0;
  while (offset < bytes.length) {
    if (bytes.length - offset < 8)
      throw new Error("Video Export returned a truncated MP4 box.");
    let size = bytes.readUInt32BE(offset);
    const type = bytes.subarray(offset + 4, offset + 8).toString("latin1");
    let header = 8;
    if (size === 1) {
      if (bytes.length - offset < 16)
        throw new Error("Video Export returned a truncated large MP4 box.");
      const largeSize = bytes.readBigUInt64BE(offset + 8);
      if (largeSize > BigInt(Number.MAX_SAFE_INTEGER))
        throw new Error("Video Export returned an excessive MP4 box.");
      size = Number(largeSize);
      header = 16;
    } else if (size === 0) {
      size = bytes.length - offset;
    }
    if (
      !/^[\x20-\x7e]{4}$/.test(type) ||
      size < header ||
      offset + size > bytes.length
    ) {
      throw new Error("Video Export returned malformed MP4 box topology.");
    }
    types.push(type);
    offset += size;
  }
  if (types[0] !== "ftyp")
    throw new Error("Video Export returned data without an MP4 file type.");
  const ftypSize = bytes.readUInt32BE(0);
  if (ftypSize < 16 || ftypSize > bytes.length)
    throw new Error("Video Export returned an invalid MP4 file type box.");
  const brands = [];
  for (let index = 8; index + 4 <= ftypSize; index += 4) {
    if (index === 12) continue;
    brands.push(bytes.subarray(index, index + 4).toString("latin1"));
  }
  if (!brands.some((brand) => MP4_BRANDS.has(brand)))
    throw new Error("Video Export returned a non-MP4 ISO media brand.");
  if (!types.includes("moov") || !types.includes("mdat")) {
    throw new Error("Video Export returned incomplete MP4 media topology.");
  }
  return Object.freeze({ kind: "mp4" });
}

function inspectGif(bytes) {
  const signature = bytes.subarray(0, 6).toString("ascii");
  if (
    bytes.length < 14 ||
    !["GIF87a", "GIF89a"].includes(signature) ||
    bytes.at(-1) !== 0x3b
  ) {
    throw new Error("Video Export returned incomplete GIF data.");
  }
  const pixelWidth = bytes.readUInt16LE(6);
  const pixelHeight = bytes.readUInt16LE(8);
  if (pixelWidth < 1 || pixelHeight < 1) {
    throw new Error("Video Export returned invalid GIF dimensions.");
  }
  return Object.freeze({ kind: "gif", pixelWidth, pixelHeight });
}

function inspectWebm(bytes) {
  const ebml = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  const segment = Buffer.from([0x18, 0x53, 0x80, 0x67]);
  const docType = Buffer.from([0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d]);
  const header = bytes.subarray(0, Math.min(bytes.length, 64 * 1024));
  if (
    bytes.length < 16 ||
    !bytes.subarray(0, 4).equals(ebml) ||
    header.indexOf(docType) < 0 ||
    header.indexOf(segment) < 0
  ) {
    throw new Error("Video Export returned incomplete WebM data.");
  }
  return Object.freeze({ kind: "webm" });
}

function inspectContainer(bytes, format) {
  if (format === "MP4") return inspectMp4(bytes);
  if (format === "GIF") return inspectGif(bytes);
  return inspectWebm(bytes);
}

function validatedResult(value, request) {
  if (exact(value, ["error"])) {
    if (!validString(value.error, 4096))
      throw new Error("Video Export returned an invalid bounded Figma error.");
    throw new Error(value.error);
  }
  if (
    !exact(value, [
      "requestedId",
      "frameId",
      "frameName",
      "frameWidth",
      "frameHeight",
      "format",
      "fps",
      "quality",
      "loopCount",
      "base64",
    ]) ||
    value.requestedId !== request.nodeId ||
    !validId(value.requestedId) ||
    !validId(value.frameId) ||
    !validString(value.frameName, MAX_NAME_CODE_UNITS, { empty: true }) ||
    !validGeometry(value.frameWidth) ||
    !validGeometry(value.frameHeight) ||
    value.format !== request.format ||
    value.fps !== request.fps ||
    value.quality !== request.quality ||
    value.loopCount !== request.loopCount
  ) {
    throw new Error("Video Export returned invalid bounded frame evidence.");
  }
  const bytes = decodeCanonicalBase64(value.base64);
  return Object.freeze({
    requestedId: value.requestedId,
    frameId: value.frameId,
    frameName: value.frameName,
    frameWidth: value.frameWidth,
    frameHeight: value.frameHeight,
    format: value.format,
    fps: value.fps,
    quality: value.quality,
    loopCount: value.loopCount,
    bytes,
    byteLength: bytes.length,
    ...inspectContainer(bytes, request.format),
  });
}

export function videoExportCode(request) {
  const input = parseVideoExportRequest(videoExportArgvFromRequest(request));
  const settings =
    input.format === "GIF"
      ? { format: input.format, fps: input.fps, loopCount: input.loopCount }
      : { format: input.format, fps: input.fps, quality: input.quality };
  return `(async () => {
    const clean = (value, max) => typeof value === 'string'
      ? value.slice(0, max).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028-\\u202e\\u2066-\\u2069]/g, ' ')
      : '';
    try {
      if (figma.editorType !== 'figma') {
        return { error: 'Video export is only available in Figma Design' };
      }
      const requested = await figma.getNodeByIdAsync(${JSON.stringify(input.nodeId)});
      if (!requested || typeof requested.exportAsync !== 'function') {
        return { error: 'Exportable node not found' };
      }
      const frame = requested.type === 'FRAME'
        && requested.parent && requested.parent.type === 'PAGE'
        ? requested
        : (typeof requested.getTopLevelFrame === 'function'
          ? requested.getTopLevelFrame()
          : null);
      if (!frame || frame.type !== 'FRAME' || !frame.parent
        || frame.parent.type !== 'PAGE' || typeof frame.exportAsync !== 'function') {
        return { error: 'Video export requires a top-level frame or one of its descendants' };
      }
      const frameWidth = Number(frame.width);
      const frameHeight = Number(frame.height);
      if (!Number.isFinite(frameWidth) || frameWidth <= 0 || frameWidth > ${MAX_GEOMETRY}
        || !Number.isFinite(frameHeight) || frameHeight <= 0 || frameHeight > ${MAX_GEOMETRY}) {
        return { error: 'Video export frame geometry is invalid' };
      }
      const bytes = await frame.exportAsync(${JSON.stringify(settings)});
      if (!(bytes instanceof Uint8Array) || !Number.isSafeInteger(bytes.length)
        || bytes.length < 1 || bytes.length > ${MAX_VIDEO_EXPORT_BYTES}) {
        return { error: 'Video export exceeds the bounded Plugin transport' };
      }
      const base64 = figma.base64Encode(bytes);
      if (base64.length > ${MAX_VIDEO_EXPORT_BASE64_CODE_UNITS}) {
        return { error: 'Video export exceeds the bounded Plugin transport' };
      }
      return {
        requestedId: clean(requested.id, ${MAX_NODE_ID_CODE_UNITS}),
        frameId: clean(frame.id, ${MAX_NODE_ID_CODE_UNITS}),
        frameName: clean(frame.name, ${MAX_NAME_CODE_UNITS}),
        frameWidth,
        frameHeight,
        format: ${JSON.stringify(input.format)},
        fps: ${input.fps},
        quality: ${JSON.stringify(input.quality)},
        loopCount: ${JSON.stringify(input.loopCount)},
        base64
      };
    } catch (error) {
      return { error: clean(error && error.message ? error.message : String(error), 4096) };
    }
  })()`;
}

export function videoExportPlanRoute(plan) {
  if (!isFigmaCommandPlan(plan)) {
    throw new TypeError(
      "Video Export routing requires a Command Plan created by the Capability Catalog."
    );
  }
  return plan.allowed && plan.id === APPLICATION_ID
    ? "command-application"
    : "not-video-export";
}

export async function executeVideoExportPlan(plan, adapters = {}) {
  if (videoExportPlanRoute(plan) !== "command-application") {
    throw new Error(
      `Command Plan ${plan?.id || "(unknown)"} is not owned by the Video Export Command Application.`
    );
  }
  if (typeof adapters.evaluate !== "function") {
    throw new TypeError("executeVideoExportPlan requires evaluate(code).");
  }
  if (!adapters.workspaceIO || typeof adapters.workspaceIO.write !== "function") {
    throw new TypeError("executeVideoExportPlan requires WorkspaceIO.");
  }
  const request = parseVideoExportRequest(plan.argv);
  const outputs = plan.outputs.filter(
    (output) => output.role === VIDEO_EXPORT_OUTPUT_ROLE
  );
  if (
    plan.outputs.length !== 1 ||
    outputs.length !== 1 ||
    outputs[0].path !== request.outputPath
  ) {
    throw new Error("Video Export output path is not owned by the Command Plan.");
  }
  const result = validatedResult(
    await adapters.evaluate(videoExportCode(request)),
    request
  );
  await adapters.workspaceIO.write(outputs[0].path, result.bytes, {
    role: VIDEO_EXPORT_OUTPUT_ROLE,
    createParents: true,
  });
  const metadata = Object.freeze({
    requestedId: result.requestedId,
    frame: Object.freeze({
      id: result.frameId,
      name: result.frameName,
      width: result.frameWidth,
      height: result.frameHeight,
    }),
    format: result.format,
    fps: result.fps,
    quality: result.quality,
    loopCount: result.loopCount,
    byteLength: result.byteLength,
    container: result.kind,
    ...(result.kind === "gif"
      ? { pixelWidth: result.pixelWidth, pixelHeight: result.pixelHeight }
      : {}),
    saved: outputs[0].path,
  });
  return {
    stdout: `✓ Exported ${metadata.frame.name} as ${metadata.format} at ${metadata.fps} fps → ${metadata.saved}`,
    stderr: request.warning ? `⚠ ${request.warning}` : "",
    result: metadata,
  };
}
