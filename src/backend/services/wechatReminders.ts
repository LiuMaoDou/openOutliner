import { randomUUID } from "node:crypto";
import type { SqlDatabase } from "../shared/sql.js";
import { OutlinerService } from "./outliner.js";

export const REMINDER_TIME_ZONE = "Asia/Shanghai";
const CHECK_INTERVAL_MS = 60_000;
const CLAIM_DURATION_MS = 5 * 60_000;
const beijingClock = new Intl.DateTimeFormat("en-CA", {
  timeZone: REMINDER_TIME_ZONE,
  year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23"
});

export interface WeChatReminderMessage {
  text: string;
  desp: string;
}
export type WeChatReminderSender = (message: WeChatReminderMessage) => Promise<void>;

export function createXtuisSender(tokenValue: string | undefined, request: typeof fetch = fetch): WeChatReminderSender | null {
  const token = tokenValue?.trim();
  if (!token) return null;
  return async message => {
    // Never include the credential-bearing URL or upstream response body in errors.
    try {
      const response = await request(`https://wx.xtuis.cn/${encodeURIComponent(token)}.send`, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded;charset=UTF-8" },
        body: new URLSearchParams({ ...message }),
        signal: AbortSignal.timeout(10_000),
        redirect: "error"
      });
      if (!response.ok) throw new Error("Push rejected");
      const body: unknown = await response.json().catch(() => null);
      if (body && typeof body === "object" && "code" in body &&
        ![0, 200, "0", "200"].includes(body.code as number | string)) throw new Error("Push rejected");
    } catch {
      throw new Error("WeChat reminder delivery failed; check XTUIS_TOKEN and network access.");
    }
  };
}

function reminderDay(now: Date): { date: string; hour: number; cutoff: string } {
  const parts = Object.fromEntries(beijingClock.formatToParts(now).map(part => [part.type, part.value]));
  const date = `${parts.year}-${parts.month}-${parts.day}`;
  const cutoff = new Date(`${date}T00:00:00Z`);
  cutoff.setUTCDate(cutoff.getUTCDate() + 2);
  return { date, hour: Number(parts.hour), cutoff: cutoff.toISOString().slice(0, 10) };
}

function compact(value: string): string {
  return value.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** Server-only delivery records deliberately stay outside browser sync and outline undo. */
export class WeChatReminderService {
  private inFlight = false;
  private outliner: OutlinerService;

  constructor(private db: SqlDatabase, private send: WeChatReminderSender, private now: () => Date = () => new Date()) {
    this.outliner = new OutlinerService(db);
    db.exec(`CREATE TABLE IF NOT EXISTS wechat_reminder_deliveries (
      reminder_date TEXT PRIMARY KEY,
      claim_id TEXT NOT NULL,
      lease_until TEXT NOT NULL,
      sent_at TEXT
    )`);
  }

  async tick(): Promise<boolean> {
    if (this.inFlight) return false;
    const now = this.now();
    const { date, hour, cutoff } = reminderDay(now);
    if (hour < 9) return false;
    const nodes = this.outliner.listDueReminderNodes(cutoff);
    if (!nodes.length) return false;

    const claimId = randomUUID();
    const claimed = this.db.prepare(`
      INSERT INTO wechat_reminder_deliveries (reminder_date, claim_id, lease_until)
      VALUES (?, ?, ?)
      ON CONFLICT(reminder_date) DO UPDATE SET claim_id = excluded.claim_id, lease_until = excluded.lease_until
      WHERE wechat_reminder_deliveries.sent_at IS NULL AND wechat_reminder_deliveries.lease_until <= ?
      RETURNING claim_id
    `).get(date, claimId, new Date(now.getTime() + CLAIM_DURATION_MS).toISOString(), now.toISOString());
    if (!claimed) return false;

    this.inFlight = true;
    try {
      const workspaces = new Map(this.outliner.listWorkspaces().map(workspace => [workspace.id, workspace.name]));
      const header = `北京时间 ${date}\n以下任务将在 2 天内到期或已逾期，完成后将停止提醒\n`;
      const lines: string[] = [];
      for (const node of nodes) {
        const days = Math.round((Date.parse(`${node.dueDate}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`)) / 86_400_000);
        const status = days < 0 ? `逾期 ${-days} 天` : days === 0 ? "今天到期" : `还有 ${days} 天到期`;
        const line = `• ${compact(node.title) || "未命名任务"}\n  ${compact(workspaces.get(node.workspaceId) ?? "")} · ${node.dueDate} · ${status}`;
        // Xtuis supports at most 64 KB. Leave room for form encoding and the summary footer.
        if (Buffer.byteLength(new URLSearchParams({ desp: `${header}${lines.join("\n")}\n${line}` }).toString()) > 60_000) break;
        lines.push(line);
      }
      const remaining = nodes.length - lines.length;
      await this.send({
        text: `任务到期提醒（${nodes.length} 项）`,
        desp: `${header}\n${lines.join("\n")}\n${remaining ? `\n另有 ${remaining} 项，请打开 OpenOutliner 查看\n` : ""}`
      });
      this.db.prepare("UPDATE wechat_reminder_deliveries SET sent_at = ? WHERE reminder_date = ? AND claim_id = ?")
        .run(this.now().toISOString(), date, claimId);
      return true;
    } catch (error) {
      this.db.prepare("DELETE FROM wechat_reminder_deliveries WHERE reminder_date = ? AND claim_id = ? AND sent_at IS NULL")
        .run(date, claimId);
      throw error;
    } finally {
      this.inFlight = false;
    }
  }
}

export function startWeChatReminders(
  db: SqlDatabase,
  token: string | undefined,
  reportError: (error: unknown) => void = () => console.error("WeChat reminder delivery failed; retrying on the next check.")
): () => void {
  const send = createXtuisSender(token);
  if (!send) return () => {};
  const service = new WeChatReminderService(db, send);
  const check = () => { void service.tick().catch(reportError); };
  const timer = setInterval(check, CHECK_INTERVAL_MS);
  timer.unref();
  check();
  return () => clearInterval(timer);
}
