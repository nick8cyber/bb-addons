import { describe, expect, it, vi } from "vitest";
import type { PluginBrowserBbSdk } from "@get-bb/plugin-sdk/app";
import {
  MAX_DOWNLOAD_BYTES,
  assertSizeWithinLimit,
  base64ToBytes,
  baseName,
  fileContentToBlob,
  formatBytes,
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
  envGet?: ReturnType<typeof vi.fn>;
  threadGet?: ReturnType<typeof vi.fn>;
}): PluginBrowserBbSdk {
  return {
    projects: { fileContent: over.fileContent ?? vi.fn() },
    files: { read: over.read ?? vi.fn() },
    threads: {
      storageLocation: over.storageLocation ?? vi.fn(),
      get: over.threadGet ?? vi.fn(),
    },
    environments: { get: over.envGet ?? vi.fn() },
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
  it("вычищает . и .. — выход за корень невозможен", () => {
    expect(joinPath("/root/store", "../etc/passwd")).toBe("/root/store/etc/passwd");
    expect(joinPath("/root/store", "a/../../b.txt")).toBe("/root/store/a/b.txt");
    expect(joinPath("/root/store", "./x/./y.md")).toBe("/root/store/x/y.md");
  });
});

describe("formatBytes", () => {
  it("подбирает единицу по размеру", () => {
    expect(formatBytes(512)).toBe("512 Б");
    expect(formatBytes(2048)).toBe("2.0 КБ");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 МБ");
    expect(formatBytes(2 * 1024 * 1024 * 1024)).toBe("2.0 ГБ");
  });
});

describe("assertSizeWithinLimit", () => {
  it("пропускает файлы в лимите и без sizeBytes", () => {
    const file = { content: "x", contentEncoding: "utf8" as const, sizeBytes: 10 };
    expect(assertSizeWithinLimit(file)).toBe(file);
    expect(assertSizeWithinLimit({ content: "x", contentEncoding: "utf8" })).toBeTruthy();
  });
  it("бросает на файлах больше лимита", () => {
    expect(() =>
      assertSizeWithinLimit({ content: "", contentEncoding: "base64", sizeBytes: MAX_DOWNLOAD_BYTES + 1 }),
    ).toThrow("слишком большой");
    expect(() =>
      assertSizeWithinLimit({ content: "", contentEncoding: "base64", sizeBytes: MAX_DOWNLOAD_BYTES }),
    ).not.toThrow();
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
  it("workspace: без projectId добирает его из environment", async () => {
    const envGet = vi.fn().mockResolvedValue({ projectId: "p9", path: "/wt", hostId: "h1" });
    const fileContent = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ fileContent, envGet }),
      "a.md",
      source({ kind: "workspace", environmentId: "e5" }),
    );
    expect(envGet).toHaveBeenCalledWith({ environmentId: "e5", signal: undefined });
    expect(fileContent).toHaveBeenCalledWith({ projectId: "p9", path: "a.md", signal: undefined, environmentId: "e5" });
  });
  it("workspace: env без projectId — читает через env.path + files.read", async () => {
    const envGet = vi.fn().mockResolvedValue({ projectId: null, path: "/wt/root", hostId: "h3" });
    const read = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(
      mockSdk({ read, envGet }),
      "dir/a.md",
      source({ kind: "workspace", environmentId: "e5" }),
    );
    expect(read).toHaveBeenCalledWith({ hostId: "h3", path: "/wt/root/dir/a.md", signal: undefined });
  });
  it("workspace: без projectId и environmentId — понятная ошибка", async () => {
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
  it("host: без hostId и threadId — primary host", async () => {
    const read = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    await readSourceFile(mockSdk({ read }), "/tmp/out.pdf", source({ kind: "host" }));
    expect(read).toHaveBeenCalledWith({ hostId: undefined, path: "/tmp/out.pdf", signal: undefined });
  });
  it("host: без hostId резолвит хост треда через environment", async () => {
    const read = vi.fn().mockResolvedValue({ content: "x", contentEncoding: "utf8" });
    const threadGet = vi.fn().mockResolvedValue({ environmentId: "e7" });
    const envGet = vi.fn().mockResolvedValue({ hostId: "h-remote" });
    await readSourceFile(
      mockSdk({ read, threadGet, envGet }),
      "/tmp/out.pdf",
      source({ kind: "host", threadId: "t9" }),
    );
    expect(threadGet).toHaveBeenCalledWith({ threadId: "t9", signal: undefined });
    expect(envGet).toHaveBeenCalledWith({ environmentId: "e7", signal: undefined });
    expect(read).toHaveBeenCalledWith({ hostId: "h-remote", path: "/tmp/out.pdf", signal: undefined });
  });
  it("host: хост треда не разрешился — понятная ошибка, чужой файл не читаем", async () => {
    const read = vi.fn();
    const threadGet = vi.fn().mockResolvedValue({ environmentId: null });
    await expect(
      readSourceFile(mockSdk({ read, threadGet }), "/tmp/out.pdf", source({ kind: "host", threadId: "t9" })),
    ).rejects.toThrow("hostId");
    expect(read).not.toHaveBeenCalled();
  });
  it("host: файл сверх лимита — ошибка до чтения байтов в Blob", async () => {
    const read = vi.fn().mockResolvedValue({
      content: "",
      contentEncoding: "base64",
      sizeBytes: MAX_DOWNLOAD_BYTES + 1,
    });
    await expect(
      readSourceFile(mockSdk({ read }), "/big.zip", source({ kind: "host", experimental_hostId: "h2" })),
    ).rejects.toThrow("слишком большой");
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
