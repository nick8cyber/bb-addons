import { test } from "node:test";
import assert from "node:assert/strict";
import { createDetector, normalizeTerms } from "../lib/patterns.ts";

const hidden = (text: string, terms: string[] = []) =>
  createDetector(terms).find(text).map((s) => text.slice(s.start, s.end));

test("emails", () => {
  assert.deepEqual(hidden("пиши на user@example.org, ок"), ["user@example.org"]);
});

test("bb ids", () => {
  assert.deepEqual(hidden("тред thr_k3m9x2p7qa и mem_q8w2e5r7t_y"), ["thr_k3m9x2p7qa", "mem_q8w2e5r7t_y"]);
  assert.deepEqual(hidden("proj_a1b2c3d4e5 env_f6g7h8j9k0 host_m1n2b3v4c5"), [
    "proj_a1b2c3d4e5", "env_f6g7h8j9k0", "host_m1n2b3v4c5",
  ]);
});

test("paths", () => {
  assert.deepEqual(hidden("файл /home/user/work/app.tsx."), ["/home/user/work/app.tsx"]);
  assert.deepEqual(hidden("см. ~/.bb/AGENTS.md"), ["~/.bb/AGENTS.md"]);
  assert.deepEqual(hidden("C:\\Users\\user\\file.txt"), ["C:\\Users\\user\\file.txt"]);
});

test("urls and domains", () => {
  assert.deepEqual(hidden("open https://sursun.getbb.app/threads/x now"), ["https://sursun.getbb.app/threads/x"]);
  assert.deepEqual(hidden("инстанс sursun.getbb.app работает"), ["sursun.getbb.app"]);
});

test("ip, uuid, hex, tokens", () => {
  assert.deepEqual(hidden("ip 10.0.0.12:8080"), ["10.0.0.12:8080"]);
  assert.deepEqual(hidden("id 123e4567-e89b-12d3-a456-426614174000"), ["123e4567-e89b-12d3-a456-426614174000"]);
  assert.deepEqual(hidden("commit 75a226b1c2d3e4f5"), ["75a226b1c2d3e4f5"]);
  assert.deepEqual(hidden("key sk-ant-abcdefghijklmnop"), ["sk-ant-abcdefghijklmnop"]);
  assert.deepEqual(hidden("token ghp_abcdefghij1234567890"), ["ghp_abcdefghij1234567890"]);
});

test("custom terms: case-insensitive, whole words, unicode", () => {
  assert.deepEqual(hidden("Проект growthhack-social и GrowthHack-Social", ["growthhack-social"]), [
    "growthhack-social", "GrowthHack-Social",
  ]);
  assert.deepEqual(hidden("Иван Петров пишет", ["Иван Петров"]), ["Иван Петров"]);
  assert.deepEqual(hidden("demonstration", ["demo"]), []);
});

test("plain prose and code stay visible", () => {
  assert.deepEqual(hidden("Run the build and check app.tsx and package.json"), []);
  assert.deepEqual(hidden("run_in_background: true, and/or text/plain"), []);
  assert.deepEqual(hidden("step 3 of 5 done at 12:30"), []);
});

test("normalizeTerms drops short and duplicate terms", () => {
  assert.deepEqual(normalizeTerms(["BB", "demo", "Demo", " host-1 "]), ["host-1", "demo"]);
});

test("snake_case identifiers without digits stay visible", () => {
  assert.deepEqual(hidden("auto_approve task_status env_vars_list"), []);
});

test("person names heuristic", () => {
  const find = (text: string) => createDetector([], { names: true }).find(text).map((s) => text.slice(s.start, s.end));
  assert.deepEqual(find("звонил Иван Петров вчера"), ["Иван Петров"]);
  assert.deepEqual(find("John Smith and Anna-Maria Lopez"), ["John Smith", "Anna-Maria Lopez"]);
  assert.deepEqual(find("Новый тред создан"), []);
  assert.deepEqual(createDetector([]).find("Иван Петров"), []);
});

test("thread titles as phrases", () => {
  assert.deepEqual(hidden("[Стратегия] Автоматизация воронки — открыт", ["[Стратегия] Автоматизация воронки"]), [
    "[Стратегия] Автоматизация воронки",
  ]);
});

test("terms keep their own trailing punctuation", () => {
  assert.deepEqual(hidden("Проба OpenCode жив?", ["Проба OpenCode жив?"]), ["Проба OpenCode жив?"]);
});
