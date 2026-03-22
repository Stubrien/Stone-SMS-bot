const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const pendingSMS = {};
const delegatedConversations = {};

const STU_NUMBER = process.env.STU_WHATSAPP_NUMBER;
const STU_WHATSAPP = 'whatsapp:' + (process.env.STU_WHATSAPP_NUMBER || '');

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

const SYSTEM_PROMPT = "You are Jordan, a personal AI assistant for Stu Brien - Principal of Stone Real Estate Ballarat. You help Stu with day to day productivity tasks via WhatsApp. You are efficient, direct and genuinely helpful. You know Stu well and communicate naturally - not overly formal. ABOUT STU: Stu Brien is the Principal and Licensed Real Estate Agent at Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central. Phone: 0416 183 566. Email: stubrien@stonerealestate.com.au. STU CONTACTS AND THEIR NUMBERS: Yasna (Wife) +61414682861 - sms. Fiona Hart (Personal Assistant) +61412185312 - sms. Leanne Madigan (Sales Associate) +61429097002 - sms. Tammy Edwards (Sales Admin) +61418318251 - sms. Gwen Brien (Mum) +61414410117 - sms. Glenn Brien (Brother) +61418301954 - sms. Josh Brien (Son) +61434308724 - sms. Aiden Brien (Son) +61498327669 - sms. Rob Cunningham (Sales Agent) +61418543634 - sms. Leigh Hutchinson (Sales Agent) +61407861960 - sms. Jamie Gepp (Sales Agent) +61459201710 - sms. Jarrod Kemp (Sales Agent) +61450836257 - sms. Linda Turk (Property Manager) +61414287337 - sms. WHAT YOU CAN HELP WITH: Drafting emails and messages. Contacting people on Stu behalf via SMS. Coordinating meetings and scheduling. Drafting listing copy and property descriptions. Drafting social media posts. Answering property market questions. Helping with calculations. Writing correspondence. Researching information. General knowledge questions. HOW TO HANDLE TASKS: When Stu asks you to draft something - draft it immediately and present it cleanly. When Stu asks a question - answer directly and concisely. When Stu asks for options - give 2 to 3 clear options. CONTACTING PEOPLE ON STU BEHALF: When Stu asks you to contact someone, show the draft message and ask for confirmation. When contacting multiple people show all drafts together and ask once. Say something like: Here are the messages I will send - shall I go ahead? IMPORTANT - When showing drafts DO NOT include any [SEND_SMS] tags. ONLY include [SEND_SMS] tags AFTER Stu confirms with YES or GO AHEAD. When Stu confirms, include one [SEND_SMS] tag per recipient each on its own line: [SEND_SMS:+PHONENUMBER:message text]. Example for two people: [SEND_SMS:+61414682861:Hi Yasna message here] [SEND_SMS:+61434308724:Hi Josh message here]. ALWAYS INTRODUCE YOURSELF: When contacting someone for the first time or who may not know Jordan exists, always introduce yourself. Say something like: Hi [name], this is Jordan - I am Stu Brien assistant. DELEGATED CONVERSATIONS: When someone replies to a message you sent on Stu behalf, their reply will be forwarded to you. Report it back to Stu and ask how to respond. Check in at key decision points. TONE: Direct, efficient and natural. No excessive formality. Concise responses. Use dot points when listing multiple things. IMPORTANT: These conversations are confidential.";

async function sendMessageOnBehalf(to, message, method) {
  try {
    const cleanTo = to.replace(/\s/g, '');
    const fromNumber = process.env.TWILIO_PHONE_NUMBER;
    const toNumber = cleanTo;

    console.log('Sending to ' + toNumber + ' from ' + fromNumber);
    console.log('Message: ' + message);

    await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      body: message
    });

    const contact = getContactByNumber(cleanTo);
    delegatedConversations[cleanTo] = {
      contactName: contact ? contact.name : cleanTo,
      method: method,
      messages: [{ role: 'sent', content: message }]
    };

    console.log('Message sent successfully to ' + cleanTo);
    return true;
  } catch (error) {
    console.error('Failed to send to ' + to + ': ' + error.message);
    return false;
  }
}

async function notifyStu(message) {
  try {
    const whatsappFrom = process.env.WHATSAPP_FROM || 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER;
    await twilioClient.messages.create({
      from: whatsappFrom,
      to: STU_WHATSAPP,
      body: message
    });
    console.log('Stu notified via WhatsApp');
  } catch (error) {
    console.error('Failed to notify Stu: ' + error.message);
  }
}

async function handleDelegatedReply(fromNumber, body) {
  const delegation = delegatedConversations[fromNumber];
  if (!delegation) return;

  console.log('Delegated reply from ' + fromNumber + ': ' + body);
  delegation.messages.push({ role: 'received', content: body });

  const contact = getContactByNumber(fromNumber);
  const contactName = contact ? contact.name : fromNumber;
  const stuFrom = STU_WHATSAPP;

  if (!conversations[stuFrom]) {
    conversations[stuFrom] = [];
  }

  const contextMessage = contactName + ' replied: "' + body + '"';
  conversations[stuFrom].push({ role: 'user', content: contextMessage });

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: SYSTEM_PROMPT,
      messages: conversations[stuFrom]
    });

    let jordanReply = response.content[0].text;

    const allSendTags = [...jordanReply.matchAll(/\[SEND_SMS:(\+[\d]+):([^\]]+)\]/g)];
    if (allSendTags.length > 0) {
      jordanReply = jordanReply.replace(/\[SEND_SMS:(\+[\d]+):([^\]]+)\]/g, '').trim();
      for (const match of allSendTags) {
        const toNumber = match[1].trim();
        const messageToSend = match[2].trim();
        const contactForSend = getContactByNumber(toNumber);
        const method = contactForSend ? contactForSend.method : 'sms';
        await sendMessageOnBehalf(toNumber, messageToSend, method);
      }
    }

    conversations[stuFrom].push({ role: 'assistant', content: jordanReply });
    await notifyStu(jordanReply);

  } catch (error) {
    console.error('Error handling delegated reply:', error);
    await notifyStu(contactName + ' replied: "' + body + '"');
  }
}

module.exports = function(app) {

  module.exports.getDelegatedConversations = function() {
    return delegatedConversations;
  };

  module.exports.handleDelegatedReply = handleDelegatedReply;

  app.post('/whatsapp', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;
    const bodyUpper = Body.trim().toUpperCase();

    console.log('WhatsApp from ' + From + ': ' + Body);
    console.log('Pending SMS keys: ' + JSON.stringify(Object.keys(pendingSMS)));
    console.log('Has pending for this From: ' + (pendingSMS[From] ? 'YES' : 'NO'));

    const cleanFrom = From.replace('whatsapp:', '').replace(/\s/g, '').replace('+', '');
    const cleanStu = (STU_NUMBER || '').replace(/\s/g, '').replace('+', '');

    if (!cleanStu || !cleanFrom.includes(cleanStu)) {
      console.log('Blocked non-authorised number: ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) {
      conversations[From] = [];
    }

    if (bodyUpper === 'CLEAR') {
      conversations[From] = [];
      delete pendingSMS[From];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Conversation cleared.');
      return res.type('text/xml').send(twiml.toString());
    }

    if (['GO AHEAD', 'YES', 'SEND', 'YEP', 'YEA', 'YEAH', 'OK', 'OKAY'].includes(bodyUpper) && pendingSMS[From]) {
      console.log('Confirmation received - sending ' + pendingSMS[From].jobs.length + ' pending messages');
      try {
        const jobs = pendingSMS[From].jobs;
        const results = [];

        for (const job of jobs) {
          const contact = getContactByNumber(job.to);
          const method = contact ? contact.method : 'sms';
          const success = await sendMessageOnBehalf(job.to, job.message, method);
          results.push({ name: job.contactName, success: success });
        }

        delete pendingSMS[From];

        const successNames = results.filter(r => r.success).map(r => r.name);
        const failNames = results.filter(r => !r.success).map(r => r.name);

        let confirmMsg = '';
        if (successNames.length > 0) {
          confirmMsg += 'Sent to ' + successNames.join(' and ') + '. I will let you know when they reply.';
        }
        if (failNames.length > 0) {
          confirmMsg += ' Failed to send to ' + failNames.join(' and ') + '.';
        }

        conversations[From].push({ role: 'user', content: Body });
        conversations[From].push({ role: 'assistant', content: confirmMsg });
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message(confirmMsg);
        return res.type('text/xml').send(twiml.toString());

      } catch (error) {
        console.error('Confirmation send error:', error);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('Failed to send - ' + error.message);
        return res.type('text/xml').send(twiml.toString());
      }
    }

    conversations[From].push({ role: 'user', content: Body });

    if (conversations[From].length > 30) {
      conversations[From] = conversations[From].slice(-30);
    }

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1000,
        system: SYSTEM_PROMPT,
        messages: conversations[From]
      });

      let reply = response.content[0].text;
      console.log('Jordan raw reply: ' + reply);

      const allSendTags = [...reply.matchAll(/\[SEND_SMS:(\+[\d]+):([^\]]+)\]/g)];

      if (allSendTags.length > 0) {
        reply = reply.replace(/\[SEND_SMS:(\+[\d]+):([^\]]+)\]/g, '').trim();

        const jobs = [];
        for (const match of allSendTags) {
          const toNumber = match[1].trim();
          const messageToSend = match[2].trim();
          const contact = getContactByNumber(toNumber);
          const contactName = contact ? contact.name : toNumber;
          jobs.push({ to: toNumber, message: messageToSend, contactName: contactName });
          console.log('Queued send job for ' + contactName + ' on ' + toNumber);
        }

        pendingSMS[From] = { jobs: jobs };
        console.log('Stored ' + jobs.length + ' pending jobs with key: ' + From);
      }

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
