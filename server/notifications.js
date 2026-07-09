const nodemailer = require('nodemailer');

function buildSummary(findings) {
  if (!findings || findings.length === 0) {
    return 'Scan complete: No vulnerabilities found';
  }
  const counts = findings.reduce((acc, f) => {
    const sev = f.severity || 'info';
    acc[sev] = (acc[sev] || 0) + 1;
    return acc;
  }, {});
  const parts = [
    `critical: ${counts.critical || 0}`,
    `high: ${counts.high || 0}`,
    `medium: ${counts.medium || 0}`,
    `low: ${counts.low || 0}`,
    `info: ${counts.info || 0}`,
  ];
  return `Scan complete: ${findings.length} findings (${parts.join(', ')})`;
}

async function sendEmail(dest, summary, findings, reportUrl) {
  let recipients = Array.isArray(dest.recipients) ? dest.recipients.map(s => String(s).trim()).filter(Boolean) : [];
  if (!recipients.length && dest.address) recipients = [dest.address];
  if (!recipients.length && process.env.EMAIL_ADDRESS) recipients = [process.env.EMAIL_ADDRESS];
  if (!recipients.length) return;

  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;
  const from = process.env.SMTP_FROM || user || 'sentinel@localhost';

  if (!host || !user || !pass) {
    throw new Error('SMTP not configured (set SMTP_HOST, SMTP_USER, SMTP_PASS)');
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  const findingLines = findings.slice(0, 20).map(f => {
    return `[${(f.severity || 'info').toUpperCase()}] ${f.name} — ${f.matchedAt || f.host || ''}`;
  }).join('\n');

  const linkText = reportUrl ? `\n\nView full report: ${reportUrl}` : '';
  await transporter.sendMail({
    from,
    to: recipients.join(', '),
    subject: `Sentinel: ${summary}`,
    text: `${summary}\n\n${findingLines || 'No findings'}${linkText}`,
  });
}

async function sendSlack(config, summary, findings, reportUrl) {
  const webhook = config.webhook || process.env.SLACK_WEBHOOK;
  if (!webhook) return;

  const blocks = findings.slice(0, 10).map(f => ({
    type: 'section',
    text: {
      type: 'mrkdwn',
      text: `*[${(f.severity || 'info').toUpperCase()}]* ${f.name}\n${f.matchedAt || f.host || ''}`,
    },
  }));

  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      text: summary,
      blocks: [
        { type: 'header', text: { type: 'plain_text', text: 'Sentinel Scan Report' } },
        { type: 'section', text: { type: 'mrkdwn', text: summary } },
        { type: 'divider' },
        ...blocks,
        ...(reportUrl ? [{ type: 'section', text: { type: 'mrkdwn', text: `<${reportUrl}|📄 View full report>` } }] : []),
      ],
    }),
  });
}

async function sendTelegram(config, summary, reportUrl) {
  const botToken = config.botToken || process.env.TELEGRAM_BOT_TOKEN;
  const chatId = config.chatId || process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !chatId) return;

  const link = reportUrl ? `\n\n[📄 View full report](${reportUrl})` : '';
  const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `🛡️ *Sentinel Scan*\n\n${summary}${link}`,
      parse_mode: 'Markdown',
    }),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Telegram API ${res.status}: ${text}`);
  }
}

async function sendDiscord(config, summary, findings, reportUrl) {
  const webhook = config.webhook || process.env.DISCORD_WEBHOOK;
  if (!webhook) return;

  const fields = findings.slice(0, 10).map(f => ({
    name: `[${(f.severity || 'info').toUpperCase()}] ${f.name}`,
    value: f.matchedAt || f.host || '',
    inline: false,
  }));

  await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      embeds: [{
        title: 'Sentinel Scan Report',
        url: reportUrl || undefined,
        description: reportUrl ? `${summary}\n\n[📄 View full report](${reportUrl})` : summary,
        color: findings.length > 0 ? 0xff0000 : 0x00ff00,
        fields,
        timestamp: new Date().toISOString(),
      }],
    }),
  });
}

async function sendWebhook(config, summary, findings, reportUrl) {
  const url = config.url || process.env.WEBHOOK_URL;
  if (!url) return;

  await fetch(url, {
    method: config.method || 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ summary, findings, reportUrl: reportUrl || null, timestamp: new Date().toISOString() }),
  });
}

// Normalize a monitor's per-channel notification config. Accepts the legacy
// { email: 'all', slack: 'high', ... } shape and the richer per-channel shape
// { email: { enabled, level, recipients }, telegram: { enabled, level, chatId }, ... }.
function normalizeChannel(value) {
  if (value == null) return null;
  if (typeof value === 'string') return { enabled: value !== 'never', level: value };
  return { enabled: value.enabled !== false, level: value.level || 'all', ...value };
}

// Per-monitor destination, falling back to the global channel config, then env.
function resolveDest(type, m, g) {
  m = m || {}; g = g || {};
  switch (type) {
    case 'email': {
      const recipients = (Array.isArray(m.recipients) ? m.recipients : [])
        .map(s => String(s).trim()).filter(Boolean);
      if (!recipients.length && g.address) recipients.push(g.address);
      return { recipients };
    }
    case 'telegram': return { botToken: m.botToken || g.botToken, chatId: m.chatId || g.chatId };
    case 'slack': return { webhook: m.webhook || g.webhook, channel: m.channel || g.channel };
    case 'discord': return { webhook: m.webhook || g.webhook, username: m.username || g.username };
    case 'webhook': return { url: m.url || g.url, method: m.method || g.method };
    default: return {};
  }
}

async function sendNotifications(findings, monitor, reportUrl) {
  const db = require('./db');
  const notif = monitor.notifications || {};
  const globalByType = {};
  for (const ch of db.channels()) globalByType[ch.type] = ch.config || {};

  const summary = buildSummary(findings);
  const hasHigh = findings.some(f => ['high', 'critical'].includes(f.severity));

  for (const type of ['email', 'slack', 'telegram', 'discord', 'webhook']) {
    const cfg = normalizeChannel(notif[type]);
    if (!cfg || !cfg.enabled || cfg.level === 'never') continue;
    if (cfg.level === 'high' && !hasHigh) continue;

    const dest = resolveDest(type, cfg, globalByType[type]);
    try {
      switch (type) {
        case 'email': await sendEmail(dest, summary, findings, reportUrl); break;
        case 'slack': await sendSlack(dest, summary, findings, reportUrl); break;
        case 'telegram': await sendTelegram(dest, summary, reportUrl); break;
        case 'discord': await sendDiscord(dest, summary, findings, reportUrl); break;
        case 'webhook': await sendWebhook(dest, summary, findings, reportUrl); break;
      }
      console.log(`[Notifier] ${type} sent for ${monitor.url}`);
    } catch (err) {
      console.error(`[Notifier] ${type} failed:`, err.message || err);
    }
  }
}

async function testChannel(type, config) {
  switch (type) {
    case 'email': {
      const host = process.env.SMTP_HOST;
      const port = parseInt(process.env.SMTP_PORT || '587', 10);
      const user = process.env.SMTP_USER;
      const pass = process.env.SMTP_PASS;
      if (!host || !user || !pass) throw new Error('SMTP not configured');
      const transporter = nodemailer.createTransport({ host, port, secure: port === 465, auth: { user, pass } });
      await transporter.verify();
      return 'SMTP connection OK';
    }
    case 'slack': {
      const webhook = config.webhook || process.env.SLACK_WEBHOOK;
      if (!webhook) throw new Error('Webhook not configured');
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: 'Sentinel test notification' }),
      });
      if (!res.ok) throw new Error(`Slack returned ${res.status}`);
      return 'Slack webhook OK';
    }
    case 'telegram': {
      const botToken = config.botToken || process.env.TELEGRAM_BOT_TOKEN;
      if (!botToken) throw new Error('Bot token not configured');
      const res = await fetch(`https://api.telegram.org/bot${botToken}/getMe`);
      if (!res.ok) throw new Error(`Telegram API ${res.status}`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.description || 'Telegram token invalid');
      return `Bot @${data.result.username} OK`;
    }
    case 'discord': {
      const webhook = config.webhook || process.env.DISCORD_WEBHOOK;
      if (!webhook) throw new Error('Webhook not configured');
      const res = await fetch(webhook, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: 'Sentinel test notification' }),
      });
      if (!res.ok) throw new Error(`Discord returned ${res.status}`);
      return 'Discord webhook OK';
    }
    case 'webhook': {
      const url = config.url || process.env.WEBHOOK_URL;
      if (!url) throw new Error('URL not configured');
      const method = config.method || process.env.WEBHOOK_METHOD || 'POST';
      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: method.toUpperCase() === 'GET' ? undefined : JSON.stringify({ test: true, timestamp: new Date().toISOString() }),
      });
      if (!res.ok) throw new Error(`Webhook returned ${res.status}`);
      return 'Webhook OK';
    }
    default:
      throw new Error(`Unknown channel type: ${type}`);
  }
}

module.exports = { sendNotifications, testChannel };
