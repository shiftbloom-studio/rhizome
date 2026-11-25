// SPDX-License-Identifier: AGPL-3.0-or-later
// The part of the R2 API rhizome uses, on the local file system.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";

export class LocalBucket {
  private root: string;
  constructor(dir: string) {
    this.root = resolve(dir);
  }

  private path(key: string): string {
    if (!key || key.includes("\0") || key.split("/").some((p) => p === ".." || p === "")) throw new Error(`invalid object key: ${key}`);
    const p = resolve(join(this.root, key));
    if (!p.startsWith(this.root + sep)) throw new Error(`invalid object key: ${key}`);
    return p;
  }

  async put(key: string, value: string | ArrayBuffer | ArrayBufferView | Blob | null) {
    const p = this.path(key);
    await mkdir(dirname(p), { recursive: true });
    const data =
      value === null ? new Uint8Array()
      : typeof value === "string" ? value
      : value instanceof Blob ? new Uint8Array(await value.arrayBuffer())
      : value instanceof ArrayBuffer ? new Uint8Array(value)
      : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    await writeFile(p, data);
    return { key, size: typeof data === "string" ? Buffer.byteLength(data) : data.byteLength };
  }

  async get(key: string) {
    let buf: Buffer;
    try {
      buf = await readFile(this.path(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
    return {
      key,
      size: buf.byteLength,
      text: async () => buf.toString("utf8"),
      json: async <T>() => JSON.parse(buf.toString("utf8")) as T,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    };
  }

  async delete(keys: string | string[]) {
    for (const k of Array.isArray(keys) ? keys : [keys]) await rm(this.path(k), { force: true });
  }
}
