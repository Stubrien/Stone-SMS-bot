// Offline tests for alex-requests.js (same fake Airtable / Twilio / Claude / clock as test.js)
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

// ---------- env + module (Alex Requests)
process.env.AIRTABLE_TOKEN = 'x'; process.env.ALEX_REQUESTS_ENABLED = 'true'; process.env.APPROVER_MOBILE = '0400000001'; process.env.ALEX_PHONE_NUMBER = '+61400000999';
const AR = require('./alex-requests.js');
const REQ = 'tbloPnRQ7chus0Oug', TEAM = 'tbl1aNcrdwmamMyEF', CON = 'tblWRqWCqXWP708dY', TSK = 'tblly5yaH9pTZrUXC', ACT = 'tblMcqHGJSqCevRaP';
const F = { title: 'fldKTmiIRcYfU5Z4I', no: 'fld5o7fUg7BVsdEoB', code: 'fldMWBufbgkv0dAZL', type: 'fldsVWRCUA0E5VxSM', status: 'fld8V4OApPUANGcMM', agent: 'fldp0mUvJKpbtFpFB', by: 'flddhf89rUcDBDsRD', contact: 'fldGO4sZPQhRk44Lm', first: 'fld9kFdzqcLtFqURU', purpose: 'flddaNdDSeRZG6wyV', where: 'fldLKd80b2j2hWayC', bring: 'fldYvzmwvwfthKo44', doc: 'fld9xPTpLJv0ZxL6R', sendTo: 'fldG6l20BYKUXpsHr', every: 'fldGkCy6dq42AEjKN', max: 'fldCs2E2vfwvp7u3U', question: 'fldmDuzqN0147O8Aa', answerTo: 'fldglNoGmYSDgGhww', confirmed: 'fldqvrWi08S02dT8S', convo: 'fldzCdzfPKSk5ofkY', state: 'fldKmJiVyb1pUddfQ', mobile: 'fldOG6muQygJJFcOz', brief: 'fldz7k0vwmcnisdWy', chases: 'fldrT5q5doEwCTaXb' };
NOW = new RealDate('2026-11-10T23:00:00Z').getTime(); // Wed 11 Nov 10:00am Melbourne
const stu = add(TEAM, { fldWZzjCL3xoU0l82: 'Stu Brien', fldbxwqujqA0rygi9: 'Stu', fldUZ1RQT4BNOo41n: '0400 000 001', fldCwH4gZpNqZKmU1: 'stu@stone.example', fld8McuiVqyHAYduE: true });
const leanne = add(TEAM, { fldWZzjCL3xoU0l82: 'Leanne Madigan', fldbxwqujqA0rygi9: 'Leanne', fldUZ1RQT4BNOo41n: '0400 000 002', fldCwH4gZpNqZKmU1: 'leanne@stone.example', fld8McuiVqyHAYduE: true });
const fiona = add(TEAM, { fldWZzjCL3xoU0l82: 'Fiona Hart', fldbxwqujqA0rygi9: 'Fiona', fldUZ1RQT4BNOo41n: '0400 000 004', fldCwH4gZpNqZKmU1: 'fiona@stone.example', fld8McuiVqyHAYduE: true });
const wendy = add(CON, { fld5hDJRpN92YZnFx: 'Wendy Clark', fld0EA8biRz66il05: '0411 222 333' });
const bob = add(CON, { fld5hDJRpN92YZnFx: 'Bob Jones', fld0EA8biRz66il05: '0411 222 444' });
let reqNo = 0;
function newReq(fields, mobile) { reqNo++; return add(REQ, Object.assign({ [F.no]: reqNo, [F.code]: 'R' + reqNo, [F.status]: 'New', [F.agent]: [leanne], [F.by]: [stu], [F.mobile]: [mobile || '0411 222 333'] }, fields)); }
const rq = id => table(REQ).get(id).fields;
const st = id => JSON.parse(rq(id)[F.state] || '{}');
const to = num => sent.filter(s => s.to === num);
const lastTo = num => { const a = to(num); return a.length ? a[a.length - 1].body : ''; };
const W = '+61411222333', B = '+61411222444', STU = '+61400000001', LEANNE = '+61400000002', FIONA = '+61400000004';
let passed = 0;
async function test(name, fn) { claudeQueue = []; try { await fn(); passed++; console.log('✔ ' + name); } catch (e) { console.log('✘ ' + name + '\n   ' + (e.stack || e).toString().split('\n').slice(0, 5).join('\n   ')); process.exitCode = 1; } }

(async () => {
  let r1;
  await test('meeting: draft goes to the requester for approval', async () => {
    r1 = newReq({ [F.type]: 'Meet the agent', [F.contact]: [wendy], [F.purpose]: 'AML / ID check', [F.where]: 'Our office', [F.bring]: 'photo ID', [F.brief]: 'AML paperwork and Section 32', [F.first]: 'Approve it first' });
    claudeQueue.push({ text: "Hi Wendy, it's Alex from Stone Ballarat - I help Leanne with bookings. Leanne would like to meet at our office to go through the AML paperwork and Section 32. What days and times suit you this week?" });
    await AR.tick();
    assert.strictEqual(rq(r1)[F.status], 'Awaiting approval');
    assert(/R1 YES/.test(lastTo(STU)), lastTo(STU));
    assert.strictEqual(to(W).length, 0);
  });
  await test('meeting: R1 YES sends it to the contact', async () => {
    assert(await AR.handleTeamSMS(STU, 'R1 yes'));
    assert.strictEqual(rq(r1)[F.status], 'Contacting');
    assert(/Hi Wendy, it's Alex/.test(lastTo(W)), lastTo(W));
  });
  await test('meeting: contact gives times → options to the agent', async () => {
    claudeQueue.push({ intent: 'availability', reply: "Thanks Wendy, I'll check with Leanne and confirm a time shortly.", options: ['2026-11-12T10:00', '2026-11-12T14:00', '2026-11-13T09:30'] });
    assert(await AR.handleContactSMS(W, 'Thursday morning or afternoon works, or Friday early'));
    assert.strictEqual(rq(r1)[F.status], 'Waiting on agent');
    assert(/R1 - Wendy Clark can do: 1 - Thu 12 Nov, 10:00am/.test(lastTo(LEANNE)), lastTo(LEANNE));
    assert(/check with Leanne/.test(lastTo(W)));
  });
  await test('meeting: agent picks 2 → confirmed with both, task made', async () => {
    assert(await AR.handleTeamSMS(LEANNE, 'R1 2'));
    assert.strictEqual(rq(r1)[F.status], 'Confirmed');
    assert(/All set Wendy - Leanne will see you Thu 12 Nov.*2:00pm at our office.*Please bring photo ID/.test(lastTo(W)), lastTo(W));
    assert(/R1 confirmed with Wendy Clark/.test(lastTo(LEANNE)), lastTo(LEANNE));
    const tasks = [...table(TSK).values()].filter(t => /AML/.test(t.fields.flds1zBNNSIuWMIAe));
    assert.strictEqual(tasks.length, 1);
    assert.deepStrictEqual(tasks[0].fields.fldaINd0hRSQlVQCN, [leanne]);
  });
  await test('meeting: done after the time passes, activity logged', async () => {
    NOW = new RealDate('2026-11-12T07:00:00Z').getTime(); // Thu 6pm
    await AR.tick();
    assert.strictEqual(rq(r1)[F.status], 'Done');
    assert([...table(ACT).values()].some(a => /R1/.test(a.fields.fldBSXLvtiGrLDlBB) && a.fields.fldFkehYx2Ow3iDm4 === 'Text message'));
  });

  let r2;
  await test('chase: sent straight away with where to send it', async () => {
    NOW = new RealDate('2026-11-12T23:00:00Z').getTime(); // Fri 13 Nov 10am
    r2 = newReq({ [F.type]: 'Chase a document', [F.contact]: [bob], [F.doc]: 'ID / AML documents', [F.sendTo]: 'Fiona', [F.every]: 2, [F.max]: 2, [F.first]: 'Send straight away' }, '0411 222 444');
    claudeQueue.push({ text: '' }); // too short → plain fallback
    await AR.tick();
    assert.strictEqual(rq(r2)[F.status], 'Contacting');
    assert(/email it to Fiona at fiona@stone.example/.test(lastTo(B)), lastTo(B));
  });
  await test('chase: reminder after 2 days (contact hours only)', async () => {
    NOW += 2 * 864e5 + 3600000; // Sun 11am
    await AR.tick();
    assert.strictEqual(rq(r2)[F.chases], 1);
    assert(/reminder/.test(lastTo(B)), lastTo(B));
  });
  await test('chase: contact says sent → Fiona asked to confirm, GOT IT closes', async () => {
    claudeQueue.push({ intent: 'sent', reply: 'Thanks Bob, I will let Fiona know.' });
    await AR.handleContactSMS(B, 'Just emailed them now');
    assert.strictEqual(rq(r2)[F.status], 'Waiting on agent');
    assert(/R2 GOT IT/.test(lastTo(FIONA)), lastTo(FIONA));
    await AR.handleTeamSMS(FIONA, 'r2 got it');
    assert.strictEqual(rq(r2)[F.status], 'Done');
    assert(/come through/.test(lastTo(B)));
  });

  let r3;
  await test('question: answer goes to the agent and the contact notes', async () => {
    r3 = newReq({ [F.type]: 'Ask a question', [F.contact]: [wendy], [F.question]: 'Is the dishwasher included in the sale?', [F.answerTo]: 'Both', [F.first]: 'Send straight away' });
    claudeQueue.push({ text: "Hi Wendy, it's Alex from Stone Ballarat - Leanne asked me to check: is the dishwasher included in the sale?" });
    await AR.tick();
    claudeQueue.push({ intent: 'answered', answer: 'Yes it stays', reply: "Thanks Wendy, I'll pass that on to Leanne." });
    await AR.handleContactSMS(W, 'Yes it stays');
    assert.strictEqual(rq(r3)[F.status], 'Done');
    assert(/answer to "Is the dishwasher/.test(lastTo(LEANNE)), lastTo(LEANNE));
    assert(/Q: Is the dishwasher.*A: Yes it stays/.test(table(CON).get(wendy).fields.fldeg2ubhT2KCRR75));
  });

  let r4;
  await test('escalation: price question → back to the agent with a High task', async () => {
    r4 = newReq({ [F.type]: 'Meet the agent', [F.contact]: [bob], [F.purpose]: 'Appraisal', [F.where]: 'Their home', [F.first]: 'Send straight away' }, '0411 222 444');
    claudeQueue.push({ text: "Hi Bob, it's Alex from Stone Ballarat - I help Leanne with bookings. Leanne would like to pop round for the appraisal - what days suit you this week?" });
    await AR.tick();
    claudeQueue.push({ intent: 'question_for_agent', reply: "Good question Bob, I'll get Leanne to give you a call." });
    await AR.handleContactSMS(B, 'What do you think it would sell for?');
    assert.strictEqual(rq(r4)[F.status], 'Needs agent');
    assert(/over to you/.test(lastTo(LEANNE)));
    assert([...table(TSK).values()].some(t => /R4 over to you/.test(t.fields.flds1zBNNSIuWMIAe) && t.fields.fldFmfDdgbBYhqki8 === 'High'));
  });
  await test('closed request: later replies are forwarded to the agent', async () => {
    const n = to(LEANNE).length;
    await AR.handleContactSMS(B, 'Also is Tuesday ok?');
    assert.strictEqual(to(LEANNE).length, n + 1);
  });

  let r5;
  await test('no reply: nudge after a day, back to the agent after another', async () => {
    r5 = newReq({ [F.type]: 'Meet the agent', [F.contact]: [wendy], [F.purpose]: 'Sign the authority', [F.where]: 'Our office', [F.first]: 'Send straight away' });
    claudeQueue.push({ text: "Hi Wendy, it's Alex from Stone Ballarat - Leanne would like to find a time to sign the authority at our office. What suits?" });
    await AR.tick();
    NOW += 25 * 3600000; await AR.tick();
    assert(/just following up/.test(lastTo(W)), lastTo(W));
    NOW += 25 * 3600000; await AR.tick();
    assert.strictEqual(rq(r5)[F.status], 'Needs agent');
  });

  let r6;
  await test('agent suggests another time; contact accepts', async () => {
    r6 = newReq({ [F.type]: 'Meet the agent', [F.contact]: [wendy], [F.purpose]: 'General catch-up', [F.where]: 'Phone call', [F.first]: 'Send straight away' });
    claudeQueue.push({ text: "Hi Wendy, it's Alex from Stone Ballarat - Leanne would like a quick call. What suits?" });
    await AR.tick();
    const day = new RealDate(NOW + 2 * 864e5).toISOString().slice(0, 10);
    claudeQueue.push({ intent: 'availability', reply: 'Thanks Wendy, will check.', options: [day + 'T09:00'] });
    await AR.handleContactSMS(W, 'mornings are best');
    claudeQueue.push({ local: day + 'T11:30' });
    await AR.handleTeamSMS(LEANNE, 'R6 11.30 that day instead');
    assert(/would .* 11:30am suit/.test(lastTo(W)), lastTo(W));
    claudeQueue.push({ intent: 'accept', reply: '' });
    await AR.handleContactSMS(W, 'yes that works');
    assert.strictEqual(rq(r6)[F.status], 'Confirmed');
    assert(/Leanne will give you a call/.test(lastTo(W)), lastTo(W));
  });

  let r7;
  await test('opt-out stops it and marks Do Not Contact', async () => {
    r7 = newReq({ [F.type]: 'Ask a question', [F.contact]: [bob], [F.question]: 'Are you home Saturday?', [F.first]: 'Send straight away' }, '0411 222 444');
    claudeQueue.push({ text: "Hi Bob, it's Alex from Stone Ballarat - Leanne asked: are you home Saturday?" });
    await AR.tick();
    claudeQueue.push({ intent: 'stop', reply: "No worries, I'll leave it there." });
    await AR.handleContactSMS(B, 'stop texting me');
    assert.strictEqual(rq(r7)[F.status], 'Cancelled');
    assert.strictEqual(table(CON).get(bob).fields.fldd9p4vMwi8R6Bx8, true);
  });

  await test('late at night the opening is queued for the morning', async () => {
    NOW = new RealDate('2026-11-18T09:30:00Z').getTime(); // Wed 8:30pm Melbourne
    const r8 = newReq({ [F.type]: 'Ask a question', [F.contact]: [wendy], [F.question]: 'Can we get the keys back?', [F.first]: 'Send straight away' });
    claudeQueue.push({ text: "Hi Wendy, it's Alex from Stone Ballarat - Leanne asked if she can get the keys back?" });
    const n = to(W).length;
    await AR.tick();
    assert.strictEqual(to(W).length, n);
    NOW = new RealDate('2026-11-18T22:05:00Z').getTime(); // Thu 9:05am
    await AR.tick();
    assert.strictEqual(to(W).length, n + 1);
  });
  await test('unknown code and non-team numbers are ignored safely', async () => {
    assert(await AR.handleTeamSMS(STU, 'R999 yes'));
    assert(/can't find/.test(lastTo(STU)));
    assert.strictEqual(await AR.handleTeamSMS('+61499999999', 'R1 yes'), false);
    assert.strictEqual(await AR.handleContactSMS('+61499999999', 'hello'), false);
  });

  await test('page buttons: approve with an edit, then pick a time', async () => {
    NOW = new RealDate('2026-11-19T23:00:00Z').getTime(); // Fri 20 Nov 10am
    const r9 = newReq({ [F.type]: 'Meet the agent', [F.contact]: [wendy], [F.purpose]: 'Sign Section 32 / contract', [F.where]: 'Our office', [F.first]: 'Approve it first' });
    claudeQueue.push({ text: "Hi Wendy, it's Alex from Stone Ballarat - Leanne would like to meet to sign the contract. What suits?" });
    await AR.tick();
    assert.strictEqual(rq(r9)[F.status], 'Awaiting approval');
    assert(/sign the contract/.test(rq(r9).fldRbDkjdVaF5BqG2));
    const n = to(STU).length;
    table(REQ).get(r9).fields.fldVQ8ivTxzVF1YAV = "EDIT Hi Wendy, Alex here for Leanne - when could you pop in to sign the contract?";
    await AR.tick();
    assert.strictEqual(rq(r9)[F.status], 'Contacting');
    assert(/pop in to sign/.test(lastTo(W)));
    assert.strictEqual(to(STU).length, n); // no text back for page buttons
    assert(!rq(r9).fldVQ8ivTxzVF1YAV);
    const d = new RealDate(NOW + 4 * 864e5).toISOString().slice(0, 10);
    claudeQueue.push({ intent: 'availability', reply: 'Thanks Wendy.', options: [d + 'T10:00', d + 'T15:00'] });
    await AR.handleContactSMS(W, 'Monday any time');
    table(REQ).get(r9).fields.fldVQ8ivTxzVF1YAV = '1';
    await AR.tick();
    assert.strictEqual(rq(r9)[F.status], 'Confirmed');
  });
  await test('page cancel before Alex starts', async () => {
    const r10 = newReq({ [F.type]: 'Ask a question', [F.contact]: [wendy], [F.question]: 'x?', [F.first]: 'Send straight away' });
    table(REQ).get(r10).fields.fldVQ8ivTxzVF1YAV = 'CANCEL';
    const n = to(W).length;
    await AR.tick();
    assert.strictEqual(rq(r10)[F.status], 'Cancelled');
    assert.strictEqual(to(W).length, n);
  });

  console.log(`\n${passed} passed`);
})();
