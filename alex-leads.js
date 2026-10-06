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

// Soft opt-out added to the end of the first text Alex sends anyone.
// Any reply asking to be left alone is treated as an opt-out (see handleVendorSMS).
const OPT_OUT_LINE = "If now's not the right time or your situation has changed, no worries at all, just reply and let me know and I'll leave it there.";
const OPT_OUT_ACK = "No worries at all, I'll leave it there. Thanks for letting me know. – Alex, Stone Ballarat";

const VOICE = "You write SMS messages as Alex from Stone Ballarat, writing on behalf of one of our sales agents. " +
  "Tone: warm, local, plain Australian English, like a real person in a real estate office - never salesy. " +
  "Rules: 1-3 short sentences. One question at most. No exclamation marks unless clearly warranted. Never start with filler (Great, Absolutely, Hope you're well is fine only if natural). " +
  "Never give a price opinion, valuation or commission. Never mention you are an AI unless asked directly. " +
  "Never write 'Reply STOP' or any opt-out wording - that is added automatically when needed. Never repeat or hint at anything marked INTERNAL, or anything in Background Notes the vendor would not have told us themselves. " +
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

async function queueDraft({ lead, ctx, purpose, draft, reasoning, extraLines, content, trackLabel }) {
  const code = await nextCode();
  await createRecord(T.messages, {
    [M.code]: code, [M.lead]: [lead.id], [M.direction]: 'To vendor', [M.purpose]: purpose, [M.status]: 'Awaiting approval',
    [M.draft]: draft, [M.reasoning]: reasoning || '', [M.number]: normalisePhone(lead.fields[L.phone]), [M_CONTENT]: content || ''
  });
  const c = ctx.card;
  const head = `${code} · ${c.contactName}${c.address && c.address !== c.contactName ? ', ' + c.address : ''} (${c.stage}${trackLabel ? '' : c.followUpInterval ? ', ' + c.followUpInterval : ''})`;
  const shownReason = String(reasoning || '').replace(/\s*PREV_FOLLOW_UP=\S+/, '').trim();
  const why = shownReason ? `\nWhy: ${shownReason}` : '';
  const extra = extraLines && extraLines.length ? '\n' + extraLines.map(x => x.replace('<code>', code)).join('\n') : '';
  const text = `${head}${why}${extra}\n\nDraft: "${draft}"\n\nReply YES ${code} · CHANGE ${code} what to change · EDIT ${code} full wording · NO ${code}`;
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
      const st = nurtureState(lead.fields, await leadMessages(lead.fields));
      leadUpd[L.followUp] = addDays(melbNow().date, st.days);
      const content = String(f[M_CONTENT] || '');
      if (content.startsWith('sale:')) {
        try {
          const saleId = content.slice(5);
          const sale = await getRecord(MS_TABLE, saleId);
          const quoted = (sale.fields[MS.quotedTo] || []).concat(leadId);
          await updateRecord(MS_TABLE, saleId, { [MS.quotedTo]: Array.from(new Set(quoted)) });
        } catch (e) { console.error('Alex leads: Quoted To link failed', e.message); }
      }
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
// An EDIT reply that starts like an instruction is treated as a request to change the draft, not as the new text.
function looksLikeInstruction(t) {
  return /^(please\s+)?(remove|delete|drop|take\s+out|cut|add|include|mention|make|change|shorten|lengthen|soften|swap|replace|rewrite|reword|don'?t|do\s+not|no\s+need|less|more|without|leave\s+out|use|say)\b/i.test(t);
}

async function handleApproverSMS(body) {
  const text = (body || '').trim();
  const m = text.match(/^(YES|Y|OK|SEND|EDIT|CHANGE|NO|N|KEEP|LIST)\b\s*(A\d+)?\s*([\s\S]*)$/i);
  if (!m) return false;
  const cmd = m[1].toUpperCase();
  let code = (m[2] || '').toUpperCase();
  const rest = (m[3] || '').trim().replace(/^[.,:;\-–—\s]+/, '');
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
  if ((cmd === 'EDIT' || cmd === 'CHANGE') && !rest) { await sendSMS(approverMobile(), `Send the new wording after the code (EDIT ${code} Hey Sonya…) or an instruction (CHANGE ${code} make it shorter).`); return true; }

  // CHANGE, or an EDIT that reads like an instruction ("remove the opt out line"), is never sent as-is:
  // Alex rewrites the draft and sends it back for approval.
  if (cmd === 'CHANGE' || (cmd === 'EDIT' && looksLikeInstruction(rest))) {
    const current = rec.fields[M.finalText] || rec.fields[M.draft];
    const out = await claudeJSON(VOICE, `CURRENT DRAFT SMS: "${current}"\n\nTHE AGENT WANTS THIS CHANGE: "${rest}"\n\n` +
      'Rewrite the SMS applying exactly that change and nothing else. Keep the greeting and introduction unless asked to change them. ' +
      'Return JSON only: {"sms": "..."}', 400);
    const revised = String(out.sms || '').trim();
    if (!revised) { await sendSMS(approverMobile(), `Couldn't apply that to ${code} – try EDIT ${code} followed by the full wording.`); return true; }
    await updateRecord(T.messages, rec.id, { [M.draft]: revised, [M.approverReply]: text });
    await sendSMS(approverMobile(), `${code} revised:\n\nDraft: "${revised}"\n\nReply YES ${code} · CHANGE ${code} what to change · EDIT ${code} full wording · NO ${code}`);
    return true;
  }

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

// ---------------------------------------------------------------- nurture cadence
// Each Nurture lead is on a track set by its Nurture Reason. The track decides how often Alex texts
// and what each text is about, rotating so nothing repeats and asks only come every few messages.
//   sale    – one recent nearby sale from the Market Sales table (never the same sale twice to a lead)
//   suburb  – a short wrap of recent sales in their suburb
//   tip     – a selling-prep tip from TIPS (never the same tip twice)
//   ask     – a light question about timing, or an offer of a free updated appraisal

const MS_TABLE = 'tblPfQKGokVJfPuN3';
const MS = {
  address: 'fld6Ya3TVCiy6EvM5', street: 'fldzC1MdamEiK1qQY', suburb: 'fldm2P7xaGkfOqtAk', type: 'fldexdbLviVOb4i1w',
  beds: 'flds3mgStHeDoTjJy', baths: 'fld5QO7IVIGLPESWY', cars: 'fldVQG0B5Pr7HLKl7', land: 'fldaVoYVw9WLCONL0',
  price: 'fldo7tVsAVAqamo4l', date: 'fldQ2NjHox6dH56az', dom: 'fldp15VbuAGxoFiCF', usable: 'fldcvXXIAYMNPBn9b',
  stone: 'fldzUlscPR8lmxPeg', quotedTo: 'fldWJEXHFpU1lxqHN'
};
const M_CONTENT = 'fldsb2ITupyCZ67y2';      // Alex Messages → Nurture Content
const L_MESSAGES = 'fldZjakyGET3iL1An';     // Leads → Alex Messages (inverse link)
const SALE_MAX_AGE_DAYS = 92;
const UNANSWERED_LIMIT = 3;

const TRACKS = {
  1: { label: 'Track 1 · weekly', days: 7, slowDays: 14, seq: ['sale', 'tip', 'suburb', 'tip'], ask: null },
  2: { label: 'Track 2 · fortnightly', days: 14, seq: ['sale', 'tip', 'ask'], ask: 'soft' },
  3: { label: 'Track 3 · monthly', days: 30, seq: ['sale', 'tip', 'ask'], ask: 'full' },
  4: { label: 'Track 4 · monthly', days: 30, seq: ['sale', 'tip', 'suburb', 'ask'], ask: 'full' },
  // Cold / no contact: every 2 months, market news first, an in-person price update offer every 4th text, never paused for silence
  5: { label: 'Track 5 · cold, every 2 months', days: 60, seq: ['market', 'sale', 'tip', 'ask'], ask: 'price', neverPause: true }
};
function trackFor(fields) {
  const r = sel(fields[L.nurtureReason]);
  if (/1.2 months/i.test(r)) return 1;
  if (/3 months|stalled/i.test(r)) return 2;
  if (/no contact|cold|quiet/i.test(r)) return 5;
  if (/12 months/i.test(r)) return 4;
  return 3; // ~6 months, or not set
}

const TIPS = [
  ['declutter', 'Start decluttering early, one room or cupboard at a time - buyers open everything, and it makes moving easier too.'],
  ['small-repairs', 'Knock off the small fixes now - dripping taps, sticky doors, blown globes. Buyers add them up in their heads.'],
  ['street-appeal', 'First impressions start at the street: mow, trim, clean the front door and letterbox.'],
  ['paint', 'A fresh coat of neutral paint in the main living areas is one of the best-value prep jobs.'],
  ['paperwork', 'Pull the paperwork together early - rates notices, permits for any work done, warranties. It speeds up the vendor statement.'],
  ['section-32', 'In Victoria you need a vendor statement (Section 32) before going to market - worth lining up a conveyancer early.'],
  ['heating-energy', 'Ballarat buyers always ask about heating and insulation - keep a note of any upgrades (solar, split systems, insulation) and a recent bill.'],
  ['reno-check', 'Before spending on bigger renovations, have a quick chat with the agent about which jobs buyers actually pay for.'],
  ['light', 'Light and bright sells: clean windows, open blinds and swap any dim globes before photos and inspections.'],
  ['garden', 'A cheap garden refresh goes a long way - fresh mulch, a prune and a couple of pots by the front door.'],
  ['kitchen-bathroom', 'Kitchens and bathrooms sell homes - regrouting, new tapware or handles is a cheap facelift.'],
  ['next-move', 'Worth thinking early about the next move - buying first or selling first changes the timing, and the agent can talk it through.'],
  ['building-inspection', 'Some sellers get a pre-sale building inspection so there are no surprises once buyers start looking.'],
  ['inspection-ready', 'For inspections: fresh air, a quick tidy and keeping pets and their gear out of sight makes a real difference.']
];

// Neighbouring suburbs (used when there is no recent sale in their own suburb)
const NEIGHBOURS = {
  'Alfredton': ['Lake Gardens', 'Wendouree', 'Delacombe', 'Cardigan', 'Lucas', 'Lake Wendouree'],
  'Lucas': ['Alfredton', 'Delacombe', 'Cardigan'],
  'Delacombe': ['Sebastopol', 'Bonshaw', 'Alfredton', 'Lucas', 'Smythes Creek', 'Redan', 'Winter Valley'],
  'Bonshaw': ['Delacombe', 'Sebastopol', 'Smythes Creek', 'Winter Valley'],
  'Sebastopol': ['Redan', 'Delacombe', 'Bonshaw', 'Mount Pleasant', 'Mount Clear'],
  'Redan': ['Sebastopol', 'Ballarat Central', 'Lake Wendouree', 'Delacombe', 'Mount Pleasant'],
  'Winter Valley': ['Delacombe', 'Bonshaw', 'Smythes Creek', 'Cardigan'],
  'Smythes Creek': ['Bonshaw', 'Delacombe', 'Winter Valley'],
  'Cardigan': ['Lucas', 'Alfredton', 'Winter Valley', 'Cardigan Village'],
  'Wendouree': ['Lake Wendouree', 'Alfredton', 'Invermay Park', 'Miners Rest', 'Mitchell Park', 'Lake Gardens', 'Ballarat North', 'Soldiers Hill'],
  'Lake Wendouree': ['Wendouree', 'Ballarat Central', 'Soldiers Hill', 'Alfredton', 'Redan', 'Lake Gardens'],
  'Lake Gardens': ['Alfredton', 'Wendouree', 'Lake Wendouree'],
  'Ballarat Central': ['Lake Wendouree', 'Soldiers Hill', 'Bakery Hill', 'Golden Point', 'Redan', 'Black Hill', 'Ballarat North'],
  'Soldiers Hill': ['Ballarat North', 'Ballarat Central', 'Black Hill', 'Lake Wendouree', 'Wendouree'],
  'Ballarat North': ['Soldiers Hill', 'Invermay Park', 'Black Hill', 'Wendouree', 'Invermay', 'Nerrina'],
  'Invermay Park': ['Ballarat North', 'Wendouree', 'Invermay', 'Miners Rest'],
  'Black Hill': ['Ballarat North', 'Soldiers Hill', 'Ballarat Central', 'Brown Hill', 'Ballarat East', 'Nerrina'],
  'Brown Hill': ['Ballarat East', 'Black Hill', 'Nerrina', 'Warrenheip'],
  'Nerrina': ['Brown Hill', 'Black Hill', 'Ballarat North', 'Invermay'],
  'Ballarat East': ['Bakery Hill', 'Brown Hill', 'Black Hill', 'Golden Point', 'Canadian', 'Eureka', 'Warrenheip'],
  'Bakery Hill': ['Ballarat Central', 'Ballarat East', 'Golden Point'],
  'Golden Point': ['Ballarat Central', 'Bakery Hill', 'Ballarat East', 'Canadian', 'Mount Pleasant', 'Redan'],
  'Canadian': ['Golden Point', 'Ballarat East', 'Mount Pleasant', 'Mount Clear', 'Mount Helen', 'Eureka'],
  'Mount Pleasant': ['Golden Point', 'Canadian', 'Mount Clear', 'Sebastopol', 'Redan'],
  'Mount Clear': ['Mount Pleasant', 'Canadian', 'Mount Helen', 'Sebastopol', 'Buninyong'],
  'Mount Helen': ['Mount Clear', 'Canadian', 'Buninyong', 'Scotsburn'],
  'Buninyong': ['Mount Helen', 'Mount Clear', 'Scotsburn', 'Durham Lead', 'Navigators'],
  'Scotsburn': ['Buninyong', 'Mount Helen'],
  'Miners Rest': ['Invermay Park', 'Wendouree', 'Mitchell Park', 'Cardigan Village', 'Ascot'],
  'Ascot': ['Miners Rest', 'Invermay', 'Coghills Creek'],
  'Warrenheip': ['Brown Hill', 'Ballarat East', 'Dunnstown'],
  'Eureka': ['Ballarat East', 'Canadian'],
  'Invermay': ['Nerrina', 'Ballarat North', 'Invermay Park']
};
(function makeSymmetric() {
  for (const [a, list] of Object.entries(NEIGHBOURS)) for (const b of list) {
    NEIGHBOURS[b] = NEIGHBOURS[b] || [];
    if (!NEIGHBOURS[b].includes(a)) NEIGHBOURS[b].push(a);
  }
})();
const SUBURB_ALIASES = [[/\bmt\.?\s/gi, 'Mount '], [/\bnth\b/gi, 'North'], [/\bsth\b/gi, 'South'], [/\bsebas\b/gi, 'Sebastopol'], [/\bsoilders\b/gi, 'Soldiers']];

const STREET_SUFFIX = { rd: 'road', st: 'street', ct: 'court', crt: 'court', dr: 'drive', ave: 'avenue', av: 'avenue', pl: 'place', cres: 'crescent', cr: 'crescent', tce: 'terrace', pde: 'parade', hwy: 'highway', ln: 'lane', bvd: 'boulevard', blvd: 'boulevard', cl: 'close', gr: 'grove', wy: 'way' };
function streetKey(s) {
  const words = String(s || '').toLowerCase().replace(/[^a-z0-9/ ]/g, ' ').split(/\s+/).filter(Boolean);
  while (words.length && (/\d/.test(words[0]) || ['lot', 'unit', 'u'].includes(words[0]))) words.shift();
  return words.map(w => STREET_SUFFIX[w] || w).join(' ');
}
function numberKey(s) { const m = String(s || '').match(/^\s*(?:lot\s*)?([\d/a-z-]+)/i); return m ? m[1].toLowerCase() : ''; }

function suburbOf(address, knownSuburbs) {
  let a = ' ' + String(address || '') + ' ';
  for (const [re, rep] of SUBURB_ALIASES) a = a.replace(re, rep);
  const lower = a.toLowerCase();
  const hit = knownSuburbs.filter(s => lower.includes(' ' + s.toLowerCase())).sort((x, y) => y.length - x.length)[0];
  if (!hit) return { suburb: '', street: '' };
  const before = a.slice(0, lower.lastIndexOf(' ' + hit.toLowerCase())).replace(/,\s*$/, '').trim();
  return { suburb: hit, street: before };
}

let salesCache = { at: 0, rows: [] };
async function recentSales() {
  if (Date.now() - salesCache.at < 30 * 60000) return salesCache.rows;
  const cutoff = addDays(melbNow().date, -SALE_MAX_AGE_DAYS);
  const rows = await listAll(MS_TABLE, { filterByFormula: `AND({${MS.usable}}, IS_AFTER({${MS.date}}, '${cutoff}'))` });
  salesCache = { at: Date.now(), rows };
  return rows;
}
function fmtPrice(n) { return '$' + Math.round(n).toLocaleString('en-AU'); }
function monthName(iso) { return new Date(iso + 'T00:00:00Z').toLocaleString('en-AU', { month: 'long', timeZone: 'UTC' }); }

async function pickSale(leadId, address, alreadyUsed) {
  const sales = await recentSales();
  const known = Array.from(new Set(sales.map(s => s.fields[MS.suburb]).filter(Boolean).concat(Object.keys(NEIGHBOURS))));
  const { suburb, street } = suburbOf(address, known);
  if (!suburb) return null;
  const myStreet = streetKey(street), myNum = numberKey(street);
  const wantUnit = /\//.test(street) || /unit/i.test(street);
  const near = new Set(NEIGHBOURS[suburb] || []);
  const scored = [];
  for (const s of sales) {
    const f = s.fields;
    if ((f[MS.quotedTo] || []).includes(leadId) || alreadyUsed.has('sale:' + s.id)) continue;
    const sStreet = streetKey(f[MS.street]);
    if (sStreet === myStreet && numberKey(f[MS.street]) === myNum && f[MS.suburb] === suburb) continue; // their own home
    let tier;
    if (f[MS.suburb] === suburb && myStreet && sStreet === myStreet) tier = 0;
    else if (f[MS.suburb] === suburb) tier = 1;
    else if (near.has(f[MS.suburb])) tier = 2;
    else continue;
    const isUnit = /^unit/i.test(f[MS.type] || '');
    scored.push({ s, tier, typeMiss: isUnit === wantUnit ? 0 : 1, stone: f[MS.stone] ? 0 : 1, date: f[MS.date] || '' });
  }
  scored.sort((a, b) => a.tier - b.tier || a.typeMiss - b.typeMiss || a.stone - b.stone || (a.date < b.date ? 1 : -1));
  if (!scored.length) return null;
  const { s, tier } = scored[0];
  const f = s.fields;
  const bits = [f[MS.beds] ? f[MS.beds] + ' bed' : '', /^unit/i.test(f[MS.type] || '') ? 'unit' : 'house'].filter(Boolean).join(' ');
  return {
    key: 'sale:' + s.id, saleId: s.id, suburb, tier,
    fact: `${f[MS.address]} – ${bits}, sold ${fmtPrice(f[MS.price])} in ${monthName(f[MS.date])}` +
      (f[MS.dom] ? `, ${f[MS.dom]} days on market` : '') + (f[MS.stone] ? ' (sold by Stone Ballarat - you may say our team sold it)' : ''),
    where: tier === 0 ? 'in their street' : tier === 1 ? 'in their suburb' : 'in a neighbouring suburb (' + f[MS.suburb] + ')'
  };
}

async function suburbWrap(address, alreadyUsed) {
  const sales = await recentSales();
  const known = Array.from(new Set(sales.map(s => s.fields[MS.suburb]).filter(Boolean)));
  const { suburb } = suburbOf(address, known);
  if (!suburb) return null;
  const key = 'suburb:' + suburb + ':' + melbNow().date.slice(0, 7);
  if (alreadyUsed.has(key)) return null;
  const houses = sales.filter(s => s.fields[MS.suburb] === suburb && !/^unit/i.test(s.fields[MS.type] || '') && s.fields[MS.price]);
  if (houses.length < 2) return null;
  const prices = houses.map(s => s.fields[MS.price]).sort((a, b) => a - b);
  return { key, fact: `${houses.length} houses sold in ${suburb} over the last 3 months, from ${fmtPrice(prices[0])} to ${fmtPrice(prices[prices.length - 1])}` };
}

// Ballarat-wide wrap from Market Sales (once a month at most per lead)
async function ballaratWrap(alreadyUsed) {
  const key = 'market:' + melbNow().date.slice(0, 7);
  if (alreadyUsed.has(key)) return null;
  const sales = await recentSales();
  const houses = sales.filter(s => !/^unit/i.test(s.fields[MS.type] || '') && s.fields[MS.price]).map(s => s.fields[MS.price]).sort((a, b) => a - b);
  if (houses.length < 10) return null;
  const mid = houses.length % 2 ? houses[(houses.length - 1) / 2] : (houses[houses.length / 2 - 1] + houses[houses.length / 2]) / 2;
  const top = {};
  for (const s of sales) top[s.fields[MS.suburb]] = (top[s.fields[MS.suburb]] || 0) + 1;
  const busiest = Object.entries(top).sort((a, b) => b[1] - a[1]).slice(0, 3).map(x => x[0]).join(', ');
  return { key, fact: `across Ballarat, ${houses.length} houses with a disclosed price sold over the last 3 months at a middle price of about ${fmtPrice(Math.round(mid / 5000) * 5000)}; the busiest suburbs were ${busiest}` };
}

// The lead's past Alex messages (newest last)
async function leadMessages(leadFields) {
  const ids = (leadFields[L_MESSAGES] || []).slice(-40);
  if (!ids.length) return [];
  const recs = await listAll(T.messages, { filterByFormula: 'OR(' + ids.map(id => `RECORD_ID()='${id}'`).join(',') + ')' });
  return recs.sort((a, b) => String(a.fields[M.created] || a.createdTime) < String(b.fields[M.created] || b.createdTime) ? -1 : 1);
}
function unansweredCount(msgs) {
  let n = 0;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const dir = sel(msgs[i].fields[M.direction]);
    if (dir === 'From vendor') break;
    if (dir === 'To vendor' && sel(msgs[i].fields[M.status]) === 'Sent') n++;
  }
  return n;
}
function nurtureState(leadFields, msgs) {
  const track = trackFor(leadFields);
  const sentNurture = msgs.filter(m => sel(m.fields[M.purpose]) === 'Nurture check-in' && sel(m.fields[M.status]) === 'Sent');
  const used = new Set(msgs.map(m => m.fields[M_CONTENT]).filter(Boolean));
  const unanswered = unansweredCount(msgs);
  const t = TRACKS[track];
  const days = track === 1 && unanswered >= UNANSWERED_LIMIT ? t.slowDays : t.days;
  const askCount = sentNurture.filter(m => String(m.fields[M_CONTENT] || '').startsWith('ask:')).length;
  return { track, t, n: sentNurture.length, askCount, used, unanswered, days, recentTexts: sentNurture.slice(-4).map(m => m.fields[M.finalText] || m.fields[M.draft]) };
}

// Decide what this nurture text is about. Falls back sale → suburb → tip so there is always something useful.
async function planNurture(lead, st) {
  const address = lead.fields[L.address] || '';
  let type = st.t.seq[st.n % st.t.seq.length];
  if (type === 'ask') {
    const kind = st.t.ask === 'soft' ? 'timing' : st.t.ask === 'price' ? 'price-update' : (st.askCount % 2 === 0 ? 'timing' : 'appraisal');
    if (kind === 'price-update') return {
      key: 'ask:price-update', label: 'price update offer',
      brief: 'Lightly suggest that if they are ever curious what their place might be worth in today\'s market, the agent is happy to pop out for a quick, no-obligation look and give them an up-to-date price guide - an accurate figure needs a visit. Never offer a price over the phone, by text or online. One sentence for the offer, zero pressure, easy to ignore.'
    };
    return {
      key: 'ask:' + kind, label: kind === 'timing' ? 'timing check' : 'appraisal offer',
      brief: kind === 'timing'
        ? 'Ask one light, no-pressure question about whether their timing or plans have changed. Make it easy to reply in a few words.'
        : 'Offer a free, no-obligation updated market appraisal - the agent pops out to the property whenever it suits them (never offer a price over the phone, by text or online). One sentence, zero pressure, easy to ignore.'
    };
  }
  if (type === 'market') {
    const wrap = await ballaratWrap(st.used);
    if (wrap) return { key: wrap.key, label: 'Ballarat market update', brief: `Share this as a short Ballarat market update, in plain words: ${wrap.fact}. You may add one general, factual observation, but never forecast prices, never say what their home is worth and do not ask them for anything.` };
    type = 'sale';
  }
  if (type === 'sale') {
    const sale = await pickSale(lead.id, address, st.used);
    if (sale) return { key: sale.key, saleId: sale.saleId, label: 'recent sale ' + sale.where, brief: `Share this recent sale ${sale.where} as a helpful local update: ${sale.fact}. Do not say what their own home is worth and do not ask them for anything. Never name the selling agency unless it was Stone Ballarat.` };
    type = 'suburb';
  }
  if (type === 'suburb') {
    const wrap = await suburbWrap(address, st.used);
    if (wrap) return { key: wrap.key, label: 'suburb sales wrap', brief: `Share this as a quick local market update: ${wrap.fact}. Do not say what their own home is worth and do not ask them for anything.` };
  }
  const tip = TIPS.find(([k]) => !st.used.has('tip:' + k)) || TIPS[st.n % TIPS.length];
  return { key: 'tip:' + tip[0], label: 'tip – ' + tip[0].replace(/-/g, ' '), brief: `Share this selling-prep tip in your own words, tied to their situation if the notes allow: ${tip[1]} Do not ask them for anything.` };
}

// Leads that have gone quiet: Track 1 slows to fortnightly; other tracks pause and the agent gets a task.
async function pauseIfQuiet(lead, st) {
  if (st.track === 1 || st.t.neverPause || st.unanswered < UNANSWERED_LIMIT) return false;
  const today = melbNow().date;
  await updateRecord(T.leads, lead.id, { [L.pauseAlex]: true, [L.nextAction]: 'Call – Alex paused after ' + st.unanswered + ' unanswered texts', [L.nextActionDate]: today });
  await logActivity(lead.id, { summary: `Alex paused – ${st.unanswered} texts without a reply`, detail: 'Untick Pause Alex on the card to restart texts.', type: 'General', kind: 'History' });
  await sendSMS(approverMobile(), `${lead.fields[L.name]} hasn't replied to ${st.unanswered} texts, so Alex has paused and set a call task for the agent. Untick Pause Alex on the card to restart.`);
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

// Fixed opening so every text starts the same way:
// first text  -> "Hey Sonya, this is Alex from Stone Ballarat on behalf of Stu Brien."
// later texts -> "Hey Sonya,"
function smsOpening(ctx, firstContact) {
  const n = ctx.card.firstName;
  const usable = n && !/^(\d|lot\b)/i.test(n) && !/\d/.test(ctx.card.contactName.split(',')[0].split(' ')[0]);
  const hey = usable ? `Hey ${n},` : 'Hey there,';
  if (!firstContact) return hey;
  const agent = ctx.agent ? ctx.agent.name : 'our sales team';
  return `${hey} this is Alex from Stone Ballarat on behalf of ${agent}.`;
}

async function draftOutbound(lead) {
  const ctx = await leadContext(lead);
  const stage = ctx.card.stage;
  const purpose = stage === 'Nurture' ? 'Nurture check-in' : 'Appraisal booking';
  let goal, plan = null, st = null;
  if (purpose === 'Nurture check-in') {
    st = nurtureState(lead.fields, await leadMessages(lead.fields));
    if (await pauseIfQuiet(lead, st)) return null;
    plan = await planNurture(lead, st);
    goal = 'Write a nurture text. ' + plan.brief + ' Keep it warm and useful - this person is not ready yet, so the aim is simply to be helpful and let them know we are here if they have questions.' +
      (st.recentTexts.length ? '\nRECENT TEXTS ALEX ALREADY SENT THEM (do not repeat their wording, openers or ideas):\n' + st.recentTexts.map(t => '- ' + t).join('\n') : '');
  } else {
    goal = `Write a message offering to book a free market appraisal${ctx.card.appraisalType ? ' (' + ctx.card.appraisalType + ')' : ''} with the agent, asking what days or times generally suit them. Do not offer specific times.`;
  }
  const firstContact = !ctx.history.some(h => h.author === 'Alex');
  const opening = smsOpening(ctx, firstContact);
  const user =
    `AGENT: ${ctx.agent ? ctx.agent.name : 'the agent'}\n` +
    `LEAD CARD: ${JSON.stringify(ctx.card)}\n\nNOTES & HISTORY (oldest first):\n${historyText(ctx.history)}\n\n` +
    `TASK: ${goal}\n\nThe message will automatically start with: "${opening}" - write ONLY what comes after that. ` +
    'Do not greet them again, do not introduce Alex again and do not sign off.\n\n' +
    'Return JSON only: {"sms": "...", "reasoning": "one short sentence for the agent on what you picked up from the card"}';
  const out = await claudeJSON(VOICE, user, 500);
  let body = String(out.sms || '').trim()
    .replace(/^(hey|hi|hello)\b[^,.!]*[,.!]\s*/i, '')            // drop a repeated greeting
    .replace(/^(this is|it's|it is|i'm)\s+alex\b[^.!?]*[.!?]\s*/i, ''); // drop a repeated intro
  body = body.charAt(0).toUpperCase() + body.slice(1);
  let draft = opening + ' ' + body;
  if (firstContact && !draft.includes(OPT_OUT_LINE)) draft += ' ' + OPT_OUT_LINE;
  const reasoning = (plan ? `${st.t.label}, text ${st.n + 1}: ${plan.label}. ` : '') + String(out.reasoning || '').trim();
  return { ctx, purpose, draft, reasoning, content: plan ? plan.key : '', trackLabel: st ? st.t.label : '' };
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
        if (d && d.draft) await queueDraft({ lead, ctx: d.ctx, purpose: d.purpose, draft: d.draft, reasoning: d.reasoning, content: d.content, trackLabel: d.trackLabel });
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
    await sendSMS(from, OPT_OUT_ACK);
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
    ' "urgent_for_agent": true/false (true if they want to talk to the agent now, are ready to list, or are upset),\n' +
    ' "new_timeframe": if they told us a new selling timeframe, EXACTLY one of "Selling in 1–2 months" | "Not quite ready (~3 months)" | "Too early (~6 months)" | "Curious (12 months+)", else empty,\n' +
    ' "wants_no_contact": true/false - true ONLY if they clearly ask us to stop texting / leave them alone / take them off the list, or say they are no longer selling and do not want to hear from us. "Not yet" or "try me in March" is NOT an opt-out - move the follow-up date instead. If unsure, false and set urgent_for_agent}';
  const out = await claudeJSON(VOICE + ' You also extract facts for the agent accurately and conservatively.', user, 700);

  if (out.wants_no_contact === true) {
    await updateRecord(T.leads, lead.id, { [L.doNotContact]: true });
    await logActivity(lead.id, { summary: 'Vendor asked to be left alone – Do Not Contact ticked by Alex', detail: text, type: 'General', kind: 'History' });
    await sendSMS(from, OPT_OUT_ACK);
    await sendSMS(approverMobile(), `${f[L.name]} asked to be left alone: "${text.slice(0, 200)}"\nDo Not Contact is now ticked and Alex replied: "${OPT_OUT_ACK}"\nIf Alex misread this, untick Do Not Contact on the card.`);
    return true;
  }

  const extra = [];
  const leadUpd = {};
  if (out.key_fact) {
    const stamp = dmy(today) + '/' + today.slice(2, 4);
    leadUpd[L.keyFacts] = ((f[L.keyFacts] || '').trim() + `\n• ${out.key_fact} (${stamp}, via Alex)`).trim();
    extra.push('Key fact added: ' + out.key_fact);
  }
  const TIMEFRAMES = ['Selling in 1–2 months', 'Not quite ready (~3 months)', 'Too early (~6 months)', 'Curious (12 months+)'];
  if (out.new_timeframe && TIMEFRAMES.includes(out.new_timeframe) && out.new_timeframe !== sel(f[L.nurtureReason])) {
    leadUpd[L.nurtureReason] = out.new_timeframe;
    extra.push(`Timeframe now "${out.new_timeframe}" – Alex's nurture rhythm adjusts to match`);
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
