// Offline test harness for alex-buyers.js: fake Airtable (with a small formula evaluator), fake Twilio, fake Claude, fake clock.
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

// ---------- env + module
process.env.AIRTABLE_TOKEN = 'x'; process.env.ALEX_BUYERS_ENABLED = 'true'; process.env.APPROVER_MOBILE = '0400000001'; process.env.ALEX_PHONE_NUMBER = '+61400000999';
process.env.BUYERS_GO_LIVE = '2026-10-01';
const AB = require('./alex-buyers.js');
const T = AB._t;

// ---------- seed
process.env.BUYER_SALES_AGENTS = 'Stu Brien,Leanne Smith,Rob C';
const TEAM = 'tbl1aNcrdwmamMyEF', CON = 'tblWRqWCqXWP708dY', BR = 'tbl43WTbzYyauRMhd', MSG = 'tbl78WnIpym0PEutf', MAT = 'tblQ9Z4lvKpxjWkJL', LIS = 'tblvJCPHTQBgdYGZu', CHK = 'tblANNW7LRvFFgMcD', INS = 'tblTVym6dw3M8rt0Z', TSK = 'tblly5yaH9pTZrUXC';
const stu = add(TEAM, { fldWZzjCL3xoU0l82: 'Stu Brien', fldbxwqujqA0rygi9: 'Stu', fldUZ1RQT4BNOo41n: '0400 000 001', fld8McuiVqyHAYduE: true, fldVcSz2oIHrhKOw6: true });
const leanne = add(TEAM, { fldWZzjCL3xoU0l82: 'Leanne Smith', fldbxwqujqA0rygi9: 'Leanne', fldUZ1RQT4BNOo41n: '0400 000 002', fld8McuiVqyHAYduE: true, fldVcSz2oIHrhKOw6: true });
const rob = add(TEAM, { fldWZzjCL3xoU0l82: 'Rob C', fldbxwqujqA0rygi9: 'Rob', fldUZ1RQT4BNOo41n: '0400 000 003', fld8McuiVqyHAYduE: true });
const prop1 = 'recPROP0000000001';
const list1 = add(LIS, { fld4iTTnjDJagkY7f: '12 Smith Street, Alfredton', fld46hCNJv589iV4P: 'Alfredton', fld7pSlzfCYyCv499: 'House', fld76puAVSOxN51vb: 4, fldWcNQArMl4CQoGG: 2, fldoPMmb2SQCFVzpy: 2, fldzmKv5AGOXxWnMt: '$640,000 - $680,000', fldWTMq9fq8DW7K2G: 640000, fldbhlybQ8LA2M6He: 680000, fldpZuWLstBgyZzSk: 'For sale', fld2JKZuS5KkqofaW: true, fldgOq5OW8mF5FNfA: 'https://stone.example/12-smith', fld0RT3rZaM6FRc8I: [prop1] });
const list2 = add(LIS, { fld4iTTnjDJagkY7f: '8 Grevillea Crescent, Delacombe', fld46hCNJv589iV4P: 'Delacombe', fld7pSlzfCYyCv499: 'House', fld76puAVSOxN51vb: 4, fldWcNQArMl4CQoGG: 2, fldoPMmb2SQCFVzpy: 2, fldzmKv5AGOXxWnMt: '$655,000', fldWTMq9fq8DW7K2G: 655000, fldpZuWLstBgyZzSk: 'For sale', fldgOq5OW8mF5FNfA: 'https://rea.example/8-grev' });

function lastSent() { return sent[sent.length - 1]; }
function msgs(filter) { return [...table(MSG).values()].filter(r => !filter || filter(r.fields)); }
function brief(id) { return table(BR).get(id); }
function stateOf(id) { return JSON.parse(brief(id).fields.fldgzAfAQQG4ogPu1 || '{}'); }
let passed = 0;
async function test(name, fn) { claudeQueue = []; try { await fn(); passed++; console.log('✔ ' + name); } catch (e) { console.log('✘ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 4).join('\n   ')); process.exitCode = 1; } }

(async () => {
  // ===== pure helpers
  await test('price safety', async () => {
    assert(T.priceSafe('Listed at $640,000 - $680,000', ['$640,000 - $680,000']));
    assert(!T.priceSafe('Worth about $700k', ['$640,000 - $680,000']));
    assert(T.priceSafe('No price here', []));
  });
  await test('windows', async () => {
    assert(T.inScheduledWindow(T.clock()));
    assert(T.inScheduledWindow({ date: '2026-10-31', hour: 14, minute: 0, weekday: 'Sat' }));
    assert(!T.inScheduledWindow({ date: '2026-11-01', hour: 14, minute: 0, weekday: 'Sun' }));
    assert(!T.inScheduledWindow({ date: '2026-11-03', hour: 11, minute: 0, weekday: 'Tue' })); // Melbourne Cup
    assert(!T.inspectionFollowUpOK({ date: '2026-10-29', hour: 19, minute: 45, weekday: 'Thu' }));
    assert(T.melbToISO('2026-10-29', 12, 0) === '2026-10-29T01:00:00.000Z');
  });
  await test('tier formula mirror', async () => {
    assert.strictEqual(T.computeTier({ fldEGmedcp49GMYw2: '0–3 months', fldEif9eW0g8t1dxp: 'Pre-approved', fld2IqbQFD5QofxmW: 'Nothing to sell' }), 'Hot');
    assert.strictEqual(T.computeTier({ fld2IqbQFD5QofxmW: 'Must sell first' }), 'Warm');
    assert.strictEqual(T.computeTier({ fldEGmedcp49GMYw2: '12+ months' }), 'Long-term');
  });

  // ===== A. open home check-in → HOLD → first text
  const sarah = add(CON, { fld5hDJRpN92YZnFx: 'Sarah Jones', fld0EA8biRz66il05: '0412 345 678', fldHsGhaiVWBnYX23: [stu] });
  const tom = add(CON, { fld5hDJRpN92YZnFx: 'Tom Lee', fld0EA8biRz66il05: '0412 000 111', fldHsGhaiVWBnYX23: [stu], fldd9p4vMwi8R6Bx8: true });
  const insp = add(INS, { fldXdDpcQL5Qm0gyn: '12 Smith Street, Alfredton – 29/10/2026', fldIrwroJCF99ergb: [prop1], fldWhporyrNvcmUEd: 'Open home', fldeQtewqz2ILV1jo: [stu] });
  const ci1 = add(CHK, { fldurgnMEIdSie5z3: 'Sarah Jones', fldTIal66LWdnINN3: '0412 345 678', fldGoYo4QgBIp3aqV: [insp], fld1WO0G10rDQe039: 'Open home', fld0NnGmQdQK3bMlc: [prop1], fldLie73SzdIoEpVm: [stu], fldgsE4tOCasN1TaI: [sarah] });
  const ci2 = add(CHK, { fldurgnMEIdSie5z3: 'Tom Lee', fldTIal66LWdnINN3: '0412 000 111', fldGoYo4QgBIp3aqV: [insp], fld1WO0G10rDQe039: 'Open home', fld0NnGmQdQK3bMlc: [prop1], fldLie73SzdIoEpVm: [stu], fldgsE4tOCasN1TaI: [tom] });
  table(INS).get(insp).fields.fldhzwmq6zLViBXgk = [ci1, ci2];

  await test('check-in → HOLD text to agent, nothing to buyers yet', async () => {
    await T.checkinTick();
    const holdMsg = sent.find(s => s.to === '+61400000001' && /checked in at 12 Smith Street/.test(s.body));
    assert(holdMsg, 'hold text sent: ' + JSON.stringify(sent));
    assert(/HOLD ALL/.test(holdMsg.body));
    assert.strictEqual(table(CHK).get(ci1).fields.fld5ZAf6ug4aASDMg, 'Waiting (HOLD)');
    assert(!sent.some(s => s.to === '+61412345678'));
  });
  await test('Stu replies HOLD Tom → Tom held + task', async () => {
    const handled = await AB.handleAgentCommand('+61400000001', 'HOLD Tom');
    assert(handled);
    assert(/holding Tom/.test(lastSent().body), lastSent().body);
    assert.strictEqual(table(CHK).get(ci2).fields.fld5ZAf6ug4aASDMg, 'Held by agent');
    assert([...table(TSK).values()].some(t => /Follow up Tom Lee/.test(t.fields.flds1zBNNSIuWMIAe)));
  });
  await test('after 60 min → Sarah gets the open-home text, brief created', async () => {
    advance(61);
    await T.checkinTick();
    const s = sent.find(x => x.to === '+61412345678');
    assert(s, 'sent to Sarah');
    assert(/Hey Sarah, this is Alex from Stone Ballarat on behalf of Stu\. Thanks for coming through 12 Smith Street today/.test(s.body), s.body);
    assert(/Reply STOP anytime/.test(s.body));
    assert.strictEqual(table(CHK).get(ci1).fields.fld5ZAf6ug4aASDMg, 'Texted');
    const b = [...table(BR).values()].find(r => (r.fields.fldKRyZ83PSx8LJNq || []).includes(sarah));
    assert(b, 'brief created');
    table(CON).get(sarah).fields.fldctz89pfrh0KeaX = [b.id];
    assert.strictEqual(JSON.parse(b.fields.fldgzAfAQQG4ogPu1).phase, 'awaiting_reply');
    assert(msgs(f => f.flditzq65DreFxtjk === 'Buyer' && f.fldAvlSCuVXNmw4AV === 'To buyer').length >= 1);
  });

  const sarahBrief = [...table(BR).values()].find(r => (r.fields.fldKRyZ83PSx8LJNq || []).includes(sarah)).id;

  // ===== B. replies
  await test('reply: liked it, wants another look → Inspecting + task + agent alert', async () => {
    const m = add(MAT, { fld8hEKHNklMaEnOB: [sarahBrief], fldSdPAw8fz58y2cq: [list1], fldUhe1yZVGfjUtme: 80, fldOEWUQ7krAMoyK9: 'Sent' });
    table(BR).get(sarahBrief).fields.fld8rUrS7lDIAF0yH = [m];
    claudeQueue.push({ intent: 'wants_inspection', reply: '', updates: {}, property: '12 Smith Street, Alfredton', feedback: 'loved the kitchen' });
    const n = sent.length;
    assert(await AB.handleBuyerSMS('+61412345678', 'Loved it! Could we see it again on the weekend?'));
    const out = sent.slice(n);
    assert(out.some(s => s.to === '+61412345678' && /I'll get Stu to call you to set up another look/.test(s.body)), JSON.stringify(out));
    assert(out.some(s => s.to === '+61400000001' && /wants another look at 12 Smith Street/.test(s.body)));
    assert.strictEqual(table(MAT).get(m).fields.fldOEWUQ7krAMoyK9, 'Inspecting');
    assert.strictEqual(brief(sarahBrief).fields.fldJ7usoWUqcvO4As, 'Warm');
    assert(msgs(f => f.fldAvlSCuVXNmw4AV === 'From buyer').length === 1);
  });
  await test('reply with details → saved + next question (area known → beds)', async () => {
    claudeQueue.push({ intent: 'answer', reply: 'Alfredton and Delacombe, got it.', updates: { suburbs: ['Alfredton', 'Delacombe', 'Narnia'], types: ['House'] } });
    const n = sent.length;
    await AB.handleBuyerSMS('+61412345678', 'We are looking at houses in Alfredton or Delacombe');
    const s = sent.slice(n).find(x => x.to === '+61412345678');
    assert(/How many bedrooms/.test(s.body), s.body);
    assert.deepStrictEqual(brief(sarahBrief).fields.fldJZQwk5J404VtSl, ['Alfredton', 'Delacombe']);
  });
  await test('qualification order ends with price, then one summary', async () => {
    claudeQueue.push({ intent: 'answer', reply: 'Four bedrooms, noted.', updates: { beds: 4, must: ['Garage'] } });
    await AB.handleBuyerSMS('+61412345678', '4 beds and a garage');
    assert(/When are you hoping to be in/.test(lastSent().body), lastSent().body);
    claudeQueue.push({ intent: 'answer', reply: 'Thanks.', updates: { timeframe: '0–3 months' } });
    await AB.handleBuyerSMS('+61412345678', 'ASAP');
    // no pause after 3 in a row any more (Stu, 6 Nov) – straight on to the next question
    const body = lastSent().body;
    assert(/place to sell first/.test(body), body);
    claudeQueue.push({ intent: 'answer', reply: 'Good to know.', updates: { saleDep: 'Nothing to sell' } });
    await AB.handleBuyerSMS('+61412345678', 'Nothing to sell, we rent');
    claudeQueue.push({ intent: 'answer', reply: 'Great.', updates: { finance: 'Pre-approved' } });
    await AB.handleBuyerSMS('+61412345678', 'Pre-approved');
    let guard = 0;
    while (!/comfortable sharing a price range/.test(lastSent().body) && guard++ < 4) { claudeQueue.push({ intent: 'thanks', reply: 'Thanks.', updates: {} }); await AB.handleBuyerSMS('+61412345678', 'ok'); }
    assert(/comfortable sharing a price range/.test(lastSent().body), 'price asked last: ' + lastSent().body);
    claudeQueue.push({ intent: 'answer', reply: 'Perfect, thank you.', updates: { pmin: 600000, pmax: 700000 } });
    await AB.handleBuyerSMS('+61412345678', '600 to 700');
    assert.strictEqual(stateOf(sarahBrief).phase, 'nurture');
    assert(/^Thanks for that Sarah, just so I'm sure I've got everything: .*\$600k.{1,3}\$700k.*Alex$/.test(lastSent().body), lastSent().body);
    assert([...table(TSK).values()].some(t => /Hot buyer/.test(t.fields.flds1zBNNSIuWMIAe)), 'hot FYI task');
  });
  await test('price question answered only with the listing price', async () => {
    claudeQueue.push({ intent: 'price_question', reply: '', updates: {}, property: '12 Smith Street, Alfredton' });
    await AB.handleBuyerSMS('+61412345678', 'What are they asking for Smith St?');
    assert(/It's listed at \$640,000 - \$680,000/.test(lastSent().body), lastSent().body);
  });
  await test('Claude reply with an invented price is blocked', async () => {
    claudeQueue.push({ intent: 'property_fact', reply: 'It would probably go for $720k.', updates: {} });
    const n = sent.length;
    await AB.handleBuyerSMS('+61412345678', 'What will it sell for?');
    const s = sent.slice(n).find(x => x.to === '+61412345678');
    assert(!/720/.test(s.body) && /check with Stu/.test(s.body), s.body);
  });
  await test('contract request with no email → asks for email → task', async () => {
    claudeQueue.push({ intent: 'contract_request', reply: '', updates: {}, property: '12 Smith Street, Alfredton' });
    await AB.handleBuyerSMS('+61412345678', 'Can I get the section 32?');
    assert(/best email/.test(lastSent().body), lastSent().body);
    claudeQueue.push({ intent: 'answer', reply: '', updates: { email: 'sarah@example.com' } });
    await AB.handleBuyerSMS('+61412345678', 'sarah@example.com');
    assert(/send that through to sarah@example.com/.test(lastSent().body) || sent.slice(-3).some(s => /sarah@example.com/.test(s.body)), lastSent().body);
    assert.strictEqual(table(CON).get(sarah).fields.fldZW60VKGeM5Pc2u, 'sarah@example.com');
    assert([...table(TSK).values()].some(t => /Section 32/.test(t.fields.flds1zBNNSIuWMIAe)));
  });
  await test('not interested → clarifier → property only', async () => {
    claudeQueue.push({ intent: 'not_interested_unclear', reply: '' });
    await AB.handleBuyerSMS('+61412345678', 'Not interested');
    assert(/are you not interested in that property, or would you like me to unsubscribe/.test(lastSent().body));
    claudeQueue.push({ intent: 'not_for_them', reply: '', property: '8 Grevillea Crescent, Delacombe', feedback: 'too far from school' });
    await AB.handleBuyerSMS('+61412345678', 'Just that property');
    assert(/No worries/.test(lastSent().body));
    assert.notStrictEqual(brief(sarahBrief).fields.fldXrAXCEFqm98MLV, 'Paused');
  });

  // ===== C. nurture list
  await test('nurture: curated list, Stone first, matches marked Sent', async () => {
    const m2 = add(MAT, { fld8hEKHNklMaEnOB: [sarahBrief], fldSdPAw8fz58y2cq: [list2], fldUhe1yZVGfjUtme: 70, fldOEWUQ7krAMoyK9: 'New' });
    const m1 = add(MAT, { fld8hEKHNklMaEnOB: [sarahBrief], fldSdPAw8fz58y2cq: [list1], fldUhe1yZVGfjUtme: 60, fldOEWUQ7krAMoyK9: 'New' });
    table(BR).get(sarahBrief).fields.fld8rUrS7lDIAF0yH = [m2, m1];
    // pretend last send was 8 days ago and it's due
    advance(8 * 1440);
    const b = brief(sarahBrief);
    b.fields.fld56ZTZDLw3TGPAk = new RealDate(NOW - 8 * 864e5).toISOString();
    b.fields.fld4WWBMw0StVNm9W = '2026-11-05';
    // move to a weekday 11am Melbourne (Fri 6 Nov 2026 00:00Z)
    NOW = new RealDate('2026-11-06T00:00:00Z').getTime();
    const n = sent.length;
    await T.nurtureTick();
    const s = sent.slice(n).find(x => x.to === '+61412345678');
    assert(s, 'list sent');
    assert(s.body.indexOf('12 Smith Street') < s.body.indexOf('8 Grevillea'), s.body);
    assert(/\(one of ours\)/.test(s.body));
    assert.strictEqual(table(MAT).get(m1).fields.fldOEWUQ7krAMoyK9, 'Sent');
  });
  await test('caps: second Alex-initiated text same day is blocked', async () => {
    const n = sent.length;
    brief(sarahBrief).fields.fld56ZTZDLw3TGPAk = new RealDate(NOW - 8 * 864e5).toISOString();
    await T.nurtureTick();
    assert(!sent.slice(n).some(x => x.to === '+61412345678'));
  });
  await test('under offer notice for an interested buyer', async () => {
    const m = [...table(MAT).values()].find(r => r.fields.fldSdPAw8fz58y2cq[0] === list1 && r.fields.fldOEWUQ7krAMoyK9 === 'Sent');
    m.fields.fldOEWUQ7krAMoyK9 = 'Interested';
    table(LIS).get(list1).fields.fldpZuWLstBgyZzSk = 'Under offer';
    NOW += 864e5; // next day
    const n = sent.length;
    await T.eventTick();
    assert(sent.slice(n).some(x => /now under offer/.test(x.body)), JSON.stringify(sent.slice(n)));
  });

  await test('off market listing: no price or link in the list line', async () => {
    const line = T.listLine(1, { short: '5 Test Street', suburb: 'Buninyong', status: 'Off market', price: '$700,000', link: 'https://x.y', stone: true });
    assert(/off market/.test(line) && !/700/.test(line) && !/x\.y/.test(line) && /one of ours/.test(line), line);
  });

  // ===== D. STOP
  await test('STOP → opted out, paused, no text to Stu (goes in the 5pm summary)', async () => {
    const n = sent.length;
    await AB.handleBuyerSMS('+61412345678', 'STOP');
    assert(table(CON).get(sarah).fields.fldKV1dvdkTd08Mgv);
    assert.strictEqual(brief(sarahBrief).fields.fldXrAXCEFqm98MLV, 'Paused');
    assert(!sent.slice(n).some(x => x.to === '+61400000001'), 'Stu not texted');
  });

  // ===== E. import campaign
  await test('import: approved → first text → nudge day 3 → Long-term day 7', async () => {
    NOW = new RealDate('2026-11-09T00:00:00Z').getTime(); // Mon 11am
    const jo = add(CON, { fld5hDJRpN92YZnFx: 'Jo Smith', fld0EA8biRz66il05: '0499 111 222', fldHsGhaiVWBnYX23: [leanne] });
    const jb = add(BR, { fldKRyZ83PSx8LJNq: [jo], fldUGX7gB3zJJIJcF: [leanne], fldXrAXCEFqm98MLV: 'Active', fldU9bnkjKJ5shc58: 'Import outreach', fldpydUaJkdGDTU0u: 'Awaiting approval', fldn4d0wQDjxpmGhS: 'Agentbox import', fldIrX6E3Qp9fNCHz: 'Nov batch 1' });
    table(CON).get(jo).fields.fldctz89pfrh0KeaX = [jb];
    await T.importTick();
    assert.strictEqual(brief(jb).fields.fldpydUaJkdGDTU0u, 'Awaiting approval');
    brief(jb).fields.fldYwKAzSafqHRlzP = true;
    await T.importTick(); // → Queued
    await T.importTick(); // → send
    const s = sent.find(x => x.to === '+61499111222');
    assert(s && /In recent months you've had some contact with our office or Leanne/.test(s.body) && /Reply Y or Yes/.test(s.body), JSON.stringify(s));
    assert.strictEqual(brief(jb).fields.fldpydUaJkdGDTU0u, 'First sent');
    NOW = new RealDate('2026-11-12T00:00:00Z').getTime(); // Thu
    await T.importTick();
    assert(/Just checking you saw my last message/.test(sent.filter(x => x.to === '+61499111222').pop().body));
    assert.strictEqual(brief(jb).fields.fldpydUaJkdGDTU0u, 'Nudged');
    NOW = new RealDate('2026-11-16T00:00:00Z').getTime(); // Mon, day 7
    await T.importTick();
    assert.strictEqual(brief(jb).fields.fldpydUaJkdGDTU0u, 'Complete');
    assert.strictEqual(brief(jb).fields.fldINgRo4UhHJZfOZ, 'No response');
    assert.strictEqual(brief(jb).fields.fldJ7usoWUqcvO4As, 'Long-term');
    assert(sent.some(x => x.to === '+61400000001' && /import batch "Nov batch 1" finished/.test(x.body)), 'batch summary');
  });
  await test('import: first text wording by age + Y reply starts qualifying', async () => {
    const mk = (name, mob, since) => {
      const c = add(CON, { fld5hDJRpN92YZnFx: name, fld0EA8biRz66il05: mob, fldHsGhaiVWBnYX23: [leanne] });
      const b = add(BR, { fldKRyZ83PSx8LJNq: [c], fldUGX7gB3zJJIJcF: [leanne], fldXrAXCEFqm98MLV: 'Active', fldU9bnkjKJ5shc58: 'Import outreach', fldpydUaJkdGDTU0u: 'Queued', fldYwKAzSafqHRlzP: true, fldn4d0wQDjxpmGhS: 'Agentbox import', fldQqrjTFxWBI7ew5: since });
      table(CON).get(c).fields.fldctz89pfrh0KeaX = [b];
      return b;
    };
    NOW = new RealDate('2026-11-18T00:00:00Z').getTime(); // Wed 11am
    const mid = mk('Ann Mid', '0499 555 001', '2026-01-20');
    const old = mk('Bob Old', '0499 555 002', '2025-02-10');
    await T.importTick();
    const bodyTo = m => sent.filter(x => x.to === m).pop().body;
    assert(/Over the past year you've been in touch/.test(bodyTo('+61499555001')), bodyTo('+61499555001'));
    assert(/A while back you were in touch/.test(bodyTo('+61499555002')) && /already bought/.test(bodyTo('+61499555002')), bodyTo('+61499555002'));
    const before = claudeQueue.length;
    await AB.handleBuyerSMS('+61499555001', 'Yes');
    assert.strictEqual(claudeQueue.length, before, 'Y handled without Claude');
    assert(/Great, thanks! A couple of quick questions/.test(lastSent().body) && /\?/.test(lastSent().body), lastSent().body);
    assert.strictEqual(brief(mid).fields.fldpydUaJkdGDTU0u, 'Replied');
    assert(/dealing with one of the other agents/.test(lastSent().body), 'agent question first: ' + lastSent().body);
    // Buyer names Rob → brief + contact move to Rob, Rob and Stu told, Alex carries on qualifying
    claudeQueue.push({ intent: 'answer', reply: 'Thanks Ann.', updates: {}, other_agent: 'Rob' });
    await AB.handleBuyerSMS('+61499555001', 'Yes, we were talking to Rob a while back');
    const f = brief(mid).fields;
    assert.deepStrictEqual(f.fldUGX7gB3zJJIJcF, [rob], 'brief moved to Rob');
    const ann = table(CON).get(f.fldKRyZ83PSx8LJNq[0]);
    assert.deepStrictEqual(ann.fields.fldHsGhaiVWBnYX23, [rob], 'contact moved to Rob');
    assert(/I'll make sure Rob looks after you/.test(lastSent().body) && /which areas/.test(lastSent().body), lastSent().body);
    assert(sent.some(x => x.to === '+61400000003' && /moved their buyer brief to you/.test(x.body)), 'Rob told');
    assert(!sent.some(x => x.to === '+61400000001' && /moved Ann Mid/.test(x.body)), 'Stu not texted about the swap');
    // Rob isn't on the pilot, but Alex keeps going for this buyer
    claudeQueue.push({ intent: 'answer', reply: 'Lovely.', updates: { suburbs: ['Alfredton'], types: ['House'] } });
    const n = sent.length;
    await AB.handleBuyerSMS('+61499555001', 'A house in Alfredton');
    assert(sent.length > n && /Lovely/.test(lastSent().body), 'Alex still replies after the swap');
  });
  await test('agent adds a buyer by text → contact + brief, first text goes', async () => {
    const out = await AB.addBuyerFromAgent({ agent: table(TEAM).get(stu), input: { name: 'Michelle Test', mobile: '0422 506 999', email: 'm@x.com', lives_in: 'Mount Clear',
      property_types: ['Land', 'Lifestyle / Acreage'], beds: 5, baths: 2, car_spaces: 2, land_m2: 20000, timeframe: '3–6 months',
      other_requirements: 'NBN; land to build on or a house on acreage', source_detail: 'Referral – friend of Stu' } });
    assert(/^ADDED/.test(out), out);
    const b = [...table(BR).values()].find(r => r.fields.fldEmtwK9XFwcQ9M1 === 'Michelle Test');
    assert(b, 'brief created');
    assert.strictEqual(b.fields.fldQ17ko5Rfcmp4go, 5);
    assert.deepStrictEqual(b.fields.fldrHF7kGI9bslQ83, ['Land', 'Lifestyle / Acreage']);
    assert(/Agent by text/.test(b.fields.fldn4d0wQDjxpmGhS));
    const mc = [...table(CON).values()].find(r => r.fields.fld5hDJRpN92YZnFx === 'Michelle Test');
    assert(mc && mc.fields.fldTP7UpdXdwis53b.includes('Buyer'), 'contact created as Buyer');
    mc.fields.fldctz89pfrh0KeaX = [b.id];
    const again = await AB.addBuyerFromAgent({ agent: table(TEAM).get(stu), input: { name: 'Michelle Test', mobile: '0422506999', price_max: 900000 } });
    assert(/^UPDATED/.test(again), again);
    assert.strictEqual(b.fields.fld1ex4aZq9ot60aL, 900000);
  });
  await test('agent-added buyer with a search area → first text names the area; reply sets near + radius', async () => {
    NOW = new RealDate('2026-11-20T00:00:00Z').getTime(); // Fri 11am
    const out = await AB.addBuyerFromAgent({ agent: table(TEAM).get(stu), input: { name: 'Nina Near', mobile: '0499 777 001', near_suburb: 'Buninyong', radius_km: 5, beds: 3 } });
    assert(/^ADDED/.test(out) && /Still missing: property type, budget, timing/.test(out), out);
    const b = [...table(BR).values()].find(r => r.fields.fldEmtwK9XFwcQ9M1 === 'Nina Near');
    assert.strictEqual(b.fields.fldEHyLCKWqNKVnKa, 'Buninyong');
    assert.strictEqual(b.fields.fld8QdDAgP7J5pILm, 5);
    const mc = [...table(CON).values()].find(r => r.fields.fld5hDJRpN92YZnFx === 'Nina Near');
    mc.fields.fldctz89pfrh0KeaX = [b.id];
    NOW += 20 * 60000;
    await T.newBriefTick();
    const first = sent.filter(x => x.to === '+61499777001').pop();
    assert(first && /around Buninyong/.test(first.body), JSON.stringify(first));
    claudeQueue.push({ intent: 'answer', reply: 'Got it.', updates: { near: 'Mount Helen', radius_km: 10, types: ['House'] } });
    await AB.handleBuyerSMS('+61499777001', 'Anything within 10km of Mt Helen, a house');
    assert.strictEqual(b.fields.fldEHyLCKWqNKVnKa, 'Mount Helen');
    assert.strictEqual(b.fields.fld8QdDAgP7J5pILm, 10);
  });
  await test('import: "no other agent" just carries on', async () => {
    const c = add(CON, { fld5hDJRpN92YZnFx: 'Cal Nobody', fld0EA8biRz66il05: '0499 555 003', fldHsGhaiVWBnYX23: [stu] });
    const b = add(BR, { fldKRyZ83PSx8LJNq: [c], fldUGX7gB3zJJIJcF: [stu], fldXrAXCEFqm98MLV: 'Active', fldU9bnkjKJ5shc58: 'Import outreach', fldpydUaJkdGDTU0u: 'Queued', fldYwKAzSafqHRlzP: true, fldn4d0wQDjxpmGhS: 'Agentbox import', fldQqrjTFxWBI7ew5: '2026-09-01' });
    table(CON).get(c).fields.fldctz89pfrh0KeaX = [b];
    await T.importTick();
    await AB.handleBuyerSMS('+61499555003', 'Yep');
    assert(/dealing with one of the other agents/.test(lastSent().body));
    claudeQueue.push({ intent: 'answer', reply: 'No worries.', updates: {}, other_agent: 'none' });
    await AB.handleBuyerSMS('+61499555003', 'No just you guys');
    assert.deepStrictEqual(brief(b).fields.fldUGX7gB3zJJIJcF, [stu]);
    assert(/which areas/.test(lastSent().body), lastSent().body);
  });
  await test('import reply → Replied → bought flow → Status Bought', async () => {
    const pete = add(CON, { fld5hDJRpN92YZnFx: 'Pete Gray', fld0EA8biRz66il05: '0499 333 444', fldHsGhaiVWBnYX23: [leanne] });
    const pb = add(BR, { fldKRyZ83PSx8LJNq: [pete], fldUGX7gB3zJJIJcF: [leanne], fldXrAXCEFqm98MLV: 'Active', fldU9bnkjKJ5shc58: 'Import outreach', fldpydUaJkdGDTU0u: 'Queued', fldYwKAzSafqHRlzP: true, fldn4d0wQDjxpmGhS: 'Agentbox import' });
    table(CON).get(pete).fields.fldctz89pfrh0KeaX = [pb];
    NOW = new RealDate('2026-11-17T00:00:00Z').getTime();
    await T.importTick();
    claudeQueue.push({ intent: 'bought', reply: '', bought: { address: '', settlement: '', through: 'Another agent' } });
    await AB.handleBuyerSMS('+61499333444', 'We actually bought last month');
    assert(/Congratulations! Where did you end up buying/.test(lastSent().body), lastSent().body);
    claudeQueue.push({ intent: 'bought', reply: '', bought: { address: '5 Hill St, Sebastopol', settlement: '', through: '' } });
    await AB.handleBuyerSMS('+61499333444', '5 Hill St Sebastopol');
    assert(/When does it settle/.test(lastSent().body));
    claudeQueue.push({ intent: 'bought', reply: '', bought: { address: '', settlement: '', through: '' } });
    await AB.handleBuyerSMS('+61499333444', 'not sure yet');
    assert(/all the best with the move/.test(lastSent().body));
    const f = brief(pb).fields;
    assert.strictEqual(f.fldXrAXCEFqm98MLV, 'Bought');
    assert.strictEqual(f.fld5agQondpSuO1T5, '5 Hill St, Sebastopol');
    assert.strictEqual(f.fldINgRo4UhHJZfOZ, 'Bought');
    assert(!f.fldTu4kZHStcZC87c, 'no settlement date stored');
  });
  await test('bought with no address → 12-month task, no fake address', async () => {
    const liz = add(CON, { fld5hDJRpN92YZnFx: 'Liz Hart', fld0EA8biRz66il05: '0499 444 555', fldHsGhaiVWBnYX23: [leanne] });
    const lb = add(BR, { fldKRyZ83PSx8LJNq: [liz], fldUGX7gB3zJJIJcF: [leanne], fldXrAXCEFqm98MLV: 'Active', fldgzAfAQQG4ogPu1: JSON.stringify({ phase: 'nurture', firstSentAt: 'x' }) });
    table(CON).get(liz).fields.fldctz89pfrh0KeaX = [lb];
    claudeQueue.push({ intent: 'bought', reply: '', bought: {} });
    await AB.handleBuyerSMS('+61499444555', 'We bought already');
    claudeQueue.push({ intent: 'bought', reply: '', bought: {} });
    await AB.handleBuyerSMS('+61499444555', 'rather not say');
    claudeQueue.push({ intent: 'bought', reply: '', bought: {} });
    await AB.handleBuyerSMS('+61499444555', 'dunno');
    const f = brief(lb).fields;
    assert.strictEqual(f.fldXrAXCEFqm98MLV, 'Bought');
    assert(!f.fld5agQondpSuO1T5);
    const t = [...table(TSK).values()].find(x => /Anniversary check-in: Liz Hart/.test(x.fields.flds1zBNNSIuWMIAe));
    assert(t && t.fields.fldFgsIL7uMKKutro > '2027-11-01', JSON.stringify(t && t.fields));
  });

  // ===== F. non-pilot agent's buyer is not touched
  await test('buyer of a non-pilot agent is ignored', async () => {
    const kim = add(CON, { fld5hDJRpN92YZnFx: 'Kim', fld0EA8biRz66il05: '0499 555 666', fldHsGhaiVWBnYX23: [rob] });
    const kb = add(BR, { fldKRyZ83PSx8LJNq: [kim], fldUGX7gB3zJJIJcF: [rob], fldXrAXCEFqm98MLV: 'Active', fldn4d0wQDjxpmGhS: 'Portal enquiry – 9 Elm St', fldgzAfAQQG4ogPu1: '{"phase":"awaiting_reply","firstSentAt":"x"}' });
    table(CON).get(kim).fields.fldctz89pfrh0KeaX = [kb];
    assert.strictEqual(await AB.handleBuyerSMS('+61499555666', 'hi'), false);
  });
  await test('new enquiry brief → instant first text even at 11pm', async () => {
    NOW = new RealDate('2026-11-17T12:00:00Z').getTime(); // 11pm Melbourne
    const amy = add(CON, { fld5hDJRpN92YZnFx: 'Amy Bell', fld0EA8biRz66il05: '0499 777 888', fldHsGhaiVWBnYX23: [stu] });
    const ab = add(BR, { fldKRyZ83PSx8LJNq: [amy], fldUGX7gB3zJJIJcF: [stu], fldXrAXCEFqm98MLV: 'Active', fldn4d0wQDjxpmGhS: 'Portal enquiry – 12 Smith Street' });
    await T.newBriefTick();
    const s = sent.find(x => x.to === '+61499777888');
    assert(s && /Thanks for your enquiry on 12 Smith Street/.test(s.body), JSON.stringify(s));
    assert(new RealDate(stateOf(ab).nudgeDue).toISOString() === '2026-11-17T21:00:00.000Z', stateOf(ab).nudgeDue); // 8am next day
  });
  await test('phone/agent-added brief waits for the send window', async () => {
    const ben = add(CON, { fld5hDJRpN92YZnFx: 'Ben Ng', fld0EA8biRz66il05: '0499 222 333', fldHsGhaiVWBnYX23: [stu] });
    add(BR, { fldKRyZ83PSx8LJNq: [ben], fldUGX7gB3zJJIJcF: [stu], fldXrAXCEFqm98MLV: 'Active', fldn4d0wQDjxpmGhS: 'Phone enquiry' });
    await T.newBriefTick();
    assert(!sent.some(x => x.to === '+61499222333'));
  });
  // ===== Qualifying only when the buyer engages (Stu, 30 Oct)
  NOW = new RealDate('2026-11-19T00:00:00Z').getTime(); // Thu 11am Melbourne
  const zed = add(CON, { fld5hDJRpN92YZnFx: 'Zed Park', fld0EA8biRz66il05: '0499 888 111', fldHsGhaiVWBnYX23: [stu] });
  const zb = add(BR, { fldKRyZ83PSx8LJNq: [zed], fldUGX7gB3zJJIJcF: [stu], fldXrAXCEFqm98MLV: 'Active', fldn4d0wQDjxpmGhS: 'Phone enquiry',
    fldJ7usoWUqcvO4As: 'Nurture', fld56ZTZDLw3TGPAk: new RealDate(NOW - 8 * 864e5).toISOString(),
    fldgzAfAQQG4ogPu1: '{"phase":"qualifying","firstSentAt":"x","asked":{"area":1}}' });
  table(CON).get(zed).fields.fldctz89pfrh0KeaX = [zb];
  await test('scheduled send never asks a qualifying question cold', async () => {
    const n = sent.length;
    await T.nurtureTick();
    const out = sent.slice(n).filter(x => x.to === '+61499888111');
    assert(!out.some(x => /bedrooms|which areas|hoping to be in|place to sell|finance sorted|price range/i.test(x.body)), JSON.stringify(out));
  });
  await test('no second question stacked on a reply that already asks one', async () => {
    claudeQueue.push({ intent: 'answer', reply: 'Got it. Which suburbs were you thinking?', updates: {} });
    await AB.handleBuyerSMS('+61499888111', 'still looking');
    const b = lastSent().body;
    assert.strictEqual((b.match(/\?/g) || []).length, 1, b);
  });
  await test('questions keep going (no 3-in-a-row pause), name used once, no echo', async () => {
    const f = brief(zb).fields;
    Object.assign(f, { fldJZQwk5J404VtSl: ['Alfredton'], fldrHF7kGI9bslQ83: ['House'], fldQ17ko5Rfcmp4go: 3, fldEGmedcp49GMYw2: '3–6 months' });
    f.fldgzAfAQQG4ogPu1 = JSON.stringify({ phase: 'qualifying', firstSentAt: 'x', asked: { area: 1, beds: 1, timeframe: 1 }, qRow: 3, lastQ: 'timeframe',
      history: [{ d: 'out', t: 'Thanks Zed, which areas?', at: new RealDate(NOW - 600e3).toISOString() }] });
    claudeQueue.push({ intent: 'answer', reply: 'Thanks Zed.', updates: {} });
    await AB.handleBuyerSMS('+61499888111', '3 to 6 months');
    const b = lastSent().body;
    assert(/place to sell first/.test(b) && !/Zed/.test(b) && !/keep an eye out/.test(b), b);
  });
  await test('tapback ("Liked …") gets no reply', async () => {
    const n = sent.length;
    await AB.handleBuyerSMS('+61499888111', 'Liked “Thanks. Do you have a place to sell first?”');
    assert.strictEqual(sent.length, n);
  });
  await test('question unanswered 30 min → one sign-off text', async () => {
    const n = sent.length;
    NOW += 31 * 60000;
    await T.idleTick();
    const s = sent.slice(n).filter(x => x.to === '+61499888111');
    assert(s.length === 1 && /^Hey Zed, looks like you've been interrupted or you're busy/.test(s[0].body), JSON.stringify(s));
    await T.idleTick();
    assert.strictEqual(sent.slice(n).filter(x => x.to === '+61499888111').length, 1, 'only once');
  });
  await test('last answer → summary sign-off', async () => {
    const f = brief(zb).fields;
    Object.assign(f, { fld1ex4aZq9ot60aL: 700000, fldEif9eW0g8t1dxp: 'Pre-approved' });
    claudeQueue.push({ intent: 'answer', reply: 'Got it.', updates: { saleDep: 'Nothing to sell' } });
    await AB.handleBuyerSMS('+61499888111', 'no, renting');
    const b = lastSent().body;
    assert(/^Thanks for that Zed, just so I'm sure I've got everything: in Alfredton, 3\+ bed house, up to \$700k/.test(b) && /Alex$/.test(b), b);
    assert.strictEqual(stateOf(zb).phase, 'nurture');
  });
  await test('timeframe is never asked twice', async () => {
    const st = stateOf(zb);
    assert(!(st.asked.timeframe > 1));
  });
  await test('5pm summary lists opt-outs and agent swaps', async () => {
    NOW = new RealDate('2026-11-19T06:00:00Z').getTime(); // Thu 5pm Melbourne
    const n = sent.length;
    await T.summaryTick();
    const s = sent.slice(n).find(x => x.to === '+61400000001');
    assert(s && /Opted out: Sarah/.test(s.body) && /Moved to another agent: Ann Mid \(Leanne → Rob\)/.test(s.body), JSON.stringify(s));
  });
  await test('What Alex Should Know: in the reply context, and "not before 5pm" holds the first text', async () => {
    NOW = new RealDate('2026-11-20T00:00:00Z').getTime(); // Fri 11am Melbourne
    const liz = add(CON, { fld5hDJRpN92YZnFx: 'Liz Ward', fld0EA8biRz66il05: '0499 444 222', fldHsGhaiVWBnYX23: [stu], fldeg2ubhT2KCRR75: 'Partner Tom makes the call' });
    const lb = add(BR, { fldKRyZ83PSx8LJNq: [liz], fldUGX7gB3zJJIJcF: [stu], fldXrAXCEFqm98MLV: 'Active', fldn4d0wQDjxpmGhS: 'Phone enquiry',
      fldoO7YeFwZo0judE: "Pre-approved. Don't text before 5pm, she's a nurse." });
    table(BR).get(lb).createdTime = new RealDate(NOW - 3600e3).toISOString();
    table(CON).get(liz).fields.fldctz89pfrh0KeaX = [lb];
    await T.newBriefTick();
    assert(!sent.some(x => x.to === '+61499444222'), 'held until 5pm');
    assert(!brief(lb).fields.fldgzAfAQQG4ogPu1, 'state untouched so it retries');
    NOW = new RealDate('2026-11-20T06:10:00Z').getTime(); // 5:10pm
    await T.newBriefTick();
    assert(sent.some(x => x.to === '+61499444222'), 'sent after 5pm');
    const n = claudeCalls.length;
    claudeQueue.push({ intent: 'answer', reply: 'Lovely.', updates: { finance: 'Pre-approved' } });
    await AB.handleBuyerSMS('+61499444222', 'yes still looking');
    const prompt = claudeCalls[n].messages[0].content;
    assert(/AGENT NOTES: Pre-approved\. Don't text before 5pm/.test(prompt) && /Partner Tom makes the call/.test(prompt), prompt);
  });
  await test('Add New Buyer page → intro text in the send window, no nudge', async () => {
    NOW = new RealDate('2026-11-20T00:30:00Z').getTime(); // Fri 11:30am Melbourne
    const jo = add(CON, { fld5hDJRpN92YZnFx: 'John Moss', fld0EA8biRz66il05: '0499 121 212', fldHsGhaiVWBnYX23: [stu] });
    const jb = add(BR, { fldKRyZ83PSx8LJNq: [jo], fldUGX7gB3zJJIJcF: [stu], fldXrAXCEFqm98MLV: 'Active', fldn4d0wQDjxpmGhS: 'Add Buyer page – Phone call – 12 Smith St' });
    table(BR).get(jb).createdTime = new RealDate(NOW - 15 * 60e3).toISOString();
    table(CON).get(jo).fields.fldctz89pfrh0KeaX = [jb];
    await T.newBriefTick();
    const s = sent.find(x => x.to === '+61499121212');
    assert(s && /^Hey John, this is Alex from Stone Ballarat\. Stu has asked me to keep you in the loop/.test(s.body) && s.body.length <= 480, JSON.stringify(s));
    assert.strictEqual(stateOf(jb).phase, 'nurture');
    const n = sent.length;
    NOW += 2 * 864e5;
    await T.nudgeTick();
    assert(!sent.slice(n).some(x => x.to === '+61499121212'), 'no nudge');
  });
  await test('PAUSE BUYERS by agent', async () => {
    assert(await AB.handleAgentCommand('+61400000002', 'PAUSE BUYERS'));
    assert(table(TEAM).get(leanne).fields.fldaMZPkpMWVcWVXW);
    assert(await AB.handleAgentCommand('+61400000002', 'resume buyers'));
    assert(!table(TEAM).get(leanne).fields.fldaMZPkpMWVcWVXW);
  });

  console.log(`\n${passed} passed`);
  console.log('\nSample of texts sent:\n' + sent.slice(0, 40).map(s => `→ ${s.to}: ${s.body}`).join('\n'));
})();
