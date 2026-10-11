import { closeSync, openSync, writeSync } from "node:fs";

/** Native compiler strings stop at 2^31 - 1 UTF-8 bytes, and exceeding that
 * traps instead of throwing. Large artifacts therefore travel as bounded
 * parts; this is the part size that batching aims for. */
export const TEXT_BATCH_LENGTH = 16 * 1024 * 1024;

/** Join consecutive small parts into batches of about TEXT_BATCH_LENGTH
 * UTF-16 units, so callers hold and write few, still-bounded strings. */
export function batchTextParts(parts: readonly string[]): string[] {
  const batches: string[] = [];
  let batch: string[] = [];
  let length = 0;
  for (const part of parts) {
    batch.push(part);
    length += part.length;
    if (length >= TEXT_BATCH_LENGTH) {
      batches.push(batch.join(""));
      batch = [];
      length = 0;
    }
  }
  if (batch.length > 0) batches.push(batch.join(""));
  return batches;
}

/** Write text parts to `path` in order without joining them first. Each part
 * is one write; pass batched parts (`batchTextParts`) for many small ones. */
export function writeTextPartsSync(path: string, parts: readonly string[]): void {
  const fd = openSync(path, "w");
  try {
    for (const part of parts) {
      const bytes = Buffer.from(part, "utf8");
      for (let offset = 0; offset < bytes.length;) {
        offset += writeSync(fd, bytes, offset, bytes.length - offset);
      }
    }
  } finally {
    closeSync(fd);
  }
}
