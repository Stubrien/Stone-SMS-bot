// Alex Requests – jobs the team gives Alex to do with a contact on an agent's behalf (Stu, 10 Nov 2026).
// Created on the "Ask Alex" page (Alex Messaging interface) → Alex Requests table. Phase 1 types:
//   Meet the agent   – get the contact's availability, offer the agent 2–3 times, confirm with both, calendar + task
//   Chase a document – ask for it, say where to send it, chase on a schedule, the receiver confirms it arrived
//   Ask a question   – ask, pass the answer back word for word, optionally save it to the contact's notes
// The team answers by text with the request code: "R12 2", "R12 YES", "R12 EDIT …", "R12 GOT IT", "R12 CALL", "R12 CANCEL".
// Anything Alex shouldn't handle (price, offers, contract terms, legal / finance advice, unhappy, wants the agent,
// silence, a second reschedule) goes back to the agent with a task – status "Needs agent".

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const away = require('./alex-away'); // team leave (Stu, 10 Nov)

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const BASE = process.env.AIRTABLE_BASE || 'apphczJpEh8x2EwQL';
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-4-6';
const TZ = 'Australia/Melbourne';
const OFFICE = '44 Armstrong St South, Ballarat Central';
const TICK_MINUTES = 2;

const T = { req: 'tbloPnRQ7chus0Oug', team: 'tbl1aNcrdwmamMyEF', contacts: 'tblWRqWCqXWP708dY', tasks: 'tblly5yaH9pTZrUXC', activity: 'tblMcqHGJSqCevRaP', opps: 'tblrFYa8aQsLJkW13', listings: 'tbl7rq0yT4S55joAJ' };
const R = {
  title: 'fldKTmiIRcYfU5Z4I', no: 'fld5o7fUg7BVsdEoB', code: 'fldMWBufbgkv0dAZL', type: 'fldsVWRCUA0E5VxSM', status: 'fld8V4OApPUANGcMM',
  agent: 'fldp0mUvJKpbtFpFB', by: 'flddhf89rUcDBDsRD', contact: 'fldGO4sZPQhRk44Lm', opp: 'fld8TWZqkilQGBlQh', brief: 'fldN4d6lX1wefKB5P', listing: 'fldhu6NoBV9zhjEK3',
  briefText: 'fldz7k0vwmcnisdWy', replyBy: 'fld60NbPn12bCPvzs', first: 'fld9kFdzqcLtFqURU',
  purpose: 'flddaNdDSeRZG6wyV', where: 'fldLKd80b2j2hWayC', address: 'fld9a7pF4cNofPLGf', minutes: 'fldM1unHsozTZsmk3', within: 'fldM7xWaezon8Xp7v', prefer: 'fldbtZ0EBwcReGfa7', bring: 'fldYvzmwvwfthKo44',
  doc: 'fld9xPTpLJv0ZxL6R', docDetail: 'fldFgS0Zj5zfIhUzZ', sendTo: 'fldG6l20BYKUXpsHr', every: 'fldGkCy6dq42AEjKN', maxChases: 'fldCs2E2vfwvp7u3U',
  question: 'fldmDuzqN0147O8Aa', answerTo: 'fldglNoGmYSDgGhww',
  proposed: 'fldh2RHz9wIqNh4xs', confirmed: 'fldqvrWi08S02dT8S', outcome: 'fldf475oEQsDJnzIw', convo: 'fldzCdzfPKSk5ofkY', chases: 'fldrT5q5doEwCTaXb',
  lastContact: 'fldAlOgM22bzf3ArV', closedAt: 'fld4xzeSH2G8tQO12', task: 'fldLwiaC81ZN8jppI', state: 'fldKmJiVyb1pUddfQ', mobile: 'fldOG6muQygJJFcOz', created: 'fldeD7bBF0m7ch8d9',
  pageCmd: 'fldVQ8ivTxzVF1YAV', draft: 'fldRbDkjdVaF5BqG2'
};
const TM = { name: 'fldWZzjCL3xoU0l82', first: 'fldbxwqujqA0rygi9', mobile: 'fldUZ1RQT4BNOo41n', email: 'fldCwH4gZpNqZKmU1', active: 'fld8McuiVqyHAYduE' };
const C = { name: 'fld5hDJRpN92YZnFx', mobile: 'fld0EA8biRz66il05', email: 'fldZW60VKGeM5Pc2u', know: 'fldeg2ubhT2KCRR75', dnc: 'fldd9p4vMwi8R6Bx8', optedOn: 'fldKV1dvdkTd08Mgv' };
const TK = { task: 'flds1zBNNSIuWMIAe', due: 'fldFgsIL7uMKKutro', status: 'flddkegXHPifQmUaV', notes: 'fldmHfFADFPhyLW2U', source: 'fldvhHAvuWm60NRo2', opp: 'fldMF7mIWcDzaCANY', with: 'fldjjI2VaSG0bYh7Q', assigned: 'fldaINd0hRSQlVQCN', brief: 'fldkwomOX6NiqAZa0', prio: 'fldFmfDdgbBYhqki8' };
const A = { summary: 'fldBSXLvtiGrLDlBB', lead: 'fldR7UavJmh0OWsDI', kind: 'fldfKAWZQWXe00nz7', type: 'fldP8or1OJQgK4jrg', detail: 'fldhFWP8aFaaRV3nV', author: 'fld9GdJ7yWaVdBE9z', actType: 'fldFkehYx2Ow3iDm4', agent: 'fldUWwdtHeEPyoESq', contact: 'fldNzBEfyZ2uOi7k2', brief: 'fldtpS92u35fQHUKp' };
const LST = { addr: 'fldSRLtRIu0xYW1O3' };

const OPEN = ['Awaiting approval', 'New', 'Contacting', 'Waiting on agent', 'Confirmed'];

// ---------------------------------------------------------------- small helpers
function enabled() { return !!process.env.AIRTABLE_TOKEN && String(process.env.ALEX_REQUESTS_ENABLED || '').toLowerCase() === 'true'; }
function normalisePhone(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d+]/g, '');
  if (d.startsWith('+')) return d;
  if (d.startsWith('61')) return '+' + d;
  if (d.startsWith('0')) return '+61' + d.slice(1);
  if (d.length === 9 && d.startsWith('4')) return '+61' + d;
  return d;
}
function isTextableMobile(raw) { return /^\+614\d{8}$/.test(normalisePhone(raw) || ''); }
function samePhone(a, b) { const x = normalisePhone(a), y = normalisePhone(b); return !!x && x === y; }
function sel(v) { return v && typeof v === 'object' ? v.name : (v || ''); }
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || ''; }
function first1(v) { return Array.isArray(v) ? v[0] : v; }
function addDays(iso, n) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function minutesSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity; }
function melbClock(ms) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false }).formatToParts(new Date(ms || Date.now()));
  const p = t => (parts.find(x => x.type === t) || {}).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hour: parseInt(p('hour'), 10) % 24, minute: parseInt(p('minute'), 10), weekday: p('weekday') };
}
// Contacts hear from Alex Mon–Sat 9am–7pm, Sun 10am–6pm; the team any day 7am–9pm
function contactHours(c) { c = c || melbClock(); return c.weekday === 'Sun' ? (c.hour >= 10 && c.hour < 18) : (c.hour >= 9 && c.hour < 19); }
function teamHours(c) { c = c || melbClock(); return c.hour >= 7 && c.hour < 21; }
function melbToISO(local) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(local || '')) return null;
  const guess = new Date(local + ':00Z');
  const shown = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .format(guess).replace(', ', 'T').replace(/T24/, 'T00');
  const diff = guess.getTime() - new Date(shown + ':00Z').getTime();
  return new Date(guess.getTime() + diff).toISOString();
}
function melbWhen(iso) {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const p = t => (parts.find(x => x.type === t) || {}).value || '';
  return `${p('weekday')} ${p('day')} ${p('month')}, ${p('hour')}:${p('minute')}${p('dayPeriod').toLowerCase()}`; // "Thu 12 Nov, 2:00pm"
}
function stamp() { const c = melbClock(); return `${Number(c.date.slice(8, 10))}/${Number(c.date.slice(5, 7))} ${c.hour % 12 || 12}:${String(c.minute).padStart(2, '0')}${c.hour < 12 ? 'am' : 'pm'}`; }
// Plain SMS characters only (one curly quote switches the whole text to Unicode)
function plainSMS(t) {
  return String(t || '').replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/\s*[–—―]\s*/g, ' - ').replace(/…/g, '...').replace(/[   ]/g, ' ').replace(/ {2,}/g, ' ').trim();
}

// ---------------------------------------------------------------- Airtable REST
async function at(method, path, body) {
  const res = await fetch('https://api.airtable.com/v0/' + BASE + '/' + path, {
    method, headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Airtable ' + method + ' ' + path + ' ' + res.status + ': ' + JSON.stringify(json));
  return json;
}
async function listAll(table, params) {
  let out = [], offset;
  do {
    const q = new URLSearchParams(Object.assign({ returnFieldsByFieldId: 'true', pageSize: '100' }, params || {}));
    if (offset) q.set('offset', offset);
    const r = await at('GET', table + '?' + q.toString());
    out = out.concat(r.records || []); offset = r.offset;
  } while (offset);
  return out;
}
async function getRecord(table, id) { return at('GET', table + '/' + id + '?returnFieldsByFieldId=true'); }
async function createRecord(table, fields) { return (await at('POST', table + '?returnFieldsByFieldId=true', { records: [{ fields }], typecast: true })).records[0]; }
async function updateRecord(table, id, fields) { return at('PATCH', table + '?returnFieldsByFieldId=true', { records: [{ id, fields }], typecast: true }); }

let teamCache = { at: 0, rows: [] };
async function teamRows() {
  if (Date.now() - teamCache.at < 5 * 60000 && teamCache.rows.length) return teamCache.rows;
  teamCache = { at: Date.now(), rows: await listAll(T.team) };
  return teamCache.rows;
}
async function teamById(id) { return id ? (await teamRows()).find(t => t.id === id) || null : null; }
async function teamByPhone(from) { return (await teamRows()).find(t => samePhone(t.fields[TM.mobile], from)) || null; }
async function teamByName(re) { return (await teamRows()).find(t => re.test(String(t.fields[TM.name] || ''))) || null; }
const tFirst = t => t ? (t.fields[TM.first] || firstName(t.fields[TM.name])) : '';
function approverMobile() { return normalisePhone(process.env.APPROVER_MOBILE); }

async function sendSMS(to, body) {
  const msg = await twilioClient.messages.create({ from: process.env.ALEX_PHONE_NUMBER, to: normalisePhone(to), body: plainSMS(body) });
  return msg.sid;
}
async function claudeJSON(system, user, maxTokens) {
  const r = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens || 700, system, messages: [{ role: 'user', content: user }] });
  const text = r.content.map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON from Claude: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

// ---------------------------------------------------------------- a request "job": load, change, save once
function getState(rec) { try { return JSON.parse(rec.fields[R.state] || '{}') || {}; } catch (e) { return {}; } }
async function load(rec) {
  if (typeof rec === 'string') rec = await getRecord(T.req, rec);
  const f = rec.fields;
  const job = { id: rec.id, f, st: getState(rec), upd: {}, lines: [], type: sel(f[R.type]), status: sel(f[R.status]), code: f[R.code] || ('R' + (f[R.no] || '')) };
  job.agent = await teamById(first1(f[R.agent]));
  job.by = await teamById(first1(f[R.by]));
  job.contact = f[R.contact] && f[R.contact][0] ? await getRecord(T.contacts, f[R.contact][0]).catch(() => null) : null;
  job.cName = job.contact ? job.contact.fields[C.name] || '' : '';
  job.cFirst = firstName(job.cName) || 'there';
  job.mobile = job.contact ? job.contact.fields[C.mobile] : '';
  job.aFirst = tFirst(job.agent) || 'our agent';
  return job;
}
function setStatus(job, s) { job.status = s; job.upd[R.status] = s; if (['Done', 'Cancelled', 'Needs agent'].includes(s)) job.upd[R.closedAt] = new Date().toISOString(); }
function note(job, who, text) { job.lines.push(`${stamp()} ${who}: ${String(text).replace(/\s+/g, ' ').trim()}`); }
async function save(job) {
  if (job.lines.length) job.upd[R.convo] = ((job.f[R.convo] ? job.f[R.convo] + '\n' : '') + job.lines.join('\n')).slice(-90000);
  job.upd[R.state] = JSON.stringify(job.st);
  await updateRecord(T.req, job.id, job.upd);
  if (job.lines.length) job.f[R.convo] = job.upd[R.convo];
  job.upd = {}; job.lines = [];
}

// Texts to the contact go now in contact hours, otherwise queued for the morning
async function textContact(job, text, purpose) {
  text = plainSMS(text);
  if (!isTextableMobile(job.mobile)) throw new Error('no mobile');
  if (contactHours()) {
    await sendSMS(job.mobile, text);
    job.upd[R.lastContact] = new Date().toISOString();
    job.st.lastOutAt = new Date().toISOString();
    note(job, 'Alex → ' + job.cFirst, text);
  } else {
    (job.st.outbox = job.st.outbox || []).push({ text, purpose: purpose || '' });
    note(job, 'Alex → ' + job.cFirst + ' (queued for the morning)', text);
  }
}
async function textTeam(job, member, text) {
  if (!member) return false;
  const to = isTextableMobile(member.fields[TM.mobile]) ? member.fields[TM.mobile] : approverMobile();
  if (!to) return false;
  text = plainSMS(text);
  if (teamHours() && await away.awayInfo(member)) { note(job, 'Alex → cover for ' + tFirst(member), text); await away.routeAgentText(member, text, sendSMS); return true; }
  if (teamHours()) { try { await sendSMS(to, text); } catch (e) { console.error('Alex requests: team text failed', e.message); } }
  else (job.st.teamOutbox = job.st.teamOutbox || []).push({ to, text });
  note(job, 'Alex → ' + tFirst(member), text);
  return true;
}
// Who confirms a document arrived: the person it's going to
async function receiverOf(job) {
  const to = sel(job.f[R.sendTo]);
  if (to === 'Fiona') return (await teamByName(/^fiona\b/i)) || job.agent;
  if (to === 'Tammy') return (await teamByName(/^tammy\b/i)) || job.agent;
  return job.agent;
}
function requester(job) { return job.by && isTextableMobile(job.by.fields[TM.mobile]) ? job.by : job.agent; }

// ---------------------------------------------------------------- wording
function whereText(job, forContact) {
  const w = sel(job.f[R.where]);
  const addr = job.f[R.address] || job.st.listingAddr || '';
  if (w === 'Phone call') return forContact ? `${job.aFirst} will give you a call` : 'phone call';
  if (w === 'Video call') return forContact ? `on a video call (${job.aFirst} will send the link)` : 'video call';
  if (w === 'Their home') return addr ? `at ${addr}` : (forContact ? 'at your place' : 'at their home');
  if (w === 'The property') return addr ? `at ${addr}` : 'at the property';
  return `at our office, ${OFFICE}`;
}
function purposeText(job) {
  const p = sel(job.f[R.purpose]);
  return ({
    'AML / ID check': 'to go through the AML / ID check', 'Sign Section 32 / contract': 'to go through and sign the Section 32 / contract',
    'Sign the authority': 'to go through and sign the authority', 'Appraisal': 'for the appraisal', 'Listing presentation': 'to go through the listing presentation',
    'General catch-up': 'for a catch-up'
  })[p] || 'for a quick meeting';
}
function docText(job) { const d = sel(job.f[R.doc]); return (d === 'Other' || !d ? job.f[R.docDetail] : d + (job.f[R.docDetail] ? ' (' + job.f[R.docDetail] + ')' : '')) || 'the paperwork'; }
async function sendToText(job) {
  const to = sel(job.f[R.sendTo]);
  if (to === 'Drop in to the office') return `drop it in to our office at ${OFFICE}`;
  const r = await receiverOf(job);
  const em = r && r.fields[TM.email];
  return em ? `email it to ${tFirst(r)} at ${em}` : `send it through to ${tFirst(r) || 'us'}`;
}
const SYSTEM = "You write SMS messages as Alex, the assistant at Stone Real Estate Ballarat, texting a client on behalf of one of our team. " +
  "Tone: warm, plain Australian English, like a helpful person in a real estate office. 1-3 short sentences, at most one question, no exclamation marks unless natural, no emojis. " +
  "Never discuss price, value, offers, negotiation, commission, contract terms, or legal / financial advice. Never invent facts that are not in the request. " +
  "Never mention you are an AI unless asked. Sign off is not needed.";

async function draftOpening(job) {
  const facts = await requestFacts(job);
  const fallback = await fallbackOpening(job);
  try {
    const r = await claudeJSON(SYSTEM + ' Reply with JSON {"text": "..."} only.',
      `Write the FIRST text to ${job.cFirst} (they may not have texted Alex before, so say who you are: "Hi ${job.cFirst}, it's Alex from Stone Ballarat - I help ${job.aFirst} with ..."). ` +
      `Keep it under 320 characters.\n\nThe job:\n${facts}\n\nA good plain version for reference (improve on it, keep every fact): ${fallback}`, 400);
    const t = plainSMS(r.text || '');
    return t.length > 40 ? t.slice(0, 480) : fallback;
  } catch (e) { console.error('Alex requests: draft failed', e.message); return fallback; }
}
async function fallbackOpening(job) {
  const hi = `Hi ${job.cFirst}, it's Alex from Stone Ballarat - I help ${job.aFirst} with bookings.`;
  if (job.type === 'Meet the agent') {
    const w = sel(job.f[R.where]);
    const how = w === 'Phone call' ? 'a quick call' : w === 'Video call' ? 'a quick video call' : `a time to meet ${whereText(job, true)}`;
    return `${hi} ${job.aFirst} would like to find ${how} ${purposeText(job)}. What days and times suit you over the next week or so?`;
  }
  if (job.type === 'Chase a document') return `${hi} ${job.aFirst} still needs the ${docText(job)} - when you get a chance, could you ${await sendToText(job)}? Thanks.`;
  return `${hi} ${job.aFirst} asked me to check something with you: ${String(job.f[R.question] || '').trim()}`;
}
async function requestFacts(job) {
  const L = [`Type: ${job.type}`, `Agent: ${job.agent ? job.agent.fields[TM.name] : ''} (first name ${job.aFirst})`, `Contact: ${job.cName}`];
  if (job.f[R.briefText]) L.push(`What the team member wants (their words): ${job.f[R.briefText]}`);
  if (job.type === 'Meet the agent') {
    L.push(`Purpose: ${sel(job.f[R.purpose]) || 'meeting'}`, `Where: ${whereText(job, true)}`, `Length: ${job.f[R.minutes] || 30} minutes`, `Book within: ${job.f[R.within] || 7} days`);
    if (job.f[R.prefer]) L.push(`Preferred times (agent): ${job.f[R.prefer]}`);
    if (job.f[R.bring]) L.push(`Ask them to bring: ${job.f[R.bring]}`);
  }
  if (job.type === 'Chase a document') L.push(`Document needed: ${docText(job)}`, `How to send it: ${await sendToText(job)}`);
  if (job.type === 'Ask a question') L.push(`Question to ask: ${job.f[R.question] || ''}`);
  if (job.f[R.replyBy]) L.push(`Needed by: ${job.f[R.replyBy]}`);
  const aw = job.agent ? await away.awayInfo(job.agent) : null;
  if (aw) L.push(`${job.aFirst} is on leave until ${aw.until} (back ${aw.back}) - any meeting must be on or after ${aw.back}.`);
  else if (job.agent && job.agent.fields['fldS5Xjx0ZZ4vknFO'] && job.agent.fields['fldS5Xjx0ZZ4vknFO'] > melbClock().date) L.push(`${job.aFirst} is on leave ${job.agent.fields['fldS5Xjx0ZZ4vknFO']} to ${job.agent.fields['fldVaVBBXJQvKLvBm']} - no meetings on those days.`);
  return L.join('\n');
}

// ---------------------------------------------------------------- calendar (Outlook via Microsoft Graph, when set up)
function calendarEnabled() { return !!(process.env.MS_TENANT_ID && process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET); }
let graphTok = { at: 0, token: '' };
async function graph(method, path, body) {
  if (!graphTok.token || Date.now() - graphTok.at > 50 * 60000) {
    const res = await fetch(`https://login.microsoftonline.com/${process.env.MS_TENANT_ID}/oauth2/v2.0/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: process.env.MS_CLIENT_ID, client_secret: process.env.MS_CLIENT_SECRET, scope: 'https://graph.microsoft.com/.default', grant_type: 'client_credentials' })
    });
    const j = await res.json(); if (!res.ok) throw new Error('Graph token failed');
    graphTok = { at: Date.now(), token: j.access_token };
  }
  const res = await fetch('https://graph.microsoft.com/v1.0' + path, { method, headers: { Authorization: 'Bearer ' + graphTok.token, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Graph ' + res.status);
  return j;
}
const utc = iso => new Date(iso).toISOString().slice(0, 19);
async function busyFor(agent, days) {
  const email = agent && agent.fields[TM.email];
  if (!calendarEnabled() || !email) return [];
  try {
    const j = await graph('POST', `/users/${encodeURIComponent(email)}/calendar/getSchedule`, {
      schedules: [email], startTime: { dateTime: utc(Date.now()), timeZone: 'UTC' }, endTime: { dateTime: utc(Date.now() + (days || 14) * 864e5), timeZone: 'UTC' }, availabilityViewInterval: 30
    });
    return (((j.value || [])[0] || {}).scheduleItems || []).filter(i => i.status !== 'free').map(i => ({ start: i.start.dateTime + 'Z', end: i.end.dateTime + 'Z' }));
  } catch (e) { console.error('Alex requests: calendar read failed', e.message); return []; }
}
async function addToCalendar(job, iso) {
  const email = job.agent && job.agent.fields[TM.email];
  if (!calendarEnabled() || !email) return '';
  try {
    const mins = job.f[R.minutes] || 30;
    await graph('POST', `/users/${encodeURIComponent(email)}/events`, {
      subject: `${sel(job.f[R.purpose]) || 'Meeting'} – ${job.cName}`,
      start: { dateTime: utc(iso), timeZone: 'UTC' }, end: { dateTime: utc(new Date(iso).getTime() + mins * 60000), timeZone: 'UTC' },
      location: { displayName: whereText(job, false).replace(/^at /, '') },
      body: { contentType: 'text', content: [`${job.cName} · ${job.mobile || ''}`, job.f[R.briefText] || '', job.f[R.bring] ? 'Bringing: ' + job.f[R.bring] : '', `Booked by Alex (${job.code}).`].filter(Boolean).join('\n') }
    });
    return ' Added to your Outlook calendar.';
  } catch (e) { console.error('Alex requests: calendar add failed', e.message); return " (Couldn't add it to your Outlook calendar - please add it.)"; }
}
const overlaps = (s, e, b) => new Date(s) < new Date(b.end) && new Date(e) > new Date(b.start);
// Keep options that are 2h+ away, inside the booking window, Mon–Sat 8am–6pm, clear of the calendar
async function cleanOptions(job, locals) {
  const busy = await busyFor(job.agent, (job.f[R.within] || 7) + 7);
  const mins = job.f[R.minutes] || 30;
  const aw = await away.awayInfo(job.agent);
  const lastDay = addDays(aw ? aw.back : melbClock().date, Math.max(2, (job.f[R.within] || 7) + 3));
  const out = [], seen = new Set();
  for (const loc of locals || []) {
    const iso = melbToISO(loc);
    if (!iso || seen.has(iso) || Date.parse(iso) < Date.now() + 2 * 3600000) continue;
    const day = loc.slice(0, 10), hhmm = loc.slice(11);
    if (day > lastDay || new Date(day + 'T00:00:00Z').getUTCDay() === 0 || hhmm < '08:00' || hhmm > '18:00') continue;
    if (job.agent && away.awayOnRecord(await teamById(job.agent.id), day)) continue; // agent on leave that day
    const end = new Date(Date.parse(iso) + mins * 60000).toISOString();
    if (busy.some(b => overlaps(new Date(Date.parse(iso) - 15 * 60000).toISOString(), end, b))) continue;
    seen.add(iso); out.push(iso);
    if (out.length >= 3) break;
  }
  return out;
}
const optionsText = isos => isos.map((iso, i) => `${i + 1} - ${melbWhen(iso)}`).join(' / ');

// ---------------------------------------------------------------- starting a request
async function start(job) {
  if (!job.contact) { await handBack(job, 'no contact picked on the request', null); return; }
  if (job.contact.fields[C.dnc]) { await handBack(job, `${job.cName} is marked Do Not Contact`, null); return; }
  if (!isTextableMobile(job.mobile)) { await handBack(job, `${job.cName} has no mobile Alex can text`, null); return; }
  if (job.type === 'Ask a question' && !String(job.f[R.question] || '').trim()) { await handBack(job, 'the question was left blank', null); return; }
  if (job.f[R.listing] && job.f[R.listing][0]) { try { job.st.listingAddr = (await getRecord(T.listings, job.f[R.listing][0])).fields[LST.addr] || ''; } catch (e) { } }
  const text = await draftOpening(job);
  job.st.opening = text; job.upd[R.draft] = text;
  if (!job.upd[R.title] && !job.f[R.title]) job.upd[R.title] = `${job.type} – ${job.cName}`;
  if (sel(job.f[R.first]) !== 'Send straight away') {
    setStatus(job, 'Awaiting approval');
    const who = requester(job);
    job.st.approvalAt = new Date().toISOString();
    await textTeam(job, who, `${job.code} - ${job.type} for ${job.aFirst} with ${job.cName} (${job.mobile}). I'd send:\n"${text}"\nReply ${job.code} YES to send, ${job.code} EDIT followed by your wording, or ${job.code} NO.`);
  } else {
    setStatus(job, 'Contacting');
    await textContact(job, text, 'opening');
  }
}
async function sendOpening(job, text) {
  setStatus(job, 'Contacting');
  await textContact(job, text || job.st.opening, 'opening');
  job.st.nudges = 0;
}

// ---------------------------------------------------------------- hand back to the agent
async function handBack(job, reason, contactMsg, extra) {
  if (contactMsg) { try { await textContact(job, contactMsg); } catch (e) { } }
  setStatus(job, 'Needs agent');
  job.upd[R.outcome] = ((job.f[R.outcome] ? job.f[R.outcome] + '\n' : '') + `Handed back: ${reason}`).trim();
  const notes = [`Alex handed this back (${job.code}): ${reason}.`, extra || '', '', `Contact: ${[job.cName, job.mobile, job.contact && job.contact.fields[C.email]].filter(Boolean).join(' · ')}`,
    `Request: ${job.type}${job.f[R.briefText] ? ' – ' + job.f[R.briefText] : ''}`, '', 'Conversation:', (job.f[R.convo] || '') + (job.lines.length ? '\n' + job.lines.join('\n') : '')].join('\n').slice(0, 9000);
  await makeTask(job, `${job.code} over to you: ${job.type.toLowerCase()} – ${job.cName || 'contact'}`, melbClock().date, notes, 'High');
  const msg = `${job.code} - over to you: ${reason}.${job.mobile ? ' ' + job.cName + ' ' + job.mobile + '.' : ''}${extra ? ' ' + extra : ''} It's in My Tasks.`;
  await textTeam(job, job.agent, msg);
  if (job.by && job.agent && job.by.id !== job.agent.id) await textTeam(job, job.by, `${job.code} (${job.cName}) has gone back to ${job.aFirst}: ${reason}.`);
  await logActivity(job, `Alex request ${job.code} handed back – ${reason}`);
}
async function makeTask(job, title, due, notes, prio) {
  const f = { [TK.task]: title.slice(0, 250), [TK.due]: due, [TK.status]: 'Open', [TK.source]: 'Alex', [TK.notes]: notes, [TK.prio]: prio || 'Medium' };
  if (job.agent) f[TK.assigned] = [job.agent.id];
  if (job.contact) f[TK.with] = [job.contact.id];
  if (job.f[R.opp] && job.f[R.opp][0]) f[TK.opp] = [job.f[R.opp][0]];
  if (job.f[R.brief] && job.f[R.brief][0]) f[TK.brief] = [job.f[R.brief][0]];
  try { const t = await createRecord(T.tasks, f); job.upd[R.task] = [...new Set([...(job.f[R.task] || []), t.id])]; job.f[R.task] = job.upd[R.task]; return t; }
  catch (e) { console.error('Alex requests: task failed', e.message); return null; }
}
async function logActivity(job, summary) {
  try {
    const f = { [A.summary]: summary.slice(0, 250), [A.kind]: 'Note', [A.type]: 'SMS', [A.author]: 'Alex', [A.actType]: 'Text message', [A.detail]: ((job.f[R.convo] || '') + '\n' + job.lines.join('\n')).trim().slice(-8000) };
    if (job.agent) f[A.agent] = [job.agent.id];
    if (job.contact) f[A.contact] = [job.contact.id];
    if (job.f[R.opp] && job.f[R.opp][0]) f[A.lead] = [job.f[R.opp][0]];
    if (job.f[R.brief] && job.f[R.brief][0]) f[A.brief] = [job.f[R.brief][0]];
    await createRecord(T.activity, f);
  } catch (e) { console.error('Alex requests: activity log failed', e.message); }
}
async function finish(job, outcome, summary) {
  setStatus(job, 'Done');
  job.upd[R.outcome] = ((job.f[R.outcome] ? job.f[R.outcome] + '\n' : '') + outcome).trim();
  await logActivity(job, summary || `Alex request ${job.code} done – ${outcome}`);
}

// ---------------------------------------------------------------- meeting: confirm a time with both sides
async function confirmMeeting(job, iso) {
  const bring = String(job.f[R.bring] || '').trim();
  const rescheduled = !!job.f[R.confirmed];
  await textContact(job, `All set ${job.cFirst} - ${sel(job.f[R.where]) === 'Phone call' ? `${job.aFirst} will give you a call ${melbWhen(iso)}` : `${job.aFirst} will see you ${melbWhen(iso)} ${whereText(job, true)}`}${sel(job.f[R.where]) === 'Our office' || !sel(job.f[R.where]) ? ',' : ''} ${purposeText(job)}.${bring ? ' Please bring ' + bring.replace(/\.$/, '') + '.' : ''} If anything changes, just reply here.`, 'confirm');
  job.upd[R.confirmed] = iso; job.f[R.confirmed] = iso;
  delete job.st.options; delete job.st.proposed; job.st.reminded = false; job.st.confirmedAt = new Date().toISOString();
  setStatus(job, 'Confirmed');
  const cal = await addToCalendar(job, iso);
  await makeTask(job, `${sel(job.f[R.purpose]) || 'Meeting'} with ${job.cName} – ${melbWhen(iso)}`, melbClock(Date.parse(iso)).date,
    [`Booked by Alex (${job.code})${rescheduled ? ' – rescheduled' : ''}: ${melbWhen(iso)}, ${whereText(job, false)}.`, job.f[R.briefText] || '', bring ? 'Bringing: ' + bring : '', `Contact: ${job.cName} · ${job.mobile}`].filter(Boolean).join('\n'), 'Medium');
  await textTeam(job, job.agent, `${job.code} confirmed with ${job.cName}: ${melbWhen(iso)}, ${whereText(job, false)}.${cal} It's in your My Tasks.`);
  if (job.by && job.agent && job.by.id !== job.agent.id) await textTeam(job, job.by, `${job.code} - ${job.cName} is booked with ${job.aFirst} ${melbWhen(iso)}.`);
  job.upd[R.outcome] = ((job.f[R.outcome] ? job.f[R.outcome] + '\n' : '') + `Confirmed ${melbWhen(iso)}`).trim();
}
async function offerToAgent(job, isos, said) {
  job.st.options = isos; job.st.offeredAt = new Date().toISOString(); job.st.agentReminded = false;
  job.upd[R.proposed] = isos.map((iso, i) => `${i + 1}. ${melbWhen(iso)}`).join('\n');
  setStatus(job, 'Waiting on agent');
  await textTeam(job, job.agent, `${job.code} - ${job.cName} can do: ${optionsText(isos)} (${sel(job.f[R.purpose]) || 'meeting'}, ${whereText(job, false)}).${said ? ' They said: "' + said.slice(0, 120) + '".' : ''}\nReply ${job.code} 1, 2 or 3, ${job.code} followed by another time, or ${job.code} CALL to take it over.`);
}

// ---------------------------------------------------------------- reading the contact's reply
async function readReply(job, text) {
  const c = melbClock();
  const busy = job.type === 'Meet the agent' ? await busyFor(job.agent, (job.f[R.within] || 7) + 7) : [];
  const facts = await requestFacts(job);
  const convo = String(job.f[R.convo] || '').split('\n').slice(-14).join('\n');
  const intents = {
    'Meet the agent': 'availability (they gave days/times that suit) | accept (they agree to the time Alex proposed) | reject_time (the proposed time does not suit) | vague (they want to meet but no usable times yet) | reschedule (a confirmed time needs to change) | cancel_meeting (they cancel / no longer need it)',
    'Chase a document': 'sent (they say they have sent / dropped it off) | will_send (they will send it, maybe by a date) | cant_provide (they cannot or will not provide it, or need help getting it)',
    'Ask a question': 'answered (they answered the question, fully or mostly) | partial (they answered part and need follow-up from the agent)'
  }[job.type];
  const r = await claudeJSON(SYSTEM + ' You read a client\'s SMS reply and decide what Alex does next. Reply with JSON only.',
    `Today is ${c.weekday} ${c.date}, ${c.hour}:${String(c.minute).padStart(2, '0')} in Ballarat.\nThe job:\n${facts}\n` +
    (job.st.proposed ? `Alex proposed this time to them: ${job.st.proposed.local}\n` : '') + (job.f[R.confirmed] ? `Already confirmed: ${melbWhen(job.f[R.confirmed])}\n` : '') +
    (busy.length ? `${job.aFirst} is busy at (UTC): ${busy.slice(0, 20).map(b => b.start + '–' + b.end).join('; ')}\n` : '') +
    `Recent conversation:\n${convo}\n\nTheir new reply: "${text}"\n\n` +
    `Pick "intent" from: ${intents} | stop (asks not to be texted / opt out) | unhappy (upset or complaining) | wants_agent (asks for ${job.aFirst} to call, or wants to talk to a person) | question_for_agent (asks about price, offers, the contract, legal or finance, or anything Alex can't answer from the job) | other (anything else, e.g. small talk or "thanks").\n` +
    `Return {"intent": "...", "reply": "Alex's SMS back to them (empty if none needed)", "options": ["YYYY-MM-DDTHH:MM", ...], "answer": "their answer in their own words (Ask a question only)", "send_by": "YYYY-MM-DD or empty", "summary": "one line for the agent"}.\n` +
    `For availability / vague / reject_time: options = up to 3 specific local Ballarat times that match what they said, Mon-Sat 8:00-17:30 on the hour or half hour, within the booking window, clear of the busy times. If no usable times, intent "vague" and reply asks for a day and time that suits. ` +
    `For availability the reply says thanks and that you'll check with ${job.aFirst} and confirm shortly (never promise a time). For stop / unhappy / wants_agent / question_for_agent the reply is short and says you'll get ${job.aFirst} to call (for stop: "No worries, I'll leave it there."). Never give price or legal opinions.`, 700);
  r.intent = String(r.intent || 'other').toLowerCase();
  r.reply = plainSMS(r.reply || '');
  r.options = Array.isArray(r.options) ? r.options : [];
  return r;
}

async function onContactReply(job, text) {
  note(job, job.cFirst + ' → Alex', text);
  job.st.lastInAt = new Date().toISOString();
  job.st.nudges = 0;
  let r;
  try { r = await readReply(job, text); } catch (e) {
    console.error('Alex requests: read failed', e.message);
    await textTeam(job, job.agent, `${job.code} - ${job.cName} replied: "${text.slice(0, 200)}". I couldn't read it - can you take a look? Reply ${job.code} CALL to take over.`);
    return;
  }
  const say = async t => { if (t) await textContact(job, t); };
  // things that always go back to the agent
  if (r.intent === 'stop') {
    await say(r.reply || "No worries, I'll leave it there.");
    try { await updateRecord(T.contacts, job.contact.id, { [C.dnc]: true, [C.optedOn]: melbClock().date }); } catch (e) { }
    setStatus(job, 'Cancelled');
    await textTeam(job, job.agent, `${job.code} - ${job.cName} asked not to be texted ("${text.slice(0, 120)}"). I've stopped and marked them Do Not Contact.`);
    await logActivity(job, `Alex request ${job.code} stopped – ${job.cName} opted out`);
    return;
  }
  if (['unhappy', 'wants_agent', 'question_for_agent'].includes(r.intent)) {
    const why = { unhappy: 'they seem unhappy', wants_agent: 'they want to talk to you', question_for_agent: "they've asked something only you should answer" }[r.intent];
    await handBack(job, why, r.reply || `Thanks ${job.cFirst}, I'll get ${job.aFirst} to give you a call.`, `They said: "${text.slice(0, 200)}"`);
    return;
  }
  if (job.type === 'Meet the agent') return meetingReply(job, text, r, say);
  if (job.type === 'Chase a document') return chaseReply(job, text, r, say);
  return questionReply(job, text, r, say);
}

async function meetingReply(job, text, r, say) {
  if (job.status === 'Confirmed' && (r.intent === 'reschedule' || r.intent === 'availability' || r.intent === 'reject_time')) {
    job.st.reschedules = (job.st.reschedules || 0) + 1;
    if (job.st.reschedules > 1) { await handBack(job, `${job.cFirst} wants to change the time again (was ${melbWhen(job.f[R.confirmed])})`, `No problem ${job.cFirst}, I'll get ${job.aFirst} to call you to sort out a new time.`, `They said: "${text.slice(0, 160)}"`); return; }
    await textTeam(job, job.agent, `${job.code} - heads up, ${job.cName} needs to move ${melbWhen(job.f[R.confirmed])}. I'm finding a new time.`);
  }
  if (r.intent === 'cancel_meeting') { await handBack(job, `${job.cFirst} cancelled / doesn't need the meeting`, r.reply || `No worries ${job.cFirst}, I'll let ${job.aFirst} know.`, `They said: "${text.slice(0, 160)}"`); return; }
  if (r.intent === 'accept' && job.st.proposed) { await confirmMeeting(job, job.st.proposed.iso); return; }
  if (['availability', 'reschedule', 'reject_time', 'vague'].includes(r.intent)) {
    const isos = await cleanOptions(job, r.options);
    if (isos.length) { await say(r.reply || `Thanks ${job.cFirst}, I'll check with ${job.aFirst} and confirm a time shortly.`); await offerToAgent(job, isos, text); return; }
    job.st.rounds = (job.st.rounds || 0) + 1;
    if (job.st.rounds > 3) { await handBack(job, `couldn't land on a time after a few goes`, `Thanks ${job.cFirst}, I'll get ${job.aFirst} to call you to find a time.`, `Last reply: "${text.slice(0, 160)}"`); return; }
    if (job.status !== 'Confirmed') setStatus(job, 'Contacting');
    await say(r.reply || `Thanks ${job.cFirst} - what day and time suits you best over the next week?`);
    return;
  }
  // thanks / small talk
  if (r.reply && job.status !== 'Confirmed') await say(r.reply);
  else if (job.status === 'Confirmed' && !/^(thanks|thank you|ta|cheers|ok|okay|great|perfect|👍)/i.test(text.trim())) await textTeam(job, job.agent, `${job.code} - ${job.cName} replied: "${text.slice(0, 200)}"`);
}

async function chaseReply(job, text, r, say) {
  if (r.intent === 'sent') {
    const rec = await receiverOf(job);
    job.st.claimedAt = new Date().toISOString(); job.st.receiverId = rec && rec.id;
    setStatus(job, 'Waiting on agent');
    await say(r.reply || `Thanks ${job.cFirst}, I'll let ${tFirst(rec) || job.aFirst} know to look out for it.`);
    await textTeam(job, rec, `${job.code} - ${job.cName} says they've sent the ${docText(job)}. Reply ${job.code} GOT IT once you have it, or ${job.code} NOT YET if it hasn't arrived.`);
    return;
  }
  if (r.intent === 'will_send') {
    const by = /^\d{4}-\d{2}-\d{2}$/.test(r.send_by || '') ? r.send_by : null;
    job.st.nextChaseOn = by ? addDays(by, 1) : null;
    await say(r.reply || `Thanks ${job.cFirst}, appreciate it.`);
    job.upd[R.outcome] = ((job.f[R.outcome] ? job.f[R.outcome] + '\n' : '') + `${stamp()} said they'll send it${by ? ' by ' + by : ''}`).trim();
    return;
  }
  if (r.intent === 'cant_provide') { await handBack(job, `${job.cFirst} can't provide the ${docText(job)} as asked`, r.reply || `Thanks ${job.cFirst}, I'll get ${job.aFirst} to give you a call about it.`, `They said: "${text.slice(0, 200)}"`); return; }
  if (r.reply) await say(r.reply);
}

async function questionReply(job, text, r, say) {
  if (r.intent === 'answered' || r.intent === 'partial') {
    const ans = String(r.answer || text).trim();
    const to = sel(job.f[R.answerTo]) || 'Text the agent';
    await say(r.reply || `Thanks ${job.cFirst}, I'll pass that on to ${job.aFirst}.`);
    if (to !== 'Save to contact notes') await textTeam(job, job.agent, `${job.code} - ${job.cName}'s answer to "${String(job.f[R.question] || '').slice(0, 100)}": "${text.slice(0, 300)}"${r.intent === 'partial' ? ' (they may need a follow-up from you)' : ''}`);
    if (to !== 'Text the agent' && job.contact) {
      try { await updateRecord(T.contacts, job.contact.id, { [C.know]: ((job.contact.fields[C.know] || '') + `\n${melbClock().date} (${job.code}) Q: ${job.f[R.question] || ''} A: ${ans}`).trim() }); } catch (e) { }
    }
    if (r.intent === 'partial') { await handBack(job, 'they answered part of it and need a follow-up', null, `Answer: "${ans.slice(0, 200)}"`); job.upd[R.outcome] = `Answer: ${ans}`; return; }
    await finish(job, `Answer: ${ans}`, `Alex request ${job.code} – ${job.cName} answered: ${ans.slice(0, 120)}`);
    return;
  }
  if (r.reply) await say(r.reply);
}

// ---------------------------------------------------------------- the team's replies ("R12 …")
async function onTeamCommand(job, member, rest, fromPage) {
  const t = String(rest || '').trim();
  // from the Ask Alex page: no text back, the page shows the result
  const reply = async msg => { if (!fromPage) await sendSMS(member.fields[TM.mobile] || approverMobile(), msg); note(job, 'Alex → ' + tFirst(member), msg); };
  note(job, tFirst(member) + (fromPage ? ' (Ask Alex page)' : '') + ' → Alex', `${job.code} ${t}`);
  if (!t || /^(\?|status|where)$/i.test(t)) {
    await reply(`${job.code} ${job.type} with ${job.cName}: ${job.status}.${job.st.options && job.status === 'Waiting on agent' ? ' Options: ' + optionsText(job.st.options) + '.' : ''}${job.f[R.confirmed] ? ' Booked ' + melbWhen(job.f[R.confirmed]) + '.' : ''}`);
    return;
  }
  if (!OPEN.includes(job.status) && !/^(reopen)$/i.test(t)) { await reply(`${job.code} is already ${job.status.toLowerCase()}.`); return; }
  if (/^(no|cancel|stop|scrap)\b/i.test(t)) { setStatus(job, 'Cancelled'); await reply(`${job.code} cancelled - I won't text ${job.cName} about it again.`); await logActivity(job, `Alex request ${job.code} cancelled by ${tFirst(member)}`); return; }
  if (/^(call|take|mine|over to me)\b/i.test(t)) { setStatus(job, 'Needs agent'); job.upd[R.outcome] = ((job.f[R.outcome] || '') + `\n${tFirst(member)} took it over`).trim(); await reply(`OK, ${job.code} is yours - I've stopped.`); return; }
  if (job.status === 'Awaiting approval') {
    if (/^(yes|y|ok|okay|send|go|approved?)\b/i.test(t)) { await sendOpening(job, job.st.opening); await reply(`Sent to ${job.cName}${contactHours() ? '' : ' (going out in the morning)'}.`); return; }
    const m = t.match(/^edit\s+([\s\S]+)/i);
    if (m) { job.st.opening = plainSMS(m[1]); await sendOpening(job, job.st.opening); await reply(`Sent your version to ${job.cName}${contactHours() ? '' : ' (going out in the morning)'}.`); return; }
    await reply(`Reply ${job.code} YES to send it, ${job.code} EDIT followed by your wording, or ${job.code} NO.`); return;
  }
  if (job.type === 'Chase a document') {
    if (/^(got it|got|received|done|yes|arrived|have it)\b/i.test(t)) {
      await textContact(job, `Thanks ${job.cFirst}, that's come through - all sorted.`);
      await finish(job, `${tFirst(member)} confirmed the ${docText(job)} arrived`);
      await reply(`Thanks - ${job.code} closed.`); return;
    }
    if (/^not\s*yet\b|^no\b/i.test(t)) {
      setStatus(job, 'Contacting');
      await textContact(job, `Hi ${job.cFirst}, the ${docText(job)} hasn't come through to us yet - could you please ${await sendToText(job)}? Thanks.`);
      job.st.claimedAt = null; job.st.lastChaseAt = new Date().toISOString();
      await reply(`OK, I've asked ${job.cFirst} to send it again.`); return;
    }
  }
  if (job.type === 'Ask a question') {
    const m = t.match(/^ask\s+([\s\S]+)/i);
    if (m) { job.upd[R.question] = ((job.f[R.question] || '') + '\nFollow-up: ' + m[1]).trim(); setStatus(job, 'Contacting'); await textContact(job, `Thanks ${job.cFirst} - ${job.aFirst} also asked: ${m[1]}`); await reply(`Asked ${job.cFirst}.`); return; }
  }
  if (job.type === 'Meet the agent') {
    const n = t.match(/^([123])\b/);
    if (n && job.st.options && job.st.options[+n[1] - 1]) {
      const iso = job.st.options[+n[1] - 1];
      if (Date.parse(iso) < Date.now() + 30 * 60000) { await reply(`That time has passed - reply ${job.code} with another time.`); return; }
      await confirmMeeting(job, iso); return;
    }
    if (/^none\b/i.test(t)) {
      setStatus(job, 'Contacting'); delete job.st.options;
      await textContact(job, `Hi ${job.cFirst}, unfortunately those times don't work for ${job.aFirst}. Are there any other days or times that would suit?`);
      await reply(`OK, I've asked ${job.cFirst} for other times.`); return;
    }
    // another time in the agent's words, e.g. "R12 thu 3pm"
    let local = null;
    try {
      const c = melbClock();
      const p = await claudeJSON('You turn a short time description into a local Ballarat date-time. Reply JSON only.', `Today is ${c.weekday} ${c.date}. Text: "${t}". Return {"local": "YYYY-MM-DDTHH:MM" or ""} (the next such day if only a weekday is given; empty if it isn't a time).`, 100);
      local = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(p.local || '') ? p.local : null;
    } catch (e) { }
    const iso = local && melbToISO(local);
    if (iso && Date.parse(iso) > Date.now() + 60 * 60000) {
      job.st.proposed = { local, iso }; delete job.st.options;
      setStatus(job, 'Contacting');
      await textContact(job, `Hi ${job.cFirst}, would ${melbWhen(iso)} suit to meet with ${job.aFirst}?`);
      await reply(`OK, I've asked ${job.cFirst} if ${melbWhen(iso)} works.`); return;
    }
  }
  await reply(`Sorry, I didn't follow. For ${job.code}: ${job.type === 'Meet the agent' ? `${job.code} 1/2/3, ${job.code} <another time>, ${job.code} NONE, ` : job.type === 'Chase a document' ? `${job.code} GOT IT, ${job.code} NOT YET, ` : `${job.code} ASK <follow-up question>, `}${job.code} CALL or ${job.code} CANCEL.`);
}

// ---------------------------------------------------------------- inbound routing (called from alex.js)
const CODE_RE = /^\s*R\s?(\d{1,5})\b[\s:,.-]*([\s\S]*)$/i;
async function requestByNo(no) { const recs = await listAll(T.req, { filterByFormula: `{${R.no}}=${Number(no)}` }); return recs[0] || null; }

async function handleTeamSMS(from, body) {
  if (!enabled()) return false;
  const m = String(body || '').match(CODE_RE);
  if (!m) return false;
  const member = await teamByPhone(from);
  if (!member && !samePhone(from, approverMobile())) return false;
  const who = member || { id: 'approver', fields: { [TM.name]: 'Stu', [TM.mobile]: from } };
  const rec = await requestByNo(m[1]);
  if (!rec) { await sendSMS(from, `I can't find request R${m[1]}.`); return true; }
  const job = await load(rec);
  try { await onTeamCommand(job, who, m[2]); } finally { await save(job); }
  return true;
}

// Replies from a contact with a live request (or one closed in the last 2 days) belong here
async function findForContact(from) {
  const recs = await listAll(T.req, { filterByFormula: `OR(${OPEN.map(s => `{${R.status}}='${s}'`).join(',')},AND(OR({${R.status}}='Done',{${R.status}}='Needs agent'),IS_AFTER({${R.closedAt}},'${new Date(Date.now() - 2 * 864e5).toISOString()}')))` });
  const mine = recs.filter(r => (Array.isArray(r.fields[R.mobile]) ? r.fields[R.mobile] : [r.fields[R.mobile]]).some(m => samePhone(m, from)))
    .filter(r => sel(r.fields[R.status]) !== 'Awaiting approval' && sel(r.fields[R.status]) !== 'New');
  const live = r => OPEN.includes(sel(r.fields[R.status])) ? 1 : 0; // a live request beats one that has just closed
  mine.sort((a, b) => (live(b) - live(a)) || String(b.fields[R.lastContact] || '').localeCompare(String(a.fields[R.lastContact] || '')) || ((b.fields[R.no] || 0) - (a.fields[R.no] || 0)));
  return mine[0] || null;
}
async function handleContactSMS(from, body) {
  if (!enabled()) return false;
  const rec = await findForContact(from);
  if (!rec) return false;
  const text = String(body || '').trim();
  // a team member's own number only counts while Alex is mid-conversation with them (testing)
  if (await teamByPhone(from) && minutesSince(rec.fields[R.lastContact]) > 24 * 60) return false;
  const job = await load(rec);
  try {
    if (['Done', 'Needs agent'].includes(job.status)) {
      note(job, job.cFirst + ' → Alex', text);
      if (!/^(thanks|thank you|ta|cheers|ok|okay|great|perfect|will do|👍)[.! ]*$/i.test(text)) await textTeam(job, job.agent, `${job.code} - ${job.cName} replied: "${text.slice(0, 250)}"`);
    } else await onContactReply(job, text);
  } catch (e) { console.error('Alex requests: contact reply failed', e.message); }
  finally { await save(job); }
  return true;
}

// ---------------------------------------------------------------- the tick: start new requests, chase, remind, close
async function tick() {
  if (!enabled()) return;
  const recs = await listAll(T.req, { filterByFormula: `OR(${OPEN.map(s => `{${R.status}}='${s}'`).join(',')},{${R.status}}='')` });
  for (const rec of recs) {
    let job;
    try {
      job = await load(rec);
      await step(job);
    } catch (e) { console.error('Alex requests: tick failed for ' + rec.id, e.message); }
    finally { if (job && (Object.keys(job.upd).length || job.lines.length || job.dirty)) { try { await save(job); } catch (e) { console.error('Alex requests: save failed', e.message); } } }
  }
}
async function step(job) {
  const c = melbClock();
  // queued texts
  if (job.st.outbox && job.st.outbox.length && contactHours(c) && isTextableMobile(job.mobile)) {
    for (const m of job.st.outbox) { await sendSMS(job.mobile, m.text); job.st.lastOutAt = new Date().toISOString(); job.upd[R.lastContact] = job.st.lastOutAt; }
    job.st.outbox = []; job.dirty = true;
  }
  if (job.st.teamOutbox && job.st.teamOutbox.length && teamHours(c)) {
    for (const m of job.st.teamOutbox) { try { await sendSMS(m.to, m.text); } catch (e) { } }
    job.st.teamOutbox = []; job.dirty = true;
  }
  // a button pressed on the Ask Alex page
  if (job.f[R.pageCmd]) {
    const cmd = String(job.f[R.pageCmd]); job.upd[R.pageCmd] = null;
    if (/^(no|cancel|stop|scrap)\b/i.test(cmd.trim()) && (!job.status || job.status === 'New')) { setStatus(job, 'Cancelled'); return; }
    if (job.status && job.status !== 'New') { await onTeamCommand(job, job.by || job.agent || { id: 'page', fields: { [TM.name]: 'Page' } }, cmd, true); return; }
  }
  if (!job.status || job.status === 'New') { if (teamHours(c)) await start(job); return; }
  if (job.status === 'Awaiting approval') {
    if (!job.st.approvalReminded && minutesSince(job.st.approvalAt) >= 180 && teamHours(c)) {
      job.st.approvalReminded = true; job.dirty = true;
      await textTeam(job, requester(job), `Reminder - ${job.code} (${job.type} with ${job.cName}) is waiting for your OK. Reply ${job.code} YES, ${job.code} EDIT <wording> or ${job.code} NO.`);
    }
    return;
  }
  // reply-by date passed
  if (job.f[R.replyBy] && job.f[R.replyBy] < c.date && ['Contacting', 'Waiting on agent'].includes(job.status)) { await handBack(job, `it's past the reply-by date (${job.f[R.replyBy]})`, null); return; }
  if (job.status === 'Contacting') {
    const since = minutesSince(job.st.lastOutAt || job.f[R.lastContact]);
    const quietSinceReply = !job.st.lastInAt || (job.st.lastOutAt && job.st.lastInAt < job.st.lastOutAt);
    if (!quietSinceReply || (job.st.outbox || []).length) return;
    if (job.type === 'Chase a document') {
      const every = Math.max(1, job.f[R.every] || 2) * 24 * 60;
      const max = job.f[R.maxChases] || 3;
      if (job.st.nextChaseOn && c.date < job.st.nextChaseOn) return;
      if (since >= every && contactHours(c)) {
        const n = (job.f[R.chases] || 0) + 1;
        if (n > max) { await handBack(job, `no ${docText(job)} after ${max} reminders`, null); return; }
        job.upd[R.chases] = n; job.st.nextChaseOn = null;
        await textContact(job, n === max
          ? `Hi ${job.cFirst}, just a last reminder from Alex at Stone Ballarat - ${job.aFirst} still needs the ${docText(job)}. Could you ${await sendToText(job)}? If there's a problem, just reply and I'll get ${job.aFirst} to call.`
          : `Hi ${job.cFirst}, a friendly reminder from Alex at Stone Ballarat - ${job.aFirst} still needs the ${docText(job)}. Could you ${await sendToText(job)} when you get a chance? Thanks.`);
      }
      return;
    }
    // meetings and questions: one nudge after a day, back to the agent after another day
    if ((job.st.nudges || 0) === 0 && since >= 24 * 60 && contactHours(c)) {
      job.st.nudges = 1;
      await textContact(job, job.type === 'Meet the agent'
        ? `Hi ${job.cFirst}, just following up for ${job.aFirst} - is there a day and time over the next week that suits ${purposeText(job)}?`
        : `Hi ${job.cFirst}, just following up for ${job.aFirst} on my earlier question when you have a moment: ${String(job.f[R.question] || '').trim().slice(0, 200)}`);
      return;
    }
    if ((job.st.nudges || 0) >= 1 && since >= 24 * 60 && teamHours(c)) { await handBack(job, `no reply from ${job.cFirst} after 2 texts`, null); return; }
    return;
  }
  if (job.status === 'Waiting on agent') {
    const ref = job.type === 'Meet the agent' ? job.st.offeredAt : job.st.claimedAt;
    if (!ref) return;
    const who = job.type === 'Meet the agent' ? job.agent : (await teamById(job.st.receiverId)) || job.agent;
    if (!job.st.agentReminded && minutesSince(ref) >= 120 && teamHours(c)) {
      job.st.agentReminded = true; job.dirty = true;
      await textTeam(job, who, job.type === 'Meet the agent'
        ? `Reminder - ${job.cName} is waiting on a time for ${job.code}: ${optionsText((job.st.options || []).filter(i => Date.parse(i) > Date.now()))}. Reply ${job.code} 1/2/3, another time, or ${job.code} CALL.`
        : `Reminder - did the ${docText(job)} from ${job.cName} arrive? Reply ${job.code} GOT IT or ${job.code} NOT YET.`);
      return;
    }
    if (job.type === 'Meet the agent' && job.st.agentReminded && minutesSince(ref) >= 6 * 60 && teamHours(c)) {
      await handBack(job, `${job.cName} has been waiting 6 hours for you to pick a time (${optionsText(job.st.options || [])})`, null); return;
    }
    if (job.type === 'Meet the agent' && (job.st.options || []).length && job.st.options.every(i => Date.parse(i) < Date.now() + 60 * 60000)) {
      setStatus(job, 'Contacting'); delete job.st.options;
      await textContact(job, `Hi ${job.cFirst}, sorry for the wait - those times have slipped by. What other days and times suit you to meet ${job.aFirst}?`);
    }
    return;
  }
  if (job.status === 'Confirmed') {
    const iso = job.f[R.confirmed];
    if (!iso) return;
    const mDay = melbClock(Date.parse(iso)).date;
    // reminder the day before, mid-morning (only if it was booked before today)
    if (!job.st.reminded && mDay === addDays(c.date, 1) && c.hour >= 10 && contactHours(c) && melbClock(Date.parse(job.st.confirmedAt || job.f[R.created] || Date.now())).date < c.date) {
      job.st.reminded = true;
      const bring = String(job.f[R.bring] || '').trim();
      await textContact(job, `Hi ${job.cFirst}, a reminder you're ${sel(job.f[R.where]) === 'Phone call' ? `chatting with ${job.aFirst} by phone` : `meeting ${job.aFirst} ${whereText(job, true)}`} tomorrow, ${melbWhen(iso)}.${bring ? ' Please bring ' + bring.replace(/\.$/, '') + '.' : ''} If anything has changed, just reply here.`);
      return;
    }
    if (Date.parse(iso) + 2 * 3600000 < Date.now()) await finish(job, `Meeting held ${melbWhen(iso)}`, `Alex request ${job.code} – arranged ${sel(job.f[R.purpose]) || 'meeting'} with ${job.cName} for ${job.aFirst} (${melbWhen(iso)})`);
  }
}

let timer = null;
function startTimer() {
  if (!enabled() || timer) return;
  timer = setInterval(() => { tick().catch(e => console.error('Alex requests tick error', e.message)); }, TICK_MINUTES * 60000);
  setTimeout(() => { tick().catch(e => console.error('Alex requests tick error', e.message)); }, 20000);
  console.log('Alex requests: on (every ' + TICK_MINUTES + ' min)');
}

module.exports = { start: startTimer, tick, handleTeamSMS, handleContactSMS, enabled, _internal: { load, save, step, onContactReply, onTeamCommand, cleanOptions, melbToISO } };
