import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type OpenOutlinerDb } from "../src/backend/db/database.js";
import { OutlinerService } from "../src/backend/services/outliner.js";
import {
  createXtuisSender, startWeChatReminders, WeChatReminderService, type WeChatReminderMessage
} from "../src/backend/services/wechatReminders.js";
import { replaceSnapshot, snapshot } from "../src/backend/shared/sync.js";

let directory: string;
let path: string;
let db: OpenOutlinerDb;
let outliner: OutlinerService;
let rootId: string;

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "openoutliner-reminders-"));
  path = join(directory, "test.sqlite");
  db = openDatabase(path);
  outliner = new OutlinerService(db);
  rootId = outliner.createWorkspace("工作任务").rootNodeId;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  db.close();
  rmSync(directory, { recursive: true, force: true });
});

function task(title: string, dueDate: string, parentId = rootId) {
  const node = outliner.createNode({ parentId, title });
  return outliner.updateNode(node.id, { dueDate });
}

describe("daily WeChat due reminders", () => {
  it("starts at 09:00 Beijing time and includes two-day, tomorrow, today and overdue tasks across workspaces", async () => {
    let now = new Date("2026-11-13T00:59:59Z");
    task("两天后", "2026-11-15");
    task("明天", "2026-11-14");
    task("今天", "2026-11-13");
    const other = outliner.createWorkspace("另一工作区");
    task("逾期任务", "2026-11-10", other.rootNodeId);
    task("三天后不提醒", "2026-11-16");
    const done = task("已完成不提醒", "2026-11-13");
    outliner.updateNode(done.id, { done: true });
    const removed = task("已删除不提醒", "2026-11-13");
    outliner.deleteNode(removed.id);
    task("已删除父级的子任务", "2026-11-13", task("待删除父级", "2026-11-20").id);
    outliner.deleteNode(outliner.listScheduledNodes().find(node => node.title === "待删除父级")!.id);
    outliner.createNode({ parentId: rootId, title: "无截止日期不提醒" });
    outliner.updateNode(rootId, { dueDate: "2026-11-13" });
    const send = vi.fn(async (_message: WeChatReminderMessage) => {});
    const service = new WeChatReminderService(db, send, () => now);
    expect(await service.tick()).toBe(false);
    now = new Date("2026-11-13T01:00:00Z");
    expect(await service.tick()).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
    const message = send.mock.calls[0][0];
    expect(message.text).toContain("4 项");
    for (const text of ["两天后", "明天", "今天", "逾期任务", "工作任务", "另一工作区", "还有 2 天到期", "逾期 3 天"])
      expect(message.desp).toContain(text);
    for (const text of ["三天后不提醒", "已完成不提醒", "已删除不提醒", "子任务", "无截止日期不提醒"])
      expect(message.desp).not.toContain(text);
    expect(await service.tick()).toBe(false);
  });

  it("repeats daily, continues overdue, and stops after completion, deletion, clearing or postponing the deadline", async () => {
    let now = new Date("2026-11-13T01:00:00Z");
    const completed = task("Finish me", "2026-11-15");
    const removed = task("Delete me", "2026-11-13");
    const cleared = task("Clear date", "2026-11-14");
    const postponed = task("Postpone me", "2026-11-13");
    const continuing = task("Still overdue", "2026-11-01");
    const messages: WeChatReminderMessage[] = [];
    const service = new WeChatReminderService(db, async message => { messages.push(message); }, () => now);
    expect(await service.tick()).toBe(true);
    outliner.updateNode(completed.id, { done: true });
    outliner.deleteNode(removed.id);
    outliner.updateNode(cleared.id, { dueDate: null });
    outliner.updateNode(postponed.id, { dueDate: "2026-12-01" });
    now = new Date("2026-11-14T00:59:59Z");
    expect(await service.tick()).toBe(false);
    now = new Date("2026-11-14T01:00:00Z");
    expect(await service.tick()).toBe(true);
    expect(messages[1].text).toContain("1 项");
    expect(messages[1].desp).toContain("Still overdue");
    expect(messages[1].desp).not.toContain("Finish me");
    outliner.updateNode(continuing.id, { done: true });
    now = new Date("2026-11-15T01:00:00Z");
    expect(await service.tick()).toBe(false);
    expect(messages).toHaveLength(2);
  });

  it("uses Beijing calendar boundaries across a leap day and catches up after a late start", async () => {
    task("Leap day", "2028-02-29");
    task("March", "2028-03-01");
    const send = vi.fn(async (_message: WeChatReminderMessage) => {});
    const service = new WeChatReminderService(db, send, () => new Date("2028-02-27T15:59:59Z"));
    expect(await service.tick()).toBe(true);
    expect(send.mock.calls[0][0].desp).toContain("2028-02-27");
    expect(send.mock.calls[0][0].desp).toContain("Leap day");
    expect(send.mock.calls[0][0].desp).not.toContain("March");
  });

  it("retains daily deduplication after a database reopen and outline synchronization", async () => {
    task("Remember delivery", "2026-11-13");
    const before = snapshot(db);
    const send = vi.fn(async () => {});
    const now = () => new Date("2026-11-13T01:00:00Z");
    expect(await new WeChatReminderService(db, send, now).tick()).toBe(true);
    expect(snapshot(db)).toEqual(before);
    replaceSnapshot(db, before);
    db.close();
    db = openDatabase(path);
    expect(await new WeChatReminderService(db, send, now).tick()).toBe(false);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("allows only one delivery while overlapping checks and another server connection compete", async () => {
    task("One delivery", "2026-11-13");
    let finish!: () => void;
    const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
    const now = () => new Date("2026-11-13T01:00:00Z");
    const first = new WeChatReminderService(db, send, now);
    const otherDb = openDatabase(path);
    try {
      const second = new WeChatReminderService(otherDb, send, now);
      const pending = first.tick();
      expect(await first.tick()).toBe(false);
      expect(await second.tick()).toBe(false);
      finish();
      expect(await pending).toBe(true);
      expect(await second.tick()).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
    } finally { otherDb.close(); }
  });

  it("retries failed deliveries and reclaims an expired lease left by a stopped process", async () => {
    task("Retry me", "2026-11-13");
    const send = vi.fn().mockRejectedValueOnce(new Error("Network unavailable")).mockResolvedValue(undefined);
    const now = () => new Date("2026-11-13T01:00:00Z");
    const service = new WeChatReminderService(db, send, now);
    await expect(service.tick()).rejects.toThrow("Network unavailable");
    db.prepare("INSERT INTO wechat_reminder_deliveries VALUES (?, ?, ?, NULL)")
      .run("2026-11-13", "old-process", "2026-11-13T00:59:59.000Z");
    expect(await service.tick()).toBe(true);
    expect(await service.tick()).toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it("leaves an empty day available for tasks synced later and limits oversized digests", async () => {
    const send = vi.fn(async (_message: WeChatReminderMessage) => {});
    const service = new WeChatReminderService(db, send, () => new Date("2026-11-13T01:00:00Z"));
    expect(await service.tick()).toBe(false);
    const node = task("中".repeat(200), "2026-11-13");
    const insert = db.prepare("INSERT INTO nodes SELECT ?, workspace_id, parent_id, position, title, body, due_date, done, collapsed, deleted_at, created_at, updated_at FROM nodes WHERE id = ?");
    for (let i = 0; i < 80; i++) insert.run(`large-${i}`, node.id);
    expect(await service.tick()).toBe(true);
    const message = send.mock.calls[0][0];
    expect(Buffer.byteLength(new URLSearchParams({ ...message }).toString())).toBeLessThan(64_000);
    expect(message.desp).toContain("请打开 OpenOutliner 查看");
  });
});

describe("Xtuis integration and scheduler", () => {
  it("stays disabled without a token and does not create delivery state", () => {
    const request = vi.fn();
    vi.stubGlobal("fetch", request);
    const stop = startWeChatReminders(db, "  ");
    stop();
    expect(createXtuisSender(undefined)).toBeNull();
    expect(request).not.toHaveBeenCalled();
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='wechat_reminder_deliveries'").get()).toBeUndefined();
  });

  it("sends encoded server-side credentials and rejects upstream errors without leaking secrets", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response('{"code":200}'));
    const send = createXtuisSender(" private/test-token ", request)!;
    await send({ text: "到期提醒", desp: "中文 & 内容" });
    const [url, options] = request.mock.calls[0];
    expect(url).toBe("https://wx.xtuis.cn/private%2Ftest-token.send");
    expect(options?.method).toBe("POST");
    expect(new URLSearchParams(String(options?.body)).get("desp")).toBe("中文 & 内容");
    for (const response of [new Response("error", { status: 503 }), new Response('{"code":500}')]) {
      request.mockResolvedValueOnce(response);
      await expect(send({ text: "test", desp: "test" })).rejects.toThrow("WeChat reminder delivery failed");
    }
    request.mockRejectedValueOnce(new Error("https://wx.xtuis.cn/private/test-token.send"));
    await expect(send({ text: "test", desp: "test" })).rejects.not.toThrow("private/test-token");
  });

  it("runs the server timer after 9, retries errors, and stops when disposed", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-13T00:59:30Z"));
    task("Server timer", "2026-11-15");
    const request = vi.fn().mockRejectedValueOnce(new Error("offline"))
      .mockImplementation(async () => new Response('{"code":200}'));
    vi.stubGlobal("fetch", request);
    const reportError = vi.fn();
    const stop = startWeChatReminders(db, "test-only-token", reportError);
    try {
      expect(request).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(reportError).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(request).toHaveBeenCalledTimes(2);
      stop();
      await vi.advanceTimersByTimeAsync(86_400_000);
      expect(request).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });
});
