/**
 * 仅用于“自动更新”场景的极简 ZIP 读取器：
 * - 依赖 Node 内置 zlib（deflate/raw）
 * - 仅支持 stored(0) 与 deflate(8)
 * - 通过中央目录读取文件列表与偏移，避免依赖本地头部的 data descriptor
 *
 * @param {Uint8Array} zipBytes
 * @param {{ zlib: any }} deps
 * @returns {{ ok:true, files: Array<{path:string, data:Uint8Array}> } | { ok:false, error:string }}
 */
export function unzipToMemory(zipBytes, deps) {
  try {
    const zlib = deps && deps.zlib ? deps.zlib : null;
    if (!zlib || typeof zlib.inflateRawSync !== "function") return { ok: false, error: "zlib unavailable" };

    const buf = toBuffer(zipBytes);
    if (!buf) return { ok: false, error: "bad zip bytes" };

    const eocdOffset = findEocdOffset(buf);
    if (eocdOffset < 0) return { ok: false, error: "bad zip (eocd missing)" };

    const totalEntries = readU16LE(buf, eocdOffset + 10);
    const centralDirSize = readU32LE(buf, eocdOffset + 12);
    const centralDirOffset = readU32LE(buf, eocdOffset + 16);

    if (centralDirOffset + centralDirSize > buf.length) return { ok: false, error: "bad zip (cd out of range)" };

    /** @type {Array<{path:string, data:Uint8Array}>} */
    const out = [];
    let p = centralDirOffset;
    for (let i = 0; i < totalEntries; i++) {
      if (p + 46 > buf.length) return { ok: false, error: "bad zip (cd truncated)" };
      const sig = readU32LE(buf, p);
      if (sig !== 0x02014b50) return { ok: false, error: "bad zip (cd signature)" };

      const flags = readU16LE(buf, p + 8);
      const method = readU16LE(buf, p + 10);
      const compSize = readU32LE(buf, p + 20);
      const uncompSize = readU32LE(buf, p + 24);
      const nameLen = readU16LE(buf, p + 28);
      const extraLen = readU16LE(buf, p + 30);
      const commentLen = readU16LE(buf, p + 32);
      const localOffset = readU32LE(buf, p + 42);

      const nameStart = p + 46;
      const nameEnd = nameStart + nameLen;
      if (nameEnd > buf.length) return { ok: false, error: "bad zip (name out of range)" };

      const nameBytes = buf.subarray(nameStart, nameEnd);
      const rawName = decodeZipName(nameBytes, (flags & 0x0800) !== 0);
      const normName = normalizeZipPath(rawName);

      p = nameEnd + extraLen + commentLen;

      if (!normName) continue;
      if (normName.endsWith("/")) continue;

      const fileData = readLocalFileData(buf, localOffset, compSize);
      if (!fileData) return { ok: false, error: "bad zip (local data)" };

      let data = null;
      if (method === 0) data = fileData;
      else if (method === 8) data = zlib.inflateRawSync(fileData);
      else return { ok: false, error: `unsupported method: ${method}` };

      if (!data) return { ok: false, error: "unzip failed" };
      const u8 = toUint8Array(data);
      if (!u8) return { ok: false, error: "unzip failed" };
      // 轻量校验：大小不匹配仅忽略（部分 zip 会在字段上不严格）。
      if (typeof uncompSize === "number" && uncompSize >= 0 && u8.length !== uncompSize) {
        // ignore
      }
      out.push({ path: normName, data: u8 });
    }

    return { ok: true, files: out };
  } catch (e) {
    return { ok: false, error: String(e && e.message ? e.message : e) || "unknown" };
  }
}

/**
 * @param {any} data
 * @returns {Uint8Array|null}
 */
function toUint8Array(data) {
  if (!data) return null;
  if (data instanceof Uint8Array) return data;
  // Node Buffer
  if (typeof data === "object" && typeof data.length === "number" && typeof data.subarray === "function") {
    try {
      return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    } catch (e) {
      return null;
    }
  }
  return null;
}

/**
 * @param {Uint8Array} u8
 * @returns {any|null}
 */
function toBuffer(u8) {
  try {
    // eslint-disable-next-line no-undef
    if (typeof Buffer !== "undefined" && Buffer.from) return Buffer.from(u8);
  } catch (e) {}
  return null;
}

/**
 * EOCD 通常在文件末尾 22 + commentLen 字节；comment 最多 65535。
 * @param {any} buf
 * @returns {number}
 */
function findEocdOffset(buf) {
  const min = Math.max(0, buf.length - 22 - 0xffff);
  for (let i = buf.length - 22; i >= min; i--) {
    if (readU32LE(buf, i) === 0x06054b50) return i;
  }
  return -1;
}

/**
 * @param {any} buf
 * @param {number} off
 * @returns {number}
 */
function readU16LE(buf, off) {
  return buf[off] | (buf[off + 1] << 8);
}

/**
 * @param {any} buf
 * @param {number} off
 * @returns {number}
 */
function readU32LE(buf, off) {
  return (buf[off] | (buf[off + 1] << 8) | (buf[off + 2] << 16) | (buf[off + 3] << 24)) >>> 0;
}

/**
 * @param {any} buf
 * @param {number} localOffset
 * @param {number} compSize
 * @returns {any|null}
 */
function readLocalFileData(buf, localOffset, compSize) {
  if (localOffset + 30 > buf.length) return null;
  if (readU32LE(buf, localOffset) !== 0x04034b50) return null;
  const nameLen = readU16LE(buf, localOffset + 26);
  const extraLen = readU16LE(buf, localOffset + 28);
  const dataStart = localOffset + 30 + nameLen + extraLen;
  const dataEnd = dataStart + compSize;
  if (dataEnd > buf.length) return null;
  return buf.subarray(dataStart, dataEnd);
}

/**
 * @param {any} nameBytes
 * @param {boolean} utf8
 * @returns {string}
 */
function decodeZipName(nameBytes, utf8) {
  try {
    // Node Buffer decode
    // eslint-disable-next-line no-undef
    if (typeof Buffer !== "undefined" && Buffer.from) {
      return Buffer.from(nameBytes).toString(utf8 ? "utf8" : "utf8");
    }
  } catch (e) {}
  try {
    const dec = new TextDecoder("utf-8");
    return dec.decode(nameBytes);
  } catch (e) {
    return "";
  }
}

/**
 * 规范化 zip 内路径，过滤绝对路径与穿越。
 *
 * @param {string} name
 * @returns {string}
 */
function normalizeZipPath(name) {
  let s = String(name || "");
  if (!s) return "";
  s = s.replace(/\\/g, "/");
  while (s.startsWith("./")) s = s.slice(2);
  // 禁止绝对路径/盘符
  if (s.startsWith("/") || /^[a-zA-Z]:\//.test(s)) return "";
  const parts = s.split("/").filter((p) => p && p !== ".");
  if (parts.some((p) => p === "..")) return "";
  return parts.join("/") + (s.endsWith("/") ? "/" : "");
}

