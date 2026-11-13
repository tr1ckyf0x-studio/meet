import nodemailer, { type Transporter } from "nodemailer";
import { fmtRange } from "../shared/format";
import { t, type Lang } from "../shared/i18n";

export interface Attachment { filename: string; content: string; contentType: string }
export interface Mail { to: string; subject: string; text: string; html: string; attachments?: Attachment[] }
export interface Mailer { send(m: Mail): Promise<void> }

export interface SmtpConfig { host: string; port: number; user: string; pass: string; from: string }

const domainOf = (to: string) => to.split("@").pop() ?? "?";

export class SmtpMailer implements Mailer {
  private readonly tr: Transporter;
  constructor(private readonly cfg: SmtpConfig, private readonly log: (msg: string) => void = () => {}) {
    this.tr = nodemailer.createTransport({
      host: cfg.host, port: cfg.port, secure: cfg.port === 465, requireTLS: cfg.port === 587,
      auth: { user: cfg.user, pass: cfg.pass },
      connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
    });
  }
  async send(m: Mail): Promise<void> {
    const info = await this.tr.sendMail({
      from: this.cfg.from, to: m.to, subject: m.subject, text: m.text, html: m.html,
      attachments: m.attachments?.map((a) => ({ filename: a.filename, content: a.content, contentType: a.contentType })),
    });
    // The relay's answer and id, to find the message in its own logs; never the full address.
    this.log(`mail to *@${domainOf(m.to)} accepted: ${String(info.response).slice(0, 120)} ${info.messageId ?? ""}`);
  }
}

/** Tests and local runs without SMTP: keeps messages in memory (and optionally prints the text). */
export class MemoryMailer implements Mailer {
  readonly sent: Mail[] = [];
  constructor(private readonly print = false) {}
  async send(m: Mail): Promise<void> {
    this.sent.push(m);
    if (this.print) console.log(`[mail to ${m.to}] ${m.subject}\n${m.text}`);
  }
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

function layout(body: string): string {
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f4ef;font-family:-apple-system,Segoe UI,Roboto,sans-serif;color:#1d1d1b">
<div style="max-width:520px;margin:0 auto;background:#fff;border-radius:14px;padding:28px">
<div style="font-weight:700;font-size:18px;margin-bottom:18px;color:#1f6f5c">meet</div>${body}</div></body></html>`;
}

const button = (url: string, label: string) =>
  `<p style="margin:24px 0"><a href="${esc(url)}" style="background:#1f6f5c;color:#fff;text-decoration:none;padding:12px 20px;border-radius:10px;font-weight:600;display:inline-block">${esc(label)}</a></p>`;

export function loginMail(to: string, url: string, lang: Lang): Mail {
  return {
    to,
    subject: t(lang, "m_login_subject"),
    text: `${t(lang, "m_login_text")}\n${url}\n\n${t(lang, "m_login_ignore")}\n`,
    html: layout(`<p>${esc(t(lang, "m_login_text"))}</p>${button(url, t(lang, "m_login_button"))}
<p style="color:#77746c;font-size:13px">${esc(t(lang, "m_login_ignore"))}</p>`),
  };
}

export interface MeetingMailInput {
  to: string;
  lang: Lang;
  tz: string;
  title: string;
  address: string;
  start: number;
  end: number;
  pageUrl: string;
  gcalUrl: string;
  ics: string;
  cancelled: boolean;
  /** The set meeting was renamed or moved to another address. */
  updated?: boolean;
}

export function meetingMail(m: MeetingMailInput): Mail {
  const when = fmtRange(m.start, m.end, m.tz, m.lang);
  const subject = t(m.lang, m.cancelled ? "m_cancel_subject" : m.updated ? "m_update_subject" : "m_confirm_subject", { title: m.title });
  const lead = t(m.lang, m.cancelled ? "m_cancel_lead" : m.updated ? "m_update_lead" : "m_confirm_lead");
  const lines = [lead, "", m.title, `${t(m.lang, "m_when")}: ${when} (${m.tz})`];
  if (m.address) lines.push(`${t(m.lang, "m_where")}: ${m.address}`);
  lines.push("");
  if (!m.cancelled) lines.push(t(m.lang, "m_confirm_attach"), `${t(m.lang, "m_gcal")}: ${m.gcalUrl}`);
  lines.push(`${t(m.lang, "m_page")}: ${m.pageUrl}`);
  const html = layout(`<p>${esc(lead)}</p>
<h2 style="font-size:20px;margin:18px 0 8px">${esc(m.title)}</h2>
<p style="margin:4px 0"><b>${esc(t(m.lang, "m_when"))}:</b> ${esc(when)} <span style="color:#77746c">(${esc(m.tz)})</span></p>
${m.address ? `<p style="margin:4px 0"><b>${esc(t(m.lang, "m_where"))}:</b> ${esc(m.address)}</p>` : ""}
${m.cancelled ? "" : `<p style="color:#55524b">${esc(t(m.lang, "m_confirm_attach"))}</p>${button(m.gcalUrl, t(m.lang, "m_gcal"))}`}
<p><a href="${esc(m.pageUrl)}" style="color:#1f6f5c">${esc(t(m.lang, "m_page"))}</a></p>`);
  const method = m.cancelled ? "CANCEL" : "PUBLISH";
  return {
    to: m.to, subject, text: lines.join("\n") + "\n", html,
    attachments: [{ filename: m.cancelled ? "cancel.ics" : "invite.ics", content: m.ics, contentType: `text/calendar; charset=utf-8; method=${method}` }],
  };
}
