// Offline tests replaying Carson / Michelle (26 Nov): bad matches, repeated question, unwanted calls
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

const mk = (name, mob, f) => { const c = add(CON, { fld5hDJRpN92YZnFx: name, fld0EA8biRz66il05: mob, fldHsGhaiVWBnYX23: [stu] });
  const b = add(BR, Object.assign({ fldEmtwK9XFwcQ9M1: name, fldKRyZ83PSx8LJNq: [c], fldXrAXCEFqm98MLV: 'Active', fldJ7usoWUqcvO4As: 'Warm', fldUGX7gB3zJJIJcF: [stu], fldgzAfAQQG4ogPu1: JSON.stringify({ phase: 'nurture' }) }, f));
  table(CON).get(c).fields.fldctz89pfrh0KeaX = [b]; return { c, b, mob: '+61' + mob.replace(/\D/g, '').slice(1) }; };
const carson = mk('Carson', '0412 200 001', { fldJZQwk5J404VtSl: ['Haddon', 'Ballarat Central', 'Alfredton'], fldrHF7kGI9bslQ83: ['Lifestyle / Acreage'], fldQ17ko5Rfcmp4go: 3, fld1ex4aZq9ot60aL: 800000, fldesqPORwtOayOpQ: 20000 });
const michelle = mk('Michelle Nunn', '0412 200 002', { fldJZQwk5J404VtSl: ['Alfredton', 'Buninyong', 'Mount Clear', 'Sebastopol'], fldrHF7kGI9bslQ83: ['Land', 'Lifestyle / Acreage'], fldQ17ko5Rfcmp4go: 5, fld1ex4aZq9ot60aL: 1500000, fldEHyLCKWqNKVnKa: 'Ballarat', fldv86K61v4e6vP12: 'Alfredton\nBuninyong\nMount Clear\nSebastopol', fldK8cQIPZLsxxWFm: 'Ballarat|' });
// half-filled Stone listing, like 602 Eyre St / 10 Ningana St on 24 Nov
const blank = add(LIS, { fld4iTTnjDJagkY7f: '602 Eyre Street, Ballarat Central', fld46hCNJv589iV4P: 'Ballarat Central', fldpZuWLstBgyZzSk: 'For sale', fld2JKZuS5KkqofaW: true, fldzmKv5AGOXxWnMt: '$600,000 - $635,000', fldWTMq9fq8DW7K2G: 600000, fldbhlybQ8LA2M6He: 635000 });
const house = add(LIS, { fld4iTTnjDJagkY7f: '10 Ningana Street, Alfredton', fld46hCNJv589iV4P: 'Alfredton', fld7pSlzfCYyCv499: 'House', fld76puAVSOxN51vb: 3, fldjxl8HWgTx7GeWw: 600, fldpZuWLstBgyZzSk: 'For sale', fld2JKZuS5KkqofaW: true, fldzmKv5AGOXxWnMt: '$550,000 - $600,000', fldWTMq9fq8DW7K2G: 550000, fldbhlybQ8LA2M6He: 600000 });
const acre = add(LIS, { fld4iTTnjDJagkY7f: '90 Macs Road, Buninyong', fld46hCNJv589iV4P: 'Buninyong', fld7pSlzfCYyCv499: 'Lifestyle / Acreage', fld76puAVSOxN51vb: 5, fldjxl8HWgTx7GeWw: 60300, fldpZuWLstBgyZzSk: 'For sale', fld2JKZuS5KkqofaW: true, fldzmKv5AGOXxWnMt: '$950,000 - $995,000', fldWTMq9fq8DW7K2G: 950000, fldbhlybQ8LA2M6He: 995000 });
const link = (who, l) => { const m = add(MAT, { fld8hEKHNklMaEnOB: [who.b], fldSdPAw8fz58y2cq: [l], fldUhe1yZVGfjUtme: 74, fldOEWUQ7krAMoyK9: 'New' });
  (table(LIS).get(l).fields.fld6oELQ0t1zZd1TC = table(LIS).get(l).fields.fld6oELQ0t1zZd1TC || []).push(m);
  (table(BR).get(who.b).fields.fld8rUrS7lDIAF0yH = table(BR).get(who.b).fields.fld8rUrS7lDIAF0yH || []).push(m); return m; };
const mC1 = link(carson, blank), mC2 = link(carson, house), mM1 = link(michelle, house), mM2 = link(michelle, acre);
let passed = 0;
async function test(name, fn) { claudeQueue = []; try { await fn(); passed++; console.log('✔ ' + name); } catch (e) { console.log('✘ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n   ')); process.exitCode = 1; } }
const to = who => sent.filter(s => s.to === who.mob);
(async () => {
  await test('instant alerts: no half-filled listing, no house to an acreage buyer', async () => {
    await T.eventTick();
    assert.strictEqual(to(carson).length, 0, JSON.stringify(to(carson)));
    const m = to(michelle).map(s => s.body).join(' | ');
    assert(!/Ningana|Eyre/.test(m), m);
    assert.strictEqual(table(MAT).get(mC1).fields.fldOEWUQ7krAMoyK9, 'New');
  });
  await test('Michelle: reason given first time → no "what didn\'t work", areas narrowed', async () => {
    const st = JSON.parse(table(BR).get(michelle.b).fields.fldgzAfAQQG4ogPu1); st.property = { listingId: house, short: '10 Ningana Street' }; table(BR).get(michelle.b).fields.fldgzAfAQQG4ogPu1 = JSON.stringify(st);
    claudeQueue.push({ intent: 'not_for_them', reply: '', feedback: 'Not in her areas – only Buninyong and Mount Clear', property: '10 Ningana Street', suburbs_only: true, updates: { suburbs: ['Buninyong', 'Mount Clear'] } });
    await AB.handleBuyerSMS(michelle.mob, 'It is located in Alfredton and I am only interested in the Buninyong and Mt Clear areas.');
    const last = to(michelle).pop().body;
    assert(!/What didn't work/.test(last), last);
    assert(/only send you places in Buninyong or Mount Clear/.test(last), last);
    const f = table(BR).get(michelle.b).fields;
    assert.deepStrictEqual(f.fldJZQwk5J404VtSl, ['Buninyong', 'Mount Clear']);
    assert(!f.fldEHyLCKWqNKVnKa && !f.fldv86K61v4e6vP12, 'near area left in place');
  });
  await test('bare "no thanks" asks why once; the answer is not met with the same question', async () => {
    claudeQueue.push({ intent: 'not_for_them', reply: '', feedback: '', property: '', updates: {} });
    await AB.handleBuyerSMS(michelle.mob, 'No thank you');
    assert(/What didn't work/.test(to(michelle).pop().body));
    claudeQueue.push({ intent: 'not_for_them', reply: '', feedback: 'too far out', property: '', updates: {} });
    await AB.handleBuyerSMS(michelle.mob, 'Too far out of town for me');
    const last = to(michelle).pop().body;
    assert(!/What didn't work/.test(last), last);
  });
  await test('Carson: annoyed feedback → apology, no promised call; "don\'t need a call" stands it down, no chase', async () => {
    table(BR).get(carson.b).fields.fldgzAfAQQG4ogPu1 = JSON.stringify({ phase: 'nurture', lastOutAt: new RealDate(NOW).toISOString(), history: [{ d: 'out', t: 'Hi Carson, just listed: 602 Eyre Street', at: new RealDate(NOW).toISOString() }] });
    claudeQueue.push({ intent: 'complaint', reply: '', updates: {} });
    await AB.handleBuyerSMS(carson.mob, 'That property has no resemblance to our short-list. Please vet before texting.');
    const a = to(carson).pop().body;
    assert(!/give you a call|call you/.test(a), a);
    await AB.handleBuyerSMS(carson.mob, 'I do not need to be called, thank you');
    assert(/no call needed/i.test(to(carson).pop().body));
    assert(sent.some(s => s.to === '+61400000001' && /don't need a call/.test(s.body)));
    const n = to(carson).length;
    advance(180); await T.escalateTick();
    assert.strictEqual(to(carson).length, n, 'chased the buyer: ' + to(carson).pop().body);
  });
  console.log(`\n${passed} passed`);
})();
