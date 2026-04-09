import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function loadEnvFile(path = ".env"): void {
  const entries = readEnvFile(path);
  for (const [key, value] of Object.entries(entries)) {
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

export function readEnvFile(path = ".env"): Record<string, string> {
  if (!existsSync(path)) {
    return {};
  }

  const contents = readFileSync(path, "utf8");
  const entries: Record<string, string> = {};

  for (const rawLine of contents.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");
    if (separatorIndex <= 0) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = stripQuotes(line.slice(separatorIndex + 1).trim());
    if (key) {
      entries[key] = value;
    }
  }

  return entries;
}

export function updateEnvFile(
  path: string,
  updates: Record<string, string>,
): { path: string; backupPath?: string } {
  const originalExists = existsSync(path);
  const original = originalExists ? readFileSync(path, "utf8") : "";
  const lines = original === "" ? [] : original.split(/\r?\n/u);
  const usedKeys = new Set<string>();
  const nextLines: string[] = [];

  for (const rawLine of lines) {
    const parsed = parseEnvAssignment(rawLine);
    if (!parsed) {
      nextLines.push(rawLine);
      continue;
    }

    if (Object.hasOwn(updates, parsed.key)) {
      const nextValue = updates[parsed.key];
      if (nextValue === undefined) {
        nextLines.push(rawLine);
        continue;
      }
      nextLines.push(`${parsed.key}=${serializeEnvValue(nextValue)}`);
      usedKeys.add(parsed.key);
      continue;
    }

    nextLines.push(rawLine);
  }

  for (const [key, value] of Object.entries(updates)) {
    if (!usedKeys.has(key)) {
      nextLines.push(`${key}=${serializeEnvValue(value)}`);
    }
  }

  const normalized = `${nextLines.filter((line, index, array) => {
    if (index !== array.length - 1) {
      return true;
    }
    return line !== "" || array.length === 1;
  }).join("\n")}\n`;

  mkdirSync(dirname(path), { recursive: true });
  let backupPath: string | undefined;
  if (originalExists) {
    backupPath = `${path}.bak`;
    copyFileSync(path, backupPath);
  }

  const tempPath = `${path}.tmp`;
  writeFileSync(tempPath, normalized, "utf8");
  renameSync(tempPath, path);

  return { path, backupPath };
}

function parseEnvAssignment(line: string): { key: string; value: string } | undefined {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) {
    return undefined;
  }

  const separatorIndex = line.indexOf("=");
  if (separatorIndex <= 0) {
    return undefined;
  }

  const key = line.slice(0, separatorIndex).trim();
  const value = line.slice(separatorIndex + 1);
  if (!key) {
    return undefined;
  }

  return { key, value };
}

function stripQuotes(value: string): string {
  if (
    (value.startsWith("\"") && value.endsWith("\"")) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function serializeEnvValue(value: string): string {
  if (value === "") {
    return "\"\"";
  }

  if (/[\s#"'`]/u.test(value)) {
    return JSON.stringify(value);
  }

  return value;
}
