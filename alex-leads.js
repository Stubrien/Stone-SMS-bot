// alex-leads.js
// Alex <-> Airtable Sales Leads integration (pilot).
// - Sweeps Airtable for vendor leads that are due a nurture check-in or need an appraisal booked
// - Drafts each SMS with Claude using the lead card + notes/history
// - Texts every draft to the approver (Stu) for YES / EDIT / NO / KEEP before anything is sent
// - Handles replies from pilot vendors: logs them, updates Key Facts / follow-up date, drafts a reply
// - Creates new vendor enquiries in Airtable (Entered Via = Alex) instead of Pipedrive
//
// Env vars: AIRTABLE_TOKEN, AIRTABLE_BASE (default below), APPROVER_MOBILE, APPROVER_NAME (default Stu),
//           ALEX_PHONE_NUMBER, ANTHROPIC_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
//           ALEX_LEADS_ENABLED ("true" to run the sweep; anything else = off), ALEX_MODEL (optional)

const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const BASE = process.env.AIRTABLE_BASE || 'apphczJpEh8x2EwQL';
const MODEL = process.env.ALEX_MODEL || 'claude-sonnet-4-6';
const TZ = 'Australia/Melbourne';
const SWEEP_MINUTES = 15;
const MIN_DAYS_BETWEEN_TEXTS = 5;

const T = {
  leads: 'tblrFYa8aQsLJkW13',
  team: 'tbl1aNcrdwmamMyEF',
  activity: 'tblMcqHGJSqCevRaP',
  messages: 'tbl78WnIpym0PEutf'
};

const L = {
  name: 'fldb5kwwfLmfF7Sqp', address: 'fldHjG3VIzePec6rR', phone: 'fld5NRekiK1Cb7hv9', email: 'fldMGaKgIuosJHBrx',
  stage: 'fldIHUJYiPGHuR0WZ', agent: 'fldDF3RmFK2CFjXc0', nextAction: 'fldXoyCWonj5IidZl', nextActionDate: 'fldbYKvYS1cxIPssp',
  keyFacts: 'fldXkemyAdKOMduEO', background: 'fldcVPpXHcVQAEpe6', nurtureReason: 'fldwouDPfX6TcWPnu',
  interval: 'flddzzAoY8pZooOSq', followUp: 'fldk7KxcmipmgwqCo', apptType: 'fldybud7oFTNi2HSm',
  doNotContact: 'fld6sb3HQyCZqRjzC', pauseAlex: 'fldn1Mn8KGPMyblm3', source: 'fldxyNzQzMKJ08wMw',
  sourceDetail: 'flduDl2hpSydx2vH8', enteredVia: 'fldTIyMoiysNEFHb2', alexLastContact: 'fldDdLadhfB3yTdSJ',
  activity: 'fldR1Cxzj1hZ9vxKE', marketingConsent: 'fldS9HaPbovHxT4Kc'
};
const TM = { name: 'fldWZzjCL3xoU0l82', firstName: 'fldbxwqujqA0rygi9', mobile: 'fldUZ1RQT4BNOo41n', alexActive: 'fld1LSnoBvGGdO2VJ' };
const A = {
  summary: 'fldBSXLvtiGrLDlBB', lead: 'fldR7UavJmh0OWsDI', kind: 'fldfKAWZQWXe00nz7', type: 'fldP8or1OJQgK4jrg',
  detail: 'fldhFWP8aFaaRV3nV', internal: 'fld0zVTRAnXEPlDjD', author: 'fld9GdJ7yWaVdBE9z', loggedAt: 'fldkHdOEI2S99kdw3'
};
const M = {
  code: 'fldjLvmqFNFdlve4K', lead: 'fldt7fbHHdWrLn5UP', direction: 'fldAvlSCuVXNmw4AV', purpose: 'fldTZu3VVcNGVAoNf',
  status: 'fldItYMA0uRs9PGfg', draft: 'fldIXNAwcqOEqFpgT', finalText: 'fldlp8M5nnCECbygV', reasoning: 'fldJbwD7ZTChzFsUi',
  number: 'fld7buRBoFF8uw2E2', approverReply: 'fldRGjJkaHxIkkEuF', approvedBy: 'fldy47BHujwPffocQ',
  approvedAt: 'fldjLGjboCUBenuAB', sentAt: 'fldD2PFGg841BiaQK', sid: 'fldNI4kd6kQB11mJM', error: 'fld5pF9AtokFDQVev',
  created: 'fldRowPux9k4y7f7f'
};

// ---------------------------------------------------------------- helpers

function enabled() { return !!process.env.AIRTABLE_TOKEN; }
function sweepEnabled() { return enabled() && String(process.env.ALEX_LEADS_ENABLED).toLowerCase() === 'true'; }

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

function melbNow() {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
  }).formatToParts(new Date());
  const p = t => (parts.find(x => x.type === t) || {}).value;
  return { date: `${p('year')}-${p('month')}-${p('day')}`, hour: parseInt(p('hour'), 10) % 24, weekday: p('weekday') };
}
function inSendWindow() {
  const n = melbNow();
  return !['Sat', 'Sun'].includes(n.weekday) && n.hour >= 9 && n.hour < 18;
}
function addDays(iso, days) { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); }
function dmy(iso) { return iso ? iso.slice(8, 10) + '/' + iso.slice(5, 7) : ''; }
function sel(v) { return v && typeof v === 'object' ? v.name : (v || ''); }
function firstName(full) { return (full || '').trim().split(/\s+/)[0] || ''; }

// ---------------------------------------------------------------- Airtable REST

async function at(method, path, body) {
  const res = await fetch('https://api.airtable.com/v0/' + BASE + '/' + path, {
    method,
    headers: { Authorization: 'Bearer ' + process.env.AIRTABLE_TOKEN, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
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
    out = out.concat(r.records || []);
    offset = r.offset;
  } while (offset);
  return out;
}
async function getRecord(table, id) { return at('GET', table + '/' + id + '?returnFieldsByFieldId=true'); }
async function createRecord(table, fields) {
  const r = await at('POST', table + '?returnFieldsByFieldId=true', { records: [{ fields }], typecast: true });
  return r.records[0];
}
async function updateRecord(table, id, fields) {
  return at('PATCH', table + '?returnFieldsByFieldId=true', { records: [{ id, fields }], typecast: true });
}

async function logActivity(leadId, { summary, detail, type, kind, internal }) {
  try {
    await createRecord(T.activity, {
      [A.summary]: summary, [A.lead]: [leadId], [A.kind]: kind || 'Note', [A.type]: type || 'SMS',
      [A.detail]: detail || '', [A.internal]: !!internal, [A.author]: 'Alex'
    });
  } catch (e) { console.error('Alex leads: activity log failed', e.message); }
}

// ---------------------------------------------------------------- context for Claude

async function leadContext(lead) {
  const f = lead.fields;
  const actIds = (f[L.activity] || []).slice(-40);
  let history = [];
  if (actIds.length) {
    const formula = 'OR(' + actIds.map(id => `RECORD_ID()='${id}'`).join(',') + ')';
    const acts = await listAll(T.activity, { filterByFormula: formula });
    history = acts
      .map(a => ({
        at: a.fields[A.loggedAt] || a.createdTime, kind: sel(a.fields[A.kind]), type: sel(a.fields[A.type]),
        summary: a.fields[A.summary] || '', detail: a.fields[A.detail] || '', internal: !!a.fields[A.internal], author: a.fields[A.author] || ''
      }))
      .sort((x, y) => (x.at < y.at ? -1 : 1));
  }
  const agentIds = f[L.agent] || [];
  let agent = null;
  if (agentIds.length) { try { agent = await getRecord(T.team, agentIds[0]); } catch (e) { /* ignore */ } }
  return {
    card: {
      contactName: f[L.name] || '', firstName: firstName(f[L.name]), address: f[L.address] || '', stage: sel(f[L.stage]),
      nextAction: f[L.nextAction] || '', nextActionDate: f[L.nextActionDate] || '', keyFacts: f[L.keyFacts] || '',
      background: f[L.background] || '', nurtureReason: sel(f[L.nurtureReason]), followUpInterval: sel(f[L.interval]),
      followUpDate: f[L.followUp] || '', appraisalType: sel(f[L.apptType]), source: sel(f[L.source])
    },
    agent: agent ? { name: agent.fields[TM.name], firstName: agent.fields[TM.firstName] || firstName(agent.fields[TM.name]), mobile: agent.fields[TM.mobile] } : null,
    history
  };
}

function historyText(history) {
  if (!history.length) return '(no notes yet)';
  return history.map(h => {
    const tag = h.internal ? ' [INTERNAL – never mention to the vendor]' : '';
    return `- ${String(h.at).slice(0, 10)} ${h.kind}/${h.type} by ${h.author || 'team'}: ${h.summary}${h.detail ? ' – ' + h.detail : ''}${tag}`;
  }).join('\n');
}

const VOICE = "You write SMS messages as Alex, who works in the office of a Stone Real Estate Ballarat sales agent. " +
  "Tone: warm, local, plain Australian English, like a real person in a real estate office - never salesy. " +
  "Rules: 1-3 short sentences. One question at most. No exclamation marks unless clearly warranted. Never start with filler (Great, Absolutely, Hope you're well is fine only if natural). " +
  "Never give a price opinion, valuation or commission. Never mention you are an AI unless asked directly. " +
  "Never repeat or hint at anything marked INTERNAL, or anything in Background Notes the vendor would not have told us themselves. " +
  "Refer to the agent by first name (e.g. 'Stu asked me to check in'). Do not invent facts that are not on the card.";

async function claudeJSON(system, user, maxTokens) {
  const r = await anthropic.messages.create({ model: MODEL, max_tokens: maxTokens || 600, system, messages: [{ role: 'user', content: user }] });
  const text = r.content.map(c => c.text || '').join('');
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error('No JSON from Claude: ' + text.slice(0, 200));
  return JSON.parse(m[0]);
}

// ---------------------------------------------------------------- approvals

async function nextCode() {
  const recent = await listAll(T.messages, { maxRecords: '50', 'sort[0][field]': M.created, 'sort[0][direction]': 'desc', [`fields[]`]: M.code });
  let max = 0;
  for (const r of recent) { const m = String(r.fields[M.code] || '').match(/^A(\d+)$/i); if (m) max = Math.max(max, parseInt(m[1], 10)); }
  const n = max >= 99 ? 1 : max + 1;
  return 'A' + n;
}

async function sendSMS(to, body) {
  const msg = await twilioClient.messages.create({ from: process.env.ALEX_PHONE_NUMBER, to: normalisePhone(to), body });
  return msg.sid;
}

function approverMobile() { return normalisePhone(process.env.APPROVER_MOBILE); }
function isApprover(from) { return !!approverMobile() && samePhone(from, approverMobile()); }

async function queueDraft({ lead, ctx, purpose, draft, reasoning, extraLines }) {
  const code = await nextCode();
  await createRecord(T.messages, {
    [M.code]: code, [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.purpose]: purpose, [M.status]: 'Awaiting approval',
    [M.draft]: draft, [M.reasoning]: reasoning || '', [M.number]: normalisePhone(lead.fields[L.phone])
  });
  const c = ctx.card;
  const head = `${code} · ${c.contactName}${c.address && c.address !== c.contactName ? ', ' + c.address : ''} (${c.stage}${c.followUpInterval ? ', ' + c.followUpInterval : ''})`;
  const shownReason = String(reasoning || '').replace(/\s*PREV_FOLLOW_UP=\S+/, '').trim();
  const why = shownReason ? `\nWhy: ${shownReason}` : '';
  const extra = extraLines && extraLines.length ? '\n' + extraLines.map(x => x.replace('<code>', code)).join('\n') : '';
  const text = `${head}${why}${extra}\n\nDraft: "${draft}"\n\nReply YES ${code} · EDIT ${code} your wording · NO ${code}`;
  await sendSMS(approverMobile(), text);
  console.log('Alex leads: draft ' + code + ' sent for approval');
  return code;
}

async function sendApproved(msgRec) {
  const f = msgRec.fields;
  const leadId = (f[M.lead] || [])[0];
  const text = f[M.finalText] || f[M.draft];
  const to = f[M.number];
  if (!leadId || !to || !text) throw new Error('Message ' + f[M.code] + ' is missing lead, number or text');
  const lead = await getRecord(T.leads, leadId);
  if (lead.fields[L.doNotContact]) {
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Rejected', [M.error]: 'Do Not Contact ticked before sending' });
    return 'blocked (Do Not Contact)';
  }
  try {
    const sid = await sendSMS(to, text);
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Sent', [M.sentAt]: new Date().toISOString(), [M.sid]: sid, [M.finalText]: text });
    const leadUpd = { [L.alexLastContact]: new Date().toISOString() };
    // A nurture check-in counts as contact: roll the follow-up forward by the interval
    if (sel(f[M.purpose]) === 'Nurture check-in') {
      const days = parseInt(sel(lead.fields[L.interval]), 10);
      if (days) leadUpd[L.followUp] = addDays(melbNow().date, days);
    }
    await updateRecord(T.leads, leadId, leadUpd);
    await logActivity(leadId, { summary: 'Alex texted the vendor (' + sel(f[M.purpose]).toLowerCase() + ')', detail: text, type: 'SMS' });
    return 'sent';
  } catch (e) {
    await updateRecord(T.messages, msgRec.id, { [M.status]: 'Failed', [M.error]: e.message });
    throw e;
  }
}

async function waitingDrafts() {
  return listAll(T.messages, { filterByFormula: `{${M.status}}='Awaiting approval'` });
}

// Returns true when the SMS was an approver command (so the normal Alex chat flow is skipped)
async function handleApproverSMS(body) {
  const text = (body || '').trim();
  const m = text.match(/^(YES|Y|OK|SEND|EDIT|NO|N|KEEP|LIST)\b\s*(A\d+)?\s*([\s\S]*)$/i);
  if (!m) return false;
  const cmd = m[1].toUpperCase();
  let code = (m[2] || '').toUpperCase();
  const rest = (m[3] || '').trim();
  const waiting = await waitingDrafts();

  if (cmd === 'LIST') {
    await sendSMS(approverMobile(), waiting.length ? 'Waiting: ' + waiting.map(w => w.fields[M.code]).join(', ') : 'Nothing waiting for approval.');
    return true;
  }
  if (!code) {
    if (waiting.length === 1) code = String(waiting[0].fields[M.code]).toUpperCase();
    else {
      await sendSMS(approverMobile(), waiting.length ? `Which one? Waiting: ${waiting.map(w => w.fields[M.code]).join(', ')}. e.g. YES ${waiting[0].fields[M.code]}` : 'Nothing waiting for approval.');
      return true;
    }
  }

  if (cmd === 'KEEP') {
    // Undo a follow-up date change Alex made while reading a vendor reply
    const all = await listAll(T.messages, { filterByFormula: `AND(UPPER({${M.code}})='${code}',{${M.direction}}='To vendor')`, maxRecords: '5', 'sort[0][field]': M.created, 'sort[0][direction]': 'desc' });
    const rec = all[0];
    const m2 = rec && String(rec.fields[M.reasoning] || '').match(/PREV_FOLLOW_UP=(\d{4}-\d{2}-\d{2}|none)/);
    if (!rec || !m2) { await sendSMS(approverMobile(), `No follow-up change to undo on ${code}.`); return true; }
    const leadId = (rec.fields[M.lead] || [])[0];
    await updateRecord(T.leads, leadId, { [L.followUp]: m2[1] === 'none' ? null : m2[1] });
    await logActivity(leadId, { summary: 'Follow-up date change undone (KEEP)', type: 'Follow-up date changed', kind: 'History' });
    await sendSMS(approverMobile(), `Done – follow-up date on ${code} put back${m2[1] === 'none' ? '' : ' to ' + dmy(m2[1])}.`);
    return true;
  }

  const rec = waiting.find(w => String(w.fields[M.code]).toUpperCase() === code);
  if (!rec) { await sendSMS(approverMobile(), `${code} isn't waiting for approval.`); return true; }
  const by = process.env.APPROVER_NAME || 'Stu';

  if (cmd === 'NO' || cmd === 'N') {
    await updateRecord(T.messages, rec.id, { [M.status]: 'Rejected', [M.approverReply]: text, [M.approvedBy]: by, [M.approvedAt]: new Date().toISOString() });
    await sendSMS(approverMobile(), `${code} binned – nothing sent.`);
    return true;
  }
  if (cmd === 'EDIT' && !rest) { await sendSMS(approverMobile(), `Send the new wording after the code, e.g. EDIT ${code} Hi Sonya…`); return true; }

  const fields = { [M.status]: cmd === 'EDIT' ? 'Edited & approved' : 'Approved', [M.approverReply]: text, [M.approvedBy]: by, [M.approvedAt]: new Date().toISOString() };
  if (cmd === 'EDIT') fields[M.finalText] = rest;
  await updateRecord(T.messages, rec.id, fields);

  if (!inSendWindow()) {
    await sendSMS(approverMobile(), `${code} approved – it will go out at 9am (outside Mon–Fri 9–6).`);
    return true;
  }
  const fresh = await getRecord(T.messages, rec.id);
  try {
    const result = await sendApproved(fresh);
    await sendSMS(approverMobile(), `${code} ${result}.`);
  } catch (e) {
    await sendSMS(approverMobile(), `${code} failed to send: ${e.message.slice(0, 120)}`);
  }
  return true;
}

// ---------------------------------------------------------------- outbound sweep

async function alexActiveAgentIds() {
  const team = await listAll(T.team, { filterByFormula: `{${TM.alexActive}}` });
  return new Set(team.map(t => t.id));
}

async function eligibleLeads() {
  const agents = await alexActiveAgentIds();
  if (!agents.size) return [];
  const leads = await listAll(T.leads, {
    filterByFormula: `AND(OR({${L.stage}}='Nurture',{${L.stage}}='Qualifying'),NOT({${L.doNotContact}}),NOT({${L.pauseAlex}}),{${L.phone}}!='')`
  });
  const today = melbNow().date;
  const cutoff = Date.now() - MIN_DAYS_BETWEEN_TEXTS * 86400000;
  const waiting = await waitingDrafts();
  const waitingLeadIds = new Set(waiting.map(w => (w.fields[M.lead] || [])[0]));
  return leads.filter(l => {
    const f = l.fields;
    if (!(f[L.agent] || []).some(id => agents.has(id))) return false;
    if (waitingLeadIds.has(l.id)) return false;
    if (f[L.alexLastContact] && new Date(f[L.alexLastContact]).getTime() > cutoff) return false;
    const stage = sel(f[L.stage]);
    if (stage === 'Nurture') return !!f[L.followUp] && f[L.followUp] <= today;
    if (stage === 'Qualifying') return /^alex\b/i.test(f[L.nextAction] || '') && (!f[L.nextActionDate] || f[L.nextActionDate] <= today);
    return false;
  });
}

async function draftOutbound(lead) {
  const ctx = await leadContext(lead);
  const stage = ctx.card.stage;
  const purpose = stage === 'Nurture' ? 'Nurture check-in' : 'Appraisal booking';
  const goal = purpose === 'Nurture check-in'
    ? 'Write a friendly nurture check-in. Reference something genuine from the card or notes if there is something (their plans, timing, the property), and ask one light question that tells us whether their timing has changed. Do not push for an appraisal unless the notes say they are close to ready.'
    : `Write a message offering to book a free market appraisal${ctx.card.appraisalType ? ' (' + ctx.card.appraisalType + ')' : ''} with the agent, asking what days or times generally suit them. Do not offer specific times.`;
  const firstContact = !ctx.history.some(h => h.author === 'Alex');
  const user =
    `AGENT: ${ctx.agent ? ctx.agent.name : 'the agent'}\n` +
    `LEAD CARD: ${JSON.stringify(ctx.card)}\n\nNOTES & HISTORY (oldest first):\n${historyText(ctx.history)}\n\n` +
    `TASK: ${goal}${firstContact ? ' This is the first time Alex is texting this person, so introduce yourself briefly (Alex from ' + (ctx.agent ? ctx.agent.firstName : 'the agent') + "'s office at Stone Real Estate Ballarat) and end with: Reply STOP to opt out." : ''}\n\n` +
    'Return JSON only: {"sms": "...", "reasoning": "one short sentence for the agent on what you picked up from the card"}';
  const out = await claudeJSON(VOICE, user, 500);
  return { ctx, purpose, draft: String(out.sms || '').trim(), reasoning: String(out.reasoning || '').trim() };
}

let lastDigestDate = null;
async function sweep() {
  if (!sweepEnabled()) return;
  if (!inSendWindow()) return;
  try {
    // 1. send anything approved outside hours
    const approved = await listAll(T.messages, { filterByFormula: `OR({${M.status}}='Approved',{${M.status}}='Edited & approved')` });
    for (const r of approved) {
      try { const res = await sendApproved(r); console.log('Alex leads: sent approved ' + r.fields[M.code] + ' ' + res); }
      catch (e) { console.error('Alex leads: send failed', e.message); }
    }

    // 2. morning digest of drafts still waiting from earlier days; expire after 2 days
    const today = melbNow().date;
    const waiting = await waitingDrafts();
    const old = waiting.filter(w => String(w.fields[M.created] || w.createdTime).slice(0, 10) < today);
    for (const w of old) {
      const ageDays = (Date.now() - new Date(w.fields[M.created] || w.createdTime).getTime()) / 86400000;
      if (ageDays > 3) await updateRecord(T.messages, w.id, { [M.status]: 'Expired' });
    }
    if (lastDigestDate !== today) {
      const stillWaiting = (await waitingDrafts()).filter(w => String(w.fields[M.created] || w.createdTime).slice(0, 10) < today);
      if (stillWaiting.length) {
        await sendSMS(approverMobile(), `Morning – ${stillWaiting.length} Alex draft(s) still waiting: ${stillWaiting.map(w => w.fields[M.code]).join(', ')}. Reply YES/EDIT/NO with the code, or LIST.`);
      }
      lastDigestDate = today;
    }

    // 3. new drafts for leads that are due (max 5 per sweep so the approver isn't flooded)
    const due = (await eligibleLeads()).slice(0, 5);
    for (const lead of due) {
      try {
        const d = await draftOutbound(lead);
        if (d.draft) await queueDraft({ lead, ctx: d.ctx, purpose: d.purpose, draft: d.draft, reasoning: d.reasoning });
      } catch (e) { console.error('Alex leads: draft failed for ' + lead.id, e.message); }
    }
  } catch (e) {
    console.error('Alex leads: sweep error', e.message);
  }
}

// ---------------------------------------------------------------- inbound from vendors

async function findLeadByPhone(from) {
  const digits = normalisePhone(from).replace('+61', '');
  // Airtable phone fields are free text: strip spaces and compare the last 9 digits
  const formula = `RIGHT(REGEX_REPLACE({${L.phone}}&'','[^0-9]',''),9)='${digits.slice(-9)}'`;
  const found = await listAll(T.leads, { filterByFormula: formula, maxRecords: '5' });
  if (!found.length) return null;
  // prefer an active / nurture card over closed ones
  const rank = s => (['Lost', 'Authority Signed'].includes(s) ? 1 : 0);
  return found.sort((a, b) => rank(sel(a.fields[L.stage])) - rank(sel(b.fields[L.stage])))[0];
}

async function isPilotLead(lead) {
  if (!lead) return false;
  const agents = await alexActiveAgentIds();
  return (lead.fields[L.agent] || []).some(id => agents.has(id));
}

// Returns true when handled (pilot lead); false to let the normal Alex chat flow run
async function handleVendorSMS(from, body) {
  if (!enabled()) return false;
  const lead = await findLeadByPhone(from);
  if (!(await isPilotLead(lead))) return false;
  const f = lead.fields;
  const text = (body || '').trim();

  await createRecord(T.messages, {
    [M.lead]: [lead.id], [M.direction]: 'From vendor', [M.status]: 'Received', [M.finalText]: text, [M.number]: normalisePhone(from), [M.purpose]: 'Other'
  });
  await logActivity(lead.id, { summary: `${firstName(f[L.name]) || 'Vendor'} replied to Alex`, detail: text, type: 'SMS' });

  if (/^(STOP|UNSUBSCRIBE|QUIT|CANCEL|END|STOPALL)$/i.test(text)) {
    await updateRecord(T.leads, lead.id, { [L.doNotContact]: true });
    await logActivity(lead.id, { summary: 'Vendor opted out by SMS – Do Not Contact ticked', type: 'General', kind: 'History' });
    await sendSMS(from, "No problem, you won't receive any more messages from us. – Stone Real Estate Ballarat");
    await sendSMS(approverMobile(), `${f[L.name]} replied STOP – Do Not Contact is now ticked.`);
    return true;
  }
  if (f[L.doNotContact]) return true; // log only, never reply

  const ctx = await leadContext(await getRecord(T.leads, lead.id));
  const today = melbNow().date;
  const user =
    `TODAY: ${today}\nAGENT: ${ctx.agent ? ctx.agent.name : 'the agent'}\nLEAD CARD: ${JSON.stringify(ctx.card)}\n\nNOTES & HISTORY (oldest first):\n${historyText(ctx.history)}\n\n` +
    `THE VENDOR JUST TEXTED: "${text}"\n\n` +
    'Work out what this means for the agent and draft Alex\'s reply. Return JSON only:\n' +
    '{"reply_sms": "Alex\'s reply (or empty string if no reply is needed)",\n' +
    ' "reasoning": "one short sentence for the agent",\n' +
    ' "key_fact": "a short new fact worth adding to Key Facts, or empty",\n' +
    ' "new_follow_up_date": "YYYY-MM-DD if their timing changed (e.g. call me in March) else empty",\n' +
    ' "wants_appraisal": true/false, "appraisal_type": "Face to face|Desktop|", "preferred_times": "what they said about days/times, or empty",\n' +
    ' "urgent_for_agent": true/false (true if they want to talk to the agent now, are ready to list, or are upset)}';
  const out = await claudeJSON(VOICE + ' You also extract facts for the agent accurately and conservatively.', user, 700);

  const extra = [];
  const leadUpd = {};
  if (out.key_fact) {
    const stamp = dmy(today) + '/' + today.slice(2, 4);
    leadUpd[L.keyFacts] = ((f[L.keyFacts] || '').trim() + `\n• ${out.key_fact} (${stamp}, via Alex)`).trim();
    extra.push('Key fact added: ' + out.key_fact);
  }
  let prevFollowUp = null;
  if (out.new_follow_up_date && /^\d{4}-\d{2}-\d{2}$/.test(out.new_follow_up_date) && out.new_follow_up_date !== f[L.followUp]) {
    prevFollowUp = f[L.followUp] || 'none';
    leadUpd[L.followUp] = out.new_follow_up_date;
    extra.push(`Follow-up moved ${f[L.followUp] ? dmy(f[L.followUp]) : '(none)'} → ${dmy(out.new_follow_up_date)}`);
  }
  if (out.wants_appraisal) {
    leadUpd[L.nextAction] = 'Book appraisal' + (out.preferred_times ? ' – vendor said: ' + out.preferred_times : '');
    leadUpd[L.nextActionDate] = today;
    if (out.appraisal_type) leadUpd[L.apptType] = out.appraisal_type;
    extra.push('Wants an appraisal' + (out.preferred_times ? ': ' + out.preferred_times : '') + ' – Next Action set to book it');
  }
  if (Object.keys(leadUpd).length) {
    await updateRecord(T.leads, lead.id, leadUpd);
    if (out.key_fact) await logActivity(lead.id, { summary: 'Key Facts updated by Alex', detail: out.key_fact, type: 'Key Facts updated', kind: 'History' });
    if (prevFollowUp) await logActivity(lead.id, { summary: `Follow-up date changed to ${dmy(out.new_follow_up_date)} by Alex`, detail: text, type: 'Follow-up date changed', kind: 'History' });
  }
  if (out.urgent_for_agent) extra.unshift('⚠ Needs the agent: they may want to talk now.');

  const reply = String(out.reply_sms || '').trim();
  if (reply) {
    const code = await queueDraft({
      lead, ctx, purpose: out.wants_appraisal ? 'Appraisal booking' : 'Reply to vendor', draft: reply,
      reasoning: (out.reasoning || '') + (prevFollowUp ? ` PREV_FOLLOW_UP=${prevFollowUp}` : ''),
      extraLines: [`They said: "${text.slice(0, 300)}"`].concat(extra, prevFollowUp ? ['Reply KEEP <code> to undo the date change.'] : [])
    });
    console.log('Alex leads: reply draft ' + code + ' for ' + lead.id);
  } else if (extra.length) {
    await sendSMS(approverMobile(), `${f[L.name]} replied: "${text.slice(0, 300)}"\n${extra.join('\n')}`);
  }
  return true;
}

// ---------------------------------------------------------------- new enquiries (replaces Pipedrive)

async function createEnquiryLead({ name, phone, email, address, suburb, summary, outcome }) {
  if (!enabled()) return null;
  const existing = await findLeadByPhone(phone);
  if (existing && !['Lost', 'Authority Signed'].includes(sel(existing.fields[L.stage]))) {
    await logActivity(existing.id, { summary: 'New Alex conversation – ' + outcome, detail: summary, type: 'SMS' });
    return existing.id;
  }
  const rec = await createRecord(T.leads, {
    [L.name]: name && name !== 'Unknown' ? name : (address || phone),
    [L.phone]: phone, [L.email]: email || undefined, [L.address]: address || (suburb ? suburb : undefined),
    [L.source]: 'Other', [L.sourceDetail]: 'Alex SMS – ' + outcome, [L.enteredVia]: 'Alex',
    [L.background]: summary
  });
  await logActivity(rec.id, { summary: 'Alex conversation summary – ' + outcome, detail: summary, type: 'SMS' });
  return rec.id;
}

// ---------------------------------------------------------------- start

let timer = null;
function start() {
  if (timer) return;
  if (!enabled()) { console.log('Alex leads: AIRTABLE_TOKEN not set – Airtable integration off'); return; }
  console.log('Alex leads: Airtable integration on' + (sweepEnabled() ? ', sweep every ' + SWEEP_MINUTES + ' min' : ' (sweep off – set ALEX_LEADS_ENABLED=true)'));
  timer = setInterval(sweep, SWEEP_MINUTES * 60000);
  setTimeout(sweep, 30000);
}

module.exports = { start, sweep, isApprover, handleApproverSMS, handleVendorSMS, createEnquiryLead, normalisePhone, enabled };
