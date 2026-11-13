const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipInputEntry {
  name: string;
  data: string | Uint8Array;
}

/**
 * Zero-dependency deterministic PKZIP builder (STORE method 0, UTF-8 flag 0x0800) for OOXML `.docx` archives.
 */
export function buildZip(entries: ZipInputEntry[]): Uint8Array {
  const enc = new TextEncoder();
  const prepared = entries.map((e) => {
    const nameBytes = enc.encode(e.name);
    const dataBytes = typeof e.data === "string" ? enc.encode(e.data) : e.data;
    return { nameBytes, dataBytes, crc: crc32(dataBytes) };
  });

  const localTotal = prepared.reduce((sum, e) => sum + 30 + e.nameBytes.length + e.dataBytes.length, 0);
  const centralTotal = prepared.reduce((sum, e) => sum + 46 + e.nameBytes.length, 0);
  const out = new Uint8Array(localTotal + centralTotal + 22);
  const view = new DataView(out.buffer);

  const offsets: number[] = [];
  let ptr = 0;

  for (const e of prepared) {
    offsets.push(ptr);
    view.setUint32(ptr, 0x04034b50, true); // Local file header signature
    view.setUint16(ptr + 4, 20, true); // Version needed to extract (2.0)
    view.setUint16(ptr + 6, 0x0800, true); // UTF-8 filename flag
    view.setUint16(ptr + 8, 0, true); // Method 0: STORE
    view.setUint16(ptr + 10, 0x0000, true); // DOS mod time
    view.setUint16(ptr + 12, 0x0021, true); // DOS mod date (1980-01-01)
    view.setUint32(ptr + 14, e.crc, true);
    view.setUint32(ptr + 18, e.dataBytes.length, true);
    view.setUint32(ptr + 22, e.dataBytes.length, true);
    view.setUint16(ptr + 26, e.nameBytes.length, true);
    view.setUint16(ptr + 28, 0, true);
    out.set(e.nameBytes, ptr + 30);
    out.set(e.dataBytes, ptr + 30 + e.nameBytes.length);
    ptr += 30 + e.nameBytes.length + e.dataBytes.length;
  }

  const centralStart = ptr;
  prepared.forEach((e, idx) => {
    view.setUint32(ptr, 0x02014b50, true); // Central directory file header signature
    view.setUint16(ptr + 4, 20, true); // Version made by
    view.setUint16(ptr + 6, 20, true); // Version needed
    view.setUint16(ptr + 8, 0x0800, true); // UTF-8 filename flag
    view.setUint16(ptr + 10, 0, true); // Method 0: STORE
    view.setUint16(ptr + 12, 0x0000, true);
    view.setUint16(ptr + 14, 0x0021, true);
    view.setUint32(ptr + 16, e.crc, true);
    view.setUint32(ptr + 20, e.dataBytes.length, true);
    view.setUint32(ptr + 24, e.dataBytes.length, true);
    view.setUint16(ptr + 28, e.nameBytes.length, true);
    view.setUint16(ptr + 30, 0, true); // Extra len
    view.setUint16(ptr + 32, 0, true); // Comment len
    view.setUint16(ptr + 34, 0, true); // Disk number
    view.setUint16(ptr + 36, 0, true); // Internal attrs
    view.setUint32(ptr + 38, 0, true); // External attrs
    view.setUint32(ptr + 42, offsets[idx]!, true); // Local header offset
    out.set(e.nameBytes, ptr + 46);
    ptr += 46 + e.nameBytes.length;
  });

  const centralSize = ptr - centralStart;
  view.setUint32(ptr, 0x06054b50, true); // End of central directory signature
  view.setUint16(ptr + 4, 0, true);
  view.setUint16(ptr + 6, 0, true);
  view.setUint16(ptr + 8, prepared.length, true);
  view.setUint16(ptr + 10, prepared.length, true);
  view.setUint32(ptr + 12, centralSize, true);
  view.setUint32(ptr + 16, centralStart, true);
  view.setUint16(ptr + 20, 0, true);

  return out;
}

/**
 * Lightweight zero-dependency reader for STORE-encoded ZIP archives (verifies central directory + CRC-32).
 */
export function readZip(archive: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  let eocd = archive.byteLength - 22;
  while (eocd >= 0 && view.getUint32(eocd, true) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error("Invalid ZIP archive: missing End of Central Directory");

  const totalEntries = view.getUint16(eocd + 10, true);
  let ptr = view.getUint32(eocd + 16, true);
  const dec = new TextDecoder();
  const entries = new Map<string, Uint8Array>();

  for (let i = 0; i < totalEntries; i++) {
    if (view.getUint32(ptr, true) !== 0x02014b50) throw new Error("Invalid ZIP central directory header");
    const method = view.getUint16(ptr + 10, true);
    const expectedCrc = view.getUint32(ptr + 16, true);
    const compSize = view.getUint32(ptr + 20, true);
    const nameLen = view.getUint16(ptr + 28, true);
    const extraLen = view.getUint16(ptr + 30, true);
    const commentLen = view.getUint16(ptr + 32, true);
    const localOff = view.getUint32(ptr + 42, true);
    const name = dec.decode(archive.subarray(ptr + 46, ptr + 46 + nameLen));

    if (view.getUint32(localOff, true) !== 0x04034b50) throw new Error(`Invalid ZIP local header for ${name}`);
    const localNameLen = view.getUint16(localOff + 26, true);
    const localExtraLen = view.getUint16(localOff + 28, true);
    const dataStart = localOff + 30 + localNameLen + localExtraLen;
    if (method !== 0) throw new Error(`Unsupported compression method ${method} in readZip for ${name}`);
    const slice = archive.slice(dataStart, dataStart + compSize);
    if (crc32(slice) !== expectedCrc) throw new Error(`CRC-32 mismatch for ${name}`);
    if (!name.endsWith("/")) entries.set(name, slice);
    ptr += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}
