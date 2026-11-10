// Offline tests for alex-away.js (team leave)
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
process.env.AIRTABLE_TOKEN = 'x'; process.env.APPROVER_MOBILE = '0400000001'; process.env.ALEX_PHONE_NUMBER = '+61400000999';
const AW = require('./alex-away.js');
const TEAM = 'tbl1aNcrdwmamMyEF';
const F = { from: 'fldS5Xjx0ZZ4vknFO', until: 'fldVaVBBXJQvKLvBm', cover: 'fldGsIxkqvbtiUzGT', held: 'fldMx5xS1YNSjzo4w' };
NOW = new RealDate('2026-11-10T23:00:00Z').getTime(); // Wed 11 Nov 10am
const stu = add(TEAM, { fldWZzjCL3xoU0l82: 'Stu Brien', fldbxwqujqA0rygi9: 'Stu', fldUZ1RQT4BNOo41n: '0400 000 001', fld8McuiVqyHAYduE: true });
const leanne = add(TEAM, { fldWZzjCL3xoU0l82: 'Leanne Madigan', fldbxwqujqA0rygi9: 'Leanne', fldUZ1RQT4BNOo41n: '0400 000 002', fld8McuiVqyHAYduE: true });
const rob = add(TEAM, { fldWZzjCL3xoU0l82: 'Rob Cunningham', fldbxwqujqA0rygi9: 'Rob', fldUZ1RQT4BNOo41n: '0400 000 003', fld8McuiVqyHAYduE: true });
const L = '+61400000002', ROB = '+61400000003', STU = '+61400000001';
const to = n => sent.filter(s => s.to === n); const lastTo = n => { const a = to(n); return a.length ? a[a.length - 1].body : ''; };
const t = id => table(TEAM).get(id).fields;
let passed = 0;
async function test(name, fn) { claudeQueue = []; try { await fn(); passed++; console.log('✔ ' + name); } catch (e) { console.log('✘ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n   ')); process.exitCode = 1; } }
(async () => {
  await test('ordinary texts are ignored (no Claude call)', async () => {
    const n = claudeCalls.length;
    assert.strictEqual(await AW.handleTeamSMS(L, 'R12 2'), false);
    assert.strictEqual(await AW.handleTeamSMS(L, 'Smith called, wants an appraisal'), false);
    assert.strictEqual(claudeCalls.length, n);
  });
  await test('leave by text: Alex reads the dates back, YES saves them and tells the cover', async () => {
    claudeQueue.push({ intent: 'set', from: '2026-11-20', until: '2026-11-27', cover: 'Rob Cunningham' });
    assert(await AW.handleTeamSMS(L, "I'm on holidays from the 20th to the 27th, Rob is covering"));
    assert(/away Fri 20 Nov to Fri 27 Nov, back Sat 28 Nov\. Rob will get/.test(lastTo(L)), lastTo(L));
    assert(!t(leanne)[F.from]);
    assert(await AW.handleTeamSMS(L, 'yes'));
    assert.strictEqual(t(leanne)[F.from], '2026-11-20');
    assert.strictEqual(t(leanne)[F.until], '2026-11-27');
    assert.deepStrictEqual(t(leanne)[F.cover], [rob]);
    assert(/asked you to cover/.test(lastTo(ROB)));
  });
  await test('not away before the start date', async () => {
    assert.strictEqual(await AW.awayInfo(leanne), null);
    assert.strictEqual(await AW.routeAgentText(leanne, 'hello'), false);
  });
  await test('while away: agent texts go to the cover and are kept', async () => {
    NOW = new RealDate('2026-11-21T22:00:00Z').getTime(); // Sun 22 Nov 9am
    assert(AW.awayOnRecord(table(TEAM).get(leanne)));
    assert(await AW.routeAgentText(leanne, 'Alex – NEW SELLER LEAD: Jo Bloggs 0412 345 678'));
    assert(/^For Leanne \(away until Fri 27 Nov\): Alex – NEW SELLER LEAD/.test(lastTo(ROB)), lastTo(ROB));
    assert(/NEW SELLER LEAD: Jo Bloggs/.test(t(leanne)[F.held]));
    const line = await AW.awayLine(leanne);
    assert(/Leanne is away on leave until Fri 27 Nov/.test(line) && /Rob from our office/.test(line), line);
  });
  await test('welcome back the morning after with what was held', async () => {
    NOW = new RealDate('2026-11-27T21:30:00Z').getTime(); // Sat 28 Nov 8:30am
    await AW.tick();
    assert(/Welcome back Leanne.*passed 1 thing/s.test(lastTo(L)), lastTo(L));
    assert(!t(leanne)[F.held]);
    const n = to(L).length; await AW.tick(); assert.strictEqual(to(L).length, n); // once only
  });
  await test("\"I'm back\" ends leave early", async () => {
    NOW = new RealDate('2026-12-01T23:00:00Z').getTime(); // Wed 2 Dec
    table(TEAM).get(rob).fields[F.from] = '2026-12-01'; table(TEAM).get(rob).fields[F.until] = '2026-12-10';
    claudeQueue.push({ intent: 'back' });
    assert(await AW.handleTeamSMS(ROB, "I'm back early"));
    assert(/you're back now/.test(lastTo(ROB)));
    await AW.handleTeamSMS(ROB, 'yep');
    assert.strictEqual(t(rob)[F.until], '2026-12-01');
    assert.strictEqual(await AW.awayInfo(rob), null);
    assert(/Welcome back Rob/.test(lastTo(ROB)));
  });
  await test('cover left blank = Stu; unclear dates get a question', async () => {
    claudeQueue.push({ intent: 'set', from: '', until: '', unclear: "I couldn't tell the last day" });
    await AW.handleTeamSMS(L, 'going on leave from next friday');
    assert(/first day away and your last day away/.test(lastTo(L)), lastTo(L));
    claudeQueue.push({ intent: 'set', from: '2026-12-11', until: '2026-12-18', cover: '' });
    await AW.handleTeamSMS(L, 'til the 18th');
    assert(/Stu will get your new leads/.test(lastTo(L)), lastTo(L));
    await AW.handleTeamSMS(L, 'yes');
    NOW = new RealDate('2026-12-11T23:00:00Z').getTime();
    await AW.routeAgentText(leanne, 'urgent thing');
    assert(/^For Leanne/.test(lastTo(STU)));
  });
  console.log(`\n${passed} passed`);
})();
