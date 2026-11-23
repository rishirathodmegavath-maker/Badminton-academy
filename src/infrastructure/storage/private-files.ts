import { mkdir, writeFile, readFile, unlink } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { DomainError } from "../../modules/training/domain/rules";
export interface StorageAdapter {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array>;
  remove(key: string): Promise<void>;
}
function pathFor(key: string) {
  // Private media is provided at runtime and must not be traced into the build.
  const root = resolve(
    /* turbopackIgnore: true */
    process.env.PRIVATE_MEDIA_PATH ||
      (process.env.NODE_ENV === "production" ? "" : ".data/private-media"),
  );
  if (process.env.NODE_ENV === "production" && !process.env.PRIVATE_MEDIA_PATH)
    throw new DomainError("Private storage is not configured.", 503);
  if (!/^[a-f0-9]{16}\/[a-f0-9-]{36}$/.test(key))
    throw new DomainError("Invalid media key.");
  const target = resolve(root, key);
  if (!target.startsWith(root + sep))
    throw new DomainError("Invalid media key.");
  return target;
}
export const privateFiles: StorageAdapter = {
  async put(key, bytes) {
    const path = pathFor(key);
    await mkdir(resolve(path, ".."), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  },
  async get(key) {
    return readFile(pathFor(key));
  },
  async remove(key) {
    await unlink(pathFor(key));
  },
};
