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
  'josh': { name: 'Josh Brien', number: '+61434308724', method: 'whatsapp', relationship: 'Son' },
  'josh brien': { name: 'Josh Brien', number: '+61434308724', method: 'whatsapp', relationship: 'Son' },
  'aiden': { name: 'Aiden Brien', number: '+61498327669', method: 'whatsapp', relationship: 'Son' },
  'aiden brien': { name: 'Aiden Brien', number: '+61498327669', method: 'whatsapp', relationship: 'Son' },
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

function findContact(nameQuery) {
  if (!nameQuery) return null;
  return CONTACTS[nameQuery.toLowerCase().trim()] || null;
}

function getContactByNumber(number) {
  const clean = number.replace('whatsapp:', '').replace(/\s/g, '');
  for (const key in CONTACTS) {
    if (CONTACTS[key].number.replace(/\s/g, '') === clean) {
      return CONTACTS[key];
    }
  }
  return null;
}

const SYSTEM_PROMPT = "You are Jordan, a personal AI assistant for Stu Brien - Principal of Stone Real Estate Ballarat. You help Stu with day to day productivity tasks via WhatsApp. You are efficient, direct and genuinely helpful. You know Stu well and communicate naturally - not overly formal. ABOUT STU: Stu Brien is the Principal and Licensed Real Estate Agent at Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central. Phone: 0416 183 566. Email: stubrien@stonerealestate.com.au. STU CONTACTS: Yasna (Wife) - sms. Fiona Hart (Personal Assistant) - sms. Leanne Madigan (Sales Associate) - sms. Tammy Edwards (Sales Admin) - sms. Gwen Brien (Mum) - sms. Glenn Brien (Brother) - sms. Josh Brien (Son) - WhatsApp. Aiden Brien (Son) - WhatsApp. Rob Cunningham (Sales Agent) - sms. Leigh Hutchinson (Sales Agent) - sms. Jamie Gepp (Sales Agent) - sms. Jarrod Kemp (Sales Agent) - sms. Linda Turk (Property Manager) - sms. WHAT YOU CAN HELP WITH: Drafting emails and messages. Contacting people on Stu behalf via SMS or WhatsApp. Coordinating meetings and scheduling. Drafting listing copy and property descriptions. Drafting social media posts. Answering property market questions. Helping with calculations. Writing correspondence. Researching information. General knowledge questions. HOW TO HANDLE TASKS: When Stu asks you to draft something - draft it immediately and present it cleanly. When Stu asks a question - answer directly and concisely. When Stu asks for options - give 2 to 3 clear options. CONTACTING PEOPLE ON STU BEHALF - ALWAYS ASK FIRST: When Stu asks you to contact someone, always confirm before sending. Say something like: I will contact [name] via [SMS or WhatsApp] with this message: [draft message]. Shall I go ahead? Once Stu confirms say GO AHEAD or YES - send the message immediately and confirm back to Stu. DELEGATED CONVERSATIONS: When you contact someone on Stu behalf and they reply, you will receive their reply and report it back to Stu via WhatsApp. Handle the back and forth naturally but check in with Stu at key decision points - for example when a time or date needs to be confirmed, when something unexpected comes up, or when the task is complete. Key decision points to always check with Stu: When you have gathered options and need Stu to choose. When someone asks a question only Stu can answer. When the conversation reaches a natural conclusion. When something unexpected or important comes up. TONE: Direct, efficient and natural. You know Stu well. No excessive formality. Keep responses concise. Use dot points when listing multiple things. SENDING SMS FORMAT: When you need to send a message on Stu behalf include this hidden tag on a new line: [SEND_SMS:number:message] where number is the recipients number and message is what to send. Example: [SEND_SMS:+61412345678:Hi this is a test message]. IMPORTANT: These conversations are confidential.";

async function sendMessageOnBehalf(to, message, method, taskId) {
  try {
    const fromNumber = method === 'whatsapp'
      ? 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER
      : process.env.TWILIO_PHONE_NUMBER;

    const toNumber = method === 'whatsapp'
      ? 'whatsapp:' + to
      : to;

    await twilioClient.messages.create({
      from: fromNumber,
      to: toNumber,
      body: message
    });

    if (taskId) {
      delegatedConversations[to] = {
        taskId: taskId,
        method: method,
        messages: [{ role: 'sent', content: message }]
      };
    }

    console.log('Sent message to ' + to + ' via ' + method);
    return true;
  } catch (error) {
    console.error('Failed to send message to ' + to + ': ' + error.message);
    return false;
  }
}

async function notifyStu(message) {
  try {
    await twilioClient.messages.create({
      from: 'whatsapp:' + process.env.TWILIO_PHONE_NUMBER,
      to: STU_WHATSAPP,
      body: message
    });
    console.log('Notified Stu via WhatsApp');
  } catch (error) {
    console.error('Failed to notify Stu: ' + error.message);
  }
}

module.exports = function(app) {

  app.post('/whatsapp', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;

    console.log('WhatsApp incoming from ' + From + ': ' + Body);

    const cleanFrom = From.replace('whatsapp:', '').replace(/\s/g, '');
    const cleanStu = (STU_NUMBER || '').replace(/\s/g, '');

    if (!cleanStu || !cleanFrom.includes(cleanStu.replace('+', ''))) {
      console.log('Blocked WhatsApp message from non-authorised number: ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) {
      conversations[From] = [];
    }

    if (Body.trim().toUpperCase() === 'CLEAR') {
      conversations[From] = [];
      delete pendingSMS[From];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Conversation cleared.');
      return res.type('text/xml').send(twiml.toString());
    }

    if ((Body.trim().toUpperCase() === 'GO AHEAD' || Body.trim().toUpperCase() === 'YES' || Body.trim().toUpperCase() === 'SEND') && pendingSMS[From]) {
      try {
        const smsJob = pendingSMS[From];
        const contact = findContact(smsJob.contactName);
        const method = contact ? contact.method : 'sms';
        const taskId = Date.now().toString();

        const success = await sendMessageOnBehalf(smsJob.to, smsJob.message, method, taskId);

        if (success) {
          delete pendingSMS[From];
          const confirmMsg = 'Done - message sent to ' + smsJob.contactName + '. I will let you know when they reply.';
          conversations[From].push({ role: 'user', content: Body });
          conversations[From].push({ role: 'assistant', content: confirmMsg });
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message(confirmMsg);
          return res.type('text/xml').send(twiml.toString());
        } else {
          const twiml = new twilio.twiml.MessagingResponse();
          twiml.message('Failed to send the message - please try again.');
          return res.type('text/xml').send(twiml.toString());
        }
      } catch (error) {
        console.error('Send error:', error);
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

      const sendTagMatch = reply.match(/\[SEND_SMS:([^:]+):([^\]]+)\]/);
      if (sendTagMatch) {
        const toNumber = sendTagMatch[1].trim();
        const messageToSend = sendTagMatch[2].trim();
        reply = reply.replace(/\[SEND_SMS:[^\]]+\]/g, '').trim();

        const contact = getContactByNumber(toNumber);
        const contactName = contact ? contact.name : toNumber;

        pendingSMS[From] = {
          to: toNumber,
          message: messageToSend,
          contactName: contactName
        };
      }

      conversations[From].push({ role: 'assistant', content: reply });
      console.log('WhatsApp reply to ' + From + ': ' + reply);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('WhatsApp Jordan error:', error);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Having a technical issue - try again in a moment.');
      res.type('text/xml').send(twiml.toString());
    }
  });

  app.post('/webhook', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;

    console.log('SMS webhook incoming from ' + From + ': ' + Body);

    const cleanFrom = From.replace(/\s/g, '');
    const delegation = delegatedConversations[cleanFrom];

    if (delegation) {
      console.log('Delegated reply received from ' + From);
      delegation.messages.push({ role: 'received', content: Body });

      const contact = getContactByNumber(cleanFrom);
      const contactName = contact ? contact.name : From;

      await notifyStu(contactName + ' replied: "' + Body + '"\n\nHow would you like me to respond?');

      return res.type('text/xml').send('<Response></Response>');
    }

    res.type('text/xml').send('<Response></Response>');
  });

  app.get('/whatsapp', function(req, res) {
    res.send('Jordan WhatsApp personal assistant is running!');
  });

};
