const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const Database = require('better-sqlite3');
const path = require('path');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const trustedConversations = {};
const delegatedConversations = {};

const STU_NUMBER = process.env.STU_WHATSAPP_NUMBER;
const STU_WHATSAPP = 'whatsapp:' + (process.env.STU_WHATSAPP_NUMBER || '');
const WHATSAPP_FROM = process.env.WHATSAPP_FROM || 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER;

const db = new Database(path.join('/tmp', 'jordan.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(category, key)
  );
  CREATE TABLE IF NOT EXISTS reminders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    context TEXT,
    recipient TEXT,
    recipient_number TEXT,
    scheduled_for DATETIME NOT NULL,
    recurrence TEXT,
    sent INTEGER DEFAULT 0,
    set_by TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS follow_ups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_name TEXT NOT NULL,
    contact_number TEXT NOT NULL,
    message_sent TEXT NOT NULL,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    prompted INTEGER DEFAULT 0,
    resolved INTEGER DEFAULT 0
  );
`);

const TRUSTED_CONTACTS = {
  '+61414682861': { name: 'Yasna', relationship: 'Wife' },
  '+61412185312': { name: 'Fiona Hart', relationship: 'Personal Assistant' },
  '+61414410117': { name: 'Gwen', relationship: 'Mum' },
  '+61434308724': { name: 'Josh', relationship: 'Son' },
  '+61498327669': { name: 'Aiden', relationship: 'Son' },
  '+61429097002': { name: 'Leanne Madigan', relationship: 'Sales Associate' },
  '+61418318251': { name: 'Tammy Edwards', relationship: 'Sales Admin' }
};

const CONTACTS = {
  'yasna': { name: 'Yasna', number: '+61414682861', method: 'sms', relationship: 'Wife' },
  'fiona': { name: 'Fiona Hart', number: '+61412185312', method: 'sms', relationship: 'Personal Assistant' },
  'fiona hart': { name: 'Fiona Hart', number: '+61412185312', method: 'sms', relationship: 'Personal Assistant' },
  'leanne': { name: 'Leanne Madigan', number: '+61429097002', method: 'sms', relationship: 'Sales Associate' },
  'leanne madigan': { name: 'Leanne Madigan', number: '+61429097002', method: 'sms', relationship: 'Sales Associate' },
  'tammy': { name: 'Tammy Edwards', number: '+61418318251', method: 'sms', relationship: 'Sales Admin' },
  'tammy edwards': { name: 'Tammy Edwards', number: '+61418318251', method: 'sms', relationship: 'Sales Admin' },
  'gwen': { name: 'Gwen Brien', number: '+61414410117', method: 'sms', relationship: 'Mum' },
  'mum': { name: 'Gwen Brien', number: '+61414410117', method: 'sms', relationship: 'Mum' },
  'gwen brien': { name: 'Gwen Brien', number: '+61414410117', method: 'sms', relationship: 'Mum' },
  'glenn': { name: 'Glenn Brien', number: '+61418301954', method: 'sms', relationship: 'Brother' },
  'glenn brien': { name: 'Glenn Brien', number: '+61418301954', method: 'sms', relationship: 'Brother' },
  'josh': { name: 'Josh Brien', number: '+61434308724', method: 'sms', relationship: 'Son' },
  'josh brien': { name: 'Josh Brien', number: '+61434308724', method: 'sms', relationship: 'Son' },
  'aiden': { name: 'Aiden Brien', number: '+61498327669', method: 'sms', relationship: 'Son' },
  'aiden brien': { name: 'Aiden Brien', number: '+61498327669', method: 'sms', relationship: 'Son' },
  'rob': { name: 'Rob Cunningham', number: '+61418543634', method: 'sms', relationship: 'Sales Agent' },
  'rob cunningham': { name: 'Rob Cunningham', number: '+61418543634', method: 'sms', relationship: 'Sales Agent' },
  'leigh': { name: 'Leigh Hutchinson', number: '+61407861960', method: 'sms', relationship: 'Sales Agent' },
  'leigh hutchinson': { name: 'Leigh Hutchinson', number: '+61407861960', method: 'sms', relationship: 'Sales Agent' },
  'jamie': { name: 'Jamie Gepp', number: '+61459201710', method: 'sms', relationship: 'Sales Agent' },
  'jamie gepp': { name: 'Jamie Gepp', number: '+61459201710', method: 'sms', relationship: 'Sales Agent' },
  'jarrod': { name: 'Jarrod Kemp', number: '+61450836257', method: 'sms', relationship: 'Sales Agent' },
  'jarrod kemp': { name: 'Jarrod Kemp', number: '+61450836257', method: 'sms', relationship: 'Sales Agent' },
  'linda': { name: 'Linda Turk', number: '+61414287337', method: 'sms', relationship: 'Senior Property Manager' },
  'linda turk': { name: 'Linda Turk', number: '+61414287337', method: 'sms', relationship: 'Senior Property Manager' }
};

function getContactByNumber(number) {
  const clean = number.replace('whatsapp:', '').replace(/\s/g, '');
  for (const key in CONTACTS) {
    if (CONTACTS[key].number.replace(/\s/g, '') === clean) {
      return CONTACTS[key];
    }
  }
  return null;
}

function getTrustedContact(number) {
  const clean = number.replace('whatsapp:', '').replace(/\s/g, '');
  return TRUSTED_CONTACTS[clean] || null;
}

function getCurrentDateTime() {
  return new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
}

function isActiveHours() {
  const hour = parseInt(new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    hour12: false
  }));
  return hour >= 7 && hour < 21;
}

function saveMemory(category, key, value) {
  try {
    db.prepare(`
      INSERT INTO memories (category, key, value, updated_at)
      VALUES (?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(category, key) DO UPDATE SET
      value = excluded.value,
      updated_at = CURRENT_TIMESTAMP
    `).run(category, key, value);
    console.log('Memory saved: [' + category + '] ' + key + ' = ' + value);
    return true;
  } catch (error) {
    console.error('Failed to save memory:', error.message);
    return false;
  }
}

function loadAllMemories() {
  try {
    return db.prepare('SELECT category, key, value FROM memories ORDER BY category, key').all();
  } catch (error) {
    return [];
  }
}

function deleteMemory(category, key) {
  try {
    db.prepare('DELETE FROM memories WHERE category = ? AND key = ?').run(category, key);
    return true;
  } catch (error) {
    return false;
  }
}

function saveReminder(type, message, context, recipient, recipientNumber, scheduledFor, recurrence, setBy) {
  try {
    db.prepare(`
      INSERT INTO reminders (type, message, context, recipient, recipient_number, scheduled_for, recurrence, set_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(type, message, context || null, recipient || 'Stu', recipientNumber || null, scheduledFor, recurrence || null, setBy || 'Stu');
    console.log('Reminder saved for ' + scheduledFor + ' set by ' + (setBy || 'Stu'));
    return true;
  } catch (error) {
    console.error('Failed to save reminder:', error.message);
    return false;
  }
}

function saveFollowUp(contactName, contactNumber, messageSent) {
  try {
    db.prepare('INSERT INTO follow_ups (contact_name, contact_number, message_sent) VALUES (?, ?, ?)').run(contactName, contactNumber, messageSent);
    return true;
  } catch (error) {
    return false;
  }
}

function buildMemoryContext() {
  const memories = loadAllMemories();
  if (memories.length === 0) return '';
  const grouped = {};
  for (const mem of memories) {
    if (!grouped[mem.category]) grouped[mem.category] = [];
    grouped[mem.category].push(mem.key + ': ' + mem.value);
  }
  let context = '\n\nSTU PREFERENCES AND MEMORY:\n';
  for (const category in grouped) {
    context += category.toUpperCase() + ':\n';
    for (const item of grouped[category]) {
      context += '- ' + item + '\n';
    }
  }
  return context;
}

function getPendingRemindersContext() {
  try {
    const reminders = db.prepare('SELECT * FROM reminders WHERE sent = 0 ORDER BY scheduled_for ASC LIMIT 10').all();
    if (reminders.length === 0) return '';
    let context = '\n\nPENDING REMINDERS:\n';
    for (const r of reminders) {
      context += '- [ID:' + r.id + '] ' + r.scheduled_for + ' - ' + (r.recipient !== 'Stu' ? 'To ' + r.recipient + ': ' : '') + r.message + (r.set_by && r.set_by !== 'Stu' ? ' (set by ' + r.set_by + ')' : '') + '\n';
    }
    return context;
  } catch (e) {
    return '';
  }
}

function getPendingRemindersForTrusted() {
  try {
    const reminders = db.prepare('SELECT * FROM reminders WHERE sent = 0 ORDER BY scheduled_for ASC LIMIT 5').all();
    if (reminders.length === 0) return 'Stu has no pending reminders.';
    let text = 'Stu current reminders:\n';
    for (const r of reminders) {
      text += '- ' + r.scheduled_for + ': ' + r.message + '\n';
    }
    return text;
  } catch (e) {
    return 'Could not retrieve reminders.';
  }
}

async function callClaudeWithSearch(systemPrompt, messages, maxTokens) {
  const response = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: maxTokens || 1000,
    system: systemPrompt,
    tools: [{ type: 'web_search_20250305', name: 'web_search' }],
    messages: messages
  });

  let fullText = '';
  for (const block of response.content) {
    if (block.type === 'text') fullText += block.text;
  }

  if (response.stop_reason === 'tool_use') {
    const toolUseBlock = response.content.find(b => b.type === 'tool_use');
    if (toolUseBlock) {
      console.log('Jordan searched: ' + toolUseBlock.input.query);
      const toolResultMessages = [
        ...messages,
        { role: 'assistant', content: response.content },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: toolUseBlock.id,
            content: 'Search completed for: ' + toolUseBlock.input.query
          }]
        }
      ];
      const followUp = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: maxTokens || 1000,
        system: systemPrompt,
        tools: [{ type: 'web_search_20250305', name: 'web_search' }],
        messages: toolResultMessages
      });
      fullText = '';
      for (const block of followUp.content) {
        if (block.type === 'text') fullText += block.text;
      }
    }
  }

  return fullText;
}

async function sendMessageOnBehalf(to, message, contactName) {
  try {
    const cleanTo = to.replace(/\s/g, '');
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: cleanTo,
      body: message
    });
    const contact = getContactByNumber(cleanTo);
    const name = contactName || (contact ? contact.name : cleanTo);
    delegatedConversations[cleanTo] = {
      contactName: name,
      messages: [{ role: 'sent', content: message, sentAt: new Date().toISOString() }]
    };
    saveFollowUp(name, cleanTo, message);
    console.log('Message sent to ' + cleanTo);
    return true;
  } catch (error) {
    console.error('Failed to send to ' + to + ': ' + error.message);
    return false;
  }
}

async function notifyStu(message) {
  try {
    await twilioClient.messages.create({
      from: WHATSAPP_FROM,
      to: STU_WHATSAPP,
      body: message
    });
    console.log('Stu notified: ' + message.substring(0, 60));
  } catch (error) {
    console.error('Failed to notify Stu: ' + error.message);
  }
}

async function replySMS(to, message) {
  try {
    await twilioClient.messages.create({
      from: process.env.TWILIO_PHONE_NUMBER,
      to: to,
      body: message
    });
    console.log('Replied to ' + to);
  } catch (error) {
    console.error('Failed to reply to ' + to + ': ' + error.message);
  }
}

async function handleTrustedContact(from, body, trustedContact) {
  const currentDateTime = getCurrentDateTime();
  console.log('Trusted contact message from ' + trustedContact.name + ': ' + body);

  if (!trustedConversations[from]) trustedConversations[from] = [];
  trustedConversations[from].push({ role: 'user', content: body });

  if (trustedConversations[from].length > 10) {
    trustedConversations[from] = trustedConversations[from].slice(-10);
  }

  const pendingReminders = getPendingRemindersForTrusted();

  const trustedSystemPrompt = 'You are Jordan, an AI assistant working for Stu Brien. You are currently talking to ' + trustedContact.name + ' (' + trustedContact.relationship + ') who is a trusted contact. They can set reminders for Stu and view his current reminders. CURRENT DATE AND TIME: ' + currentDateTime + ' Melbourne Australia time. WHAT ' + trustedContact.name.toUpperCase() + ' CAN DO: 1. Set a reminder for Stu - they describe what Stu needs to be reminded about and when. 2. View Stu current reminders. STU CURRENT REMINDERS: ' + pendingReminders + ' SETTING A REMINDER: When ' + trustedContact.name + ' asks you to set a reminder for Stu, confirm the details naturally and include this tag: [TRUSTED_REMINDER:message:scheduled_datetime:context] where scheduled_datetime is YYYY-MM-DD HH:MM. Example: [TRUSTED_REMINDER:Pick up milk and bread on the way home:2026-03-23 17:00:Requested by Yasna]. Tell ' + trustedContact.name + ' the reminder has been set and what time it will go off. Be warm and helpful. Keep responses brief - this is SMS. If they ask about anything outside of reminders and schedule politely explain you can only help with reminders and Stu schedule on this number.';

  try {
    const response = await callClaudeWithSearch(trustedSystemPrompt, trustedConversations[from], 500);
    let reply = response;

    const reminderTagMatch = reply.match(/\[TRUSTED_REMINDER:([^:]+):([^:]+):([^\]]+)\]/);
    if (reminderTagMatch) {
      const message = reminderTagMatch[1].trim();
      const scheduledFor = reminderTagMatch[2].trim();
      const context = reminderTagMatch[3].trim();

      saveReminder('STU', message, context, 'Stu', null, scheduledFor, 'ONCE', trustedContact.name);
      reply = reply.replace(/\[TRUSTED_REMINDER:[^\]]+\]/g, '').trim();

      await notifyStu(trustedContact.name + ' has set a reminder for you:\n"' + message + '"\nScheduled for: ' + scheduledFor + '\n\nI have added it to your reminders.');
    }

    trustedConversations[from].push({ role: 'assistant', content: reply });
    await replySMS(from, reply);

  } catch (error) {
    console.error('Error handling trusted contact:', error);
    await replySMS(from, 'Sorry, having a technical issue. Please try again in a moment.');
  }
}

async function handleDelegatedReply(fromNumber, body) {
  const delegation = delegatedConversations[fromNumber];
  if (!delegation) return;

  console.log('Delegated reply from ' + fromNumber + ': ' + body);
  delegation.messages.push({ role: 'received', content: body });

  try {
    db.prepare('UPDATE follow_ups SET resolved = 1 WHERE contact_number = ? AND resolved = 0').run(fromNumber);
  } catch (e) {}

  const contact = getContactByNumber(fromNumber);
  const contactName = contact ? contact.name : fromNumber;
  const stuFrom = STU_WHATSAPP;

  if (!conversations[stuFrom]) conversations[stuFrom] = [];

  const contextMessage = contactName + ' replied: "' + body + '"';
  conversations[stuFrom].push({ role: 'user', content: contextMessage });

  try {
    const currentDateTime = getCurrentDateTime();
    const memoryContext = buildMemoryContext();
    const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + '\n\nCURRENT DATE AND TIME: ' + currentDateTime + ' Melbourne time.';

    const reply = await callClaudeWithSearch(systemPrompt, conversations[stuFrom]);

    const allSendTags = [...reply.matchAll(/\[SEND:(\+[\d]+):([^\]]+)\]/g)];
    let cleanReply = reply;
    if (allSendTags.length > 0) {
      cleanReply = reply.replace(/\[SEND:(\+[\d]+):([^\]]+)\]/g, '').trim();
      for (const match of allSendTags) {
        await sendMessageOnBehalf(match[1].trim(), match[2].trim());
      }
    }

    processTagsFromReply(reply);
    cleanReply = stripAllTags(cleanReply);
    conversations[stuFrom].push({ role: 'assistant', content: cleanReply });
    await notifyStu(cleanReply);

  } catch (error) {
    console.error('Error handling delegated reply:', error);
    await notifyStu(contactName + ' replied: "' + body + '"');
  }
}

function processTagsFromReply(reply) {
  const memoryTags = [...reply.matchAll(/\[MEMORY:([^:]+):([^:]+):([^\]]+)\]/g)];
  for (const match of memoryTags) {
    saveMemory(match[1].trim(), match[2].trim(), match[3].trim());
  }
  const forgetTags = [...reply.matchAll(/\[FORGET:([^:]+):([^\]]+)\]/g)];
  for (const match of forgetTags) {
    deleteMemory(match[1].trim(), match[2].trim());
  }
  const reminderTags = [...reply.matchAll(/\[REMINDER:([^:]+):([^:]+):([^:]+):([^:]+):([^:]+):([^:]+):([^\]]+)\]/g)];
  for (const match of reminderTags) {
    saveReminder(match[1].trim(), match[6].trim(), match[7].trim(), match[2].trim(), match[3].trim() === 'none' ? null : match[3].trim(), match[4].trim(), match[5].trim(), 'Stu');
  }
  const cancelTags = [...reply.matchAll(/\[CANCEL_REMINDER:(\d+)\]/g)];
  for (const match of cancelTags) {
    try { db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(parseInt(match[1])); } catch (e) {}
  }
  const followUpTags = [...reply.matchAll(/\[FOLLOW_UP:([^:]+):([^:]+):([^\]]+)\]/g)];
  for (const match of followUpTags) {
    saveFollowUp(match[1].trim(), match[2].trim(), match[3].trim());
  }
}

function stripAllTags(reply) {
  return reply
    .replace(/\[MEMORY:[^\]]+\]/g, '')
    .replace(/\[FORGET:[^\]]+\]/g, '')
    .replace(/\[REMINDER:[^\]]+\]/g, '')
    .replace(/\[CANCEL_REMINDER:[^\]]+\]/g, '')
    .replace(/\[FOLLOW_UP:[^\]]+\]/g, '')
    .replace(/\[SEND:[^\]]+\]/g, '')
    .replace(/\[TRUSTED_REMINDER:[^\]]+\]/g, '')
    .trim();
}

async function checkRemindersAndFollowUps() {
  if (!isActiveHours()) return;
  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');
  try {
    const dueReminders = db.prepare('SELECT * FROM reminders WHERE sent = 0 AND scheduled_for <= ?').all(now);
    for (const reminder of dueReminders) {
      console.log('Processing reminder: ' + reminder.message);
      if (reminder.type === 'STU') {
        const setByText = reminder.set_by && reminder.set_by !== 'Stu' ? '\n(Set by ' + reminder.set_by + ')' : '';
        await notifyStu('Reminder: ' + reminder.message + (reminder.context ? '\n' + reminder.context : '') + setByText);
      } else if (reminder.type === 'CONTACT' && reminder.recipient_number) {
        await sendMessageOnBehalf(reminder.recipient_number, reminder.message, reminder.recipient);
        await notifyStu('Sent reminder to ' + reminder.recipient + ': "' + reminder.message + '"');
      }
      if (!reminder.recurrence || reminder.recurrence === 'ONCE') {
        db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminder.id);
      } else {
        let nextDate = new Date(reminder.scheduled_for);
        if (reminder.recurrence === 'DAILY') nextDate.setDate(nextDate.getDate() + 1);
        else if (reminder.recurrence === 'WEEKLY') nextDate.setDate(nextDate.getDate() + 7);
        else if (reminder.recurrence === 'MONTHLY') nextDate.setMonth(nextDate.getMonth() + 1);
        db.prepare('UPDATE reminders SET scheduled_for = ? WHERE id = ?').run(nextDate.toISOString().slice(0, 16).replace('T', ' '), reminder.id);
      }
    }
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const overdueFollowUps = db.prepare('SELECT * FROM follow_ups WHERE resolved = 0 AND prompted = 0 AND sent_at <= ?').all(threeHoursAgo);
    for (const followUp of overdueFollowUps) {
      await notifyStu(followUp.contact_name + ' has not replied to your message from 3 hours ago.\n"' + followUp.message_sent.substring(0, 80) + '"\nWant me to follow up?');
      db.prepare('UPDATE follow_ups SET prompted = 1 WHERE id = ?').run(followUp.id);
    }
  } catch (error) {
    console.error('Reminder check error:', error.message);
  }
}

const BASE_SYSTEM_PROMPT = "You are Jordan, a personal AI assistant for Stu Brien - Principal of Stone Real Estate Ballarat. You help Stu with day to day productivity tasks via WhatsApp. You are efficient, direct and genuinely helpful. You know Stu well and communicate naturally - not overly formal. You have access to web search and use it proactively whenever Stu asks for current information, property data, news, business details, weather, prices or anything that requires up to date information. ABOUT STU: Stu Brien is the Principal and Licensed Real Estate Agent at Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central. Phone: 0416 183 566. Email: stubrien@stonerealestate.com.au. STU CONTACTS AND THEIR NUMBERS: Yasna (Wife) +61414682861 - sms. Fiona Hart (Personal Assistant) +61412185312 - sms. Leanne Madigan (Sales Associate) +61429097002 - sms. Tammy Edwards (Sales Admin) +61418318251 - sms. Gwen Brien (Mum) +61414410117 - sms. Glenn Brien (Brother) +61418301954 - sms. Josh Brien (Son) +61434308724 - sms. Aiden Brien (Son) +61498327669 - sms. Rob Cunningham (Sales Agent) +61418543634 - sms. Leigh Hutchinson (Sales Agent) +61407861960 - sms. Jamie Gepp (Sales Agent) +61459201710 - sms. Jarrod Kemp (Sales Agent) +61450836257 - sms. Linda Turk (Property Manager) +61414287337 - sms. WHAT YOU CAN HELP WITH: Web research and information lookup. Drafting and sending messages. Contacting people on Stu behalf. Coordinating meetings and scheduling. Setting reminders. Remembering preferences. Drafting listing copy. Drafting social media posts. Property market questions. Calculations. Writing correspondence. General knowledge. WEB SEARCH USAGE: Use web search for current property sales, listings, RBA rate, weather, business hours, news, market data, restaurant recommendations, any current facts. Summarise concisely. HOW TO HANDLE TASKS: Draft immediately and present cleanly. Answer questions directly. Give 2 to 3 clear options when asked. CONTACTING PEOPLE - TWO STEP PROCESS: STEP 1 - Show draft messages in plain text and ask shall I send these. Do NOT include any [SEND:] tags yet. STEP 2 - When Stu confirms with yes, send, go ahead, ok, yep, yeah or similar - include [SEND:] tags. Format: [SEND:+PHONENUMBER:message text] one per line per recipient. ALWAYS INTRODUCE AS AI ASSISTANT: When contacting someone for the first time say: Hi [name], this is Jordan - I am Stu Brien AI assistant. MEMORY SYSTEM - SAVING: When Stu tells you something worth remembering save it using: [MEMORY:category:key:value]. Categories: preferences, contacts, instructions, tasks. Tell Stu: Got it - I will remember that. MEMORY SYSTEM - DELETING: [FORGET:category:key]. REMINDER SYSTEM: When Stu sets a reminder use: [REMINDER:type:recipient:recipient_number:scheduled_datetime:recurrence:message:context]. Type is STU or CONTACT. Recurrence is ONCE, DAILY, WEEKLY or MONTHLY. Datetime format is YYYY-MM-DD HH:MM. Confirm back with exact date and time. CANCEL REMINDER: [CANCEL_REMINDER:id]. FOLLOW UP TRACKING: When you send a message expecting a reply use: [FOLLOW_UP:contact_name:contact_number:message_summary]. DELEGATED CONVERSATIONS: When someone replies their message will be forwarded to you. Report back to Stu and ask how to respond. TONE: Direct, efficient and natural. No excessive formality. Concise. Dot points for lists. IMPORTANT: Confidential.";

module.exports = function(app) {

  module.exports.getDelegatedConversations = function() {
    return delegatedConversations;
  };

  module.exports.handleDelegatedReply = handleDelegatedReply;

  module.exports.handleTrustedContact = handleTrustedContact;

  module.exports.getTrustedContact = getTrustedContact;

  setInterval(checkRemindersAndFollowUps, 60 * 1000);
  console.log('Jordan reminder checker started');

  app.post('/whatsapp', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;
    const bodyUpper = Body.trim().toUpperCase();

    console.log('WhatsApp from ' + From + ': ' + Body);

    const cleanFrom = From.replace('whatsapp:', '').replace(/\s/g, '').replace('+', '');
    const cleanStu = (STU_NUMBER || '').replace(/\s/g, '').replace('+', '');

    if (!cleanStu || !cleanFrom.includes(cleanStu)) {
      console.log('Blocked non-authorised WhatsApp number: ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) conversations[From] = [];

    if (bodyUpper === 'CLEAR') {
      conversations[From] = [];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Conversation cleared.');
      return res.type('text/xml').send(twiml.toString());
    }

    conversations[From].push({ role: 'user', content: Body });
    if (conversations[From].length > 30) conversations[From] = conversations[From].slice(-30);

    try {
      const currentDateTime = getCurrentDateTime();
      const memoryContext = buildMemoryContext();
      const remindersContext = getPendingRemindersContext();
      const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + remindersContext + '\n\nCURRENT DATE AND TIME: It is currently ' + currentDateTime + ' Melbourne Australia time. Use this to accurately calculate all future dates and times.';

      const reply = await callClaudeWithSearch(systemPrompt, conversations[From]);
      console.log('Jordan raw reply: ' + reply);

      const allSendTags = [...reply.matchAll(/\[SEND:(\+[\d]+):([^\]]+)\]/g)];
      let cleanReply = reply;

      if (allSendTags.length > 0) {
        cleanReply = reply.replace(/\[SEND:(\+[\d]+):([^\]]+)\]/g, '').trim();
        const results = [];
        for (const match of allSendTags) {
          const toNumber = match[1].trim();
          const messageToSend = match[2].trim();
          const contact = getContactByNumber(toNumber);
          const contactName = contact ? contact.name : toNumber;
          const success = await sendMessageOnBehalf(toNumber, messageToSend, contactName);
          results.push({ name: contactName, success: success });
        }
        const successNames = results.filter(r => r.success).map(r => r.name);
        const failNames = results.filter(r => !r.success).map(r => r.name);
        if (successNames.length > 0) cleanReply = cleanReply + '\n\nSent to ' + successNames.join(' and ') + '. I will let you know when they reply.';
        if (failNames.length > 0) cleanReply = cleanReply + '\nFailed to send to ' + failNames.join(' and ') + '.';
      }

      processTagsFromReply(reply);
      cleanReply = stripAllTags(cleanReply);

      conversations[From].push({ role: 'assistant', content: cleanReply });
      console.log('WhatsApp reply to ' + From + ': ' + cleanReply);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(cleanReply);
      res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('WhatsApp error:', error);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Having a technical issue - try again in a moment.');
      res.type('text/xml').send(twiml.toString());
    }
  });

  app.get('/whatsapp', function(req, res) {
    res.send('Jordan WhatsApp personal assistant is running!');
  });

};
