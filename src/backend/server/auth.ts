import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
const password = process.env.OPENOUTLINER_PASSWORD;
const sign = (value: string) => createHmac("sha256", password ?? "local").update(value).digest("hex");
const same = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export function authorized(req: IncomingMessage): boolean {
  if (!password) return true;
  const value = req.headers.cookie?.split(";").map(item => item.trim()).find(item => item.startsWith("oo_session="))?.slice(11) ?? "";
  const [expires, signature = ""] = value.split(".");
  return Number(expires) > Date.now() && same(sign(expires), signature);
}
const attempts = new Map<string, { count: number; until: number }>();
export function login(req: IncomingMessage, res: ServerResponse, input: { password?: string }): void {
  const address = req.socket.remoteAddress ?? "unknown";
  let attempt = attempts.get(address);
  if (!attempt || attempt.until < Date.now()) { attempt = { count: 0, until: Date.now() + 60000 }; attempts.set(address, attempt); }
  if (++attempt.count > 10) { res.writeHead(429); res.end(JSON.stringify({ error: "尝试过于频繁，请一分钟后重试" })); return; }
  if (password && (typeof input.password !== "string" || !same(sign(input.password), sign(password)))) {
    res.writeHead(401); res.end(JSON.stringify({ error: "密码不正确" })); return;
  }
  const expires = String(Date.now() + 30 * 86400000);
  res.setHeader("set-cookie", `oo_session=${expires}.${sign(expires)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=2592000${process.env.NODE_ENV === "production" ? "; Secure" : ""}`);
  res.writeHead(200, { "content-type": "application/json" }); res.end('{"ok":true}');
}
