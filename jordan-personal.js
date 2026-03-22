const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const pendingSMS = {};

const STU_NUMBER = process.env.STU_WHATSAPP_NUMBER;

const SYSTEM_PROMPT = "You are Jordan, a personal AI assistant for Stu Brien - Principal of Stone Real Estate Ballarat. You help Stu with day to day productivity tasks via WhatsApp. You are efficient, direct and helpful. You know Stu well and communicate in a natural conversational way - not overly formal. ABOUT STU: Stu Brien is the Principal and Licensed Real Estate Agent at Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central. Phone: 0416 183 566. Email: stubrien@stonerealestate.com.au. STU TEAM: Rob Cunningham - Sales Agent - 0418 543 634 - robertcunningham@stonerealestate.com.au. Leigh Hutchinson - Sales Agent - 0407 861 960 - leighhutchinson@stonerealestate.com.au. Jamie Gepp - Sales Agent - 0459 201 710 - jamiegepp@stonerealestate.com.au. Jarrod Kemp - Sales Agent - 0450 836 257 - jarrodkemp@stonerealestate.com.au. Fiona Hart - Sales Associate - 0412 185 313 - fionahart@stonerealestate.com.au. Linda Turk - Senior Property Manager - 0414 287 337 - lindaturk@stonerealestate.com.au. Josh Shanahan - Property Manager - 0491 118 698 - joshshanahan@stonerealestate.com.au. WHAT YOU CAN HELP WITH: Drafting emails and messages for Stu to review and approve before sending. Sending SMS messages on Stu behalf via Twilio once approved. Drafting listing copy and property descriptions. Drafting social media posts. Answering questions about the Ballarat property market. Helping with calculations - commission, distances, splits. Summarising information. Writing thank you messages, follow up messages and correspondence. Researching property or suburb information. Helping think through decisions or strategies. General knowledge questions. HOW TO HANDLE TASKS: When Stu asks you to draft something - draft it immediately and present it cleanly. When Stu asks you to send an SMS on his behalf - draft the message first, confirm the recipient and ask Stu to reply SEND to confirm before sending. When Stu asks a question - answer it directly and concisely. When Stu asks for options or ideas - give 2 to 3 clear options. SENDING SMS ON STU BEHALF: When Stu wants to send a text to someone say: Here is the message I will send to [name] on [number]: [message]. Reply SEND to confirm or tell me any changes. Once Stu replies SEND dispatch the SMS immediately via Twilio. TONE: Direct, efficient and natural. You know Stu well. No need for excessive formality. Keep responses concise but complete. Use dot points when listing multiple things. Do not pad responses with unnecessary words. IMPORTANT: You are Stu private assistant - these conversations are confidential.";

module.exports = function(app) {

  app.post('/whatsapp', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;

    console.log('WhatsApp incoming from ' + From + ': ' + Body);

    if (!STU_NUMBER || !From.includes(STU_NUMBER.replace('+', '').replace(/\s/g, ''))) {
      console.log('Blocked WhatsApp message from non-authorised number: ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) {
      conversations[From] = [];
    }

    if (Body.trim().toUpperCase() === 'SEND' && pendingSMS[From]) {
      try {
        const smsJob = pendingSMS[From];
        await twilioClient.messages.create({
          from: process.env.TWILIO_PHONE_NUMBER,
          to: smsJob.to,
          body: smsJob.message
        });
        delete pendingSMS[From];
        conversations[From].push({ role: 'user', content: 'SEND' });
        conversations[From].push({ role: 'assistant', content: 'Sent.' });
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('Sent.');
        return res.type('text/xml').send(twiml.toString());
      } catch (error) {
        console.error('SMS send error:', error);
        const twiml = new twilio.twiml.MessagingResponse();
        twiml.message('Failed to send - ' + error.message);
        return res.type('text/xml').send(twiml.toString());
      }
    }

    if (Body.trim().toUpperCase() === 'CLEAR') {
      conversations[From] = [];
      delete pendingSMS[From];
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Conversation cleared.');
      return res.type('text/xml').send(twiml.toString());
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

      if (reply.includes('[SMS_READY]')) {
        const smsMatch = reply.match(/TO:\s*(\+?[\d\s]+)\nMESSAGE:\s*([\s\S]+?)(?:\[SMS_READY\])/);
        if (smsMatch) {
          const smsTo = smsMatch[1].trim().replace(/\s/g, '');
          const smsMessage = smsMatch[2].trim();
          pendingSMS[From] = { to: smsTo, message: smsMessage };
        }
        reply = reply.replace(/\[SMS_READY\]/g, '').trim();
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

  app.get('/whatsapp', function(req, res) {
    res.send('Jordan WhatsApp personal assistant is running!');
  });

};
