import { describe, expect, it, vi } from "vitest";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import {
  base64ToBytes,
  baseName,
  fileContentToBlob,
  joinPath,
  readSourceFile,
} from "../src/resolve";

const source = (over: object) => ({
  kind: "workspace" as const,
  threadId: null,
  environmentId: null,
  projectId: null,
  ...over,
});

function mockSdk(over: {
  fileContent?: ReturnType<typeof vi.fn>;
  read?: ReturnType<typeof vi.fn>;
  storageLocation?: ReturnType<typeof vi.fn>;
}): PluginBrowserBbSdk {
  return {
    projects: { fileContent: over.fileContent ?? vi.fn() },
    files: { read: over.read ?? vi.fn() },
    threads: { storageLocation: over.storageLocation ?? vi.fn() },
  } as unknown as PluginBrowserBbSdk;
}

describe("baseName", () => {
  it("берёт последний сегмент POSIX-пути", () => {
    expect(baseName("src/reports/final.md")).toBe("final.md");
    expect(baseName("a/b/c.zip")).toBe("c.zip");
    expect(baseName("file.txt")).toBe("file.txt");
  });
  it("понимает Windows-разделители и пустые сегменты", () => {
    expect(baseName("C:\\work\\out.csv")).toBe("out.csv");
    expect(baseName("/abs/path/")).toBe("path");
    expect(baseName("")).toBe("download");
  });
});

describe("joinPath", () => {
  it("склеивает без двойных и пропавших слэшей", () => {
    expect(joinPath("/root/store", "a/b.txt")).toBe("/root/store/a/b.txt");
    expect(joinPath("/root/store/", "/a/b.txt")).toBe("/root/store/a/b.txt");
    expect(joinPath("/", "x")).toBe("/x");
  });
});

describe("base64ToBytes", () => {
  it("декодирует бинарные данные", () => {
    const original = new Uint8Array([0, 1, 2, 250, 255]);
    const b64 = btoa(String.fromCharCode(...original));
    expect([...base64ToBytes(b64)]).toEqual([...original]);
  });
});

describe("fileContentToBlob", () => {
  it("utf8 → текстовый Blob с mimeType хоста", async () => {
    const blob = fileContentToBlob({ content: "привет", contentEncoding: "utf8", mimeType: "text/markdown" });
    expect(blob.type).toBe("text/markdown");
    expect(await blob.text()).toBe("привет");
  });
  it("base64 → бинарный Blob, дефолтный mime octet-stream", async () => {
    const blob = fileContentToBlob({ content: btoa("AB"), contentEncoding: "base64", mimeType: null });
    expect(blob.type).toBe("application/octet-stream");
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([65, 66]));
  });
});

describe("readSourceFile", () => {
  it("workspace: fileContent с environmentId", async () => {
    const fileContent = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ fileContent }),
      "a.md",
      source({ kind: "workspace", projectId: "p1", environmentId: "e1" }),
    );
    expect(fileContent).toHaveBeenCalledWith({ projectId: "p1", path: "a.md", signal: undefined, environmentId: "e1" });
  });
  it("workspace: environmentId приоритетнее experimental_hostId", async () => {
    const fileContent = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ fileContent }),
      "a.md",
      source({ kind: "workspace", projectId: "p1", environmentId: "e1", experimental_hostId: "h9" }),
    );
    expect(fileContent).toHaveBeenCalledWith({ projectId: "p1", path: "a.md", signal: undefined, environmentId: "e1" });
  });
  it("workspace: hostId как роутинг, когда нет environmentId", async () => {
    const fileContent = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ fileContent }),
      "a.md",
      source({ kind: "workspace", projectId: "p1", experimental_hostId: "h9" }),
    );
    expect(fileContent).toHaveBeenCalledWith({ projectId: "p1", path: "a.md", signal: undefined, hostId: "h9" });
  });
  it("workspace: без projectId — понятная ошибка", async () => {
    await expect(
      readSourceFile(mockSdk({}), "a.md", source({ kind: "workspace" })),
    ).rejects.toThrow("projectId");
  });
  it("host: files.read по абсолютному пути", async () => {
    const read = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ read }),
      "/tmp/out.pdf",
      source({ kind: "host", experimental_hostId: "h2" }),
    );
    expect(read).toHaveBeenCalledWith({ hostId: "h2", path: "/tmp/out.pdf", signal: undefined });
  });
  it("thread-storage: storageLocation → files.read по root+path", async () => {
    const storageLocation = vi.fn().mockResolvedValue({ hostId: "h1", storageRootPath: "/home/u/.bb/thread-storage/t1" });
    const read = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ read, storageLocation }),
      "notes/a.md",
      source({ kind: "thread-storage", threadId: "t1" }),
    );
    expect(storageLocation).toHaveBeenCalledWith({ threadId: "t1", signal: undefined });
    expect(read).toHaveBeenCalledWith({ hostId: "h1", path: "/home/u/.bb/thread-storage/t1/notes/a.md", signal: undefined });
  });
  it("thread-storage: без threadId — понятная ошибка", async () => {
    await expect(
      readSourceFile(mockSdk({}), "a.md", source({ kind: "thread-storage" })),
    ).rejects.toThrow("threadId");
  });
});
