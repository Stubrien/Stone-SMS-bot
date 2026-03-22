const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');
const Database = require('better-sqlite3');
const path = require('path');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
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
    const memories = db.prepare('SELECT category, key, value FROM memories ORDER BY category, key').all();
    return memories;
  } catch (error) {
    console.error('Failed to load memories:', error.message);
    return [];
  }
}

function deleteMemory(category, key) {
  try {
    db.prepare('DELETE FROM memories WHERE category = ? AND key = ?').run(category, key);
    return true;
  } catch (error) {
    console.error('Failed to delete memory:', error.message);
    return false;
  }
}

function saveReminder(type, message, context, recipient, recipientNumber, scheduledFor, recurrence) {
  try {
    db.prepare(`
      INSERT INTO reminders (type, message, context, recipient, recipient_number, scheduled_for, recurrence)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(type, message, context || null, recipient || 'Stu', recipientNumber || null, scheduledFor, recurrence || null);
    console.log('Reminder saved for ' + scheduledFor);
    return true;
  } catch (error) {
    console.error('Failed to save reminder:', error.message);
    return false;
  }
}

function saveFollowUp(contactName, contactNumber, messageSent) {
  try {
    db.prepare(`
      INSERT INTO follow_ups (contact_name, contact_number, message_sent)
      VALUES (?, ?, ?)
    `).run(contactName, contactNumber, messageSent);
    console.log('Follow up tracking saved for ' + contactName);
    return true;
  } catch (error) {
    console.error('Failed to save follow up:', error.message);
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

function getMelbourneHour() {
  return parseInt(new Date().toLocaleString('en-AU', {
    timeZone: 'Australia/Melbourne',
    hour: '2-digit',
    hour12: false
  }));
}

function isActiveHours() {
  const hour = getMelbourneHour();
  return hour >= 7 && hour < 21;
}

const BASE_SYSTEM_PROMPT = "You are Jordan, a personal AI assistant for Stu Brien - Principal of Stone Real Estate Ballarat. You help Stu with day to day productivity tasks via WhatsApp. You are efficient, direct and genuinely helpful. You know Stu well and communicate naturally - not overly formal. ABOUT STU: Stu Brien is the Principal and Licensed Real Estate Agent at Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central. Phone: 0416 183 566. Email: stubrien@stonerealestate.com.au. STU CONTACTS AND THEIR NUMBERS: Yasna (Wife) +61414682861 - sms. Fiona Hart (Personal Assistant) +61412185312 - sms. Leanne Madigan (Sales Associate) +61429097002 - sms. Tammy Edwards (Sales Admin) +61418318251 - sms. Gwen Brien (Mum) +61414410117 - sms. Glenn Brien (Brother) +61418301954 - sms. Josh Brien (Son) +61434308724 - sms. Aiden Brien (Son) +61498327669 - sms. Rob Cunningham (Sales Agent) +61418543634 - sms. Leigh Hutchinson (Sales Agent) +61407861960 - sms. Jamie Gepp (Sales Agent) +61459201710 - sms. Jarrod Kemp (Sales Agent) +61450836257 - sms. Linda Turk (Property Manager) +61414287337 - sms. WHAT YOU CAN HELP WITH: Drafting and sending messages. Contacting people on Stu behalf. Coordinating meetings and scheduling. Setting reminders. Remembering preferences and instructions. Drafting listing copy. Drafting social media posts. Answering property market questions. Calculations. Writing correspondence. General knowledge. HOW TO HANDLE TASKS: Draft immediately and present cleanly. Answer questions directly and concisely. Give 2 to 3 clear options when asked. CONTACTING PEOPLE - TWO STEP PROCESS: STEP 1 - Show draft messages in plain text and ask shall I send these. Do NOT include any [SEND:] tags yet. STEP 2 - When Stu confirms with yes, send, go ahead, ok, yep, yeah or similar - include [SEND:] tags. Format: [SEND:+PHONENUMBER:message text] one per line per recipient. Example: [SEND:+61414682861:Hi Yasna message here]. ALWAYS INTRODUCE AS AI ASSISTANT: When contacting someone for the first time say: Hi [name], this is Jordan - I am Stu Brien AI assistant. MEMORY SYSTEM - SAVING: When Stu tells you something worth remembering or when you notice an important preference, save it using this tag on its own line: [MEMORY:category:key:value]. Categories: preferences, contacts, instructions, tasks. Example: [MEMORY:preferences:sign_off:Always sign off as Stu not Stuart]. Also save when Stu corrects you - that correction is a memory worth keeping. When you save a memory tell Stu: Got it - I will remember that. MEMORY SYSTEM - READING: Your saved memories will be injected into your context automatically. Always apply them. MEMORY SYSTEM - DELETING: When Stu asks you to forget something use: [FORGET:category:key]. REMINDER SYSTEM - SETTING: When Stu sets a reminder use this tag: [REMINDER:type:recipient:recipient_number:scheduled_datetime:recurrence:message:context]. Type is either STU for reminders to Stu or CONTACT for messages to someone else. Recurrence is ONCE, DAILY, WEEKLY or MONTHLY. Datetime format is YYYY-MM-DD HH:MM. Example reminder to Stu: [REMINDER:STU:Stu:none:2026-03-24 15:00:ONCE:Call the vendor:Re Buninyong listing]. Example reminder to contact: [REMINDER:CONTACT:Yasna:+61414682861:2026-03-28 09:00:ONCE:Hi Yasna reminder from Stu about dinner Saturday night:Weekend dinner]. When you save a reminder confirm it back to Stu with the exact date and time. REMINDER SYSTEM - LISTING: When Stu asks what reminders they have, tell them from memory - you will be provided with pending reminders in your context. REMINDER SYSTEM - CANCELLING: When Stu cancels a reminder use: [CANCEL_REMINDER:id]. FOLLOW UP TRACKING: When you send a message that expects a reply, save a follow up record using: [FOLLOW_UP:contact_name:contact_number:message_summary]. Jordan will automatically prompt Stu if no reply comes within 3 hours during active hours 7am to 9pm. DELEGATED CONVERSATIONS: When someone replies their message will be forwarded to you. Report back to Stu and ask how to respond. Check in at key decision points. TONE: Direct, efficient and natural. No excessive formality. Concise responses. Dot points for lists. IMPORTANT: These conversations are confidential.";

async function sendMessageOnBehalf(to, message, contactName) {
  try {
    const cleanTo = to.replace(/\s/g, '');
    console.log('Sending to ' + cleanTo + ': ' + message);

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
    console.log('Message sent successfully to ' + cleanTo);
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
    console.log('Stu notified: ' + message.substring(0, 50));
  } catch (error) {
    console.error('Failed to notify Stu: ' + error.message);
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

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: systemPrompt,
      messages: conversations[stuFrom]
    });

    let jordanReply = response.content[0].text;

    const allSendTags = [...jordanReply.matchAll(/\[SEND:(\+[\d]+):([^\]]+)\]/g)];
    if (allSendTags.length > 0) {
      jordanReply = jordanReply.replace(/\[SEND:(\+[\d]+):([^\]]+)\]/g, '').trim();
      for (const match of allSendTags) {
        await sendMessageOnBehalf(match[1].trim(), match[2].trim());
      }
    }

    processTagsFromReply(jordanReply);
    jordanReply = stripAllTags(jordanReply);

    conversations[stuFrom].push({ role: 'assistant', content: jordanReply });
    await notifyStu(jordanReply);

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
    const type = match[1].trim();
    const recipient = match[2].trim();
    const recipientNumber = match[3].trim() === 'none' ? null : match[3].trim();
    const scheduledFor = match[4].trim();
    const recurrence = match[5].trim();
    const message = match[6].trim();
    const context = match[7].trim();
    saveReminder(type, message, context, recipient, recipientNumber, scheduledFor, recurrence);
  }

  const cancelTags = [...reply.matchAll(/\[CANCEL_REMINDER:(\d+)\]/g)];
  for (const match of cancelTags) {
    try {
      db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(parseInt(match[1]));
      console.log('Reminder cancelled: ' + match[1]);
    } catch (e) {}
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
    .trim();
}

async function checkRemindersAndFollowUps() {
  if (!isActiveHours()) return;

  const now = new Date().toISOString().slice(0, 16).replace('T', ' ');

  try {
    const dueReminders = db.prepare(`
      SELECT * FROM reminders 
      WHERE sent = 0 AND scheduled_for <= ?
    `).all(now);

    for (const reminder of dueReminders) {
      console.log('Processing reminder: ' + reminder.message);

      if (reminder.type === 'STU') {
        await notifyStu('Reminder: ' + reminder.message + (reminder.context ? '\n' + reminder.context : ''));
      } else if (reminder.type === 'CONTACT' && reminder.recipient_number) {
        await sendMessageOnBehalf(reminder.recipient_number, reminder.message, reminder.recipient);
        await notifyStu('Sent reminder to ' + reminder.recipient + ': "' + reminder.message + '"');
      }

      if (reminder.recurrence === 'ONCE' || !reminder.recurrence) {
        db.prepare('UPDATE reminders SET sent = 1 WHERE id = ?').run(reminder.id);
      } else {
        let nextDate = new Date(reminder.scheduled_for);
        if (reminder.recurrence === 'DAILY') nextDate.setDate(nextDate.getDate() + 1);
        else if (reminder.recurrence === 'WEEKLY') nextDate.setDate(nextDate.getDate() + 7);
        else if (reminder.recurrence === 'MONTHLY') nextDate.setMonth(nextDate.getMonth() + 1);
        const nextScheduled = nextDate.toISOString().slice(0, 16).replace('T', ' ');
        db.prepare('UPDATE reminders SET scheduled_for = ? WHERE id = ?').run(nextScheduled, reminder.id);
      }
    }

    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
    const overdueFollowUps = db.prepare(`
      SELECT * FROM follow_ups 
      WHERE resolved = 0 AND prompted = 0 AND sent_at <= ?
    `).all(threeHoursAgo);

    for (const followUp of overdueFollowUps) {
      await notifyStu(followUp.contact_name + ' has not replied to your message from 3 hours ago.\n"' + followUp.message_sent.substring(0, 80) + '"\nWant me to follow up?');
      db.prepare('UPDATE follow_ups SET prompted = 1 WHERE id = ?').run(followUp.id);
    }

  } catch (error) {
    console.error('Reminder check error:', error.message);
  }
}

function getPendingRemindersContext() {
  try {
    const reminders = db.prepare(`
      SELECT * FROM reminders WHERE sent = 0 ORDER BY scheduled_for ASC LIMIT 10
    `).all();

    if (reminders.length === 0) return '';

    let context = '\n\nPENDING REMINDERS:\n';
    for (const r of reminders) {
      context += '- [ID:' + r.id + '] ' + r.scheduled_for + ' - ' + (r.recipient !== 'Stu' ? 'To ' + r.recipient + ': ' : '') + r.message + '\n';
    }
    return context;
  } catch (e) {
    return '';
  }
}

module.exports = function(app) {

  module.exports.getDelegatedConversations = function() {
    return delegatedConversations;
  };

  module.exports.handleDelegatedReply = handleDelegatedReply;

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
      console.log('Blocked non-authorised number: ' + From);
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

    if (conversations[From].length > 30) {
      conversations[From] = conversations[From].slice(-30);
    }

    try {
      const currentDateTime = getCurrentDateTime();
      const memoryContext = buildMemoryContext();
      const remindersContext = getPendingRemindersContext();
      const systemPrompt = BASE_SYSTEM_PROMPT + memoryContext + remindersContext + '\n\nCURRENT DATE AND TIME: It is currently ' + currentDateTime + ' Melbourne Australia time. Use this to accurately calculate all future dates and times. When someone asks about next Saturday or next week calculate the exact date based on todays date.';

      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: systemPrompt,
        messages: conversations[From]
      });

      let reply = response.content[0].text;
      console.log('Jordan raw reply: ' + reply);

      const allSendTags = [...reply.matchAll(/\[SEND:(\+[\d]+):([^\]]+)\]/g)];

      if (allSendTags.length > 0) {
        reply = reply.replace(/\[SEND:(\+[\d]+):([^\]]+)\]/g, '').trim();
        const results = [];
        for (const match of allSendTags) {
          const toNumber = match[1].trim();
          const messageToSend = match[2].trim();
          const contact = getContactByNumber(toNumber);
          const contactName = contact ? contact.name : toNumber;
          console.log('Sending to ' + contactName + ' on ' + toNumber);
          const success = await sendMessageOnBehalf(toNumber, messageToSend, contactName);
          results.push({ name: contactName, success: success });
        }

        const successNames = results.filter(r => r.success).map(r => r.name);
        const failNames = results.filter(r => !r.success).map(r => r.name);

        if (successNames.length > 0) reply = reply + '\n\nSent to ' + successNames.join(' and ') + '. I will let you know when they reply.';
        if (failNames.length > 0) reply = reply + '\nFailed to send to ' + failNames.join(' and ') + '.';
      }

      processTagsFromReply(reply);
      reply = stripAllTags(reply);

      conversations[From].push({ role: 'assistant', content: reply });
      console.log('WhatsApp reply to ' + From + ': ' + reply);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
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
