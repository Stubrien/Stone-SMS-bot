// alex-buyers.js
// Alex <-> Airtable Buyer Management (Buyer Briefs, Buyer Matches, Market Listings, Buyer Check-ins).
// Follows the "Alex Buyer Messaging Playbook" (Claude Doc, signed off by Stu 29 Oct 2026).
//
// What it does
// - Inspection check-ins: texts the agent a HOLD check when people check in, then (60 min after an open,
//   2 hrs after a private) sends each buyer the first text unless the agent replied HOLD ALL / HOLD <names>
//   or ticked Agent Following Up. Not after 7:30pm (then 9:30am next day; Sundays 10am).
// - New buyer briefs (enquiry / coming-soon register → instantly, 24/7; phone / agent-added → next send window)
// - One follow-up nudge if a first text gets no reply (next day after 8am, or ~24 hrs later)
// - Agentbox import outreach campaign: approved briefs only, max 25 first texts a day, nudge day 3–4,
//   no reply by day 7 → Long-term
// - Buyer replies (any hour): understood with Claude, brief updated, one qualifying question at a time (price last),
//   agent tasks + alerts for offers / second looks / questions Alex can't answer, "not interested" clarifier,
//   STOP, bought flow, must-sell-first, neighbours, contract / Section 32 requests (email captured, agent task)
// - Nurture by tier on Next Send Date: curated list (max 3, Stone listings first) or a no-match touch point,
//   brief re-checks every 60 / 90 days, 3 unanswered → drop a tier
// - Events: instant match (≥70 outside listings, any Stone match) for Hot (Warm for Stone), coming-soon alerts,
//   price drops, under offer / sold notices
// - Safeguards: Alex Buyers Active per agent (pilot), Pause Buyer Texts per agent (PAUSE BUYERS / RESUME BUYERS),
//   Pause Alex / opted out per buyer, sending hours, caps (75/day total, 1/day + 2/week per buyer), no dollar figure
//   unless it matches the listing's Price Text exactly, same text never twice in 30 days, auto-pause on high opt-outs
// - Logging: every text in / out goes to Alex Messages with Audience = Buyer; 5pm summary to Stu; instant alerts
//   to Stu for STOP, complaints and send errors; urgent agent tasks not done in time escalate to Stu
//
// Env vars (shared with alex-leads.js): AIRTABLE_TOKEN, AIRTABLE_BASE, ANTHROPIC_API_KEY, TWILIO_ACCOUNT_SID,
//   TWILIO_AUTH_TOKEN, ALEX_PHONE_NUMBER, APPROVER_MOBILE (Stu), ALEX_MODEL
// New: ALEX_BUYERS_ENABLED ("true" to run the buyer ticks; replies are handled whenever it is "true")
//      BUYER_DAILY_CAP (default 75), BUYER_IMPORT_DAILY_CAP (default 25), BUYER_HOLIDAYS (extra YYYY-MM-DD, comma separated)
//      BUYERS_GO_LIVE (YYYY-MM-DD; briefs created before this date never get an automatic first text – default: 2 days ago)

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
let twilioClient = null;
function tw() { if (!twilioClient) twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN); return twilioClient; }

const BASE = process.env.AIRTABLE_BASE || 'apphczJpEh8x2EwQL';
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-4-6';
const TZ = 'Australia/Melbourne';
const DAILY_CAP = parseInt(process.env.BUYER_DAILY_CAP || '75', 10);
const IMPORT_DAILY_CAP = parseInt(process.env.BUYER_IMPORT_DAILY_CAP || '25', 10);
const BRIEF_PAGE = 'pag5FFQuKYFNJBXPx';   // Buyer Management → Brief Detail
const REVIEW_PAGE = 'pagLJaDLEUpqackix';  // Alex Messaging → Buyer Text Messages

const T = {
  briefs: 'tbl43WTbzYyauRMhd', contacts: 'tblWRqWCqXWP708dY', team: 'tbl1aNcrdwmamMyEF', messages: 'tbl78WnIpym0PEutf',
  matches: 'tblQ9Z4lvKpxjWkJL', listings: 'tblvJCPHTQBgdYGZu', checkins: 'tblANNW7LRvFFgMcD', inspections: 'tblTVym6dw3M8rt0Z',
  tasks: 'tblly5yaH9pTZrUXC', opps: 'tblrFYa8aQsLJkW13'
};
const B = {
  name: 'fldEmtwK9XFwcQ9M1', buyers: 'fldKRyZ83PSx8LJNq', agent: 'fldUGX7gB3zJJIJcF', status: 'fldXrAXCEFqm98MLV',
  tier: 'fldJ7usoWUqcvO4As', lock: 'fldAcq87PwGOvoRMI', suburbs: 'fldJZQwk5J404VtSl', pmin: 'fldpGpYh9fDe6sGZO',
  pmax: 'fld1ex4aZq9ot60aL', types: 'fldrHF7kGI9bslQ83', beds: 'fldQ17ko5Rfcmp4go', baths: 'fldt0uK81S8Auzq8Q',
  car: 'fldmBZAubyZAVKq1q', land: 'fldesqPORwtOayOpQ', must: 'fld9gGxXJjDnD6Yy0', other: 'fldmzubCGu7ujW9ze',
  breakers: 'fldvc3CTRK6cUqSBq', reason: 'fldlR2JjHQWcelq3q', finance: 'fldEif9eW0g8t1dxp', saleDep: 'fld2IqbQFD5QofxmW',
  timeframe: 'fldEGmedcp49GMYw2', sellOpp: 'fldNp20KOxTZKGgJr', nextSend: 'fld4WWBMw0StVNm9W', lastSent: 'fld56ZTZDLw3TGPAk',
  unanswered: 'fld8p9q70fWc3DSBp', lastReply: 'fldgkHju9nSB5g81T', checkedOn: 'fldrNwD8LsBxED4vt', pause: 'fldVcPWTSXlByDrUK',
  know: 'fldoO7YeFwZo0judE', source: 'fldn4d0wQDjxpmGhS', boughtAddr: 'fld5agQondpSuO1T5', settle: 'fldTu4kZHStcZC87c',
  through: 'fldP9mhab6VSd6Siu', notes: 'fldlTAcdUHJHjkQBK', created: 'fld1qKffhUxl7GmNX', matches: 'fld8rUrS7lDIAF0yH',
  state: 'fldgzAfAQQG4ogPu1', campaign: 'fldU9bnkjKJ5shc58', cStage: 'fldpydUaJkdGDTU0u', cOutcome: 'fldINgRo4UhHJZfOZ',
  approve: 'fldYwKAzSafqHRlzP', batch: 'fldIrX6E3Qp9fNCHz', following: 'fldVan9kErtWqqXqF'
};
const C = {
  name: 'fld5hDJRpN92YZnFx', mobile: 'fld0EA8biRz66il05', email: 'fldZW60VKGeM5Pc2u', agent: 'fldHsGhaiVWBnYX23',
  doNotContact: 'fldd9p4vMwi8R6Bx8', optedOut: 'fldKV1dvdkTd08Mgv', check: 'fld4WL1a2HptJT6N7', suburb: 'fldDtSnHpnYeksX3A',
  sellOpps: 'fldAy62nRYsgrM8rG', briefs: 'fldctz89pfrh0KeaX', types: 'fldTP7UpdXdwis53b', know: 'fldeg2ubhT2KCRR75'
};
const TM = {
  name: 'fldWZzjCL3xoU0l82', first: 'fldbxwqujqA0rygi9', mobile: 'fldUZ1RQT4BNOo41n', active: 'fld8McuiVqyHAYduE',
  buyersActive: 'fldVcSz2oIHrhKOw6', pauseBuyers: 'fldaMZPkpMWVcWVXW'
};
const M = {
  code: 'fldjLvmqFNFdlve4K', direction: 'fldAvlSCuVXNmw4AV', purpose: 'fldTZu3VVcNGVAoNf', status: 'fldItYMA0uRs9PGfg',
  draft: 'fldIXNAwcqOEqFpgT', finalText: 'fldlp8M5nnCECbygV', reasoning: 'fldJbwD7ZTChzFsUi', number: 'fld7buRBoFF8uw2E2',
  sentAt: 'fldD2PFGg841BiaQK', sid: 'fldNI4kd6kQB11mJM', error: 'fld5pF9AtokFDQVev', created: 'fldRowPux9k4y7f7f',
  audience: 'flditzq65DreFxtjk', brief: 'fldkqlBzGnzmVj8vh', match: 'fldpuh7IUoTGi5BPi', contact: 'fldBc1sVuEodOvCmM'
};
const MT = {
  name: 'fldcUWY60iBkz7oym', brief: 'fld8hEKHNklMaEnOB', listing: 'fldSdPAw8fz58y2cq', score: 'fldUhe1yZVGfjUtme',
  why: 'fldQKMQt9PZH0i2CD', status: 'fldOEWUQ7krAMoyK9', sentAt: 'fldZGwCTz9WLPWGKO', feedback: 'fldj3bqTTzMzqbkEj',
  matchedAt: 'fldnREWWWDHeorGqU'
};
const LS = {
  addr: 'fld4iTTnjDJagkY7f', suburb: 'fld46hCNJv589iV4P', type: 'fld7pSlzfCYyCv499', beds: 'fld76puAVSOxN51vb',
  baths: 'fldWcNQArMl4CQoGG', car: 'fldoPMmb2SQCFVzpy', land: 'fldjxl8HWgTx7GeWw', ptext: 'fldzmKv5AGOXxWnMt',
  plo: 'fldWTMq9fq8DW7K2G', phi: 'fldbhlybQ8LA2M6He', listDate: 'fldBgyKXtIzhIk4Vh', status: 'fldpZuWLstBgyZzSk',
  stone: 'fld2JKZuS5KkqofaW', link: 'fldgOq5OW8mF5FNfA', feat: 'fldZtJVT3tGVUYyHr', property: 'fld0RT3rZaM6FRc8I'
};
const CI = {
  name: 'fldurgnMEIdSie5z3', mobile: 'fldTIal66LWdnINN3', suburb: 'fldToYwX9ednVlJah', email: 'fldSvv3KIWgDacByG',
  insp: 'fldGoYo4QgBIp3aqV', type: 'fld1WO0G10rDQe039', property: 'fld0NnGmQdQK3bMlc', agent: 'fldLie73SzdIoEpVm',
  notes: 'fldIWgs0iBZAqHqaa', contact: 'fldgsE4tOCasN1TaI', at: 'fldZYcGxRUsmKSnXT', following: 'fldDfmwmL6wHDPT18',
  alexStatus: 'fld5ZAf6ug4aASDMg', alexNote: 'fldN14BOQr50tRp3r'
};
const IN = {
  name: 'fldXdDpcQL5Qm0gyn', property: 'fldIrwroJCF99ergb', type: 'fldWhporyrNvcmUEd', agent: 'fldeQtewqz2ILV1jo',
  date: 'fldjriKRBzggStngU', notes: 'fldp6GSJyw01h46P6', checkins: 'fldhzwmq6zLViBXgk', started: 'fld35kHcfNNCDpQtN',
  holdAsked: 'fldHPWfDFcEulxIQr'
};
const TK = {
  task: 'flds1zBNNSIuWMIAe', due: 'fldFgsIL7uMKKutro', status: 'flddkegXHPifQmUaV', notes: 'fldmHfFADFPhyLW2U',
  source: 'fldvhHAvuWm60NRo2', with: 'fldjjI2VaSG0bYh7Q', assigned: 'fldaINd0hRSQlVQCN', brief: 'fldkwomOX6NiqAZa0'
};
const OPP_STAGE = 'fldIHUJYiPGHuR0WZ';
const CLOSED_OPP_STAGES = ['Lost', 'Lost / Not Progressing', 'Listed (Won)', 'Authority Signed', 'Nurture', 'Won'];

// Select options (must match Airtable exactly)
const OPT = {
  suburbs: ['Alfredton', 'Bakery Hill', 'Ballarat Central', 'Ballarat East', 'Ballarat North', 'Black Hill', 'Bonshaw', 'Brown Hill',
    'Buninyong', 'Canadian', 'Cardigan', 'Cardigan Village', 'Clunes', 'Creswick', 'Delacombe', 'Enfield', 'Golden Point', 'Haddon',
    'Invermay', 'Invermay Park', 'Lake Gardens', 'Lake Wendouree', 'Learmonth', 'Lucas', 'Magpie', 'Miners Rest', 'Mitchell Park',
    'Mount Clear', 'Mount Helen', 'Mount Pleasant', 'Napoleons', 'Nerrina', 'Newington', 'Redan', 'Scotsburn', 'Sebastopol',
    'Smythes Creek', 'Smythesdale', 'Soldiers Hill', 'Warrenheip', 'Wendouree', 'Winter Valley', 'Anywhere in Ballarat'],
  types: ['House', 'Unit / Townhouse', 'Land', 'Lifestyle / Acreage', 'Rural', 'Investment'],
  must: ['Single level', 'Shed / workshop', 'Study', '2 living areas', 'Garage', 'Low maintenance', 'Large block', 'Character / period',
    'New / near new', 'Pool', 'Ensuite', 'Walk to schools', 'Walk to CBD', 'Rural outlook', 'Dual living / granny flat', 'Room for a pool'],
  reason: ['First home', 'Upsizing', 'Downsizing', 'Investor', 'Relocating to Ballarat', 'Lifestyle change', 'Other'],
  finance: ['Cash buyer', 'Pre-approved', 'Talking to lender', 'Not started', 'Unknown'],
  saleDep: ['Nothing to sell', 'Sold / under contract', 'Must sell first', 'Might sell', 'Unknown'],
  timeframe: ['0–3 months', '3–6 months', '6–12 months', '12+ months', 'Unknown'],
  through: ['Stone Ballarat', 'Another agent', 'Private sale', 'Unknown']
};

// Public holidays (Victoria) – no scheduled sends. Add more with BUYER_HOLIDAYS.
const HOLIDAYS = new Set(['2026-11-03', '2026-12-25', '2026-12-28', '2027-01-01', '2027-01-26']
  .concat(String(process.env.BUYER_HOLIDAYS || '').split(',').map(s => s.trim()).filter(Boolean)));

// ---------------------------------------------------------------- small helpers

function enabled() { return !!process.env.AIRTABLE_TOKEN && String(process.env.ALEX_BUYERS_ENABLED).toLowerCase() === 'true'; }

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
function last9(raw) { return String(raw || '').replace(/\D/g, '').slice(-9); }
function sel(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v.name : (v || ''); }
function sels(v) { return (v || []).map(x => (typeof x === 'object' ? x.name : x)); }
function firstName(full) { return String(full || '').trim().split(/\s+/)[0] || ''; }
function linkId(v) { return ((v || [])[0] || {}).id || (typeof (v || [])[0] === 'string' ? v[0] : null); }
function ids(v) { return (v || []).map(x => (typeof x === 'object' ? x.id : x)).filter(Boolean); }
function esc(s) { return String(s || '').replace(/'/g, "\\'"); }
function plainSMS(t) {
  return String(t || '').replace(/[‘’‛′]/g, "'").replace(/[“”″]/g, '"')
    .replace(/\s*[–—―]\s*/g, ' - ').replace(/…/g, '...').replace(/[   ]/g, ' ')
    .replace(/[•·]/g, '-').replace(/ {2,}/g, ' ').trim();
}
function shortAddress(a) {
  // "12 Smith Street, Alfredton VIC 3350" → "12 Smith Street"
  return String(a || '').split(',')[0].replace(/\s+(VIC|Vic)\s*\d{4}$/, '').trim();
}
function money(n) { return '$' + Math.round(n).toLocaleString('en-AU'); }
function k(n) { return '$' + Math.round(n / 1000) + 'k'; }

// ---------------------------------------------------------------- time (Melbourne)

function clock(d) {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  }).formatToParts(d || new Date());
  const p = t => (parts.find(x => x.type === t) || {}).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hour: parseInt(p('hour'), 10) % 24, minute: parseInt(p('minute'), 10), weekday: p('weekday') };
}
function addDays(iso, n) { const d = new Date(iso.slice(0, 10) + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
function weekdayOf(iso) { return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(iso + 'T00:00:00Z').getUTCDay()]; }
function daysBetween(a, b) { return Math.round((new Date(b.slice(0, 10) + 'T00:00:00Z') - new Date(a.slice(0, 10) + 'T00:00:00Z')) / 864e5); }
function minutesSince(iso) { return iso ? (Date.now() - new Date(iso).getTime()) / 60000 : Infinity; }
// Melbourne local "YYYY-MM-DD HH:mm" → ISO (handles AEST / AEDT)
function melbToISO(date, hh, mm) {
  const guess = new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}:00Z`);
  for (const off of [11, 10]) {
    const d = new Date(guess.getTime() - off * 3600000);
    const c = clock(d);
    if (c.date === date && c.hour === hh && c.minute === (mm || 0)) return d.toISOString();
  }
  return new Date(guess.getTime() - 11 * 3600000).toISOString();
}
function isHoliday(iso) { return HOLIDAYS.has(iso); }
// Scheduled sends (lists, check-ins, re-checks, import outreach): Mon–Sat 9:00–6:00, not public holidays
function inScheduledWindow(c) { c = c || clock(); return c.weekday !== 'Sun' && !isHoliday(c.date) && c.hour >= 9 && c.hour < 18; }
// Next time a post-inspection follow-up may go: now if before 7:30pm; else 9:30am next day (Sunday 10am)
function inspectionSendOK(c) { c = c || clock(); if (c.weekday === 'Sun' && c.hour < 10) return false; return c.hour >= 8 && (c.hour < 19 || (c.hour === 19 && c.minute < 30)); }
function nextMorningISO(c) {
  c = c || clock();
  const tomorrow = addDays(c.date, 1);
  return weekdayOf(tomorrow) === 'Sun' ? melbToISO(tomorrow, 10, 0) : melbToISO(tomorrow, 9, 30);
}
function next8amISO(c) { c = c || clock(); return melbToISO(c.hour < 8 ? c.date : addDays(c.date, 1), 8, 0); }
function goLiveDate() { return process.env.BUYERS_GO_LIVE || addDays(clock().date, -2); }

// ---------------------------------------------------------------- Airtable REST

async function at(method, path, body) {
  const res = await fetch('https://api.airtable.com/v0/' + BASE + '/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error('Airtable ' + method + ' ' + path.slice(0, 80) + ' ' + res.status + ': ' + JSON.stringify(json).slice(0, 300));
  return json;
}
async function listAll(table, params) {
  let out = [], offset;
  do {
    const q = new URLSearchParams({ returnFieldsByFieldId: 'true', pageSize: '100' });
    for (const [key, val] of Object.entries(params || {})) {
      if (Array.isArray(val)) val.forEach(v => q.append(key, v)); else q.set(key, val);
    }
    if (offset) q.set('offset', offset);
    const r = await at('GET', table + '?' + q.toString());
    out = out.concat(r.records || []);
    offset = r.offset;
  } while (offset);
  return out;
}
async function getRecord(table, id) { return at('GET', table + '/' + id + '?returnFieldsByFieldId=true'); }
async function getMany(table, recIds) {
  recIds = [...new Set((recIds || []).filter(Boolean))];
  const out = [];
  for (let i = 0; i < recIds.length; i += 40) {
    const chunk = recIds.slice(i, i + 40);
    const formula = 'OR(' + chunk.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    out.push(...await listAll(table, { filterByFormula: formula }));
  }
  return out;
}
async function createRecord(table, fields) {
  const r = await at('POST', table, { records: [{ fields }], typecast: true, returnFieldsByFieldId: true });
  return r.records[0];
}
async function updateRecord(table, id, fields) {
  const r = await at('PATCH', table, { records: [{ id, fields }], typecast: true, returnFieldsByFieldId: true });
  return r.records[0];
}
function recordLink(pageId, recId) { return `https://airtable.com/${BASE}/${pageId}/${recId}`; }

// ---------------------------------------------------------------- team

let teamCache = { at: 0, rows: [] };
async function teamRows() {
  if (Date.now() - teamCache.at < 60000) return teamCache.rows;
  teamCache = { at: Date.now(), rows: await listAll(T.team, {}) };
  return teamCache.rows;
}
function teamChanged() { teamCache.at = 0; }
async function teamById(id) { return (await teamRows()).find(t => t.id === id) || null; }
async function teamByPhone(from) { return (await teamRows()).find(t => samePhone(t.fields[TM.mobile], from)) || null; }
function agentFirst(agent) { return agent ? (agent.fields[TM.first] || firstName(agent.fields[TM.name])) : 'the team'; }
function agentLive(agent) { return !!agent && !!agent.fields[TM.buyersActive]; }          // pilot gate
function agentPaused(agent) { return !!agent && !!agent.fields[TM.pauseBuyers]; }
function approverMobile() { return normalisePhone(process.env.APPROVER_MOBILE); }
function isApprover(from) { return !!approverMobile() && samePhone(from, approverMobile()); }

// ---------------------------------------------------------------- brief state (JSON in Alex State)

function getState(brief) { try { return JSON.parse((brief.fields || {})[B.state] || '{}') || {}; } catch (e) { return {}; } }
async function saveState(brief, state, extra) {
  state.history = (state.history || []).slice(-14);
  const fields = Object.assign({ [B.state]: JSON.stringify(state) }, extra || {});
  const r = await updateRecord(T.briefs, brief.id, fields);
  brief.fields = Object.assign(brief.fields || {}, r.fields || {}, fields);
  return brief;
}
function remember(state, dir, text) { (state.history = state.history || []).push({ d: dir, t: String(text).slice(0, 400), at: new Date().toISOString() }); }

// ---------------------------------------------------------------- contacts and briefs

async function contactByPhone(from) {
  const d = last9(from);
  if (d.length < 9) return null;
  const formula = `RIGHT(REGEX_REPLACE({${C.mobile}}&'','[^0-9]',''),9)='${d}'`;
  const found = await listAll(T.contacts, { filterByFormula: formula, maxRecords: '5' });
  // prefer a contact that has a buyer brief
  return found.sort((a, b) => ids(b.fields[C.briefs]).length - ids(a.fields[C.briefs]).length)[0] || null;
}
async function briefsOfContact(contact) {
  const recs = await getMany(T.briefs, ids(contact.fields[C.briefs]));
  const rank = b => ({ Active: 0, Paused: 1, Bought: 2, Closed: 3 }[sel(b.fields[B.status])] ?? 4);
  return recs.sort((a, b) => rank(a) - rank(b) || String(b.fields[B.created] || '').localeCompare(String(a.fields[B.created] || '')));
}
async function primaryContact(brief) { const id = linkId(brief.fields[B.buyers]); return id ? getRecord(T.contacts, id) : null; }
async function briefAgent(brief, contact) {
  return teamById(linkId(brief.fields[B.agent]) || (contact && linkId(contact.fields[C.agent])));
}
function optedOut(contact) { return !!(contact && contact.fields[C.optedOut]); }
function dncFlag(contact) { return !!(contact && contact.fields[C.doNotContact]); }

async function isCurrentSeller(contact) {
  const opps = await getMany(T.opps, ids(contact.fields[C.sellOpps]));
  return opps.find(o => !CLOSED_OPP_STAGES.includes(sel(o.fields[OPP_STAGE]))) || null;
}

// Everything Alex can say about a listing comes from here (no invented facts or prices)
function listingFacts(l) {
  const f = l.fields || {};
  return {
    id: l.id, address: f[LS.addr] || '', short: shortAddress(f[LS.addr]), suburb: f[LS.suburb] || '', type: sel(f[LS.type]),
    beds: f[LS.beds] ?? null, baths: f[LS.baths] ?? null, car: f[LS.car] ?? null, land: f[LS.land] ?? null,
    price: (f[LS.ptext] || '').trim(), lo: f[LS.plo] || null, hi: f[LS.phi] || null, status: sel(f[LS.status]),
    stone: !!f[LS.stone], link: f[LS.link] || '', features: String(f[LS.feat] || '').slice(0, 400), property: linkId(f[LS.property])
  };
}
function bbc(x) { return [x.beds, x.baths, x.car].every(v => v === null || v === undefined) ? '' : `${x.beds ?? '-'}/${x.baths ?? '-'}/${x.car ?? '-'}`; }

async function listingForProperty(propertyId) {
  if (!propertyId) return null;
  const stone = await listAll(T.listings, { filterByFormula: `{${LS.stone}}` });
  return stone.find(l => ids(l.fields[LS.property]).includes(propertyId)) || null;
}

// ---------------------------------------------------------------- message log

function msgCode() { return 'B' + Date.now().toString(36).toUpperCase().slice(-6); }
async function logMsg({ brief, contact, match, direction, purpose, status, text, number, sid, reasoning, error }) {
  const f = {
    [M.code]: msgCode(), [M.audience]: 'Buyer', [M.direction]: direction, [M.purpose]: purpose || 'Other', [M.status]: status,
    [M.finalText]: text || '', [M.number]: normalisePhone(number) || ''
  };
  if (brief) f[M.brief] = [brief.id];
  if (contact) f[M.contact] = [contact.id];
  if (match) f[M.match] = [match.id || match];
  if (sid) f[M.sid] = sid;
  if (reasoning) f[M.reasoning] = reasoning;
  if (error) f[M.error] = String(error).slice(0, 2000);
  if (status === 'Sent') f[M.sentAt] = new Date().toISOString();
  try { return await createRecord(T.messages, f); } catch (e) { console.error('Alex buyers: log failed', e.message); return null; }
}

// Purposes that are Alex-initiated (count towards caps); replies to the buyer don't
const REPLY_PURPOSES = ['Reply to buyer', 'Opt-out confirmation', 'Not interested clarifier', 'Bought congratulations'];

async function sentCounts(contactId) {
  const today = clock().date;
  const since = new Date(Date.now() - 8 * 864e5).toISOString();
  const formula = `AND({${M.audience}}='Buyer',{${M.direction}}='To buyer',{${M.status}}='Sent',IS_AFTER({${M.created}},'${since}'))`;
  const recs = await listAll(T.messages, { filterByFormula: formula, 'fields[]': [M.purpose, M.contact, M.created, M.finalText] });
  const init = recs.filter(r => !REPLY_PURPOSES.includes(sel(r.fields[M.purpose])));
  const isToday = r => clock(new Date(r.fields[M.created])).date === today;
  const mine = init.filter(r => ids(r.fields[M.contact]).includes(contactId));
  return {
    totalToday: init.filter(isToday).length,
    importToday: init.filter(r => isToday(r) && sel(r.fields[M.purpose]) === 'Import outreach').length,
    buyerToday: mine.filter(isToday).length,
    buyerWeek: mine.filter(r => minutesSince(r.fields[M.created]) < 7 * 1440).length
  };
}
async function sameTextRecently(contactId, text) {
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const formula = `AND({${M.audience}}='Buyer',{${M.direction}}='To buyer',IS_AFTER({${M.created}},'${since}'))`;
  const recs = await listAll(T.messages, { filterByFormula: formula, 'fields[]': [M.contact, M.finalText] });
  const norm = s => plainSMS(s).toLowerCase().replace(/\W+/g, ' ').trim();
  return recs.some(r => ids(r.fields[M.contact]).includes(contactId) && norm(r.fields[M.finalText]) === norm(text));
}

// Dollar figures may only be ones that appear in a listing's advertised Price Text
function priceSafe(text, allowedPrices) {
  const found = (String(text).match(/\$\s?\d[\d,]*(\.\d+)?\s?(k|m)?\b/gi) || []).map(x => x.trim());
  if (!found.length) return true;
  const allowed = (allowedPrices || []).join(' ').replace(/\s/g, '').toLowerCase();
  return found.every(f => allowed.includes(f.replace(/\s/g, '').toLowerCase()));
}

// ---------------------------------------------------------------- sending

const OPT_OUT_LINE = "Reply STOP anytime and I'll leave you be.";
const OPT_OUT_CLEAR = "If you'd rather not get texts from us, just reply STOP and I won't message again.";

async function rawSMS(to, body) {
  const msg = await tw().messages.create({ from: process.env.ALEX_PHONE_NUMBER, to: normalisePhone(to), body });
  return msg.sid;
}

// Sends a text to a buyer with every safeguard. kind: 'reply' (buyer texted first – no caps, any hour) or
// 'initiated' (counts towards caps; caller has already checked the time window).
// Returns { ok, reason, sid }
async function sendToBuyer({ brief, contact, match, text, purpose, kind, allowedPrices, reasoning, skipDuplicateCheck }) {
  const number = contact && contact.fields[C.mobile];
  text = plainSMS(text);
  const fail = async (reason) => { console.log('Alex buyers: not sent (' + reason + ') ' + (contact ? contact.fields[C.name] : '')); return { ok: false, reason }; };
  if (!contact || !isTextableMobile(number)) return fail('no textable mobile');
  if (optedOut(contact)) return fail('opted out');
  if (kind !== 'reply') {
    if (brief.fields[B.pause] || brief.fields[B.following]) return fail('paused / agent following up');
    if (!['Active'].includes(sel(brief.fields[B.status]))) return fail('brief not active');
    const counts = await sentCounts(contact.id);
    if (counts.totalToday >= DAILY_CAP) return fail('daily cap');
    if (counts.buyerToday >= 1) return fail('already texted today');
    if (counts.buyerWeek >= 2) return fail('2 this week');
  }
  if (!priceSafe(text, allowedPrices)) {
    await alertStu(`Alex (buyers): held a text to ${contact.fields[C.name]} – it had a price that didn't match the listing. Text: "${text}"`);
    return fail('price check');
  }
  if (!skipDuplicateCheck && kind !== 'reply' && await sameTextRecently(contact.id, text)) return fail('same text in last 30 days');
  if (text.length > 480) text = text.slice(0, 477) + '...';
  try {
    const sid = await rawSMS(number, text);
    await logMsg({ brief, contact, match, direction: 'To buyer', purpose, status: 'Sent', text, number, sid, reasoning });
    console.log('Alex buyers → ' + contact.fields[C.name] + ': ' + text);
    return { ok: true, sid, text };
  } catch (e) {
    await logMsg({ brief, contact, match, direction: 'To buyer', purpose, status: 'Failed', text, number, error: e.message, reasoning });
    try { await updateRecord(T.contacts, contact.id, { [C.check]: 'Alex could not text this mobile: ' + e.message.slice(0, 120) }); } catch (x) { }
    await alertStu(`Alex (buyers): text to ${contact.fields[C.name]} failed – ${e.message.slice(0, 140)}. Mobile flagged on the contact.`);
    return { ok: false, reason: 'send failed' };
  }
}

async function textAgent(agent, text, brief, contact) {
  if (!agent || !agent.fields[TM.mobile]) return false;
  try {
    const sid = await rawSMS(agent.fields[TM.mobile], text);
    await logMsg({ brief, contact, direction: 'To agent', purpose: 'Buyer alert to agent', status: 'Sent', text, number: agent.fields[TM.mobile], sid });
    return true;
  } catch (e) { console.error('Alex buyers: agent text failed', e.message); return false; }
}
async function alertStu(text) {
  const to = approverMobile();
  if (!to) return;
  try {
    const sid = await rawSMS(to, text);
    await logMsg({ direction: 'To agent', purpose: 'Buyer alert to agent', status: 'Sent', text, number: to, sid });
  } catch (e) { console.error('Alex buyers: alert to Stu failed', e.message); }
}

async function createTask({ brief, contact, agent, task, due, notes }) {
  const f = { [TK.task]: task, [TK.status]: 'Open', [TK.source]: 'Alex', [TK.due]: due || clock().date };
  if (brief) f[TK.brief] = [brief.id];
  if (contact) f[TK.with] = [contact.id];
  if (agent) f[TK.assigned] = [agent.id];
  if (notes) f[TK.notes] = notes;
  try { return await createRecord(T.tasks, f); } catch (e) { console.error('Alex buyers: task failed', e.message); return null; }
}

// ---------------------------------------------------------------- first texts (playbook section 2 / 7a)

function optOutFor(contact) { return dncFlag(contact) ? OPT_OUT_CLEAR : OPT_OUT_LINE; }
function firstTextFor(kind, { first, agentName, short, area, contact, when }) {
  const hi = `Hey ${first || 'there'}, this is Alex from Stone Ballarat on behalf of ${agentName}.`;
  const oo = ' ' + optOutFor(contact);
  switch (kind) {
    case 'open':
      return `${hi} Thanks for coming through ${short} ${when || 'today'}. What did you think, and did you have any questions about it?` + oo;
    case 'private':
      return `Hey ${first || 'there'}, Alex here from Stone Ballarat on behalf of ${agentName}. Thanks for taking the time to see ${short}. How did it stack up against what you're after?` + oo;
    case 'enquiry':
      return short
        ? `${hi} Thanks for your enquiry on ${short}. Would you like the Property Price Range or a copy of the contract, or to book a time to see it?` + oo
        : `${hi} Thanks for your enquiry. What sort of place are you looking for, and which areas?` + oo;
    case 'coming_soon':
      return `Hey ${first || 'there'}, Alex from Stone Ballarat on behalf of ${agentName}. Thanks for registering for ${short || 'our upcoming listing'}. I'll send the details and first open time as soon as they're locked in. Are you looking in that area generally?` + oo;
    case 'import':
      return short
        ? `Hey ${first || 'there'}, this is Alex, ${agentName}'s assistant at Stone Ballarat. You enquired with us about ${short} a while back. Are you still looking to buy? I'd love to help with your search.` + oo
        : `Hey ${first || 'there'}, this is Alex, ${agentName}'s assistant at Stone Ballarat. I'm here to help with your property buying journey and make sure you hear about the right homes first. Are you still looking to buy${area ? ' around ' + area : ''}?` + oo;
    default: // agent-added / phone enquiry
      return `${hi} ${agentName} mentioned you're looking to buy around ${area || 'Ballarat'}. I'll keep an eye out and send you anything that fits. Can I ask a couple of quick questions so I only send you the right ones?` + oo;
  }
}
function nudgeTextFor(kind, { first, short }) {
  if (kind === 'import') return `Hi ${first || 'there'}, Alex from Stone again. Just checking whether you're still on the hunt for a property? A quick yes or no is perfect, and I'll only send you what's relevant.`;
  if (short && ['open', 'private', 'enquiry'].includes(kind)) return `Hi ${first || 'there'}, just following up on ${short}. Happy to send through the details or line up a time to see it. Anything I can help with?`;
  return `Hi ${first || 'there'}, Alex from Stone again. Just checking in, are you still looking to buy? A quick yes or no is perfect.`;
}
function kindFromSource(src) {
  const s = String(src || '').toLowerCase();
  if (/coming soon|pre-market|register/.test(s)) return 'coming_soon';
  if (/agentbox import|import/.test(s)) return 'import';
  if (/phone|call|walk-in|referral|agent/.test(s)) return 'agent';
  if (/open home/.test(s)) return 'open';
  if (/private/.test(s)) return 'private';
  if (/enquir|portal|email|realestate|rea\b|domain|website|web/.test(s)) return 'enquiry';
  return 'agent';
}
function areaOf(brief, contact) {
  const subs = sels(brief.fields[B.suburbs]).filter(s => s !== 'Anywhere in Ballarat');
  if (subs.length) return subs.slice(0, 2).join(' or ');
  return (contact && contact.fields[C.suburb]) || '';
}

async function createBrief({ contact, agent, source, state, extra }) {
  const f = Object.assign({
    [B.buyers]: [contact.id], [B.status]: 'Active', [B.source]: source || 'Alex',
    [B.state]: JSON.stringify(state || {})
  }, extra || {});
  if (agent) f[B.agent] = [agent.id];
  const r = await createRecord(T.briefs, f);
  return r;
}

// Sends the first text for a brief. Caller has checked timing. Returns the send result.
async function sendFirstText({ brief, contact, agent, kind, short, listing, reasoningNote, when }) {
  const st = getState(brief);
  const text = firstTextFor(kind, { first: firstName(contact.fields[C.name]), agentName: agentFirst(agent), short, area: areaOf(brief, contact), contact, when });
  const purpose = kind === 'import' ? 'Import outreach' : (['open', 'private'].includes(kind) ? 'Inspection follow-up' : 'Enquiry reply');
  const res = await sendToBuyer({ brief, contact, text, purpose, kind: 'initiated', allowedPrices: [], reasoning: reasoningNote || ('First text: ' + kind) });
  if (!res.ok) return res;
  const c = clock();
  const outOfHours = c.hour < 8 || c.hour >= 19 || c.weekday === 'Sun';
  st.phase = 'awaiting_reply';
  st.firstKind = kind;
  st.firstSentAt = new Date().toISOString();
  st.nudged = false;
  st.nudgeDue = kind === 'import' ? melbToISO(addDays(c.date, 3), 10, 0) : (outOfHours ? next8amISO(c) : new Date(Date.now() + 24 * 3600000).toISOString());
  if (short) st.property = { short, listingId: listing ? listing.id : null };
  st.lastOutAt = st.firstSentAt;
  remember(st, 'out', res.text);
  await saveState(brief, st, { [B.lastSent]: new Date().toISOString(), [B.unanswered]: (brief.fields[B.unanswered] || 0) + 1 });
  return res;
}

// ---------------------------------------------------------------- inspection check-ins + HOLD (section 3)

const HOLD_MINUTES = { 'Open home': 60, 'Private inspection': 120 };
function inspectionFollowUpOK(c) {
  c = c || clock();
  const mins = c.hour * 60 + c.minute;
  if (c.weekday === 'Sun') return mins >= 600 && mins < 1170;
  return mins >= 570 && mins < 1170; // 9:30am – 7:30pm
}

async function checkinTick() {
  const since = new Date(Math.max(Date.now() - 24 * 3600000, new Date(goLiveDate() + 'T00:00:00+11:00').getTime())).toISOString();
  const formula = `AND({${CI.alexStatus}}='',IS_AFTER({${CI.at}},'${since}'))`;
  const fresh = await listAll(T.checkins, { filterByFormula: formula });
  const waitingFormula = `{${CI.alexStatus}}='Waiting (HOLD)'`;
  const byInsp = new Map();
  for (const ci of fresh) {
    const f = ci.fields;
    const agent = await teamById(linkId(f[CI.agent]));
    if (!linkId(f[CI.contact])) {
      if (minutesSince(f[CI.at]) > 30) await updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Skipped', [CI.alexNote]: 'No contact linked' });
      continue;
    }
    if (!agentLive(agent)) { await updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Skipped', [CI.alexNote]: 'Agent not on Alex buyers yet' }); continue; }
    const inspId = linkId(f[CI.insp]);
    if (!inspId) {
      // Added with the Add a Buyer form (phone enquiry / agent-added): no HOLD, next send window
      await updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Waiting (HOLD)', [CI.alexNote]: 'Agent-added – next send window' });
      continue;
    }
    if (!byInsp.has(inspId)) byInsp.set(inspId, []);
    byInsp.get(inspId).push(ci);
  }
  // HOLD check text to the agent, once per inspection
  for (const [inspId, cis] of byInsp) {
    const insp = await getRecord(T.inspections, inspId);
    const agent = await teamById(linkId(insp.fields[IN.agent]) || linkId(cis[0].fields[CI.agent]));
    for (const ci of cis) await updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Waiting (HOLD)' });
    if (!insp.fields[IN.holdAsked]) {
      const type = sel(insp.fields[IN.type]) || 'Open home';
      const all = await getMany(T.checkins, ids(insp.fields[IN.checkins]));
      const names = all.map(x => firstName(x.fields[CI.name])).filter(Boolean);
      const due = new Date(Date.now() + (HOLD_MINUTES[type] || 60) * 60000);
      const dc = clock(due);
      const when = `${dc.hour % 12 || 12}:${String(dc.minute).padStart(2, '0')}${dc.hour < 12 ? 'am' : 'pm'}`;
      const addr = shortAddress((insp.fields[IN.name] || '').split(' – ')[0]) || 'the inspection';
      const msg = `Alex: ${all.length} ${all.length === 1 ? 'person' : 'people'} checked in at ${addr} (${names.slice(0, 8).join(', ')}${names.length > 8 ? '…' : ''}). ` +
        `I'll follow them up at ${when} unless you reply HOLD ALL or HOLD + names.`;
      await textAgent(agent, msg);
      await updateRecord(T.inspections, inspId, { [IN.holdAsked]: new Date().toISOString() });
    }
  }
  // Waiting check-ins whose HOLD is over → first text
  const waiting = await listAll(T.checkins, { filterByFormula: waitingFormula });
  const c = clock();
  for (const ci of waiting) {
    try { await processWaitingCheckin(ci, c); } catch (e) { console.error('Alex buyers: check-in ' + ci.id + ' failed', e.message); }
  }
}

async function processWaitingCheckin(ci, c) {
  const f = ci.fields;
  if (minutesSince(f[CI.at]) > 2 * 1440) return updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Skipped', [CI.alexNote]: 'Not sent within 2 days (caps / hours) – agent to follow up' });
  if (f[CI.following]) return updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Held by agent', [CI.alexNote]: 'Agent following up' });
  const inspId = linkId(f[CI.insp]);
  let kind = 'agent', insp = null;
  if (inspId) {
    insp = await getRecord(T.inspections, inspId);
    const type = sel(insp.fields[IN.type]) || sel(f[CI.type]) || 'Open home';
    kind = type === 'Private inspection' ? 'private' : 'open';
    const all = await getMany(T.checkins, ids(insp.fields[IN.checkins]));
    const lastAt = all.map(x => x.fields[CI.at]).concat([insp.fields[IN.holdAsked]]).filter(Boolean).sort().pop();
    if (minutesSince(lastAt) < (HOLD_MINUTES[type] || 60)) return;
    if (/agent to follow up/i.test(String(insp.fields[IN.notes] || '') + ' ' + String(f[CI.notes] || ''))) {
      return updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Held by agent', [CI.alexNote]: 'Notes say agent to follow up' });
    }
    if (!inspectionFollowUpOK(c)) return; // goes at 9:30am (Sun 10am)
  } else if (!inScheduledWindow(c)) return;

  const contact = await getRecord(T.contacts, linkId(f[CI.contact]));
  const agent = await teamById(linkId(f[CI.agent]) || (insp && linkId(insp.fields[IN.agent])));
  const skip = async (note) => updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Skipped', [CI.alexNote]: note });
  if (optedOut(contact)) return skip('Opted out');
  if (!isTextableMobile(contact.fields[C.mobile])) return skip('Mobile looks wrong – check');
  const sellerOpp = await isCurrentSeller(contact);
  if (sellerOpp) {
    await createTask({ contact, agent, task: `${contact.fields[C.name]} (current seller) checked in at an inspection – follow up as a buyer`, notes: 'Alex did not text them as a buyer because they are on an open selling opportunity.' });
    return skip('Current seller – task for agent');
  }
  // Property facts
  const propertyId = linkId(f[CI.property]) || (insp && linkId(insp.fields[IN.property]));
  const listing = await listingForProperty(propertyId);
  const short = listing ? listingFacts(listing).short : shortAddress(((f[CI.property] || [])[0] || {}).name || (insp ? String(insp.fields[IN.name] || '').split(' – ')[0] : ''));

  // Existing brief?
  const briefs = await briefsOfContact(contact);
  let brief = briefs.find(b => ['Active', 'Paused'].includes(sel(b.fields[B.status])));
  if (brief && sel(brief.fields[B.status]) === 'Paused') {
    if (optedOut(contact)) return skip('Brief paused (opted out)');
    await updateRecord(T.briefs, brief.id, { [B.status]: 'Active', [B.pause]: false });
    brief = await getRecord(T.briefs, brief.id);
  }
  if (brief) {
    const st = getState(brief);
    if (brief.fields[B.following]) return updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Held by agent', [CI.alexNote]: 'Brief has Agent Following Up' });
    if (minutesSince(st.lastOutAt) < 48 * 60) {
      const note = `${c.date}: inspected ${short} (${kind === 'private' ? 'private' : 'open home'}).`;
      await updateRecord(T.briefs, brief.id, { [B.notes]: ((brief.fields[B.notes] || '') + '\n' + note).trim() });
      st.mention = short;
      await saveState(brief, st);
      return skip('Texted in last 48 hrs – noted on brief, mentioned next time');
    }
  } else {
    brief = await createBrief({ contact, agent, source: (kind === 'private' ? 'Private inspection' : kind === 'open' ? 'Open home' : 'Agent-added') + (short ? ' – ' + short : ''), state: { phase: 'new' } });
  }
  const ciDate = clock(new Date(f[CI.at])).date;
  const when = ciDate === c.date ? 'today' : (ciDate === addDays(c.date, -1) ? 'yesterday' : 'on ' + ({ Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday' })[weekdayOf(ciDate)]);
  const res = await sendFirstText({ brief, contact, agent, kind, short, listing, when });
  if (res.ok) return updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Texted', [CI.alexNote]: '' });
  if (['already texted today', '2 this week', 'daily cap'].includes(res.reason)) return; // try again later
  return skip('Not sent: ' + res.reason);
}

// Agent replies to the HOLD check: "HOLD ALL" / "HOLD Sarah, John"
async function handleHold(member, text) {
  const since = new Date(Date.now() - 8 * 3600000).toISOString();
  const insps = (await listAll(T.inspections, { filterByFormula: `IS_AFTER({${IN.holdAsked}},'${since}')` }))
    .filter(i => ids(i.fields[IN.agent]).includes(member.id))
    .sort((a, b) => String(b.fields[IN.holdAsked]).localeCompare(String(a.fields[IN.holdAsked])));
  const waiting = [];
  for (const i of insps) {
    const cis = await getMany(T.checkins, ids(i.fields[IN.checkins]));
    waiting.push(...cis.filter(x => sel(x.fields[CI.alexStatus]) === 'Waiting (HOLD)').map(x => ({ ci: x, insp: i })));
  }
  if (!waiting.length) return 'Nothing waiting – Alex has already followed up (or nothing to hold).';
  const rest = text.replace(/^hold\s*/i, '').trim();
  let pick;
  if (!rest || /^all\b/i.test(rest)) pick = waiting;
  else {
    const wanted = rest.split(/[,&]|\band\b/i).map(s => s.trim().toLowerCase()).filter(Boolean);
    pick = waiting.filter(w => wanted.some(n => String(w.ci.fields[CI.name] || '').toLowerCase().includes(n)));
    if (!pick.length) return `Couldn't match ${rest} to anyone waiting (${waiting.map(w => w.ci.fields[CI.name]).join(', ')}). Reply HOLD + first name.`;
  }
  const until = new Date(Date.now() + 3 * 864e5).toISOString();
  for (const { ci, insp } of pick) {
    await updateRecord(T.checkins, ci.id, { [CI.alexStatus]: 'Held by agent', [CI.alexNote]: 'Agent replied HOLD' });
    const contactId = linkId(ci.fields[CI.contact]);
    const addr = shortAddress(String(insp.fields[IN.name] || '').split(' – ')[0]);
    let brief = null, contact = null;
    if (contactId) {
      contact = await getRecord(T.contacts, contactId);
      brief = (await briefsOfContact(contact)).find(b => sel(b.fields[B.status]) === 'Active');
      if (!brief && !optedOut(contact)) brief = await createBrief({ contact, agent: member, source: 'Open home – ' + addr, state: { phase: 'held', heldUntil: until } });
      else if (brief) { const st = getState(brief); if (['new', 'awaiting_reply', undefined].includes(st.phase)) { st.phase = 'held'; st.heldUntil = until; await saveState(brief, st); } }
    }
    await createTask({ brief, contact, agent: member, task: `Follow up ${ci.fields[CI.name]} from ${addr}`, notes: 'You replied HOLD, so Alex left this one with you. Alex starts nurture in 3 days.' });
  }
  return `Done – holding ${pick.map(w => firstName(w.ci.fields[CI.name])).join(', ')}. They're in My Tasks for today; I'll start nurture in 3 days.`;
}

// ---------------------------------------------------------------- new briefs from other sources (enquiry, coming soon, agent-added)

async function newBriefTick() {
  const goLive = goLiveDate();
  const formula = `AND({${B.status}}='Active',{${B.state}}='',{${B.campaign}}='',IS_AFTER({${B.created}},'${goLive}'))`;
  const briefs = await listAll(T.briefs, { filterByFormula: formula });
  const c = clock();
  for (const brief of briefs) {
    try {
      if (brief.fields[B.pause] || brief.fields[B.following]) continue;
      const contact = await primaryContact(brief);
      if (!contact) continue;
      const agent = await briefAgent(brief, contact);
      if (!agentLive(agent)) continue;
      const kind = kindFromSource(brief.fields[B.source]);
      if (['open', 'private'].includes(kind)) { await saveState(brief, { phase: 'awaiting_reply', note: 'from inspection, first text handled by check-in' }); continue; }
      const instant = ['enquiry', 'coming_soon'].includes(kind);
      if (!instant && !inScheduledWindow(c)) continue;
      if (!instant && minutesSince(brief.fields[B.created]) < 10) continue; // give the agent a moment to tick "Agent following up"
      if (optedOut(contact) || !isTextableMobile(contact.fields[C.mobile])) { await saveState(brief, { phase: 'nurture', note: 'no first text – opted out or no mobile' }); continue; }
      const short = (String(brief.fields[B.source] || '').split(' – ')[1] || '').trim();
      const res = await sendFirstText({ brief, contact, agent, kind, short });
      if (!res.ok && !['already texted today', '2 this week', 'daily cap'].includes(res.reason)) await saveState(brief, { phase: 'nurture', note: 'first text not sent: ' + res.reason });
    } catch (e) { console.error('Alex buyers: new brief ' + brief.id, e.message); }
  }
}

// One follow-up if the first text got no reply; then into nurture
async function nudgeTick() {
  const formula = `AND({${B.status}}='Active',FIND('"phase":"awaiting_reply"',{${B.state}}&''))`;
  const briefs = await listAll(T.briefs, { filterByFormula: formula });
  const c = clock();
  const mins = c.hour * 60 + c.minute;
  if (c.weekday === 'Sun' || isHoliday(c.date) || mins < 480 || mins >= 1170) return; // 8am – 7:30pm Mon–Sat
  for (const brief of briefs) {
    try {
      const st = getState(brief);
      if (st.firstKind === 'import' || !st.nudgeDue || new Date(st.nudgeDue) > new Date()) continue;
      if (st.lastInAt && st.lastInAt > (st.firstSentAt || '')) { st.phase = 'qualifying'; await saveState(brief, st); continue; }
      const contact = await primaryContact(brief);
      const agent = await briefAgent(brief, contact);
      if (!agentLive(agent) || agentPaused(agent)) continue;
      if (st.nudged) { st.phase = 'nurture'; await saveState(brief, st); continue; }
      const text = nudgeTextFor(st.firstKind, { first: firstName(contact.fields[C.name]), short: (st.property || {}).short });
      const res = await sendToBuyer({ brief, contact, text, purpose: 'Follow-up nudge', kind: 'initiated' });
      if (res.ok) {
        st.nudged = true; st.phase = 'nurture'; st.lastOutAt = new Date().toISOString(); remember(st, 'out', res.text);
        await saveState(brief, st, { [B.lastSent]: new Date().toISOString(), [B.unanswered]: (brief.fields[B.unanswered] || 0) + 1 });
      } else if (!['already texted today', '2 this week', 'daily cap'].includes(res.reason)) { st.phase = 'nurture'; await saveState(brief, st); }
    } catch (e) { console.error('Alex buyers: nudge ' + brief.id, e.message); }
  }
}

// ---------------------------------------------------------------- Agentbox import outreach (section 7a)

async function importTick() {
  const c = clock();
  const formula = `AND({${B.campaign}}='Import outreach',{${B.status}}='Active',OR({${B.cStage}}='Awaiting approval',{${B.cStage}}='Queued',{${B.cStage}}='First sent',{${B.cStage}}='Nudged'))`;
  const briefs = await listAll(T.briefs, { filterByFormula: formula, 'sort[0][field]': B.created, 'sort[0][direction]': 'desc' });
  let sentToday = null;
  for (const brief of briefs) {
    try {
      const stage = sel(brief.fields[B.cStage]);
      const st = getState(brief);
      if (stage === 'Awaiting approval') {
        if (brief.fields[B.approve]) await updateRecord(T.briefs, brief.id, { [B.cStage]: 'Queued' });
        continue;
      }
      const contact = await primaryContact(brief);
      const agent = await briefAgent(brief, contact);
      if (!contact || !agentLive(agent) || agentPaused(agent)) continue;
      if (stage === 'Queued') {
        if (!brief.fields[B.approve] || !inScheduledWindow(c)) continue;
        if (sentToday === null) sentToday = (await sentCounts('none')).importToday;
        if (sentToday >= IMPORT_DAILY_CAP) continue;
        const skip = async (outcome, note) => updateRecord(T.briefs, brief.id, { [B.cStage]: 'Complete', [B.cOutcome]: outcome, [B.notes]: ((brief.fields[B.notes] || '') + '\nImport outreach skipped: ' + note).trim() });
        if (optedOut(contact)) { await skip('Opted out', 'opted out'); continue; }
        if (!isTextableMobile(contact.fields[C.mobile])) { await skip('No response', 'mobile looks wrong'); continue; }
        if (await isCurrentSeller(contact)) { await skip('No response', 'current seller on an open opportunity'); continue; }
        const others = (await briefsOfContact(contact)).filter(b => b.id !== brief.id && sel(b.fields[B.status]) === 'Active');
        if (others.some(b => minutesSince(getState(b).lastOutAt) < 90 * 1440)) { await skip('No response', 'already being looked after on another brief'); continue; }
        const short = (String(brief.fields[B.source] || '').split(' – ')[1] || '').trim();
        const res = await sendFirstText({ brief, contact, agent, kind: 'import', short });
        if (res.ok) { sentToday++; await updateRecord(T.briefs, brief.id, { [B.cStage]: 'First sent' }); }
        continue;
      }
      // First sent / Nudged: reply handling moves the stage to Replied, so anything here has had no reply
      const days = st.firstSentAt ? daysBetween(clock(new Date(st.firstSentAt)).date, c.date) : 0;
      if (stage === 'First sent' && days >= 3 && inScheduledWindow(c)) {
        const res = await sendToBuyer({ brief, contact, text: nudgeTextFor('import', { first: firstName(contact.fields[C.name]) }), purpose: 'Follow-up nudge', kind: 'initiated' });
        if (res.ok) {
          st.nudged = true; st.lastOutAt = new Date().toISOString(); remember(st, 'out', res.text);
          await saveState(brief, st, { [B.cStage]: 'Nudged', [B.lastSent]: new Date().toISOString(), [B.unanswered]: (brief.fields[B.unanswered] || 0) + 1 });
        }
      } else if (stage === 'Nudged' && days >= 7) {
        st.phase = 'nurture'; st.alexLocked = true;
        await saveState(brief, st, { [B.cStage]: 'Complete', [B.cOutcome]: 'No response', [B.tier]: 'Long-term', [B.lock]: true });
      }
    } catch (e) { console.error('Alex buyers: import ' + brief.id, e.message); }
  }
  await importBatchSummaries();
}

async function importBatchSummaries() {
  const done = await listAll(T.briefs, { filterByFormula: `AND({${B.campaign}}='Import outreach',{${B.batch}}!='')`, 'fields[]': [B.batch, B.cStage, B.cOutcome, B.tier, B.sellOpp, B.state] });
  const batches = new Map();
  for (const b of done) { const k = b.fields[B.batch]; if (!batches.has(k)) batches.set(k, []); batches.get(k).push(b); }
  for (const [batch, list] of batches) {
    if (list.some(b => sel(b.fields[B.cStage]) !== 'Complete') || summarisedBatches.has(batch)) continue;
    const exists = await listAll(T.messages, { filterByFormula: `{${M.code}}='BATCH ${esc(batch)}'`, maxRecords: '1' });
    summarisedBatches.add(batch);
    if (exists.length) continue;
    const n = o => list.filter(b => sel(b.fields[B.cOutcome]) === o).length;
    const tiers = ['Hot', 'Warm', 'Nurture', 'Long-term'].map(t => `${t} ${list.filter(b => ['Qualified', 'Partly qualified'].includes(sel(b.fields[B.cOutcome])) && sel(b.fields[B.tier]) === t).length}`).join(', ');
    const replied = list.filter(b => !['No response', ''].includes(sel(b.fields[B.cOutcome]))).length;
    const text = `Alex: import batch "${batch}" finished. ${list.length} buyers, ${replied} replied (${Math.round(100 * replied / list.length)}%). ` +
      `Qualified ${n('Qualified')} + partly ${n('Partly qualified')} (${tiers}). Not looking ${n('Not looking')}, bought ${n('Bought')}, opted out ${n('Opted out')}, no response ${n('No response')}. ` +
      `Selling opportunities: ${list.filter(b => ids(b.fields[B.sellOpp]).length).length}.`;
    await alertStu(text);
    await createRecord(T.messages, { [M.code]: 'BATCH ' + batch, [M.audience]: 'Buyer', [M.direction]: 'To agent', [M.purpose]: 'Buyer alert to agent', [M.status]: 'Sent', [M.finalText]: text });
  }
}
const summarisedBatches = new Set();

// ---------------------------------------------------------------- qualification (section 4)

const QUESTIONS = [
  { key: 'area', max: 2, done: f => sels(f[B.suburbs]).length || sels(f[B.types]).length, text: 'What sort of place are you after, and which areas?' },
  { key: 'beds', max: 2, done: f => f[B.beds] || sels(f[B.must]).length, text: "How many bedrooms do you need, and anything you can't do without? (garage, single level, a shed...)" },
  { key: 'timeframe', max: 2, done: f => sel(f[B.timeframe]) && sel(f[B.timeframe]) !== 'Unknown', text: 'When are you hoping to be in? Next few months, or more down the track?' },
  { key: 'saleDep', max: 2, done: f => sel(f[B.saleDep]) && sel(f[B.saleDep]) !== 'Unknown', text: 'Do you have a place to sell first?' },
  { key: 'finance', max: 1, done: f => sel(f[B.finance]) && sel(f[B.finance]) !== 'Unknown', text: 'Is finance sorted, or still in the works?' },
  // Always last (Stu, 29 Oct)
  { key: 'price', max: 1, done: f => f[B.pmin] || f[B.pmax], text: "We want to make sure we're not sending properties outside your budget. Are you comfortable sharing a price range we should keep in mind for you?" }
];
function nextQuestion(brief, st) {
  const asked = st.asked || {};
  for (const q of QUESTIONS) {
    if (q.done(brief.fields)) continue;
    if (q.key === 'price' && st.declinedPrice) continue;
    if ((asked[q.key] || 0) >= q.max) continue;
    return q;
  }
  return null;
}
function qualified(brief) { return QUESTIONS.every(q => q.done(brief.fields) || (q.key === 'finance') || (q.key === 'price' && getState(brief).declinedPrice)); }
function listReady(f) { return (sels(f[B.suburbs]).length || sels(f[B.types]).length) && (f[B.beds] || f[B.pmax] || f[B.pmin]); }

function briefSummary(f) {
  const parts = [];
  const subs = sels(f[B.suburbs]); if (subs.length) parts.push('areas: ' + subs.join(', '));
  const types = sels(f[B.types]); if (types.length) parts.push('type: ' + types.join(', '));
  if (f[B.beds]) parts.push(f[B.beds] + '+ beds');
  if (f[B.baths]) parts.push(f[B.baths] + '+ baths');
  if (f[B.pmin] || f[B.pmax]) parts.push('price ' + (f[B.pmin] ? k(f[B.pmin]) : '') + '–' + (f[B.pmax] ? k(f[B.pmax]) : ''));
  const must = sels(f[B.must]); if (must.length) parts.push('must-haves: ' + must.join(', '));
  ['timeframe', 'finance', 'saleDep', 'reason'].forEach(x => { if (sel(f[B[x]])) parts.push(x + ': ' + sel(f[B[x]])); });
  if (f[B.breakers]) parts.push('deal-breakers: ' + f[B.breakers]);
  if (f[B.other]) parts.push('other: ' + f[B.other]);
  return parts.join('; ') || '(nothing known yet)';
}
function shortSummary(f) {
  const bits = [];
  if (f[B.beds]) bits.push(f[B.beds] + '-bed');
  const types = sels(f[B.types]); bits.push((types[0] || 'place').toLowerCase());
  const subs = sels(f[B.suburbs]).filter(s => s !== 'Anywhere in Ballarat'); if (subs.length) bits.push('in ' + subs.slice(0, 2).join(' or '));
  if (f[B.pmax]) bits.push('up to ' + k(f[B.pmax]));
  return bits.join(' ');
}

// ---------------------------------------------------------------- understanding a reply (Claude)

const INTENTS = ['still_looking', 'answer', 'liked_property', 'wants_inspection', 'wants_offer', 'price_question', 'contract_request',
  'property_fact', 'unknown_question', 'not_for_them', 'not_interested_unclear', 'not_looking_now', 'check_in_later_yes', 'check_in_later_no',
  'bought', 'must_sell', 'value_question', 'neighbour', 'neighbour_yes', 'stop', 'complaint', 'who_is_this', 'wants_agent', 'thanks', 'other'];

const READ_SYSTEM = `You read SMS replies from property BUYERS to Alex, the assistant at Stone Real Estate Ballarat, and return JSON only.
Return: {"intent": one of ${JSON.stringify(INTENTS)},
 "reply": "Alex's reply text, see rules",
 "updates": {"suburbs":[],"types":[],"beds":null,"baths":null,"car":null,"land":null,"pmin":null,"pmax":null,"must":[],"breakers":"","other":"","reason":"","finance":"","saleDep":"","timeframe":"","email":""},
 "declined_price": false,
 "property": "address of the listing they are talking about, copied from KNOWN LISTINGS, or empty",
 "feedback": "short note of what they said about that property, or empty",
 "bought": {"address":"","settlement":"YYYY-MM-DD or empty","through":"Stone Ballarat|Another agent|Private sale|Unknown"},
 "agent_note": "one line for the agent summarising what they want, or empty"}
Only fill update keys the buyer actually stated in THIS message (leave others empty/null). Allowed values:
 suburbs ${JSON.stringify(OPT.suburbs)}; types ${JSON.stringify(OPT.types)}; must ${JSON.stringify(OPT.must)};
 reason ${JSON.stringify(OPT.reason)}; finance ${JSON.stringify(OPT.finance)}; saleDep ${JSON.stringify(OPT.saleDep)}; timeframe ${JSON.stringify(OPT.timeframe)}.
 Prices are whole dollars: "around 600" → pmin 570000, pmax 630000; "up to 700" → pmax 700000 only; "600 to 650k" → 600000 / 650000.
 Timeframe "ASAP"/"next couple of months" → "0–3 months"; "this year"/"6 months" → "3–6 months"; "next year" → "6–12 months" or "12+ months" as fits.
 "Pre-approved"/"approval done" → "Pre-approved"; "cash" → "Cash buyer"; "talking to the bank/broker" → "Talking to lender".
 Must sell first only if they need to sell before buying; "already sold"/"unconditional" → "Sold / under contract"; renting/first home → "Nothing to sell".
 declined_price = true if they'd rather not share a budget.
Intent guide: liked_property = liked the inspected home / wants another look → use wants_inspection when they ask to see it (again);
 wants_offer = wants to make an offer or talk price/negotiation; price_question = asks the asking price / price range / guide;
 contract_request = asks for the contract, Section 32 or vendor statement; property_fact = asks something answerable from KNOWN LISTINGS facts;
 unknown_question = asks something not in the facts (building report, rates, body corp, offers received, why selling, open times unless listed);
 not_for_them = a property didn't suit; not_interested_unclear = "not interested" and it's unclear if they mean the property or the texts
 (if PENDING is "clarify" and they now say the texts → stop; the property → not_for_them);
 not_looking_now = not looking at the moment / just browsing / on hold; check_in_later_yes/no = answering "want me to check in every few months?" (PENDING "later");
 bought = they have bought (anywhere) or are answering the bought questions (PENDING "bought"); must_sell = they need to sell first or ask what theirs is worth because they'll sell;
 value_question = asks what their own home is worth without needing to sell first; neighbour = says they live near the listing; neighbour_yes = says yes to an appraisal chat after the neighbour offer;
 stop = wants no more texts; complaint = annoyed, upset, complaint, or asks for legal/finance advice; who_is_this = asks who this is / is this a bot;
 wants_agent = says they'll deal with the agent directly or names an agent to talk to; still_looking = yes still looking (no new detail); answer = gives brief details;
 thanks = thanks / ok with nothing else.
Reply rules (the reply is sent as-is by SMS from Alex, on behalf of the agent):
 - Warm, local, plain Australian English, like a real person. 1-2 short sentences. No emojis. Don't start with filler (Great, Absolutely, Perfect).
 - Do NOT ask any qualifying question (areas, beds, timing, finance, selling, budget) - the system adds the next one.
 - Never give a value or price opinion. Only quote a price by copying a listing's Price exactly from KNOWN LISTINGS. Never invent facts, open times or dates.
 - Never share vendor details, reasons for selling, offers or other buyers' interest. Never promise what the agent will do beyond "I'll get {agent} to ..." / "I'll pass that on".
 - For intents handled by fixed wording (wants_inspection, wants_offer, contract_request, not_interested_unclear, not_looking_now, check_in_later_yes, check_in_later_no, bought, stop, complaint, who_is_this, must_sell, value_question, neighbour, unknown_question) the reply can be empty.
 - For property_fact answer only from the facts given. For answer/still_looking/thanks a short acknowledgement that reflects what they said.`;

async function readReply({ brief, contact, agent, st, text, listings }) {
  const f = brief.fields;
  const facts = listings.map(l => `- ${l.address}${l.stone ? ' (Stone Ballarat listing)' : ''}: ${l.type || ''} ${bbc(l) ? bbc(l) + ' bed/bath/car' : ''}${l.land ? ', ' + l.land + 'm²' : ''}; Price: ${l.price || 'not advertised'}; status ${l.status}${l.link ? '; link ' + l.link : ''}${l.features ? '; features: ' + l.features : ''}`).join('\n');
  const hist = (st.history || []).slice(-8).map(h => `${h.d === 'in' ? 'Buyer' : 'Alex'}: ${h.t}`).join('\n');
  const user = `Agent: ${agentFirst(agent)}. Buyer: ${contact.fields[C.name]}.
Brief so far: ${briefSummary(f)}.
PENDING: ${st.pending || 'none'}. Last qualifying question asked: ${st.lastQ || 'none'}.
KNOWN LISTINGS:
${facts || '(none)'}
Conversation so far:
${hist || '(none)'}
Buyer's new message: "${text}"`;
  const r = await anthropic.messages.create({ model: MODEL, max_tokens: 700, system: READ_SYSTEM, messages: [{ role: 'user', content: user }] });
  const raw = r.content.map(c => c.text || '').join('');
  const m = raw.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON from Claude: ' + raw.slice(0, 200));
  const out = JSON.parse(m[0]);
  if (!INTENTS.includes(out.intent)) out.intent = 'other';
  return out;
}

// Turn Claude's "updates" into safe Airtable fields
function cleanUpdates(u, f) {
  const out = {};
  if (!u) return out;
  const pick = (list, v) => list.find(x => x.toLowerCase() === String(v || '').toLowerCase().trim());
  const subs = (u.suburbs || []).map(s => pick(OPT.suburbs, s)).filter(Boolean);
  if (subs.length) out[B.suburbs] = [...new Set(sels(f[B.suburbs]).concat(subs))];
  const types = (u.types || []).map(s => pick(OPT.types, s)).filter(Boolean);
  if (types.length) out[B.types] = [...new Set(sels(f[B.types]).concat(types))];
  const must = (u.must || []).map(s => pick(OPT.must, s)).filter(Boolean);
  if (must.length) out[B.must] = [...new Set(sels(f[B.must]).concat(must))];
  for (const [key, fld] of [['beds', B.beds], ['baths', B.baths], ['car', B.car], ['land', B.land]]) {
    const n = Number(u[key]); if (u[key] !== null && u[key] !== undefined && u[key] !== '' && isFinite(n) && n > 0 && n < (key === 'land' ? 1e7 : 20)) out[fld] = n;
  }
  for (const [key, fld] of [['pmin', B.pmin], ['pmax', B.pmax]]) {
    const n = Number(u[key]); if (u[key] && isFinite(n) && n >= 50000 && n <= 20000000) out[fld] = Math.round(n);
  }
  if (out[B.pmin] && out[B.pmax] && out[B.pmin] > out[B.pmax]) delete out[B.pmin];
  for (const [key, fld, list] of [['reason', B.reason, OPT.reason], ['finance', B.finance, OPT.finance], ['saleDep', B.saleDep, OPT.saleDep], ['timeframe', B.timeframe, OPT.timeframe]]) {
    const v = pick(list, u[key]); if (v) out[fld] = v;
  }
  if (u.breakers) out[B.breakers] = ((f[B.breakers] ? f[B.breakers] + '; ' : '') + u.breakers).slice(0, 2000);
  if (u.other) out[B.other] = ((f[B.other] ? f[B.other] + '; ' : '') + u.other).slice(0, 2000);
  return out;
}

// ---------------------------------------------------------------- buyer replies (section 5)

const STOP_WORDS = /^\s*(stop|stopall|unsubscribe|unsub|cancel|end|quit|opt ?out|remove me)\s*[.!]*\s*$/i;

async function findBuyerByPhone(from) {
  const contact = await contactByPhone(from);
  if (!contact) return null;
  const briefs = await briefsOfContact(contact);
  const brief = briefs.find(b => ['Active', 'Paused'].includes(sel(b.fields[B.status])))
    || briefs.find(b => sel(b.fields[B.status]) === 'Bought' && minutesSince(b.fields[B.lastReply] || b.fields[B.lastSent]) < 14 * 1440);
  if (!brief) return null;
  const agent = await briefAgent(brief, contact);
  if (!agentLive(agent)) return null;
  // Only take over if Alex has actually texted this buyer (otherwise it's someone else's conversation)
  const st = getState(brief);
  if (!st.firstSentAt && !st.lastOutAt) return null;
  return { contact, brief, agent };
}

async function knownListings(brief, st) {
  const out = [];
  const matches = await getMany(T.matches, ids(brief.fields[B.matches]));
  const relevant = matches.filter(m => ['Sent', 'Interested', 'Inspecting'].includes(sel(m.fields[MT.status])))
    .sort((a, b) => String(b.fields[MT.sentAt] || '').localeCompare(String(a.fields[MT.sentAt] || ''))).slice(0, 6);
  const listingIds = relevant.map(m => linkId(m.fields[MT.listing]));
  if (st.property && st.property.listingId) listingIds.unshift(st.property.listingId);
  const recs = await getMany(T.listings, listingIds);
  for (const l of recs) out.push(listingFacts(l));
  return { listings: out, matches };
}
function matchFor(matches, listings, address) {
  if (!address) return null;
  const a = shortAddress(address).toLowerCase();
  const l = listings.find(x => x.short.toLowerCase() === a || x.address.toLowerCase().includes(a));
  if (!l) return null;
  return { listing: l, match: matches.find(m => linkId(m.fields[MT.listing]) === l.id) || null };
}

async function setMatch(match, status, feedback) {
  if (!match) return;
  const f = { [MT.status]: status };
  if (feedback) f[MT.feedback] = ((match.fields[MT.feedback] ? match.fields[MT.feedback] + '\n' : '') + clock().date + ': ' + feedback).slice(0, 2000);
  await updateRecord(T.matches, match.id, f);
}

// Agent handoff (section 8): task in My Tasks + text alert for urgent / high
const RESPONSE_MINUTES = { urgent: 60, complaint: 120 };
async function handoff({ brief, contact, agent, st, priority, task, alertText, escalateAfter }) {
  const due = priority === 'normal' ? addDays(clock().date, 1) : clock().date;
  const t = await createTask({ brief, contact, agent, task, due, notes: alertText });
  if (priority === 'urgent' || priority === 'high') {
    await textAgent(agent, `Alex: ${alertText} Brief: ${recordLink(BRIEF_PAGE, brief.id)}`, brief, contact);
  }
  if (escalateAfter && t) {
    (st.urgent = st.urgent || []).push({ taskId: t.id, at: new Date().toISOString(), after: escalateAfter, what: alertText, chased: false });
  }
  return t;
}

// Returns true when handled (a buyer Alex is looking after); false to let the other handlers run
async function handleBuyerSMS(from, body) {
  if (!enabled()) return false;
  const found = await findBuyerByPhone(from);
  if (!found) return false;
  const { contact, agent } = found;
  let brief = found.brief;
  const text = String(body || '').trim();
  const st = getState(brief);
  const first = firstName(contact.fields[C.name]);
  const agentName = agentFirst(agent);

  await logMsg({ brief, contact, direction: 'From buyer', purpose: 'Reply to buyer', status: 'Received', text, number: from });
  remember(st, 'in', text);
  st.lastInAt = new Date().toISOString();
  const upd = { [B.lastReply]: new Date().toISOString(), [B.unanswered]: 0 };
  if (st.alexLocked) { upd[B.lock] = false; st.alexLocked = false; }
  if (sel(brief.fields[B.campaign]) === 'Import outreach' && ['Queued', 'First sent', 'Nudged'].includes(sel(brief.fields[B.cStage]))) upd[B.cStage] = 'Replied';
  if (st.phase === 'awaiting_reply' || st.phase === 'held' || !st.phase) st.phase = 'qualifying';
  st.fallbacks = 0;

  const reply = async (msg, purpose, extra) => {
    if (!msg) return null;
    const res = await sendToBuyer(Object.assign({ brief, contact, text: msg, purpose: purpose || 'Reply to buyer', kind: 'reply' }, extra || {}));
    if (res.ok) { remember(st, 'out', res.text); st.lastOutAt = new Date().toISOString(); }
    return res;
  };
  const finish = async (more) => { await saveState(brief, st, Object.assign(upd, more || {})); return true; };

  // 1. STOP
  if (STOP_WORDS.test(text)) return optOut({ brief, contact, agent, st, upd, text, quietTwilio: true });

  // 2. Agent is following up: no automatic reply, just make sure the agent knows
  if (brief.fields[B.following]) {
    await handoff({ brief, contact, agent, st, priority: 'high', task: `${contact.fields[C.name]} replied to Alex – you're following up`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) replied: "${text.slice(0, 200)}" – you're marked as following up, so I haven't answered.` });
    return finish();
  }

  // 3. Understand it
  const { listings, matches } = await knownListings(brief, st);
  let r;
  try { r = await readReply({ brief, contact, agent, st, text, listings }); }
  catch (e) {
    console.error('Alex buyers: read failed', e.message);
    await reply(`Thanks ${first}, I'll pass that on to ${agentName}.`);
    await handoff({ brief, contact, agent, st, priority: 'normal', task: `Reply from ${contact.fields[C.name]} – Alex couldn't read it`, alertText: `"${text.slice(0, 200)}"` });
    return finish();
  }
  const fieldsUpd = cleanUpdates(r.updates, brief.fields);
  Object.assign(upd, fieldsUpd);
  if (r.updates && r.updates.email && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(r.updates.email.trim()) && !contact.fields[C.email]) {
    await updateRecord(T.contacts, contact.id, { [C.email]: r.updates.email.trim() });
    contact.fields[C.email] = r.updates.email.trim();
  }
  if (r.declined_price) st.declinedPrice = true;
  if (Object.keys(fieldsUpd).length) upd[B.checkedOn] = clock().date;
  const prop = matchFor(matches, listings, r.property) || (st.property && st.property.listingId ? { listing: listings.find(l => l.id === st.property.listingId), match: matches.find(m => linkId(m.fields[MT.listing]) === st.property.listingId) } : null);
  const propShort = (prop && prop.listing && prop.listing.short) || (st.property || {}).short || 'the property';
  const allowedPrices = listings.map(l => l.price).filter(Boolean);
  const intent = r.intent;
  const prevPending = st.pending;
  st.pending = null;
  if (sel(brief.fields[B.status]) === 'Paused' && !optedOut(contact) && ['still_looking', 'answer', 'liked_property', 'wants_inspection', 'wants_offer', 'check_in_later_yes'].includes(intent)) {
    upd[B.status] = 'Active'; upd[B.pause] = false;
  }

  let out = '', addQuestion = false;
  switch (intent) {
    case 'stop':
      return optOut({ brief, contact, agent, st, upd, text });

    case 'not_interested_unclear':
      st.pending = 'clarify';
      await reply("Sorry, just to clarify, are you not interested in that property, or would you like me to unsubscribe you from these updates?", 'Not interested clarifier');
      return finish();

    case 'not_for_them':
      if (prop) await setMatch(prop.match, 'Not for them', r.feedback || text);
      if (r.feedback) { const prevB = upd[B.breakers] || brief.fields[B.breakers] || ''; upd[B.breakers] = (prevB + (prevB ? '; ' : '') + `Didn't suit: ${propShort} – ${r.feedback}`).slice(0, 2000); }
      out = prevPending === 'clarify'
        ? `No worries, thanks for letting me know. I'll keep sending ones that might suit better.`
        : `No worries, thanks for letting me know. What didn't work about it? Helps me send better ones.`;
      addQuestion = prevPending === 'clarify';
      break;

    case 'not_looking_now':
      st.pending = 'later';
      await reply("All good. Want me to check in every few months in case that changes?");
      return finish();

    case 'check_in_later_yes':
      st.phase = 'nurture'; st.alexLocked = true;
      upd[B.tier] = 'Long-term'; upd[B.lock] = true;
      if (sel(brief.fields[B.campaign]) === 'Import outreach') { upd[B.cStage] = 'Complete'; upd[B.cOutcome] = 'Not looking'; }
      await reply(`Will do ${first}. I'll check in every few months, and just text me here if anything changes.`);
      return finish();

    case 'check_in_later_no':
      upd[B.status] = 'Paused'; upd[B.pause] = true; st.phase = 'paused';
      if (sel(brief.fields[B.campaign]) === 'Import outreach') { upd[B.cStage] = 'Complete'; upd[B.cOutcome] = 'Not looking'; }
      await reply(`No problem ${first}. If anything changes, just text me here.`);
      return finish();

    case 'bought':
      return boughtFlow({ brief, contact, agent, st, upd, r, prevPending, reply, finish });

    case 'complaint':
      upd[B.pause] = true;
      await reply(`Sorry about that ${first}, I'll get ${agentName} to give you a call.`);
      await handoff({ brief, contact, agent, st, priority: 'urgent', task: `Call ${contact.fields[C.name]} – unhappy / needs a call`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) is unhappy or asked for advice: "${text.slice(0, 200)}". I've paused Alex for them. Please call.`, escalateAfter: RESPONSE_MINUTES.complaint });
      await alertStu(`Alex (buyers): complaint from ${contact.fields[C.name]} (${agentName}'s buyer): "${text.slice(0, 200)}". Alex paused for them; ${agentName} has an urgent task.`);
      await noteComplaint();
      return finish();

    case 'wants_offer':
      if (prop) await setMatch(prop.match, 'Interested', r.feedback || text);
      upd[B.tier] = 'Hot'; upd[B.lock] = true;
      await reply(`Leave that with me ${first}, I'll get ${agentName} to call you shortly.`);
      await handoff({ brief, contact, agent, st, priority: 'urgent', task: `Call ${contact.fields[C.name]} – wants to make an offer on ${propShort}`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) wants to make an offer on ${propShort}. Call ASAP.`, escalateAfter: RESPONSE_MINUTES.urgent });
      return finish();

    case 'liked_property':
    case 'wants_inspection':
      if (prop) await setMatch(prop.match, 'Inspecting', r.feedback || text);
      if (!['Hot', 'Warm'].includes(sel(brief.fields[B.tier]))) { upd[B.tier] = 'Warm'; }
      await reply(intent === 'wants_inspection' || /look|see|inspect|view/i.test(text)
        ? `Great to hear. I'll get ${agentName} to call you to set up another look. Any particular time that suits?`
        : (r.reply || `Good to hear you liked it. Would you like ${agentName} to line up another look?`));
      if (intent === 'wants_inspection' || /look|see|inspect|view/i.test(text)) {
        await handoff({ brief, contact, agent, st, priority: 'high', task: `Book another look at ${propShort} for ${contact.fields[C.name]}`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) wants another look at ${propShort}.` });
      } else st.pending = 'second_look';
      return finish();

    case 'price_question': {
      const l = prop && prop.listing;
      if (l && l.price) {
        out = `It's listed at ${l.price}.${l.link ? ' Details here: ' + l.link : ''}`;
        addQuestion = true;
      } else {
        out = `I'll get ${agentName} to send through the price details for ${propShort}.`;
        await handoff({ brief, contact, agent, st, priority: 'high', task: `Send price details / PPR for ${propShort} to ${contact.fields[C.name]}`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) asked for the price on ${propShort} – Alex doesn't have it.` });
      }
      break;
    }

    case 'contract_request': {
      const email = contact.fields[C.email];
      if (email) {
        out = `No problem, I'll get ${agentName} to send that through to ${email}.`;
        await handoff({ brief, contact, agent, st, priority: 'high', task: `Send contract / Section 32 for ${propShort} to ${contact.fields[C.name]} (${email})`, alertText: `${contact.fields[C.name]} asked for the contract / Section 32 on ${propShort}. Email: ${email}.` });
      } else if (prevPending === 'email' && !(r.updates || {}).email) {
        out = `No worries, I'll get ${agentName} to sort that out with you.`;
        await handoff({ brief, contact, agent, st, priority: 'high', task: `Send contract / Section 32 for ${propShort} to ${contact.fields[C.name]} – no email yet`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) wants the contract / Section 32 on ${propShort} but didn't give an email.` });
      } else {
        st.pending = 'email'; st.pendingDoc = propShort;
        out = 'Sure, what\'s the best email to send it to?';
      }
      break;
    }

    case 'must_sell':
    case 'value_question':
      if (intent === 'must_sell') upd[B.saleDep] = 'Must sell first'; // the brief automation creates the selling opportunity
      out = `Would it help to know what yours might be worth in today's market? ${agentName} can pop round for a quick chat, no obligation.`;
      st.pending = 'appraisal';
      if (intent === 'value_question') await handoff({ brief, contact, agent, st, priority: 'normal', task: `Appraisal chat – ${contact.fields[C.name]} asked what their home is worth`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) asked about the value of their home. Alex offered an in-person chat (never a figure by text).` });
      break;

    case 'neighbour':
      out = `Thanks! If you ever think about selling, ${agentName} is happy to give you a quick idea of value in person.`;
      st.pending = 'neighbour';
      await updateRecord(T.contacts, contact.id, { [C.know]: ((contact.fields[C.know] || '') + `\nLives near ${propShort} (told Alex ${clock().date}).`).trim() });
      break;

    case 'neighbour_yes':
      out = `Lovely, I'll get ${agentName} to give you a call to find a time.`;
      await handoff({ brief, contact, agent, st, priority: 'normal', task: `Appraisal chat with ${contact.fields[C.name]} (neighbour near ${propShort})`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) said yes to a chat about the value of their home.` });
      break;

    case 'who_is_this':
      out = `I'm Alex, Stone Ballarat's assistant. I look after buyer updates for ${agentName} and pass anything important straight to them.`;
      addQuestion = st.phase === 'qualifying';
      break;

    case 'wants_agent':
      out = `No problem, I'll let ${agentName} know.`;
      await handoff({ brief, contact, agent, st, priority: 'high', task: `${contact.fields[C.name]} would like to deal with you directly`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) said: "${text.slice(0, 200)}". I've stepped back – over to you.` });
      upd[B.following] = true;
      break;

    case 'unknown_question':
      out = `Good question, I'll check with ${agentName} and come back to you.`;
      await handoff({ brief, contact, agent, st, priority: 'high', task: `Answer ${contact.fields[C.name]}'s question about ${propShort}`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) asked: "${text.slice(0, 200)}"` });
      break;

    case 'property_fact':
      out = r.reply || `I'll check with ${agentName} and come back to you.`;
      if (!r.reply) await handoff({ brief, contact, agent, st, priority: 'high', task: `Answer ${contact.fields[C.name]}'s question`, alertText: `"${text.slice(0, 200)}"` });
      addQuestion = true;
      break;

    case 'still_looking':
    case 'answer':
    case 'thanks':
      out = r.reply || '';
      if (prevPending === 'email' && (r.updates || {}).email) {
        out = `Thanks, I'll get ${agentName} to send that through to ${contact.fields[C.email]}.`;
        await handoff({ brief, contact, agent, st, priority: 'high', task: `Send contract / Section 32 for ${st.pendingDoc || 'the property'} to ${contact.fields[C.name]} (${contact.fields[C.email]})`, alertText: `${contact.fields[C.name]} asked for the contract / Section 32 on ${st.pendingDoc || 'the property'}. Email: ${contact.fields[C.email]}.` });
      } else if (prevPending === 'appraisal' && /\b(yes|yeah|yep|sure|ok|okay|please)\b/i.test(text)) {
        out = `Lovely, I'll get ${agentName} to give you a call to find a time.`;
        await handoff({ brief, contact, agent, st, priority: 'normal', task: `Appraisal chat with ${contact.fields[C.name]} (buyer who needs to sell)`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) said yes to an in-person chat about what their home is worth.` });
      } else if (prevPending === 'second_look' && /\b(yes|yeah|yep|sure|please)\b/i.test(text)) {
        out = `Great, I'll get ${agentName} to call you to set it up.`;
        await handoff({ brief, contact, agent, st, priority: 'high', task: `Book another look at ${propShort} for ${contact.fields[C.name]}`, alertText: `${contact.fields[C.name]} (${contact.fields[C.mobile]}) wants another look at ${propShort}.` });
      } else addQuestion = true;
      if (st.lastQ === 'price' && !fieldsUpd[B.pmin] && !fieldsUpd[B.pmax] && r.declined_price) st.declinedPrice = true;
      break;

    default: // other
      out = `Thanks ${first}, I'll pass that on to ${agentName}.`;
      upd[B.notes] = ((brief.fields[B.notes] || '') + `\n${clock().date} buyer said: ${text.slice(0, 300)}`).trim();
      await handoff({ brief, contact, agent, st, priority: 'normal', task: `Check ${contact.fields[C.name]}'s reply to Alex`, alertText: `"${text.slice(0, 200)}"` });
  }

  // Next qualifying question (one at a time, max 3 in a row, price last)
  const merged = { fields: Object.assign({}, brief.fields, upd) };
  if (addQuestion && ['qualifying', 'nurture'].includes(st.phase || 'qualifying')) {
    const q = nextQuestion(merged, st);
    if (q && (st.qRow || 0) < 3) {
      out = (out ? out + ' ' : '') + q.text;
      st.asked = st.asked || {}; st.asked[q.key] = (st.asked[q.key] || 0) + 1; st.lastQ = q.key; st.qRow = (st.qRow || 0) + 1;
    } else if (q) {
      out = (out ? out + ' ' : '') + "I'll keep an eye out and send you anything that fits.";
      st.qRow = 0; st.lastQ = null;
    } else {
      st.lastQ = null; st.qRow = 0;
      if (st.phase === 'qualifying') {
        st.phase = 'nurture';
        if (!/keep an eye out/i.test(out)) out = (out ? out + ' ' : '') + "That's really helpful. I'll keep an eye out and send you anything that fits.";
        if (sel(brief.fields[B.campaign]) === 'Import outreach' && sel(brief.fields[B.cStage]) !== 'Complete') { upd[B.cStage] = 'Complete'; upd[B.cOutcome] = 'Qualified'; }
        if (sel(merged.fields[B.tier]) === 'Hot' || computeTier(merged.fields) === 'Hot') {
          await handoff({ brief, contact, agent, st, priority: 'normal', task: `Hot buyer: ${contact.fields[C.name]} – ${shortSummary(merged.fields)}`, alertText: `FYI ${contact.fields[C.name]} is a Hot buyer: ${briefSummary(merged.fields)}.` });
        }
      }
    }
  } else if (!addQuestion) { st.qRow = 0; }
  if (out) {
    const safe = priceSafe(out, allowedPrices);
    if (!safe) {
      out = `Good question, I'll check with ${agentName} and come back to you.`;
      await handoff({ brief, contact, agent, st, priority: 'high', task: `Answer ${contact.fields[C.name]}'s question`, alertText: `"${text.slice(0, 200)}"` });
    }
    await reply(out, 'Reply to buyer', { allowedPrices });
  }
  return finish();
}

// Same thresholds as the Suggested Tier formula
function computeTier(f) {
  const tf = sel(f[B.timeframe]), fin = sel(f[B.finance]), dep = sel(f[B.saleDep]);
  if (tf === '12+ months') return 'Long-term';
  if (tf === '0–3 months' && ['Cash buyer', 'Pre-approved'].includes(fin) && ['Nothing to sell', 'Sold / under contract'].includes(dep)) return 'Hot';
  if (['0–3 months', '3–6 months'].includes(tf) || dep === 'Must sell first') return 'Warm';
  return 'Nurture';
}

async function optOut({ brief, contact, agent, st, upd, text, quietTwilio }) {
  const today = clock().date;
  await updateRecord(T.contacts, contact.id, { [C.optedOut]: today });
  contact.fields[C.optedOut] = today;
  Object.assign(upd, { [B.pause]: true, [B.status]: 'Paused' });
  if (sel(brief.fields[B.campaign]) === 'Import outreach') { upd[B.cStage] = 'Complete'; upd[B.cOutcome] = 'Opted out'; }
  st.phase = 'opted_out';
  const ack = `No worries ${firstName(contact.fields[C.name])}, I've taken you off the list. If anything changes just text me here.`;
  try {
    const sid = await rawSMS(contact.fields[C.mobile], ack);
    await logMsg({ brief, contact, direction: 'To buyer', purpose: 'Opt-out confirmation', status: 'Sent', text: ack, number: contact.fields[C.mobile], sid });
  } catch (e) { if (!quietTwilio) console.error('Alex buyers: opt-out ack failed', e.message); }
  await saveState(brief, st, upd);
  await alertStu(`Alex (buyers): ${contact.fields[C.name]} (${agentFirst(agent)}'s buyer) opted out – "${String(text).slice(0, 100)}".`);
  await checkOptOutRate();
  return true;
}

// Bought (section 7): congratulate → address → settlement → done. Missing details are not chased.
async function boughtFlow({ brief, contact, agent, st, upd, r, prevPending, reply, finish }) {
  const first = firstName(contact.fields[C.name]);
  st.bought = st.bought || {};
  const b = r.bought || {};
  if (b.address) st.bought.address = b.address;
  if (b.settlement && /^\d{4}-\d{2}-\d{2}$/.test(b.settlement)) st.bought.settlement = b.settlement;
  if (b.through && OPT.through.includes(b.through) && b.through !== 'Unknown') st.bought.through = b.through;
  const step = st.bought.step || 0;
  if (!st.bought.address && step < 1) {
    st.bought.step = 1; st.pending = 'bought';
    await reply(`Congratulations ${first}! Where did you end up buying?`, 'Bought congratulations');
    return finish();
  }
  if (!st.bought.settlement && step < 2) {
    st.bought.step = 2; st.pending = 'bought';
    await reply(`Lovely. When does it settle?`, 'Bought congratulations');
    return finish();
  }
  // Done: Status Bought → the brief automation adds them to Sales Nurturing for the anniversary touch.
  // No address / settlement given: first follow-up 12 months from today (Stu, 29 Oct).
  Object.assign(upd, {
    [B.status]: 'Bought', [B.pause]: true,
    [B.boughtAddr]: st.bought.address || 'Address not given',
    [B.settle]: st.bought.settlement || null,
    [B.through]: st.bought.through || 'Unknown'
  });
  if (sel(brief.fields[B.campaign]) === 'Import outreach') { upd[B.cStage] = 'Complete'; upd[B.cOutcome] = 'Bought'; }
  st.phase = 'bought'; st.pending = null;
  await reply(`Wonderful, all the best with the move. I'll take you off the property alerts.`, 'Bought congratulations');
  const skipped = (await getMany(T.matches, ids(brief.fields[B.matches]))).filter(m => ['New', 'Sent', 'Interested', 'Inspecting'].includes(sel(m.fields[MT.status])));
  for (const m of skipped) await updateRecord(T.matches, m.id, { [MT.status]: 'Skipped' });
  if (st.bought.through === 'Stone Ballarat') {
    await handoff({ brief, contact, agent, st, priority: 'normal', task: `FYI ${contact.fields[C.name]} bought ${st.bought.address || ''} through Stone`, alertText: `${contact.fields[C.name]} told Alex they bought ${st.bought.address || 'a home'} through Stone. Moved to Sales Nurturing.` });
  }
  return finish();
}

// ---------------------------------------------------------------- nurture by tier (section 6)

const DROP = { Hot: 'Warm', Warm: 'Nurture', Nurture: 'Long-term' };
function listLine(n, l) {
  const bits = [`${n}. ${l.short}${l.suburb && !l.short.toLowerCase().includes(l.suburb.toLowerCase()) ? ', ' + l.suburb : ''}`];
  if (bbc(l)) bits.push(bbc(l));
  if (l.status === 'Coming soon') bits.push('coming soon');
  else if (l.price) bits.push(l.price);
  let line = bits.join(' - ');
  if (l.stone) line += ' (one of ours)';
  if (l.link && l.status !== 'Coming soon') line += ' ' + l.link;
  return line;
}

async function nurtureTick() {
  const c = clock();
  if (!inScheduledWindow(c)) return;
  const formula = `AND({${B.status}}='Active',NOT({${B.pause}}),NOT({${B.following}}),{${B.state}}!='',OR({${B.nextSend}}='',NOT(IS_AFTER({${B.nextSend}},'${c.date}'))))`;
  const briefs = await listAll(T.briefs, { filterByFormula: formula, 'sort[0][field]': B.nextSend, 'sort[0][direction]': 'asc' });
  for (const brief of briefs) {
    try { await nurtureOne(brief, c); } catch (e) { console.error('Alex buyers: nurture ' + brief.id, e.message); }
  }
}

async function nurtureOne(brief, c) {
  const st = getState(brief);
  const f = brief.fields;
  const camp = sel(f[B.campaign]) === 'Import outreach' ? sel(f[B.cStage]) : null;
  if (camp && ['Awaiting approval', 'Queued', 'First sent', 'Nudged'].includes(camp)) return;
  if (camp === 'Replied' && minutesSince(st.lastInAt) > 7 * 1440) {
    await updateRecord(T.briefs, brief.id, { [B.cStage]: 'Complete', [B.cOutcome]: qualified(brief) ? 'Qualified' : 'Partly qualified' });
  }
  if (st.phase === 'held') { if (new Date(st.heldUntil || 0) > new Date()) return; st.phase = 'nurture'; }
  if (!['nurture', 'qualifying'].includes(st.phase)) return;
  if (!f[B.lastSent] && !st.firstSentAt) return; // never contacted: first text flows look after these
  if (f[B.lastSent] && minutesSince(f[B.lastSent]) < 3 * 1440) return; // a recent first text / nudge sets Last Sent
  const contact = await primaryContact(brief);
  if (!contact || optedOut(contact)) return;
  const agent = await briefAgent(brief, contact);
  if (!agentLive(agent) || agentPaused(agent)) return;
  const first = firstName(contact.fields[C.name]);
  const tier = sel(f[B.tier]) || 'Nurture';
  const after = { [B.lastSent]: new Date().toISOString(), [B.unanswered]: (f[B.unanswered] || 0) + 1 };
  let text, purpose, matchRecs = [], listingRecs = [];

  st.sendCount = (st.sendCount || 0) + 1;
  const optOutDue = st.sendCount % 4 === 0;

  if ((f[B.unanswered] || 0) >= 3) {
    if (tier === 'Long-term') {
      st.phase = 'paused';
      await saveState(brief, st, { [B.status]: 'Paused', [B.pause]: true, [B.notes]: ((f[B.notes] || '') + `\n${c.date}: paused by Alex – Long-term and 3 texts unanswered.`).trim() });
      quietPaused.push(`${contact.fields[C.name]} (${agentFirst(agent)})`);
      return;
    }
    text = `No pressure ${first}, I'll check in less often. Just text if you want more.`;
    purpose = 'Brief re-check';
    Object.assign(after, { [B.tier]: DROP[tier] || 'Long-term', [B.lock]: true, [B.unanswered]: 0 });
    st.alexLocked = true;
  } else {
    const recheckDays = ['Hot', 'Warm'].includes(tier) ? 60 : 90;
    const checked = f[B.checkedOn];
    if (listReady(f) && checked && daysBetween(checked, c.date) >= recheckDays) {
      text = `Hi ${first}, quick check: still looking for a ${shortSummary(f)}? Anything changed with timing or budget?`;
      purpose = 'Brief re-check';
      after[B.checkedOn] = c.date;
    } else if (!listReady(f)) {
      const q = nextQuestion(brief, st);
      if (q) {
        text = `Hi ${first}, Alex here from Stone. Still keen to help you find the right place. ${q.text}`;
        purpose = 'Qualifying question';
        st.asked = st.asked || {}; st.asked[q.key] = (st.asked[q.key] || 0) + 1; st.lastQ = q.key; st.phase = 'qualifying';
      }
    }
    if (!text && listReady(f)) {
      const matches = (await getMany(T.matches, ids(f[B.matches]))).filter(m => sel(m.fields[MT.status]) === 'New' && (m.fields[MT.score] || 0) >= 40);
      const ls = await getMany(T.listings, matches.map(m => linkId(m.fields[MT.listing])));
      const pairs = matches.map(m => ({ m, l: ls.find(x => x.id === linkId(m.fields[MT.listing])) })).filter(p => p.l)
        .map(p => ({ m: p.m, l: listingFacts(p.l) }))
        .filter(p => ['For sale', 'Coming soon'].includes(p.l.status))
        .sort((a, b) => (b.l.stone - a.l.stone) || ((b.m.fields[MT.score] || 0) - (a.m.fields[MT.score] || 0)))
        .slice(0, 3);
      if (pairs.length) {
        const intro = st.mention ? `Hi ${first}, Alex here from Stone. Thanks for coming through ${st.mention} too. A few others that might suit:` : `Hi ${first}, Alex here from Stone. A few that might suit:`;
        text = intro + '\n' + pairs.map((p, i) => listLine(i + 1, p.l)).join('\n') + '\nAny catch your eye? Happy to line up a look.';
        purpose = 'Curated list';
        matchRecs = pairs.map(p => p.m); listingRecs = pairs.map(p => p.l);
        st.fallbacks = 0; st.mention = null;
      }
    }
    if (!text) {
      st.fallbacks = (st.fallbacks || 0) + 1;
      if (st.fallbacks >= 3 && listReady(f)) {
        text = `Hi ${first}, Alex from Stone. Still nothing new that fits a ${shortSummary(f)}. Would you consider a nearby suburb or a bit more on price?`;
        st.fallbacks = 0;
      } else {
        text = `Hi ${first}, Alex from Stone. I couldn't find any new matches for you this time. Let me know if your situation has changed (areas, budget or timing) and I'll widen the search. If you'd rather not hear from me, just reply STOP.`;
      }
      purpose = 'No-match touch point';
    }
  }
  if (optOutDue && !/STOP/.test(text)) text += ' ' + optOutFor(contact);
  const res = await sendToBuyer({ brief, contact, text, purpose, kind: 'initiated', allowedPrices: listingRecs.map(l => l.price).filter(Boolean), match: matchRecs[0] });
  if (!res.ok) { st.sendCount--; return; }
  for (const m of matchRecs) await updateRecord(T.matches, m.id, { [MT.status]: 'Sent', [MT.sentAt]: new Date().toISOString() });
  st.lastOutAt = new Date().toISOString(); remember(st, 'out', res.text);
  st.watch = st.watch || {};
  for (let i = 0; i < matchRecs.length; i++) st.watch[matchRecs[i].id] = { status: listingRecs[i].status, price: listingRecs[i].price };
  await saveState(brief, st, after);
}
const quietPaused = [];

// ---------------------------------------------------------------- events (section 7)

async function eventTick() {
  const c = clock();
  if (!inScheduledWindow(c)) return;
  // 1. Instant match / coming soon
  const since = new Date(Date.now() - 2 * 864e5).toISOString();
  const fresh = await listAll(T.matches, { filterByFormula: `AND({${MT.status}}='New',IS_AFTER({${MT.matchedAt}},'${since}'))` });
  const byBrief = new Map();
  for (const m of fresh) { const b = linkId(m.fields[MT.brief]); if (!byBrief.has(b)) byBrief.set(b, []); byBrief.get(b).push(m); }
  for (const [briefId, ms] of byBrief) {
    try {
      const brief = await getRecord(T.briefs, briefId);
      const f = brief.fields;
      if (sel(f[B.status]) !== 'Active' || f[B.pause] || f[B.following]) continue;
      const st = getState(brief);
      if (!['nurture', 'qualifying'].includes(st.phase) || !listReady(f)) continue;
      const tier = sel(f[B.tier]);
      const ls = (await getMany(T.listings, ms.map(m => linkId(m.fields[MT.listing])))).map(listingFacts);
      const cand = ms.map(m => ({ m, l: ls.find(x => x.id === linkId(m.fields[MT.listing])) })).filter(p => p.l && ['For sale', 'Coming soon'].includes(p.l.status))
        .filter(p => (tier === 'Hot' && ((p.m.fields[MT.score] || 0) >= 70 || p.l.stone)) || (p.l.stone && (tier === 'Warm' || (tier === 'Hot'))))
        .sort((a, b) => (b.l.stone - a.l.stone) || ((b.m.fields[MT.score] || 0) - (a.m.fields[MT.score] || 0)));
      if (!cand.length) continue;
      const { m, l } = cand[0];
      const contact = await primaryContact(brief);
      const agent = await briefAgent(brief, contact);
      if (!contact || !agentLive(agent) || agentPaused(agent)) continue;
      const first = firstName(contact.fields[C.name]);
      const listAgent = agentFirst(agent);
      const text = l.status === 'Coming soon'
        ? `Hi ${first}, heads-up before it's advertised: ${listAgent} is about to list ${l.short}${bbc(l) ? ', ' + l.beds + ' bed' : ''} in ${l.suburb}. Want first look?`
        : `Hi ${first}, just listed and I thought of you: ${l.short}${l.suburb ? ', ' + l.suburb : ''}${bbc(l) ? ' - ' + bbc(l) : ''}${l.price ? ' - ' + l.price : ''}${l.link ? ' ' + l.link : ''}. Want me to get ${listAgent} to book you in?`;
      const res = await sendToBuyer({ brief, contact, text, purpose: l.status === 'Coming soon' ? 'Coming soon alert' : 'Instant match', kind: 'initiated', allowedPrices: [l.price].filter(Boolean), match: m });
      if (!res.ok) continue;
      await updateRecord(T.matches, m.id, { [MT.status]: 'Sent', [MT.sentAt]: new Date().toISOString() });
      st.lastOutAt = new Date().toISOString(); remember(st, 'out', res.text);
      st.watch = st.watch || {}; st.watch[m.id] = { status: l.status, price: l.price };
      st.pending = 'second_look';
      await saveState(brief, st, { [B.unanswered]: (f[B.unanswered] || 0) + 1 });
    } catch (e) { console.error('Alex buyers: instant match ' + briefId, e.message); }
  }
  // 2. Price change / under offer / sold on listings we've sent
  const watched = await listAll(T.briefs, { filterByFormula: `AND({${B.status}}='Active',NOT({${B.pause}}),FIND('"watch":{"',{${B.state}}&''))` });
  for (const brief of watched) {
    try {
      const st = getState(brief);
      const mids = Object.keys(st.watch || {});
      if (!mids.length) continue;
      const ms = await getMany(T.matches, mids);
      const ls = (await getMany(T.listings, ms.map(m => linkId(m.fields[MT.listing])))).map(listingFacts);
      let changed = false;
      for (const m of ms) {
        const l = ls.find(x => x.id === linkId(m.fields[MT.listing]));
        if (!l) continue;
        const w = st.watch[m.id] || {};
        const mStatus = sel(m.fields[MT.status]);
        if (mStatus === 'Not for them' || mStatus === 'Skipped') { delete st.watch[m.id]; changed = true; continue; }
        let text = null, purpose = null;
        const keen = ['Interested', 'Inspecting'].includes(mStatus);
        if (l.status !== w.status && l.status === 'Under offer' && keen) {
          text = `Just letting you know ${l.short} is now under offer. I'll keep looking for something similar.`; purpose = 'Under offer / sold notice';
        } else if (l.status !== w.status && l.status === 'Sold' && keen) {
          text = `${l.short} has sold. I'll keep an eye out for similar ones and send them through.`; purpose = 'Under offer / sold notice';
        } else if (l.status === 'For sale' && w.status === 'Coming soon' && l.price && ['Sent', 'Interested'].includes(mStatus)) {
          text = `${l.short} is now on the market at ${l.price}.${l.link ? ' ' + l.link : ''} Want me to line up a look?`; purpose = 'Coming soon alert';
        } else if (l.status === 'For sale' && w.price && l.price && l.price !== w.price && ['Sent', 'Interested'].includes(mStatus)) {
          const pmax = brief.fields[B.pmax];
          if (!pmax || !l.lo || l.lo <= pmax * 1.05) { text = `Update on ${l.short}: it's now listed at ${l.price}. Still of interest?`; purpose = 'Price change'; }
        }
        if (text) {
          const contact = await primaryContact(brief);
          const agent = await briefAgent(brief, contact);
          if (!contact || !agentLive(agent) || agentPaused(agent)) continue;
          const res = await sendToBuyer({ brief, contact, text, purpose, kind: 'initiated', allowedPrices: [l.price].filter(Boolean), match: m });
          if (!res.ok) continue; // try again next tick (watch not updated)
          st.lastOutAt = new Date().toISOString(); remember(st, 'out', res.text);
        }
        if (w.status !== l.status || w.price !== l.price) { st.watch[m.id] = { status: l.status, price: l.price }; changed = true; }
        if (['Sold', 'Withdrawn'].includes(l.status)) { delete st.watch[m.id]; changed = true; }
      }
      if (changed) await saveState(brief, st);
    } catch (e) { console.error('Alex buyers: watch ' + brief.id, e.message); }
  }
}

// ---------------------------------------------------------------- escalation, summary, auto-pause (sections 8–10)

async function escalateTick() {
  const briefs = await listAll(T.briefs, { filterByFormula: `FIND('"chased":false',{${B.state}}&'')` });
  for (const brief of briefs) {
    const st = getState(brief);
    let changed = false;
    for (const u of st.urgent || []) {
      if (u.chased) continue;
      const t = await getRecord(T.tasks, u.taskId).catch(() => null);
      if (!t || sel(t.fields[TK.status]) !== 'Open') { u.chased = true; changed = true; continue; }
      if (minutesSince(u.at) >= (u.after || 60)) {
        const contact = await primaryContact(brief);
        const agent = await briefAgent(brief, contact);
        await textAgent(agent, `Alex: reminder – ${u.what}`, brief, contact);
        await alertStu(`Alex (buyers): ${agentFirst(agent)} hasn't actioned this yet (${Math.round(minutesSince(u.at))} min): ${u.what}`);
        if (contact) {
          const first = firstName(contact.fields[C.name]);
          if (!st.chaseReplied) { await sendToBuyer({ brief, contact, text: `${agentFirst(agent)}'s been tied up ${first}, I've flagged it again and they'll call you shortly.`, purpose: 'Reply to buyer', kind: 'reply' }); st.chaseReplied = true; }
        }
        u.chased = true; changed = true;
      }
    }
    if (changed) { st.urgent = (st.urgent || []).filter(u => !u.chased || minutesSince(u.at) < 3 * 1440); await saveState(brief, st); }
  }
}

async function summaryTick() {
  const c = clock();
  if (c.hour !== 17 || c.weekday === 'Sun') return;
  const code = 'BSUM ' + c.date;
  if (summaryDone === c.date) return;
  const exists = await listAll(T.messages, { filterByFormula: `{${M.code}}='${code}'`, maxRecords: '1' });
  if (exists.length) { summaryDone = c.date; return; }
  const since = melbToISO(c.date, 0, 0);
  const msgs = await listAll(T.messages, { filterByFormula: `AND({${M.audience}}='Buyer',IS_AFTER({${M.created}},'${since}'))`, 'fields[]': [M.direction, M.status, M.purpose] });
  const n = (fn) => msgs.filter(fn).length;
  const sent = n(m => sel(m.fields[M.direction]) === 'To buyer' && sel(m.fields[M.status]) === 'Sent');
  const replies = n(m => sel(m.fields[M.direction]) === 'From buyer');
  const failed = n(m => sel(m.fields[M.status]) === 'Failed');
  const optouts = n(m => sel(m.fields[M.purpose]) === 'Opt-out confirmation');
  const alerts = n(m => sel(m.fields[M.direction]) === 'To agent');
  const tasks = await listAll(T.tasks, { filterByFormula: `AND({${TK.source}}='Alex',{${TK.brief}}!='',IS_AFTER(CREATED_TIME(),'${since}'))`, 'fields[]': [TK.task] });
  const text = `Alex buyers today: ${sent} texts sent, ${replies} replies, ${tasks.length} agent tasks, ${alerts} agent alerts, ${optouts} opt-outs${failed ? ', ' + failed + ' failed' : ''}.` +
    (quietPaused.length ? ` Paused (Long-term, no replies): ${quietPaused.splice(0).join(', ')}.` : '') +
    ` Review: ${recordLink(REVIEW_PAGE, '').replace(/\/$/, '')}`;
  await alertStu(text);
  await createRecord(T.messages, { [M.code]: code, [M.audience]: 'Buyer', [M.direction]: 'To agent', [M.purpose]: 'Buyer alert to agent', [M.status]: 'Sent', [M.finalText]: text });
  summaryDone = c.date;
}
let summaryDone = null;

async function pauseAll(reason) {
  for (const t of await teamRows()) if (agentLive(t) && !agentPaused(t)) await updateRecord(T.team, t.id, { [TM.pauseBuyers]: true });
  teamChanged();
  await alertStu(`Alex (buyers): scheduled buyer texts paused for everyone – ${reason}. Untick Pause Buyer Texts on the Team table (or text RESUME ALL BUYERS) to restart.`);
}
async function checkOptOutRate() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const msgs = await listAll(T.messages, { filterByFormula: `AND({${M.audience}}='Buyer',{${M.direction}}='To buyer',IS_AFTER({${M.created}},'${since}'))`, 'fields[]': [M.purpose, M.status] });
  const optouts = msgs.filter(m => sel(m.fields[M.purpose]) === 'Opt-out confirmation').length;
  const sends = msgs.filter(m => sel(m.fields[M.status]) === 'Sent' && !REPLY_PURPOSES.includes(sel(m.fields[M.purpose]))).length;
  if (sends >= 20 && optouts / sends > 0.05) await pauseAll(`${optouts} opt-outs from ${sends} texts this week (over 5%)`);
}
async function noteComplaint() {
  const since = new Date(Date.now() - 7 * 864e5).toISOString();
  const msgs = await listAll(T.messages, { filterByFormula: `AND({${M.audience}}='Buyer',{${M.direction}}='To agent',IS_AFTER({${M.created}},'${since}'),FIND('complaint from',{${M.finalText}}&''))`, 'fields[]': [M.finalText] });
  if (msgs.length >= 3) await pauseAll(`${msgs.length} complaints this week`);
}

// ---------------------------------------------------------------- agent commands

// Texts from team members: HOLD ALL / HOLD <names>, PAUSE BUYERS / RESUME BUYERS (Stu: PAUSE ALL BUYERS / RESUME ALL BUYERS)
async function handleAgentCommand(from, body) {
  if (!enabled()) return false;
  const text = String(body || '').trim();
  if (!/^(hold\b|pause( all)? buyers\b|resume( all)? buyers\b)/i.test(text)) return false;
  const member = await teamByPhone(from);
  if (!member && !isApprover(from)) return false;
  const say = msg => rawSMS(from, msg).catch(e => console.error('Alex buyers: command reply failed', e.message));
  if (/^hold\b/i.test(text)) {
    if (!member) return false;
    await say(await handleHold(member, text));
    return true;
  }
  if (/^pause all buyers/i.test(text) || /^resume all buyers/i.test(text)) {
    if (!isApprover(from)) { await say('Only Stu can pause or resume everyone. Try PAUSE BUYERS for just yours.'); return true; }
    const on = /^pause/i.test(text);
    for (const t of await teamRows()) if (agentLive(t)) await updateRecord(T.team, t.id, { [TM.pauseBuyers]: on });
    teamChanged();
    await say(on ? 'Done – Alex has paused scheduled texts to all buyers. Replies to buyers who text in still go.' : 'Done – Alex is back on for all buyers.');
    return true;
  }
  if (!member) return false;
  const on = /^pause/i.test(text);
  await updateRecord(T.team, member.id, { [TM.pauseBuyers]: on });
  teamChanged();
  await say(on ? "Done – I've paused scheduled texts to your buyers. Text RESUME BUYERS to start again." : "Done – I'm back on for your buyers.");
  return true;
}

// ---------------------------------------------------------------- start

let fastTimer = null, slowTimer = null;
function start() {
  if (fastTimer) return;
  if (!enabled()) { console.log('Alex buyers: off (set ALEX_BUYERS_ENABLED=true and AIRTABLE_TOKEN)'); return; }
  console.log('Alex buyers: on – go-live date ' + goLiveDate() + ', daily cap ' + DAILY_CAP + ', import cap ' + IMPORT_DAILY_CAP);
  let fastBusy = false, slowBusy = false;
  const fast = async () => {
    if (fastBusy) return; fastBusy = true;
    for (const [name, fn] of [['check-ins', checkinTick], ['new briefs', newBriefTick], ['nudges', nudgeTick], ['escalation', escalateTick]]) {
      try { await fn(); } catch (e) { console.error('Alex buyers: ' + name + ' tick failed', e.message); }
    }
    fastBusy = false;
  };
  const slow = async () => {
    if (slowBusy) return; slowBusy = true;
    for (const [name, fn] of [['import', importTick], ['events', eventTick], ['nurture', nurtureTick], ['summary', summaryTick]]) {
      try { await fn(); } catch (e) { console.error('Alex buyers: ' + name + ' tick failed', e.message); }
    }
    slowBusy = false;
  };
  fastTimer = setInterval(fast, 2 * 60000);
  slowTimer = setInterval(slow, 15 * 60000);
  setTimeout(fast, 60000);
  setTimeout(slow, 90000);
}

module.exports = {
  start, enabled, handleBuyerSMS, handleAgentCommand,
  // exposed for testing
  _t: { checkinTick, newBriefTick, nudgeTick, importTick, nurtureTick, eventTick, escalateTick, summaryTick, nextQuestion, cleanUpdates, priceSafe, firstTextFor, computeTier, listLine, inScheduledWindow, inspectionFollowUpOK, melbToISO, clock }
};
