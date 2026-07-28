import { deflateRawSync } from "node:zlib";

/**
 * Constructor de archivos ZIP en memoria, sin dependencias externas.
 *
 * Solo soporta lo que necesitamos hoy: entradas pequeñas (markdown de
 * credenciales) que caben en RAM, sin directorios ni ZIP64. Si algún día hay
 * que empaquetar cientos de MB, esto debe pasar a streaming.
 */
export interface ZipEntry {
  name: string;
  content: string | Buffer;
}

const localHeaderSignature = 0x04034b50;
const centralHeaderSignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;
/** Bit 11: los nombres de archivo van en UTF-8. */
const utf8NameFlag = 0x0800;
const deflateMethod = 8;
const storeMethod = 0;
const versionNeeded = 20;
const maxEntries = 0xffff;
/** Permisos 0644 en los 16 bits altos de los atributos externos (unix). */
const unixFileAttributes = 0o100644 * 0x10000;

export function createZipArchive(entries: ZipEntry[], modifiedAt: Date = new Date()): Buffer {
  if (entries.length > maxEntries) {
    throw new Error(`zip_too_many_entries: ${entries.length} > ${maxEntries}`);
  }

  const { time, date } = dosDateTime(modifiedAt);
  const localChunks: Buffer[] = [];
  const centralChunks: Buffer[] = [];
  const usedNames = new Set<string>();
  let offset = 0;

  for (const entry of entries) {
    const nameBytes = Buffer.from(uniqueEntryName(entry.name, usedNames), "utf8");
    const content = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, "utf8");
    const deflated = deflateRawSync(content);
    // Guardamos sin comprimir cuando deflate no ayuda (archivos diminutos).
    const useDeflate = deflated.length < content.length;
    const payload = useDeflate ? deflated : content;
    const method = useDeflate ? deflateMethod : storeMethod;
    const crc = crc32(content);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(localHeaderSignature, 0);
    localHeader.writeUInt16LE(versionNeeded, 4);
    localHeader.writeUInt16LE(utf8NameFlag, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(time, 10);
    localHeader.writeUInt16LE(date, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(payload.length, 18);
    localHeader.writeUInt32LE(content.length, 22);
    localHeader.writeUInt16LE(nameBytes.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localChunks.push(localHeader, nameBytes, payload);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(centralHeaderSignature, 0);
    centralHeader.writeUInt16LE(versionNeeded, 4);
    centralHeader.writeUInt16LE(versionNeeded, 6);
    centralHeader.writeUInt16LE(utf8NameFlag, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(time, 12);
    centralHeader.writeUInt16LE(date, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(payload.length, 20);
    centralHeader.writeUInt32LE(content.length, 24);
    centralHeader.writeUInt16LE(nameBytes.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(unixFileAttributes, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralChunks.push(centralHeader, nameBytes);

    offset += localHeader.length + nameBytes.length + payload.length;
  }

  const central = Buffer.concat(centralChunks);
  const endOfCentralDirectory = Buffer.alloc(22);
  endOfCentralDirectory.writeUInt32LE(endOfCentralDirectorySignature, 0);
  endOfCentralDirectory.writeUInt16LE(0, 4);
  endOfCentralDirectory.writeUInt16LE(0, 6);
  endOfCentralDirectory.writeUInt16LE(usedNames.size, 8);
  endOfCentralDirectory.writeUInt16LE(usedNames.size, 10);
  endOfCentralDirectory.writeUInt32LE(central.length, 12);
  endOfCentralDirectory.writeUInt32LE(offset, 16);
  endOfCentralDirectory.writeUInt16LE(0, 20);

  return Buffer.concat([...localChunks, central, endOfCentralDirectory]);
}

/**
 * Nombre plano y seguro: sin rutas, sin `..`, sin control chars. Los nombres
 * salen de datos almacenados (dominios), así que no confiamos en ellos para
 * armar rutas dentro del zip.
 */
function sanitizeEntryName(value: string): string {
  const flattened = value
    .replace(/\\/g, "/")
    .split("/")
    .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..")
    .join("_");
  // eslint-disable-next-line no-control-regex
  const cleaned = flattened.replace(/[\u0000-\u001f\u007f:*?"<>|]/g, "_").trim();
  return cleaned.length > 0 ? cleaned.slice(0, 200) : "archivo";
}

function uniqueEntryName(rawName: string, usedNames: Set<string>): string {
  const name = sanitizeEntryName(rawName);
  if (!usedNames.has(name)) {
    usedNames.add(name);
    return name;
  }
  const dotIndex = name.lastIndexOf(".");
  const stem = dotIndex > 0 ? name.slice(0, dotIndex) : name;
  const extension = dotIndex > 0 ? name.slice(dotIndex) : "";
  for (let suffix = 2; suffix < 10_000; suffix += 1) {
    const candidate = `${stem}-${suffix}${extension}`;
    if (!usedNames.has(candidate)) {
      usedNames.add(candidate);
      return candidate;
    }
  }
  throw new Error(`zip_duplicate_entry_name: ${name}`);
}

function dosDateTime(value: Date): { time: number; date: number } {
  const stamp = Number.isNaN(value.getTime()) ? new Date(0) : value;
  // El epoch de ZIP es 1980; cualquier fecha anterior se ancla ahí.
  const year = Math.max(1980, stamp.getUTCFullYear());
  const time =
    (stamp.getUTCHours() << 11) | (stamp.getUTCMinutes() << 5) | Math.floor(stamp.getUTCSeconds() / 2);
  const date = ((year - 1980) << 9) | ((stamp.getUTCMonth() + 1) << 5) | stamp.getUTCDate();
  return { time, date };
}

let cachedCrcTable: Uint32Array | null = null;

function crc32Table(): Uint32Array {
  if (cachedCrcTable) return cachedCrcTable;
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  cachedCrcTable = table;
  return table;
}

export function crc32(buffer: Buffer): number {
  const table = crc32Table();
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc = (table[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
