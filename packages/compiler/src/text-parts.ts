import { open } from "node:fs/promises";

/** Writes compiler text artifacts (LLVM, serialized IR) in large batches.
 * Programs past the engine's string limit arrive as many parts, and writing
 * each part separately is several times slower than writing the same bytes in
 * a few large chunks. Batches stay far below the limit. */
export async function writeTextParts(
  path: string,
  text: string | readonly string[],
  mode = 0o666,
): Promise<void> {
  const file = await open(path, "w", mode);
  try {
    const write = async (chunk: string): Promise<void> => {
      const bytes = Buffer.from(chunk, "utf8");
      for (let offset = 0; offset < bytes.length;) {
        const { bytesWritten } = await file.write(bytes, offset, bytes.length - offset);
        offset += bytesWritten;
      }
    };
    if (typeof text === "string") return await write(text);
    let batch: string[] = [];
    let length = 0;
    for (const part of text) {
      batch.push(part);
      length += part.length;
      if (length >= 16 * 1024 * 1024) {
        await write(batch.join(""));
        batch = [];
        length = 0;
      }
    }
    if (batch.length > 0) await write(batch.join(""));
  } finally {
    await file.close();
  }
}
