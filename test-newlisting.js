// Offline tests for new-listing campaigns (alex-buyers.js campaignTick, Stu 14 Nov)
const assert = require('assert');
const path = require('path');

// ---------- fake clock
const RealDate = Date;
let NOW = new RealDate('2026-10-29T01:00:00Z').getTime(); // Thu 12:00pm Melbourne
class FakeDate extends RealDate {
  constructor(...a) { if (a.length) super(...a); else super(NOW); }
  static now() { return NOW; }
}
global.Date = FakeDate;
function advance(mins) { NOW += mins * 60000; }

// ---------- fake Twilio
const sent = [];
const twilioStub = () => ({ messages: { create: async ({ to, body }) => { sent.push({ to, body }); return { sid: 'SM' + sent.length }; } } });
require.cache[require.resolve('twilio')] = { id: 'twilio', filename: 'twilio', loaded: true, exports: twilioStub };

// ---------- fake Claude
let claudeQueue = [];
let claudeCalls = [];
class AnthropicStub { constructor() { this.messages = { create: async (p) => { claudeCalls.push(p); const nxt = claudeQueue.shift() || { intent: 'other', reply: '' }; return { content: [{ text: JSON.stringify(nxt) }] }; } }; } }
require.cache[require.resolve('@anthropic-ai/sdk')] = { id: 'a', filename: 'a', loaded: true, exports: AnthropicStub };

// ---------- fake Airtable
const db = {}; // table -> Map(id -> {id, createdTime, fields})
let seq = 1;
function table(t) { if (!db[t]) db[t] = new Map(); return db[t]; }
function newId() { return 'rec' + String(seq++).padStart(14, '0'); }
function add(t, fields, createdTime) { const id = newId(); table(t).set(id, { id, createdTime: createdTime || new RealDate(NOW).toISOString(), fields: Object.assign({}, fields) }); return id; }

// createdTime fields per table (computed)
const CREATED = { tbl78WnIpym0PEutf: 'fldRowPux9k4y7f7f', tbl43WTbzYyauRMhd: 'fld1qKffhUxl7GmNX', tblANNW7LRvFFgMcD: 'fldZYcGxRUsmKSnXT', tblTVym6dw3M8rt0Z: 'fld35kHcfNNCDpQtN', tblQ9Z4lvKpxjWkJL: 'fldnREWWWDHeorGqU' };
function view(t, r) { const f = Object.assign({}, r.fields); if (CREATED[t]) f[CREATED[t]] = r.createdTime; return { id: r.id, createdTime: r.createdTime, fields: f }; }

// Formula → JS (enough for the formulas alex-buyers uses)
function evalFormula(formula, rec) {
  let js = formula
    .replace(/\{(fld[A-Za-z0-9]{14})\}/g, (m, id) => `F(${JSON.stringify(id)})`)
    .replace(/RECORD_ID\(\)/g, 'RID')
    .replace(/CREATED_TIME\(\)/g, 'CT')
    .replace(/([^!<>=])=([^=])/g, '$1==$2')
    .replace(/!==/g, '!=')
    .replace(/&/g, '+');
  const F = id => { const v = rec.fields[id]; if (v === undefined || v === null) return ''; if (Array.isArray(v)) return v.join(', '); if (v === true) return 1; if (v === false) return 0; return v; };
  const AND = (...a) => a.every(Boolean), OR = (...a) => a.some(Boolean), NOT = a => !a;
  const FIND = (n, h) => String(h).indexOf(n) + 1;
  const IS_AFTER = (a, b) => !!a && new RealDate(a) > new RealDate(b);
  const RIGHT = (s, n) => String(s).slice(-n);
  const REGEX_REPLACE = (s, re, rep) => String(s).replace(new RegExp(re, 'g'), rep);
  const RID = rec.id, CT = rec.createdTime;
  // eslint-disable-next-line no-new-func
  return Function('F', 'AND', 'OR', 'NOT', 'FIND', 'IS_AFTER', 'RIGHT', 'REGEX_REPLACE', 'RID', 'CT', 'return (' + js + ');')(F, AND, OR, NOT, FIND, IS_AFTER, RIGHT, REGEX_REPLACE, RID, CT);
}
const SELECT_FIELDS = new Set(); // not needed: we store selects as strings already
function applyFields(t, rec, fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) rec.fields[k] = v.map(x => (typeof x === 'object' && x && x.id ? x.id : x));
    else if (v && typeof v === 'object' && v.name) rec.fields[k] = v.name;
    else if (v === null || v === false || v === '') delete rec.fields[k];
    else rec.fields[k] = v;
  }
}
global.fetch = async (url, opts) => {
  const u = new URL(url);
  const parts = u.pathname.split('/').filter(Boolean); // v0, base, table, [id]
  const t = parts[2], id = parts[3];
  const method = (opts && opts.method) || 'GET';
  const ok = (body) => ({ ok: true, status: 200, json: async () => body });
  if (method === 'GET' && id) { const r = table(t).get(id); if (!r) return { ok: false, status: 404, json: async () => ({ error: 'NOT_FOUND' }) }; return ok(view(t, r)); }
  if (method === 'GET') {
    const formula = u.searchParams.get('filterByFormula');
    let recs = [...table(t).values()].map(r => view(t, r));
    if (formula) recs = recs.filter(r => { try { return evalFormula(formula, r); } catch (e) { throw new Error('formula failed: ' + formula + ' :: ' + e.message); } });
    const sf = u.searchParams.get('sort[0][field]');
    if (sf) { const dir = u.searchParams.get('sort[0][direction]') === 'desc' ? -1 : 1; recs.sort((a, b) => String(a.fields[sf] || '').localeCompare(String(b.fields[sf] || '')) * dir); }
    const max = u.searchParams.get('maxRecords'); if (max) recs = recs.slice(0, +max);
    return ok({ records: recs });
  }
  const body = JSON.parse(opts.body);
  if (method === 'POST') {
    const out = body.records.map(r => { const nid = add(t, {}); applyFields(t, table(t).get(nid), r.fields); return view(t, table(t).get(nid)); });
    return ok({ records: out });
  }
  if (method === 'PATCH') {
    const out = body.records.map(r => { const rec = table(t).get(r.id); if (!rec) throw new Error('PATCH missing ' + r.id); applyFields(t, rec, r.fields); return view(t, rec); });
    return ok({ records: out });
  }
  if (method === 'DELETE') { table(t).delete(id); return ok({ deleted: true }); }
  throw new Error('unsupported ' + method);
};
process.env.AIRTABLE_TOKEN = 'x'; process.env.ALEX_BUYERS_ENABLED = 'true'; process.env.APPROVER_MOBILE = '0400000001'; process.env.ALEX_PHONE_NUMBER = '+61400000999';
process.env.BUYERS_GO_LIVE = '2026-10-01';
const AB = require('./alex-buyers.js');
const T = AB._t;
const TEAM = 'tbl1aNcrdwmamMyEF', CON = 'tblWRqWCqXWP708dY', BR = 'tbl43WTbzYyauRMhd', MAT = 'tblQ9Z4lvKpxjWkJL', LIS = 'tblvJCPHTQBgdYGZu', CMP = 'tbl17x0s7HkrX1oZ0';
const stu = add(TEAM, { fldWZzjCL3xoU0l82: 'Stu Brien', fldbxwqujqA0rygi9: 'Stu', fldUZ1RQT4BNOo41n: '0400 000 001', fld8McuiVqyHAYduE: true, fldVcSz2oIHrhKOw6: true });
const people = [['Hana Hot', '0412 100 001', 'Hot'], ['Wes Warm', '0412 100 002', 'Warm'], ['Nell Nurture', '0412 100 003', 'Nurture'], ['Lou Longterm', '0412 100 004', 'Long-term'], ['Ivy Import', '0412 100 005', 'Nurture']];
const briefs = people.map(([name, mob, tier]) => {
  const c = add(CON, { fld5hDJRpN92YZnFx: name, fld0EA8biRz66il05: mob, fldHsGhaiVWBnYX23: [stu] });
  const b = add(BR, { fldEmtwK9XFwcQ9M1: name, fldKRyZ83PSx8LJNq: [c], fldXrAXCEFqm98MLV: 'Active', fldJ7usoWUqcvO4As: tier, fldUGX7gB3zJJIJcF: [stu], fldgzAfAQQG4ogPu1: JSON.stringify({ phase: 'nurture' }) });
  table(CON).get(c).fields.fldctz89pfrh0KeaX = [b];
  return { c, b, mob: '+61' + mob.replace(/\D/g, '').slice(1) };
});
const MSG = "Hi {first}, it's Alex from Stone Ballarat on behalf of Stu Brien. We've just listed 327 Sandys Hill Rd, Durham Lead for sale: 5 bed, 2 bath on approx. 5.8 acres with stables and sheds. Guide $1,050,000 - $1,150,000. Private inspections only. Stu (0416 183 566) and Leanne (0429 097 002) are looking after it - call either to book, or reply here if you're keen or want more info. https://www.realestate.com.au/property-house-vic-durham+lead-152927364 Reply STOP to opt out.";
const camp = add(CMP, { fldqMQIZ5vTEwf0mJ: 'New listing – 327 Sandys Hill Road, Durham Lead', fld49XPROvzq2xx3n: 'C1', flde07SRX4wndlPA8: 'Draft', fldr01AGNxotUQEgV: 'New listing', fld5tevDvg4CjC6WR: [stu], fld08amLhnJysm5cp: 'Use the price guide', fldW0WwMz53tTg0Gz: MSG });
const ml = add(LIS, { fld4iTTnjDJagkY7f: '327 Sandys Hill Road, Durham Lead', fld46hCNJv589iV4P: 'Durham Lead', fldpZuWLstBgyZzSk: 'Coming soon', fld2JKZuS5KkqofaW: true, fld76puAVSOxN51vb: 5, fldzmKv5AGOXxWnMt: '$1,050,000 - $1,150,000', fldSiKRSajHdI6KWo: [camp], fldhpPQWn4ecHiA6I: 'Draft' });
table(CMP).get(camp).fields.fldKWtHZl36IE3SsP = [ml];
const mids = briefs.map(x => add(MAT, { fld8hEKHNklMaEnOB: [x.b], fldSdPAw8fz58y2cq: [ml], fldUhe1yZVGfjUtme: 60, fldOEWUQ7krAMoyK9: 'New' }));
table(LIS).get(ml).fields.fld6oELQ0t1zZd1TC = mids;
briefs.forEach((x, i) => { table(BR).get(x.b).fields.fld8rUrS7lDIAF0yH = [mids[i]]; });
briefs.forEach((x, i) => { table(BR).get(x.b).fields.fldVcPWTSXlByDrUK = false; });
// Ivy: fresh Agentbox import, never texted (Import outreach, awaiting approval, empty state)
Object.assign(table(BR).get(briefs[4].b).fields, { fldU9bnkjKJ5shc58: 'Import outreach', fldpydUaJkdGDTU0u: 'Awaiting approval' }); delete table(BR).get(briefs[4].b).fields.fldgzAfAQQG4ogPu1;
let passed = 0;
async function test(name, fn) { claudeQueue = []; try { await fn(); passed++; console.log('✔ ' + name); } catch (e) { console.log('✘ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n   ')); process.exitCode = 1; } }
const L = () => table(LIS).get(ml).fields;
(async () => {
  await test('draft: nothing goes out, even if someone flips the listing to For sale early', async () => {
    await T.eventTick(); await T.campaignTick();
    L().fldpZuWLstBgyZzSk = 'For sale'; // campaign still Draft → still held
    await T.eventTick();
    assert.strictEqual(sent.filter(s => briefs.some(x => x.mob === s.to)).length, 0, JSON.stringify(sent));
    L().fldpZuWLstBgyZzSk = 'Coming soon';
  });
  await test('approved: listing goes For sale, full message to every tier, agent told it was the new listing text', async () => {
    table(CMP).get(camp).fields.flde07SRX4wndlPA8 = 'Sending'; L().fldhpPQWn4ecHiA6I = 'Sending';
    table(CMP).get(camp).fields.fldAIlFnsROLtooVx = new RealDate(NOW).toISOString();
    await T.campaignTick();
    assert.strictEqual(L().fldpZuWLstBgyZzSk, 'For sale');
    const got = sent.filter(s => briefs.some(x => x.mob === s.to));
    assert.strictEqual(got.length, 5, JSON.stringify(sent));
    assert(got[0].body.startsWith("Hi Hana, it's Alex from Stone Ballarat on behalf of Stu Brien."), got[0].body);
    assert(got[0].body.endsWith('Reply STOP to opt out.'), 'message was cut: ' + got[0].body);
    assert(got[0].body.includes('$1,050,000 - $1,150,000'));
    assert.strictEqual(table(CMP).get(camp).fields.flde07SRX4wndlPA8, 'Running');
    assert(/C1 - the new listing text for 327 Sandys Hill Road has gone to 5 matching buyers/.test(sent.filter(s => s.to === '+61400000001').pop().body), sent.filter(s => s.to === '+61400000001').pop().body);
  });
  await test('buyer wants a look → private inspection wording + PRIVATE INSPECTION alert', async () => {
    L().fldhpPQWn4ecHiA6I = 'Running';
    claudeQueue.push({ intent: 'wants_inspection', reply: '', updates: {}, property: '327 Sandys Hill Road' });
    await AB.handleBuyerSMS(briefs[1].mob, 'Yes keen to have a look');
    assert(/book a private inspection/.test(sent.filter(s => s.to === briefs[1].mob).pop().body), sent.filter(s => s.to === briefs[1].mob).pop().body);
    assert(sent.some(s => s.to === '+61400000001' && /PRIVATE INSPECTION/.test(s.body)), JSON.stringify(sent.slice(-3)));
  });
  await test('fresh import replies keen → handed to the agent, not the import consent flow', async () => {
    claudeQueue.push({ intent: 'wants_inspection', reply: '', updates: {}, property: '327 Sandys Hill Road' });
    await AB.handleBuyerSMS(briefs[4].mob, 'Hi yes we would like to inspect');
    const last = sent.filter(s => s.to === briefs[4].mob).pop().body;
    assert(/book a private inspection/.test(last), last);
    await T.newBriefTick(); await T.importTick();
    const after = sent.filter(s => s.to === briefs[4].mob).pop().body;
    assert.strictEqual(after, last, 'extra text: ' + after);
  });
  console.log(`\n${passed} passed`);
})();
