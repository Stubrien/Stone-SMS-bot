// Team leave / holidays (Stu, 10 Nov 2026).
// Team table: Away From, Away Until (last day away), Away Cover (blank = Stu). Set on the Team page, or by texting Alex
// ("I'm on leave 20th to 27th", "away next week", "I'm back", "cancel my leave") – Alex reads the dates back and saves them on YES.
// While someone is away:
//   - routine texts to their sellers and buyers pause (nurture, check-ins, curated lists, match alerts)
//   - anything Alex would text them goes to the cover person instead ("For Leanne (away until Mon 30 Nov): …"), and a
//     copy is kept in Held While Away – summarised to them on their first morning back
//   - new leads: Alex engages straight away (no CALL / ALEX wait) and tells the cover person
//   - if one of their contacts texts, Alex says they're away until X and offers the cover person if it's urgent
// Other modules use: awayInfo(id), routeAgentText(agent, text, send), awayLine(id), handleTeamSMS, start.

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const BASE = process.env.AIRTABLE_BASE || 'apphczJpEh8x2EwQL';
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-4-6';
const TZ = 'Australia/Melbourne';
const TEAM = 'tbl1aNcrdwmamMyEF';
const TM = {
  name: 'fldWZzjCL3xoU0l82', first: 'fldbxwqujqA0rygi9', mobile: 'fldUZ1RQT4BNOo41n', active: 'fld8McuiVqyHAYduE',
  from: 'fldS5Xjx0ZZ4vknFO', until: 'fldVaVBBXJQvKLvBm', cover: 'fldGsIxkqvbtiUzGT', held: 'fldMx5xS1YNSjzo4w', notified: 'fldpDsAXmfm8NqAl4'
};

function enabled() { return !!process.env.AIRTABLE_TOKEN; }
function normalisePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('61')) return '+' + d;
  if (d.startsWith('0')) return '+61' + d.slice(1);
  if (d.length === 9 && d.startsWith('4')) return '+61' + d;
  return d;
}
function samePhone(a, b) { const x = normalisePhone(a), y = normalisePhone(b); return !!x && x === y; }
function melbClock() {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(Date.now()));
  const p = t => (parts.find(x => x.type === t) || {}).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hour: parseInt(p('hour'), 10) % 24, minute: parseInt(p('minute'), 10), weekday: p('weekday') };
}
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function niceDay(iso) { return iso ? new Date(iso + 'T00:00:00Z').toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' }).replace(',', '') : ''; }
const firstOf = t => t ? (t.fields[TM.first] || String(t.fields[TM.name] || '').split(' ')[0]) : '';
function approverMobile() { return normalisePhone(process.env.APPROVER_MOBILE); }

async function at(method, path, body) {
  const res = await fetch('https://api.airtable.com/v0/' + BASE + '/' + path, {
    method, headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Airtable ' + method + ' ' + path + ' ' + res.status + ': ' + JSON.stringify(json));
  return json;
}
let cache = { at: 0, rows: [] };
async function teamRows(fresh) {
  if (!fresh && Date.now() - cache.at < 2 * 60000 && cache.rows.length) return cache.rows;
  let out = [], offset;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' }); if (offset) q.set('offset', offset);
    const r = await at('GET', TEAM + '?' + q.toString()); out = out.concat(r.records || []); offset = r.offset;
  } while (offset);
  cache = { at: Date.now(), rows: out };
  return out;
}
async function updateTeam(id, fields) { cache.at = 0; return at('PATCH', TEAM + '?returnFieldsByFieldId=true', { records: [{ id, fields }], typecast: true }); }
async function sendSMS(to, body) { return (await twilioClient.messages.create({ from: process.env.ALEX_PHONE_NUMBER, to: normalisePhone(to), body })).sid; }

// ---------------------------------------------------------------- who's away
// Returns null, or { from, until, back, cover (team row or null), coverName, name, first }
async function awayInfo(memberOrId, onDate) {
  if (!enabled() || !memberOrId) return null;
  const id = typeof memberOrId === 'string' ? memberOrId : memberOrId.id;
  let rows; try { rows = await teamRows(); } catch (e) { return null; }
  const t = rows.find(r => r.id === id);
  if (!t) return null;
  const from = t.fields[TM.from], until = t.fields[TM.until];
  const d = onDate || melbClock().date;
  if (!from || !until || d < from || d > until) return null;
  const coverId = (t.fields[TM.cover] || [])[0];
  let cover = coverId ? rows.find(r => r.id === coverId) || null : null;
  if (!cover) cover = rows.find(r => samePhone(r.fields[TM.mobile], approverMobile())) || null; // blank = Stu
  if (cover && cover.id === t.id) cover = null;
  return { from, until, back: addDays(until, 1), cover, coverName: cover ? firstOf(cover) : 'Stu', name: t.fields[TM.name] || '', first: firstOf(t), member: t };
}
// Same check straight from a Team record the caller already has (no lookup)
function awayOnRecord(t, onDate) {
  if (!t || !t.fields) return false;
  const from = t.fields[TM.from], until = t.fields[TM.until], d = onDate || melbClock().date;
  return !!(from && until && d >= from && d <= until);
}
// One line for Alex's reply prompts when the contact's agent is away
async function awayLine(agentId) {
  const a = await awayInfo(agentId);
  if (!a) return '';
  return `IMPORTANT: ${a.first} is away on leave until ${niceDay(a.until)} (back ${niceDay(a.back)}). If they ask for ${a.first}, want a call or need something only ${a.first} can do, say ${a.first} is away until ${niceDay(a.until)}, that you'll make sure ${a.first} sees it when back, and that if it's urgent ${a.coverName} from our office can call them. Don't promise anything on ${a.first}'s behalf.`;
}
// Texts meant for an away agent: go to the cover person, copy kept for their return. Returns true when handled.
async function routeAgentText(agent, text, send) {
  const a = await awayInfo(agent);
  if (!a) return false;
  try {
    const c = melbClock();
    const line = `${c.date.slice(8, 10)}/${c.date.slice(5, 7)}: ${String(text).replace(/\s+/g, ' ').slice(0, 300)}`;
    const t = (await teamRows()).find(r => r.id === a.member.id);
    await updateTeam(a.member.id, { [TM.held]: ((t && t.fields[TM.held] ? t.fields[TM.held] + '\n' : '') + line).slice(-20000) });
  } catch (e) { console.error('Alex away: hold failed', e.message); }
  const to = a.cover && a.cover.fields[TM.mobile] ? a.cover.fields[TM.mobile] : approverMobile();
  if (to) {
    const body = `For ${a.first} (away until ${niceDay(a.until)}): ${text}`;
    try { if (send) await send(to, body); else await sendSMS(to, body); } catch (e) { console.error('Alex away: cover text failed', e.message); }
  }
  return true;
}

// ---------------------------------------------------------------- setting leave by text
const pending = new Map(); // phone -> { memberId, from, until, coverId, at }
const LEAVE_RE = /\b(holiday|holidays|hols|leave|away|annual leave|on vacation|vacation|off (from|next|this|until|till)|out of (the )?office|i'?m back|back early|cancel (my )?(leave|holiday|holidays))\b/i;

async function readLeave(member, text, team) {
  const c = melbClock();
  const names = team.filter(t => t.fields[TM.active]).map(t => t.fields[TM.name]).join(', ');
  const r = await anthropic.messages.create({
    model: MODEL, max_tokens: 300,
    system: 'You read a staff member\'s text to the office assistant and pull out leave dates. Reply with JSON only.',
    messages: [{ role: 'user', content: `Today is ${c.weekday} ${c.date} (Ballarat, Australia). ${member.fields[TM.name]} texted: "${text}"\nTeam: ${names}\n` +
      `Return {"intent": "set" (they're telling us about leave / time away) | "back" (they're back early / cancel current leave) | "cancel" (cancel leave that hasn't started) | "none" (not about their own leave), ` +
      `"from": "YYYY-MM-DD first day away", "until": "YYYY-MM-DD last day away (not the day they're back)", "cover": "team member's full name from the list if they named someone to cover, else empty", "unclear": "what's missing, if the dates can't be worked out, else empty"}.\n` +
      `"next week" = Monday to Sunday of next week; "back on Monday the 30th" means until = the day before. A weekday on its own means the next one.` }]
  });
  const m = r.content.map(x => x.text || '').join('').match(/\{[\s\S]*\}/);
  return m ? JSON.parse(m[0]) : { intent: 'none' };
}

async function handleTeamSMS(from, body) {
  if (!enabled()) return false;
  const text = String(body || '').trim();
  const key = normalisePhone(from);
  const team = await teamRows(true);
  const member = team.find(t => samePhone(t.fields[TM.mobile], from));
  if (!member) return false;
  const reply = msg => sendSMS(from, msg);

  // confirming what Alex read back
  const p = pending.get(key);
  if (p && Date.now() - p.at < 60 * 60000) {
    if (/^(yes|y|yep|yeah|correct|ok|okay|confirm|that's right|thats right|👍)\b/i.test(text)) {
      pending.delete(key);
      if (p.kind === 'back') {
        await updateTeam(member.id, { [TM.until]: addDays(melbClock().date, -1) });
        await reply(`Welcome back ${firstOf(member)} - I've switched everything back on.`);
        await welcomeBack(await refreshed(member.id), true);
        return true;
      }
      if (p.kind === 'cancel') {
        await updateTeam(member.id, { [TM.from]: null, [TM.until]: null, [TM.cover]: [] });
        await reply('Done - your leave is cancelled and nothing will pause.');
        return true;
      }
      await updateTeam(member.id, { [TM.from]: p.from, [TM.until]: p.until, [TM.cover]: p.coverId ? [p.coverId] : [], [TM.notified]: '' });
      const cover = p.coverId ? team.find(t => t.id === p.coverId) : null;
      await reply(`All set - you're down as away ${niceDay(p.from)} to ${niceDay(p.until)}. While you're away I'll pause routine texts to your sellers and buyers, and send new leads and anything urgent to ${cover ? firstOf(cover) : 'Stu'}. I'll catch you up on ${niceDay(addDays(p.until, 1))}. Enjoy the break.`);
      if (cover && cover.fields[TM.mobile]) await sendSMS(cover.fields[TM.mobile], `Heads up - ${firstOf(member)} is away ${niceDay(p.from)} to ${niceDay(p.until)} and has asked you to cover. I'll send you their new leads and anything urgent.`).catch(() => { });
      return true;
    }
    if (/^(no|nope|cancel|wrong|nah)\b/i.test(text) && text.length < 12) { pending.delete(key); await reply("No worries, I haven't changed anything. Text me the dates again whenever you're ready."); return true; }
    // anything else: treat as a correction if it looks like leave, otherwise fall through
  }
  if (!LEAVE_RE.test(text) && !(p && /\d|mon|tue|wed|thu|fri|sat|sun|week/i.test(text))) return false;

  let r;
  try { r = await readLeave(member, p ? `${p.text} / correction: ${text}` : text, team); } catch (e) { console.error('Alex away: read failed', e.message); return false; }
  if (!r || r.intent === 'none') return false;
  const cur = await awayInfo(member.id);
  if (r.intent === 'back') {
    if (!cur) { await reply("You're not marked as away at the moment, so nothing's paused."); return true; }
    pending.set(key, { kind: 'back', at: Date.now(), text });
    await reply(`Just to confirm - you're back now and I should switch everything back on (you were away until ${niceDay(cur.until)})? Reply YES.`);
    return true;
  }
  if (r.intent === 'cancel') {
    if (!member.fields[TM.from]) { await reply("There's no leave booked for you, so there's nothing to cancel."); return true; }
    pending.set(key, { kind: 'cancel', at: Date.now(), text });
    await reply(`Cancel your leave ${niceDay(member.fields[TM.from])} to ${niceDay(member.fields[TM.until])}? Reply YES.`);
    return true;
  }
  const okDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
  if (!okDate(r.from) || !okDate(r.until) || r.until < r.from || r.until < melbClock().date) {
    pending.set(key, { kind: 'set', at: Date.now(), text, from: null, until: null });
    await reply(`Happy to pause things while you're away${r.unclear ? ' - ' + r.unclear : ''}. What's your first day away and your last day away?`);
    return true;
  }
  const cover = r.cover ? team.find(t => String(t.fields[TM.name] || '').toLowerCase() === String(r.cover).toLowerCase()) : null;
  pending.set(key, { kind: 'set', at: Date.now(), text, from: r.from, until: r.until, coverId: cover && cover.id !== member.id ? cover.id : '' });
  await reply(`Just to confirm: away ${niceDay(r.from)} to ${niceDay(r.until)}, back ${niceDay(addDays(r.until, 1))}. ${cover && cover.id !== member.id ? firstOf(cover) : 'Stu'} will get your new leads and anything urgent${cover ? '' : ' (text me a name if someone else should cover)'}. Reply YES to set it.`);
  return true;
}
async function refreshed(id) { return (await teamRows(true)).find(t => t.id === id); }

// ---------------------------------------------------------------- morning texts: first day away, first day back
async function welcomeBack(t, force) {
  if (!t || !t.fields[TM.mobile]) return;
  const held = String(t.fields[TM.held] || '').trim().split('\n').filter(Boolean);
  const body = held.length
    ? `Welcome back ${firstOf(t)}. Everything's switched back on. While you were away I passed ${held.length} thing${held.length > 1 ? 's' : ''} to your cover:\n` + held.slice(-8).map(h => '- ' + h.slice(0, 140)).join('\n') + (held.length > 8 ? `\n(+${held.length - 8} more on your Team record)` : '')
    : `Welcome back ${firstOf(t)}. Everything's switched back on - nothing urgent came through while you were away.`;
  await sendSMS(t.fields[TM.mobile], body.slice(0, 1500)).catch(e => console.error('Alex away: welcome back failed', e.message));
  await updateTeam(t.id, { [TM.held]: '', [TM.notified]: `back:${t.fields[TM.until] || ''}` });
}
async function tick() {
  if (!enabled()) return;
  const c = melbClock();
  if (c.hour < 7 || c.hour >= 21) return;
  for (const t of await teamRows(true)) {
    const from = t.fields[TM.from], until = t.fields[TM.until], note = t.fields[TM.notified] || '';
    if (!from || !until) continue;
    try {
      if (c.date >= from && c.date <= until && note !== `start:${from}` && !note.startsWith('back:' + until) && t.fields[TM.mobile]) {
        await updateTeam(t.id, { [TM.notified]: `start:${from}` });
        if (c.date === from) await sendSMS(t.fields[TM.mobile], `Morning ${firstOf(t)} - you're on leave until ${niceDay(until)}, so I've paused routine texts to your contacts and I'm sending anything urgent to your cover. Text me "I'm back" if plans change. Enjoy.`);
      }
      if (c.date > until && c.date <= addDays(until, 3) && c.hour >= 8 && !note.startsWith('back:' + until)) await welcomeBack(t);
    } catch (e) { console.error('Alex away: tick failed for ' + t.id, e.message); }
  }
}
let timer = null;
function start() {
  if (!enabled() || timer) return;
  timer = setInterval(() => tick().catch(e => console.error('Alex away tick', e.message)), 15 * 60000);
  setTimeout(() => tick().catch(() => { }), 30000);
}

module.exports = { awayInfo, awayOnRecord, awayLine, routeAgentText, handleTeamSMS, start, tick, _internal: { pending, niceDay } };
