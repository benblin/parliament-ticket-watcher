// Watches the Hungarian Parliament visit on jegymester.hu for open slots on the target
// dates and sends a Telegram message when one appears. It uses the site like a normal
// visitor: open the page, pick each date in the calendar, read what the page shows.
const fs = require('fs');
const { chromium } = require('playwright');

const PAGE = 'https://jegymester.hu/production/480000/hungarian-parliament-building-parliament-visit';
const DATES = (process.env.DATES || '2026-12-22,2026-12-23,2026-12-27').split(',');
const RUN_MINUTES = Number(process.env.RUN_MINUTES || 0);   // 0 = check once
const INTERVAL_SECONDS = Number(process.env.INTERVAL_SECONDS || 180);
const STATE_FILE = process.env.STATE_FILE || 'state.json';
const { TELEGRAM_BOT_TOKEN, HTTPS_PROXY, TEST_ALERT } = process.env;
let chatId = process.env.TELEGRAM_CHAT_ID;
const HU_MONTHS = ['január','február','március','április','május','június','július','augusztus','szeptember','október','november','december'];

const loadState = () => { try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; } };
const saveState = s => fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + '\n');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const budapestTime = ms => new Date(ms).toLocaleString('en-GB', { timeZone: 'Europe/Budapest', weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// With only a bot token set, the chat is the first person to press Start on the bot.
async function findChat(state) {
  chatId = chatId || state.chatId;
  if (chatId || !TELEGRAM_BOT_TOKEN) return;
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates`).then(r => r.json()).catch(() => ({}));
  const chats = (r.result || []).map(u => (u.message || u.my_chat_member || {}).chat).filter(c => c && c.type === 'private');
  if (chats.length) state.chatId = chats[0].id;
  chatId = state.chatId;
  if (!chatId) console.log('Telegram bot token is set, but nobody has pressed Start on the bot yet.');
}

async function telegram(text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) { console.log('[telegram not configured]\n' + text); return; }
  const r = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (!r.ok) console.log('Telegram error', r.status, await r.text());
}

// Opens the calendar, moves to the target month and clicks the day. Returns the
// events list the page itself loaded for that day.
async function eventsForDate(page, iso) {
  const [y, m, d] = iso.split('-').map(Number);
  const picker = page.locator('bs-datepicker-container, .bs-datepicker').first();
  if (!(await picker.isVisible())) await page.locator('input.form-control[readonly]').first().click();
  await picker.waitFor({ timeout: 15000 });
  // The picker can show two months side by side; find the one for the target month.
  let view;
  for (let i = 0; i < 24 && !view; i++) {
    for (const v of await picker.locator('bs-days-calendar-view').all()) {
      const label = (await v.locator('.bs-datepicker-head button.current').allInnerTexts()).join(' ').toLowerCase();
      if (label.includes(HU_MONTHS[m - 1]) && label.includes(String(y))) { view = v; break; }
    }
    if (!view) { await picker.locator('.bs-datepicker-head button.next').last().click({ force: true }); await sleep(300); }
  }
  if (!view) throw new Error(`could not find ${iso} in the calendar`);
  const day = view.locator('td[role=gridcell] span:not(.is-other-month)', { hasText: new RegExp(`^${d}$`) }).first();
  if (await day.evaluate(el => el.classList.contains('disabled'))) return { events: [], note: 'no visits that day' };
  const resp = page.waitForResponse(r => r.url().includes('/rest/production/480000/events') && r.status() === 200, { timeout: 30000 });
  await day.click();
  const body = await (await resp).json();
  await sleep(500);
  const want = new Date(`${iso}T00:00:00`).toDateString();
  return { events: (body.events || []).filter(e => new Date(new Date(e.startDate).toLocaleString('en-US', { timeZone: 'Europe/Budapest' })).toDateString() === want) };
}

async function checkOnce(browser) {
  const ctx = await browser.newContext({ locale: 'en-US', timezoneId: 'Europe/Budapest', serviceWorkers: 'block', viewport: { width: 1280, height: 1400 } });
  const page = await ctx.newPage();
  try {
    await page.goto(PAGE, { waitUntil: 'networkidle', timeout: 90000 });
    const out = {};
    for (const iso of DATES) {
      if (page.isClosed()) break;
      out[iso] = await eventsForDate(page, iso);
      await page.keyboard.press('Escape').catch(() => {});
    }
    return out;
  } finally { await ctx.close(); }
}

async function main() {
  const state = loadState();
  state.notified = state.notified || {};
  await findChat(state);
  if (TEST_ALERT) await telegram(`🧪 Test alert from your Parliament ticket watcher. If you see this, alerts work.\n${PAGE}`);
  const browser = await chromium.launch({
    ...(HTTPS_PROXY ? { proxy: { server: HTTPS_PROXY } } : {}),
    args: HTTPS_PROXY ? ['--ignore-certificate-errors'] : [],
  });
  const end = Date.now() + RUN_MINUTES * 60000;
  let failures = 0;
  try {
    do {
      try {
        const result = await checkOnce(browser);
        failures = 0;
        state.lastOk = new Date().toISOString();
        const open = [];
        for (const [iso, r] of Object.entries(result)) {
          const slots = r.events.map(e => `${budapestTime(e.startDate)} ${e.status}`);
          console.log(new Date().toISOString(), iso, r.note || slots.join(' | ') || 'no events');
          for (const e of r.events) {
            if (e.status !== 'sold-out') open.push(e);
            else delete state.notified[e.id];   // re-alert if it opens again later
          }
        }
        const fresh = open.filter(e => !state.notified[e.id]);
        if (fresh.length) {
          const lines = fresh.map(e => `• <b>${budapestTime(e.startDate)}</b>` + (e.availableTickets ? ` (${e.availableTickets} left)` : ''));
          await telegram(`🎟 <b>Parliament tickets available!</b>\n${lines.join('\n')}\n\nBook now: ${PAGE}\nFamily ticket: 2 adults + 1 child (6-14). Under-6s are free, ask on site or at idegenforgalom@parlament.hu.`);
          for (const e of fresh) state.notified[e.id] = new Date().toISOString();
        }
        if (!state.welcomed && chatId) {
          await telegram(`✅ Watcher is live. Checking ${DATES.join(', ')} every few minutes until Dec 27. Right now: ${open.length ? open.length + ' open slot(s)' : 'all sold out'}.`);
          state.welcomed = true;
        }
        if (state.errorAlerted) { state.errorAlerted = false; await telegram('✅ Watcher recovered and is checking again.'); }
      } catch (err) {
        failures++;
        console.log(new Date().toISOString(), 'check failed:', err.message);
        if (failures >= 3 && !state.errorAlerted) {
          await telegram(`⚠️ Ticket watcher keeps failing: ${err.message.slice(0, 200)}`);
          state.errorAlerted = true;
        }
      }
      saveState(state);
      if (Date.now() + INTERVAL_SECONDS * 1000 > end) break;
      await sleep(INTERVAL_SECONDS * 1000);
    } while (true);
  } finally { await browser.close(); }
}

main().catch(e => { console.error(e); process.exit(1); });
