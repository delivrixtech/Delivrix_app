import { inflateRawSync } from "node:zlib";
import { crc32 } from "./zip-archive.ts";

/**
 * Lector mínimo de ZIP para tests: recorre el central directory y devuelve el
 * contenido de cada entrada. No es parte del runtime; solo verifica lo que
 * produce createZipArchive.
 */
export interface ReadZipEntry {
  name: string;
  content: string;
  method: number;
}

const centralHeaderSignature = 0x02014b50;
const endOfCentralDirectorySignature = 0x06054b50;

export function readZipEntries(archive: Buffer): ReadZipEntry[] {
  const eocd = findEndOfCentralDirectory(archive);
  const entryCount = archive.readUInt16LE(eocd + 10);
  const entries: ReadZipEntry[] = [];
  let cursor = archive.readUInt32LE(eocd + 16);

  for (let index = 0; index < entryCount; index += 1) {
    if (archive.readUInt32LE(cursor) !== centralHeaderSignature) {
      throw new Error(`central directory header inválido en la entrada ${index}`);
    }
    const method = archive.readUInt16LE(cursor + 10);
    const expectedCrc = archive.readUInt32LE(cursor + 16);
    const compressedSize = archive.readUInt32LE(cursor + 20);
    const uncompressedSize = archive.readUInt32LE(cursor + 24);
    const nameLength = archive.readUInt16LE(cursor + 28);
    const extraLength = archive.readUInt16LE(cursor + 30);
    const commentLength = archive.readUInt16LE(cursor + 32);
    const localOffset = archive.readUInt32LE(cursor + 42);
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString("utf8");

    const localNameLength = archive.readUInt16LE(localOffset + 26);
    const localExtraLength = archive.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const payload = archive.subarray(dataStart, dataStart + compressedSize);
    const content = method === 8 ? inflateRawSync(payload) : Buffer.from(payload);

    if (content.length !== uncompressedSize) {
      throw new Error(`tamaño descomprimido no coincide para ${name}`);
    }
    if (crc32(content) !== expectedCrc) {
      throw new Error(`crc32 no coincide para ${name}`);
    }

    entries.push({ name, content: content.toString("utf8"), method });
    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}

function findEndOfCentralDirectory(archive: Buffer): number {
  for (let offset = archive.length - 22; offset >= 0; offset -= 1) {
    if (archive.readUInt32LE(offset) === endOfCentralDirectorySignature) {
      return offset;
    }
  }
  throw new Error("end of central directory no encontrado");
}
