import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export async function canonicalWorkspace(candidate: unknown): Promise<string> {
  if (typeof candidate !== "string" || !isAbsolute(candidate)) {
    throw new Error("Workspace must be an absolute path");
  }
  const resolved = resolve(candidate);
  await access(resolved);
  const info = await stat(resolved);
  if (!info.isDirectory()) throw new Error("Workspace must be an accessible directory");
  return realpath(resolved);
}

export function textPrompt(blocks: readonly ContentLike[]): string {
  if (blocks.length === 0 || blocks.some(block => block.type !== "text" || typeof block.text !== "string")) {
    throw new Error("Pi V1 accepts text content only");
  }
  const text = blocks.map(block => block.text).join("\n");
  if (text.trim().length === 0) throw new Error("Pi prompt must contain visible text");
  return text;
}

export interface ContentLike {
  readonly type: string;
  readonly text?: unknown;
}
