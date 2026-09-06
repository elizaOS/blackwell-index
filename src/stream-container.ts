/**
 * Local V2 recovery container. This layer authenticates opaque bounded frames;
 * the caller must separately validate the source descriptor, blocks and seal.
 * A reader is verified only after its iterator returns normally at strict EOF.
 *
 * Wire format (all integers unsigned big endian):
 *   magic | random salt[32] | maximum frame bytes:u32
 *   repeated(type:u8 | index:u64 | bytes:u32 | ciphertext[bytes] | GCM tag[16])
 * Type 1 carries opaque source bytes. Type 255 is an authenticated terminal
 * containing data-frame count:u64 and total plaintext bytes:u64. The AES key is
 * HKDF-SHA256(recovery key, salt, format-specific info); nonce = zero:u32|index:u64.
 * AAD binds the format, complete header digest, frame type, index and length.
 * This is standard Node crypto, not an encryption primitive implemented here.
 */
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, realpathSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export const STREAM_CONTAINER_FORMAT = "SBX_NODE_RECOVERY_V2";
const MAGIC = Buffer.from(`${STREAM_CONTAINER_FORMAT}\n`, "ascii");
const KDF_INFO = Buffer.from(`${STREAM_CONTAINER_FORMAT}:AES-256-GCM:HKDF-SHA256`, "ascii");
const AAD_DOMAIN = Buffer.from(`${STREAM_CONTAINER_FORMAT}:FRAME\n`, "ascii");
const DATA = 1, TERMINAL = 255, TAG_BYTES = 16, FRAME_HEADER_BYTES = 13;
export const STREAM_CONTAINER_HEADER_BYTES = MAGIC.length + 32 + 4;
export const STREAM_CONTAINER_LIMITS = Object.freeze({
  maxFrameBytes: 512 * 1024,
  hardMaxFrameBytes: 2 * 1024 * 1024,
  maxArchiveBytes: 20 * 1024 * 1024 * 1024,
  minFreeDiskBytes: 64 * 1024 * 1024,
});

export interface StreamContainerOptions {
  signal?: AbortSignal;
  maxFrameBytes?: number;
  maxArchiveBytes?: number;
  /** Writer only: leave this much space available after each bounded write. */
  minFreeDiskBytes?: number;
}
export interface StreamContainerSummary {
  format: typeof STREAM_CONTAINER_FORMAT;
  file: string;
  archiveBytes: number;
  plaintextBytes: number;
  frames: number;
  sha256: string;
}
function failure(code: string): never { throw new Error(`STREAM_CONTAINER_${code}`); }
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) failure("ABORTED"); }
function integer(value: number, minimum: number, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) failure("INVALID_LIMIT");
  return value;
}
function limits(options: StreamContainerOptions) {
  return {
    frame: integer(options.maxFrameBytes ?? STREAM_CONTAINER_LIMITS.maxFrameBytes, 1, STREAM_CONTAINER_LIMITS.hardMaxFrameBytes),
    archive: integer(options.maxArchiveBytes ?? STREAM_CONTAINER_LIMITS.maxArchiveBytes, STREAM_CONTAINER_HEADER_BYTES + FRAME_HEADER_BYTES + 32),
    reserve: integer(options.minFreeDiskBytes ?? STREAM_CONTAINER_LIMITS.minFreeDiskBytes, 0),
  };
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function readExact(fd: number, bytes: number): Buffer {
  const result = Buffer.allocUnsafe(bytes);
  let offset = 0;
  while (offset < bytes) {
    const count = readSync(fd, result, offset, bytes - offset, null);
    if (!count) failure("TRUNCATED");
    offset += count;
  }
  return result;
}
function openRegular(path: string): number {
  // O_NOFOLLOW closes the check/open symlink race for the final path component.
  // Nonblocking open lets us reject a FIFO/device instead of waiting forever
  // before fstat can establish that this is a bounded regular file.
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try { if (!fstatSync(fd).isFile()) failure("REGULAR_FILE_REQUIRED"); return fd; }
  catch (error) { closeSync(fd); throw error; }
}
function recoveryKey(path: string): Buffer {
  const fd = openRegular(path);
  try {
    const stat = fstatSync(fd);
    if ((stat.mode & 0o077) !== 0) failure("KEY_PERMISSIONS");
    if (stat.size < 1 || stat.size > 100) failure("KEY_ENCODING");
    const encoded = readExact(fd, stat.size).toString("utf8").trim();
    const key = Buffer.from(encoded, "base64");
    if (key.length !== 32 || key.toString("base64") !== encoded) { key.fill(0); failure("KEY_ENCODING"); }
    return key;
  } finally { closeSync(fd); }
}
function archiveKey(path: string, salt: Uint8Array): Buffer {
  const key = recoveryKey(path);
  try { return Buffer.from(hkdfSync("sha256", key, salt, KDF_INFO, 32)); }
  finally { key.fill(0); }
}
function nonce(index: number): Buffer {
  integer(index, 0);
  const value = Buffer.alloc(12);
  value.writeBigUInt64BE(BigInt(index), 4);
  return value;
}
function frameHeader(type: number, index: number, bytes: number): Buffer {
  const value = Buffer.alloc(FRAME_HEADER_BYTES);
  value[0] = type; value.writeBigUInt64BE(BigInt(index), 1); value.writeUInt32BE(bytes, 9);
  return value;
}
function terminal(frames: number, bytes: number): Buffer {
  const value = Buffer.alloc(16);
  value.writeBigUInt64BE(BigInt(frames), 0); value.writeBigUInt64BE(BigInt(bytes), 8);
  return value;
}
async function nextFrame(iterator: AsyncIterator<Uint8Array>, signal?: AbortSignal): Promise<IteratorResult<Uint8Array>> {
  checkAbort(signal);
  if (!signal) return iterator.next();
  let listener: (() => void) | undefined;
  try {
    return await Promise.race([iterator.next(), new Promise<never>((_, reject) => {
      listener = () => reject(new Error("STREAM_CONTAINER_ABORTED"));
      signal.addEventListener("abort", listener, { once: true });
      if (signal.aborted) listener();
    })]);
  } finally { if (listener) signal.removeEventListener("abort", listener); }
}

/**
 * Writes no plaintext artifact. On failure the owned `${outputPath}.partial`
 * remains encrypted and explicitly incomplete; restarting requires a new path.
 * The final name is an atomic, no-overwrite hard link after fsync. Both names
 * refer to the same new file until the partial name is removed. A crash can
 * leave both names, but the final name can never refer to an unfinished stream.
 */
export async function writeStreamContainer(frames: AsyncIterable<Uint8Array>, outputPath: string, keyPath: string,
  options: StreamContainerOptions = {}): Promise<StreamContainerSummary> {
  const budget = limits(options); checkAbort(options.signal);
  if (outputPath.endsWith(".partial")) failure("FINAL_NAME_REQUIRED");
  const directory = realpathSync(dirname(resolve(outputPath)));
  const file = join(directory, basename(outputPath)), partial = `${file}.partial`;
  if (exists(file) || exists(partial)) failure("OUTPUT_EXISTS");
  const directoryFd = openSync(directory, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let fd: number | undefined, key: Buffer | undefined, iterator: AsyncIterator<Uint8Array> | undefined;
  let finished = false, archiveBytes = 0, plaintextBytes = 0, count = 0;
  const hash = createHash("sha256");
  try {
    const salt = randomBytes(32);
    key = archiveKey(keyPath, salt);
    fd = openSync(partial, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    fchmodSync(fd, 0o600);
    const header = Buffer.alloc(STREAM_CONTAINER_HEADER_BYTES);
    MAGIC.copy(header); salt.copy(header, MAGIC.length); header.writeUInt32BE(budget.frame, MAGIC.length + 32);
    const headerHash = createHash("sha256").update(header).digest();
    const write = (parts: readonly Uint8Array[]) => {
      checkAbort(options.signal);
      const bytes = parts.reduce((sum, part) => sum + part.byteLength, 0);
      if (!Number.isSafeInteger(archiveBytes + bytes) || archiveBytes + bytes > budget.archive) failure("ARCHIVE_BUDGET");
      const disk = statfsSync(directory, { bigint: true });
      if (disk.bavail * disk.bsize < BigInt(budget.reserve) + BigInt(bytes)) failure("DISK_BUDGET");
      for (const part of parts) {
        let offset = 0;
        while (offset < part.byteLength) {
          const written = writeSync(fd!, part, offset, part.byteLength - offset);
          if (!written) failure("WRITE_FAILED");
          offset += written;
        }
        hash.update(part); archiveBytes += part.byteLength;
      }
    };
    const encrypt = (type: number, plaintext: Uint8Array) => {
      const frame = frameHeader(type, count, plaintext.byteLength);
      const cipher = createCipheriv("aes-256-gcm", key!, nonce(count), { authTagLength: TAG_BYTES });
      cipher.setAAD(Buffer.concat([AAD_DOMAIN, headerHash, frame]));
      const ciphertext = cipher.update(plaintext), final = cipher.final();
      write([frame, ciphertext, final, cipher.getAuthTag()]);
    };
    write([header]);
    iterator = frames[Symbol.asyncIterator]();
    for (;;) {
      const item = await nextFrame(iterator, options.signal);
      checkAbort(options.signal);
      if (item.done) { finished = true; break; }
      if (!(item.value instanceof Uint8Array) || item.value.byteLength < 1 || item.value.byteLength > budget.frame) failure("FRAME_BUDGET");
      if (!Number.isSafeInteger(plaintextBytes + item.value.byteLength) || count >= Number.MAX_SAFE_INTEGER - 1) failure("COUNTER_OVERFLOW");
      encrypt(DATA, item.value); plaintextBytes += item.value.byteLength; count++;
    }
    encrypt(TERMINAL, terminal(count, plaintextBytes));
    checkAbort(options.signal);
    fsyncSync(fd);
    const owned = fstatSync(fd), named = lstatSync(partial);
    if (!named.isFile() || named.dev !== owned.dev || named.ino !== owned.ino || named.size !== archiveBytes) failure("OUTPUT_CHANGED");
    // link() fails if another process created either a regular file or symlink
    // at the final name. Unlike rename(), it never replaces an existing target.
    linkSync(partial, file);
    fsyncSync(directoryFd);
    unlinkSync(partial);
    fsyncSync(directoryFd);
    return { format: STREAM_CONTAINER_FORMAT, file, archiveBytes, plaintextBytes, frames: count, sha256: hash.digest("hex") };
  } finally {
    if (fd !== undefined) closeSync(fd);
    closeSync(directoryFd);
    key?.fill(0);
    if (!finished && iterator?.return) {
      // A pending source next() may not cooperate with return(). Do not hang
      // cancellation; callers must also pass the signal to their network source.
      try { void Promise.resolve(iterator.return()).catch(() => {}); } catch { /* Preserve the original failure. */ }
    }
    // Do not unlink a failed partial or any competing output. If completion's
    // directory fsync fails, the final file may exist but success is not reported.
  }
}

/** Exhaust the returned iterator: yielded frames alone do not prove completion. */
export async function* readStreamContainer(inputPath: string, keyPath: string,
  options: StreamContainerOptions = {}): AsyncGenerator<Uint8Array, StreamContainerSummary> {
  const budget = limits(options); checkAbort(options.signal);
  if (inputPath.endsWith(".partial")) failure("INCOMPLETE_ARTIFACT");
  const file = join(realpathSync(dirname(resolve(inputPath))), basename(inputPath)), fd = openRegular(file);
  let key: Buffer | undefined;
  try {
    const initial = fstatSync(fd);
    if (!Number.isSafeInteger(initial.size) || initial.size > budget.archive) failure("ARCHIVE_BUDGET");
    if (initial.size < STREAM_CONTAINER_HEADER_BYTES + FRAME_HEADER_BYTES + 32) failure("TRUNCATED");
    const hash = createHash("sha256");
    let archiveBytes = 0, plaintextBytes = 0, count = 0;
    const read = (bytes: number): Buffer => {
      checkAbort(options.signal);
      if (archiveBytes + bytes > initial.size || archiveBytes + bytes > budget.archive) failure("TRUNCATED");
      const result = readExact(fd, bytes); hash.update(result); archiveBytes += bytes; return result;
    };
    const header = read(STREAM_CONTAINER_HEADER_BYTES);
    if (!header.subarray(0, MAGIC.length).equals(MAGIC)) failure("FORMAT");
    const frameLimit = header.readUInt32BE(MAGIC.length + 32);
    if (!frameLimit || frameLimit > budget.frame || frameLimit > STREAM_CONTAINER_LIMITS.hardMaxFrameBytes) failure("FRAME_BUDGET");
    const headerHash = createHash("sha256").update(header).digest();
    key = archiveKey(keyPath, header.subarray(MAGIC.length, MAGIC.length + 32));
    for (;;) {
      const frame = read(FRAME_HEADER_BYTES), type = frame[0]!, index = frame.readBigUInt64BE(1), bytes = frame.readUInt32BE(9);
      if (index !== BigInt(count)) failure("FRAME_ORDER");
      if (type !== DATA && type !== TERMINAL) failure("FRAME_TYPE");
      // Validate the hostile advertised size before allocating a body buffer.
      if ((type === DATA && (!bytes || bytes > frameLimit)) || (type === TERMINAL && bytes !== 16)) failure("FRAME_BUDGET");
      const ciphertext = read(bytes), tag = read(TAG_BYTES);
      let plaintext: Buffer;
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, nonce(count), { authTagLength: TAG_BYTES });
        decipher.setAAD(Buffer.concat([AAD_DOMAIN, headerHash, frame])); decipher.setAuthTag(tag);
        const output = decipher.update(ciphertext), final = decipher.final();
        plaintext = final.length ? Buffer.concat([output, final]) : output;
      } catch { failure("AUTHENTICATION"); }
      if (type === TERMINAL) {
        if (!plaintext.equals(terminal(count, plaintextBytes))) failure("TERMINAL_COUNTS");
        if (archiveBytes !== initial.size) failure("TRAILING_DATA");
        const extra = Buffer.alloc(1);
        if (readSync(fd, extra, 0, 1, null)) failure("TRAILING_DATA");
        const finalStat = fstatSync(fd);
        if (finalStat.size !== initial.size || finalStat.mtimeMs !== initial.mtimeMs || finalStat.ctimeMs !== initial.ctimeMs) failure("INPUT_CHANGED");
        checkAbort(options.signal);
        return { format: STREAM_CONTAINER_FORMAT, file, archiveBytes, plaintextBytes, frames: count, sha256: hash.digest("hex") };
      }
      if (!Number.isSafeInteger(plaintextBytes + bytes) || count >= Number.MAX_SAFE_INTEGER - 1) failure("COUNTER_OVERFLOW");
      plaintextBytes += bytes; count++;
      yield plaintext;
    }
  } finally { key?.fill(0); closeSync(fd); }
}
