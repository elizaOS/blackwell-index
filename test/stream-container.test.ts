// Synthetic opaque frames only. No provider/network calls or deployed state.
import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createCipheriv, createHash, hkdfSync, randomBytes } from "node:crypto";
import { appendFileSync, chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRecoveryKey } from "../src/recovery";
import { readStreamContainer, STREAM_CONTAINER_FORMAT, STREAM_CONTAINER_HEADER_BYTES, STREAM_CONTAINER_LIMITS, writeStreamContainer, type StreamContainerOptions } from "../src/stream-container";

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "sbx-stream-container-test-")); directories.push(directory);
  const key = join(directory, "recovery.key"), file = join(directory, "archive.sbx-stream");
  createRecoveryKey(key);
  return { directory, key, file };
}
async function* frames(values: readonly Uint8Array[]) { for (const value of values) yield value; }
async function read(file: string, key: string, options: StreamContainerOptions = {}) {
  const iterator = readStreamContainer(file, key, options), values: Buffer[] = [];
  for (;;) {
    const item = await iterator.next();
    if (item.done) return { values, summary: item.value };
    values.push(Buffer.from(item.value));
  }
}
const opaque = [Buffer.from('{"descriptor":"isolated source fixture"}'), Buffer.from('{"block":"isolated private fixture"}'), Buffer.from('{"seal":"isolated source seal"}')];
async function ready() { const f = fixture(); const result = await writeStreamContainer(frames(opaque), f.file, f.key); return { ...f, result }; }
function altered(f: ReturnType<typeof fixture>, bytes: Uint8Array, name = "altered.sbx-stream") {
  const path = join(f.directory, name); writeFileSync(path, bytes, { mode: 0o600 }); return path;
}
function split(bytes: Buffer) {
  const result: Buffer[] = [];
  let offset = STREAM_CONTAINER_HEADER_BYTES;
  while (offset < bytes.length) {
    const length = 13 + bytes.readUInt32BE(offset + 9) + 16;
    result.push(bytes.subarray(offset, offset + length)); offset += length;
  }
  return result;
}

test("V2 streams opaque frames, authenticates EOF, returns a digest and atomically completes a private artifact", async () => {
  const f = await ready(), bytes = readFileSync(f.file), restored = await read(f.file, f.key);
  expect(restored.values).toEqual(opaque);
  expect(restored.summary).toEqual(f.result);
  expect(f.result).toMatchObject({ format: STREAM_CONTAINER_FORMAT, frames: opaque.length, plaintextBytes: opaque.reduce((sum, value) => sum + value.length, 0), archiveBytes: bytes.length });
  expect(f.result.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  expect(statSync(f.file).mode & 0o777).toBe(0o600);
  expect(existsSync(`${f.file}.partial`)).toBe(false);
  for (const value of opaque) expect(bytes.includes(value)).toBe(false);
});

test("standard Node runtime reads Bun archives and writes interoperable V2 containers", async () => {
  const f = await ready(), output = join(f.directory, "node-written.sbx-stream");
  const module = new URL("../src/stream-container.ts", import.meta.url).href;
  const source = `import {readStreamContainer,writeStreamContainer} from ${JSON.stringify(module)};
    const [input,key,output]=process.argv.slice(1);let count=0;for await(const frame of readStreamContainer(input,key)){if(!frame.length)throw new Error("EMPTY_FRAME");count++;}
    async function* source(){yield Buffer.from("Node interoperability fixture");}
    const result=await writeStreamContainer(source(),output,key);console.log(JSON.stringify({read:count,written:result.frames}));`;
  const result = execFileSync("node", ["--experimental-strip-types", "--input-type=module", "-e", source, f.file, f.key, output], { encoding: "utf8" });
  expect(JSON.parse(result)).toEqual({ read: 3, written: 1 });
  expect((await read(output, f.key)).values).toEqual([Buffer.from("Node interoperability fixture")]);
});

test("new archives under the same recovery key get different salts, keys and ciphertext", async () => {
  const f = await ready(), second = join(f.directory, "second.sbx-stream");
  const result = await writeStreamContainer(frames(opaque), second, f.key);
  expect(result.sha256).not.toBe(f.result.sha256);
  const a = readFileSync(f.file), b = readFileSync(second);
  expect(a.subarray(STREAM_CONTAINER_HEADER_BYTES - 36, STREAM_CONTAINER_HEADER_BYTES - 4)).not.toEqual(b.subarray(STREAM_CONTAINER_HEADER_BYTES - 36, STREAM_CONTAINER_HEADER_BYTES - 4));
  expect(split(a)[0]).not.toEqual(split(b)[0]);
  expect((await read(second, f.key)).values).toEqual(opaque);
});

test("empty opaque stream still requires an authenticated terminal", async () => {
  const f = fixture(); await writeStreamContainer(frames([]), f.file, f.key);
  expect((await read(f.file, f.key)).summary).toMatchObject({ frames: 0, plaintextBytes: 0 });
});

test("wrong key fails before any opaque frame is yielded", async () => {
  const f = await ready(), wrong = join(f.directory, "wrong.key"); createRecoveryKey(wrong);
  await expect(readStreamContainer(f.file, wrong).next()).rejects.toThrow("STREAM_CONTAINER_AUTHENTICATION");
});

for (const target of ["magic", "salt", "frame limit", "type", "index", "length", "ciphertext", "tag", "terminal tag"] as const) {
  test(`authenticated container rejects tampering with ${target}`, async () => {
    const f = await ready(), bytes = readFileSync(f.file);
    const offset = target === "magic" ? 0 : target === "salt" ? STREAM_CONTAINER_HEADER_BYTES - 36 : target === "frame limit" ? STREAM_CONTAINER_HEADER_BYTES - 1
      : target === "type" ? STREAM_CONTAINER_HEADER_BYTES : target === "index" ? STREAM_CONTAINER_HEADER_BYTES + 8 : target === "length" ? STREAM_CONTAINER_HEADER_BYTES + 12
        : target === "ciphertext" ? STREAM_CONTAINER_HEADER_BYTES + 13 : target === "tag" ? STREAM_CONTAINER_HEADER_BYTES + 13 + opaque[0]!.length : bytes.length - 1;
    bytes[offset] = bytes[offset]! ^ 1;
    await expect(read(altered(f, bytes), f.key)).rejects.toThrow();
  });
}

test("truncated header, frame headers, ciphertext, tags and missing terminal all fail", async () => {
  const f = await ready(), bytes = readFileSync(f.file), parts = split(bytes);
  for (const length of [0, 1, STREAM_CONTAINER_HEADER_BYTES - 1, STREAM_CONTAINER_HEADER_BYTES,
    STREAM_CONTAINER_HEADER_BYTES + 12, STREAM_CONTAINER_HEADER_BYTES + 20, bytes.length - 1, bytes.length - parts.at(-1)!.length]) {
    await expect(read(altered(f, bytes.subarray(0, length), `truncate-${length}`), f.key)).rejects.toThrow("STREAM_CONTAINER_TRUNCATED");
  }
});

test("trailing bytes and duplicate terminal are not a complete archive", async () => {
  const f = await ready(), bytes = readFileSync(f.file), parts = split(bytes);
  for (const suffix of [Buffer.from([0]), parts.at(-1)!]) {
    const path = altered(f, Buffer.concat([bytes, suffix]), `trailing-${suffix.length}`);
    await expect(read(path, f.key)).rejects.toThrow("STREAM_CONTAINER_TRAILING_DATA");
  }
});

test("reordered, duplicated, omitted and cross-archive frames are rejected", async () => {
  const f = await ready(), bytes = readFileSync(f.file), parts = split(bytes), header = bytes.subarray(0, STREAM_CONTAINER_HEADER_BYTES);
  const second = join(f.directory, "second.sbx-stream"); await writeStreamContainer(frames(opaque), second, f.key);
  const variants = [[parts[1]!, parts[0]!, ...parts.slice(2)], [parts[0]!, parts[0]!, ...parts.slice(1)], parts.slice(1), [split(readFileSync(second))[0]!, ...parts.slice(1)]];
  for (const [index, variant] of variants.entries()) {
    await expect(read(altered(f, Buffer.concat([header, ...variant]), `sequence-${index}`), f.key)).rejects.toThrow();
  }
});

test("advertised oversized frames and uint64 sequence overflow fail before body allocation", async () => {
  const f = await ready();
  const oversized = readFileSync(f.file); oversized.writeUInt32BE(0xffffffff, STREAM_CONTAINER_HEADER_BYTES + 9);
  await expect(read(altered(f, oversized), f.key)).rejects.toThrow("STREAM_CONTAINER_FRAME_BUDGET");
  const overflow = readFileSync(f.file); overflow.writeBigUInt64BE(0xffffffffffffffffn, STREAM_CONTAINER_HEADER_BYTES + 1);
  await expect(read(altered(f, overflow, "overflow"), f.key)).rejects.toThrow("STREAM_CONTAINER_FRAME_ORDER");
});

test("independent crypto fixture confirms HKDF, nonce, AAD and terminal count verification", async () => {
  const f = fixture(), maximum = 128, salt = randomBytes(32), magic = Buffer.from(`${STREAM_CONTAINER_FORMAT}\n`);
  const header = Buffer.alloc(STREAM_CONTAINER_HEADER_BYTES); magic.copy(header); salt.copy(header, magic.length); header.writeUInt32BE(maximum, magic.length + 32);
  const key = Buffer.from(hkdfSync("sha256", Buffer.from(readFileSync(f.key, "utf8").trim(), "base64"), salt,
    Buffer.from(`${STREAM_CONTAINER_FORMAT}:AES-256-GCM:HKDF-SHA256`), 32));
  const headerHash = createHash("sha256").update(header).digest();
  const encrypt = (type: number, index: number, body: Buffer) => {
    const metadata = Buffer.alloc(13), iv = Buffer.alloc(12);
    metadata[0] = type; metadata.writeBigUInt64BE(BigInt(index), 1); metadata.writeUInt32BE(body.length, 9); iv.writeBigUInt64BE(BigInt(index), 4);
    const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: 16 });
    cipher.setAAD(Buffer.concat([Buffer.from(`${STREAM_CONTAINER_FORMAT}:FRAME\n`), headerHash, metadata]));
    return Buffer.concat([metadata, cipher.update(body), cipher.final(), cipher.getAuthTag()]);
  };
  const body = Buffer.from("independent test bytes"), terminal = Buffer.alloc(16);
  terminal.writeBigUInt64BE(1n); terminal.writeBigUInt64BE(BigInt(body.length), 8);
  writeFileSync(f.file, Buffer.concat([header, encrypt(1, 0, body), encrypt(255, 1, terminal)]), { mode: 0o600 });
  expect((await read(f.file, f.key)).values).toEqual([body]);
  terminal.writeBigUInt64BE(2n);
  await expect(read(altered(f, Buffer.concat([header, encrypt(1, 0, body), encrypt(255, 1, terminal)])), f.key)).rejects.toThrow("STREAM_CONTAINER_TERMINAL_COUNTS");
  key.fill(0);
});

test("invalid key encoding, permissive key files, key symlinks and archive symlinks are rejected", async () => {
  const f = await ready();
  for (const [index, value] of ["not base64", Buffer.alloc(31).toString("base64"), "x".repeat(101), "", `${Buffer.alloc(32).toString("base64")}junk`].entries()) {
    const path = join(f.directory, `invalid-${index}.key`); writeFileSync(path, value, { mode: 0o600 });
    await expect(read(f.file, path)).rejects.toThrow("STREAM_CONTAINER_KEY_ENCODING");
  }
  chmodSync(f.key, 0o644); await expect(read(f.file, f.key)).rejects.toThrow("STREAM_CONTAINER_KEY_PERMISSIONS"); chmodSync(f.key, 0o600);
  const keyLink = join(f.directory, "linked.key"), fileLink = join(f.directory, "linked.sbx-stream"); symlinkSync(f.key, keyLink); symlinkSync(f.file, fileLink);
  await expect(read(f.file, keyLink)).rejects.toThrow(); await expect(read(fileLink, f.key)).rejects.toThrow();
});

test("nonregular key and archive inputs fail without blocking on a FIFO", async () => {
  const f = await ready(), pipe = join(f.directory, "not-a-file"); execFileSync("mkfifo", [pipe]);
  await expect(read(f.file, pipe)).rejects.toThrow("STREAM_CONTAINER_REGULAR_FILE_REQUIRED");
  await expect(read(pipe, f.key)).rejects.toThrow("STREAM_CONTAINER_REGULAR_FILE_REQUIRED");
  await expect(read(f.directory, f.key)).rejects.toThrow("STREAM_CONTAINER_REGULAR_FILE_REQUIRED");
});

test("writer and reader enforce frame and archive budgets without overwrites", async () => {
  const f = await ready();
  await expect(read(f.file, f.key, { maxArchiveBytes: 110 })).rejects.toThrow("STREAM_CONTAINER_ARCHIVE_BUDGET");
  await expect(read(f.file, f.key, { maxFrameBytes: 128 })).rejects.toThrow("STREAM_CONTAINER_FRAME_BUDGET");
  const large = join(f.directory, "large");
  await expect(writeStreamContainer(frames([Buffer.alloc(129)]), large, f.key, { maxFrameBytes: 128 })).rejects.toThrow("STREAM_CONTAINER_FRAME_BUDGET");
  expect(existsSync(large)).toBe(false); expect(statSync(`${large}.partial`).mode & 0o777).toBe(0o600);
  const capped = join(f.directory, "capped");
  await expect(writeStreamContainer(frames(opaque), capped, f.key, { maxArchiveBytes: 110 })).rejects.toThrow("STREAM_CONTAINER_ARCHIVE_BUDGET");
  expect(existsSync(capped)).toBe(false);
  await expect(writeStreamContainer(frames(opaque), large, f.key)).rejects.toThrow("STREAM_CONTAINER_OUTPUT_EXISTS");
  await expect(read(`${large}.partial`, f.key)).rejects.toThrow("STREAM_CONTAINER_INCOMPLETE_ARTIFACT");
});

test("all limits are finite safe integers with a fixed independent frame ceiling", async () => {
  const f = fixture();
  for (const options of [{ maxFrameBytes: NaN }, { maxFrameBytes: 0 }, { maxFrameBytes: 1.5 }, { maxFrameBytes: STREAM_CONTAINER_LIMITS.hardMaxFrameBytes + 1 },
    { maxArchiveBytes: Infinity }, { maxArchiveBytes: Number.MAX_SAFE_INTEGER + 1 }, { minFreeDiskBytes: -1 }]) {
    await expect(writeStreamContainer(frames(opaque), f.file, f.key, options)).rejects.toThrow("STREAM_CONTAINER_INVALID_LIMIT");
    expect(existsSync(f.file)).toBe(false); expect(existsSync(`${f.file}.partial`)).toBe(false);
  }
});

test("disk reserve stops writing before a file is marked complete", async () => {
  const f = fixture();
  await expect(writeStreamContainer(frames(opaque), f.file, f.key, { minFreeDiskBytes: Number.MAX_SAFE_INTEGER })).rejects.toThrow("STREAM_CONTAINER_DISK_BUDGET");
  expect(existsSync(f.file)).toBe(false); expect(statSync(`${f.file}.partial`).size).toBe(0);
});

test("existing final, partial, directories and symlink outputs are never replaced", async () => {
  const f = fixture(), marker = Buffer.from("keep this existing target"); writeFileSync(f.file, marker);
  await expect(writeStreamContainer(frames(opaque), f.file, f.key)).rejects.toThrow("STREAM_CONTAINER_OUTPUT_EXISTS"); expect(readFileSync(f.file)).toEqual(marker);
  const link = join(f.directory, "output-link"); symlinkSync(f.file, link);
  await expect(writeStreamContainer(frames(opaque), link, f.key)).rejects.toThrow("STREAM_CONTAINER_OUTPUT_EXISTS"); expect(lstatSync(link).isSymbolicLink()).toBe(true);
  const directory = join(f.directory, "output-directory"); mkdirSync(directory);
  await expect(writeStreamContainer(frames(opaque), directory, f.key)).rejects.toThrow("STREAM_CONTAINER_OUTPUT_EXISTS");
  await expect(writeStreamContainer(frames(opaque), join(f.directory, "name.partial"), f.key)).rejects.toThrow("STREAM_CONTAINER_FINAL_NAME_REQUIRED");
});

test("a competing final file created during streaming survives no-overwrite completion", async () => {
  const f = fixture(), marker = Buffer.from("competing operator file");
  async function* source() { yield opaque[0]!; writeFileSync(f.file, marker); yield opaque[1]!; }
  await expect(writeStreamContainer(source(), f.file, f.key)).rejects.toThrow();
  expect(readFileSync(f.file)).toEqual(marker); expect(existsSync(`${f.file}.partial`)).toBe(true);
});

test("replacement of the owned partial pathname cannot promote a different file", async () => {
  const f = fixture(), marker = Buffer.from("competing partial pathname");
  async function* source() { yield opaque[0]!; unlinkSync(`${f.file}.partial`); writeFileSync(`${f.file}.partial`, marker, { mode: 0o600 }); yield opaque[1]!; }
  await expect(writeStreamContainer(source(), f.file, f.key)).rejects.toThrow("STREAM_CONTAINER_OUTPUT_CHANGED");
  expect(existsSync(f.file)).toBe(false); expect(readFileSync(`${f.file}.partial`)).toEqual(marker);
});

test("source failure after payload leaves only an encrypted incomplete artifact", async () => {
  const f = fixture(); let closed = false;
  async function* source() { try { yield opaque[0]!; throw new Error("isolated source rejected its seal"); } finally { closed = true; } }
  await expect(writeStreamContainer(source(), f.file, f.key)).rejects.toThrow("isolated source rejected its seal");
  expect(closed).toBe(true); expect(existsSync(f.file)).toBe(false); expect(readFileSync(`${f.file}.partial`).includes(opaque[0]!)).toBe(false);
  // Renaming an interrupted artifact cannot forge the missing authenticated EOF.
  await expect(read(altered(f, readFileSync(`${f.file}.partial`)), f.key)).rejects.toThrow("STREAM_CONTAINER_TRUNCATED");
});

test("abort before starting has no side effect, and abort while source is pending closes output promptly", async () => {
  const f = fixture(), before = new AbortController(); before.abort();
  await expect(writeStreamContainer(frames(opaque), f.file, f.key, { signal: before.signal })).rejects.toThrow("STREAM_CONTAINER_ABORTED");
  expect(existsSync(`${f.file}.partial`)).toBe(false);
  const controller = new AbortController(); let returned = false;
  const source: AsyncIterable<Uint8Array> = { [Symbol.asyncIterator]() { let count = 0; return {
    next: async () => count++ === 0 ? { value: opaque[0]!, done: false } : new Promise<IteratorResult<Uint8Array>>(() => { queueMicrotask(() => controller.abort()); }),
    return: async () => { returned = true; return { value: undefined, done: true }; },
  }; } };
  await expect(writeStreamContainer(source, f.file, f.key, { signal: controller.signal })).rejects.toThrow("STREAM_CONTAINER_ABORTED");
  expect(returned).toBe(true); expect(existsSync(f.file)).toBe(false); expect(existsSync(`${f.file}.partial`)).toBe(true);
});

for (const size of [1, 512 * 1024]) test(`timer cancellation interrupts a synchronous source with ${size}-byte frames`, async () => {
  const f = fixture(), controller = new AbortController(), frame = Buffer.alloc(size, 37);
  // The large-frame source ends before the frame-count scheduling threshold,
  // so it also proves that byte-based scheduling is independently effective.
  const total = size === 1 ? 200 : 32;
  let produced = 0, closed = false;
  async function* source() {
    try { for (; produced < total; produced++) yield frame; }
    finally { closed = true; }
  }
  const interrupt = setImmediate(() => controller.abort());
  try { await expect(writeStreamContainer(source(), f.file, f.key, { signal: controller.signal })).rejects.toThrow("STREAM_CONTAINER_ABORTED"); }
  finally { clearImmediate(interrupt); }
  expect(produced).toBeLessThan(total); expect(closed).toBe(true); expect(existsSync(f.file)).toBe(false);
  expect(existsSync(`${f.file}.partial`)).toBe(true);
});

test("reader cancellation and early consumer return close the handle without claiming verification", async () => {
  const f = await ready(), controller = new AbortController();
  const reader = readStreamContainer(f.file, f.key, { signal: controller.signal });
  expect((await reader.next()).done).toBe(false); controller.abort();
  await expect(reader.next()).rejects.toThrow("STREAM_CONTAINER_ABORTED");
  const early = readStreamContainer(f.file, f.key);
  await early.next(); expect((await early.return(undefined as never)).value).toBeUndefined();
});

test("a file that grows after opening cannot pass strict EOF verification", async () => {
  const f = await ready(), reader = readStreamContainer(f.file, f.key);
  expect((await reader.next()).done).toBe(false); appendFileSync(f.file, Buffer.from([0]));
  await reader.next(); await reader.next();
  await expect(reader.next()).rejects.toThrow("STREAM_CONTAINER_TRAILING_DATA");
});

test("more than 128 MiB round-trips with bounded per-frame allocations and backpressure", async () => {
  const f = fixture(), size = 256 * 1024, count = 529, total = size * count;
  const body = Buffer.alloc(size, 0xa7); body.write("isolated capacity fixture, not market history");
  let emitted = 0;
  async function* source() { for (; emitted < count; emitted++) yield body; }
  const written = await writeStreamContainer(source(), f.file, f.key);
  expect(emitted).toBe(count); expect(written.plaintextBytes).toBe(total); expect(written.archiveBytes).toBeGreaterThan(128 * 1024 * 1024);
  const reader = readStreamContainer(f.file, f.key); let received = 0;
  for (;;) {
    const item = await reader.next();
    if (item.done) { expect(item.value).toEqual(written); break; }
    expect(item.value.byteLength).toBe(size); expect(Buffer.from(item.value).equals(body)).toBe(true); received++;
  }
  expect(received).toBe(count);
}, 60_000);
