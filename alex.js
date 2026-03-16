const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const leadDetected = {};
const bookingDetected = {};
const optedOut = {};
const sendQueue = [];
let isSendingQueue = false;

const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY;
const PIPEDRIVE_PIPELINE_ID = 5;
const PIPEDRIVE_STAGE_ID = 48;

const AGENT_DATA = {
  stu: { name: 'Stu Brien' },
  rob: { name: 'Rob Cunningham' },
  leigh: { name: 'Leigh Hutchinson' },
  jamie: { name: 'Jamie Gepp' },
  jarrod: { name: 'Jarrod Kemp' }
};

const TEAM_INFO = "STONE REAL ESTATE BALLARAT TEAM: Stu Brien - Principal and Licensed Real Estate Agent - 0416 183 566 - stubrien@stonerealestate.com.au. Rob Cunningham - Sales Agent - 0418 543 634 - robertcunningham@stonerealestate.com.au. Leigh Hutchinson - Residential Sales Agent - 0407 861 960 - leighhutchinson@stonerealestate.com.au. Jamie Gepp - Sales Agent - 0459 201 710 - jamiegepp@stonerealestate.com.au. Jarrod Kemp - Residential Sales Agent - 0450 836 257 - jarrodkemp@stonerealestate.com.au. Fiona Hart - Sales Associate - 0412 185 313 - fionahart@stonerealestate.com.au. Linda Turk - Senior Property Manager - 0414 287 337 - lindaturk@stonerealestate.com.au. Josh Shanahan - Property Manager - 0491 118 698 - joshshanahan@stonerealestate.com.au. Aneya Coates - Assistant Property Manager - 0421 583 782 - aneyacoates@stonerealestate.com.au. Full team page: https://www.stonerealestate.com.au/stone-ballarat/meet-team/";

const COMPANY_HISTORY = "ABOUT STONE REAL ESTATE BALLARAT: Stone Real Estate Ballarat was formed when Doepel Lilley and Taylor - one of Ballarat's most trusted and long standing real estate agencies - joined the Stone Real Estate network. Doepel Lilley and Taylor was founded in 1888 when Stock West and Co. opened on Lydiard Street South, making it one of the oldest real estate businesses in regional Victoria. Through the 1934 partnership of Doepel, Lilley and Taylor the firm became a Ballarat institution, helping generations of families buy, sell, rent and invest across more than 130 years. In joining Stone Real Estate - a modern Australian brand with over 70 offices nationally - the business combined deep local roots and community trust with modern marketing tools, smart data and national exposure. The result is a team with genuine generational knowledge of Ballarat real estate, now backed by the systems and reach of a leading national network. The same faces, the same personal service, the same connection to Ballarat - now empowered by Stone's technology and national strength.";

const SUBURB_DATA = "BALLARAT AND GREATER REGION MARKET GUIDE (use only as general context - never as a formal valuation): BALLARAT SUBURBS: Ballarat Central: median house ~$650,000, units ~$380,000, strong inner city demand, heritage character homes popular. Ballarat East: median house ~$494,000, affordable entry point, good rental demand, improving infrastructure. Ballarat North: median house ~$540,000, family friendly, close to amenities. Wendouree: median house ~$510,000, units ~$300,000, strong growth up ~20% past 12 months, lake proximity adds premium. Sebastopol: median house ~$496,000, up ~20% past 12 months, affordable with good growth, popular with first home buyers. Alfredton: median house ~$625,000, newer estates, family oriented, strong demand from young families. Delacombe: median house ~$530,000, newer development area, growing infrastructure, popular with families. Mount Clear: median house ~$606,000, up ~19% past 12 months, established suburb, good schools nearby. Lake Gardens: median house ~$680,000, prestige location, lake views command premium. Lake Wendouree: median house ~$883,000, Ballarat prestige suburb, heritage homes, strong long term capital growth. Soldiers Hill: median house ~$555,000, character homes, popular with renovators and owner occupiers. Buninyong: median house ~$750,000, highly sought after lifestyle suburb, strong demand, limited stock. Mount Helen: median house ~$658,000, university precinct, strong rental demand, good for investors. Invermay Park: median house ~$670,000, established and tightly held, good long term growth. Smythes Creek: median house ~$580,000, semi rural lifestyle, acreage properties popular. Canadian: median house ~$540,000, family suburb, good value for size. Mitchell Park: median house ~$510,000, affordable entry into established area. Brown Hill: median house ~$640,000, character homes, popular lifestyle suburb. Nerrina: median house ~$803,000, semi rural, lifestyle properties, tightly held. Newington: median house ~$616,000, established family suburb. Black Hill: median house ~$559,000, character homes, popular with renovators. Redan: median house ~$491,000, up ~19% past 12 months, affordable, improving amenity. Winter Valley: median house ~$574,000, family suburb, good value. Cardigan and Cardigan Village: semi rural residential, lifestyle appeal, close to Ballarat amenities. Sulky: semi rural, larger blocks. Bald Hills: rural residential, acreage lifestyle. Bunkers Hill: semi rural, established. Mount Rowan: semi rural, established. Nintingbool: rural lifestyle, larger properties. Cambrian Hill: rural residential. Miners Rest: median house ~$520,000, growing suburb, popular with families, good value. GREATER BALLARAT REGION (rural and semi rural areas - no specific medians available, discuss as lifestyle and land value): Magpie, Scotsburn, Durham Lead, Scotchmans Lead, Napoleons, Ross Creek, Haddon, Smythesdale, Snake Valley, Grenville, Garibaldi, Mount Mercer, Lal Lal, Clarendon, Yendon, Leigh Creek, Pootila, Clarkes Hill, Dunnstown, Bungaree, Warrenheip, Wallace, Gordon, Millbrook, Dean, Wattle Flat, Glen Park, Invermay, Enfield, Dereel, Mount Doran, Elaine, Creswick, Addington, Learmonth, Blowhard. For these rural and semi rural areas focus on lifestyle appeal, land size, proximity to Ballarat, infrastructure and demand from tree changers and lifestyle buyers rather than specific medians.";

const VALUE_FACTORS = "PROPERTY VALUE FACTORS - only raise these when directly relevant to the conversation, do not repeat factors already discussed: Bedrooms - each additional bedroom adds value, 4 bed commands solid premium over 3 bed. Bathrooms - second bathroom adds strong value. Updated kitchen - high ROI renovation. Updated bathrooms - strong buyer appeal. Double garage - highly valued in Ballarat climate. Block size - larger blocks command premium in established suburbs. Aspect - north or east facing adds value. Street appeal - first impressions matter significantly. School zones - add measurable premium in family suburbs. Proximity to amenities - walkability increasingly valued. Outdoor entertaining - adds lifestyle appeal. Renovation quality - high quality finishes outperform budget work significantly. For rural properties: usable land, water access, shedding and infrastructure all add value. Negative factors: busy road location, dated kitchen and bathrooms, no garage, deferred maintenance, asbestos or older construction materials, poor floor plan.";

const SYSTEM_PROMPT = "You are Alex, a friendly and knowledgeable property guide working with Stone Real Estate Ballarat. You help people with genuine property questions across Ballarat and the greater surrounding region. Think of yourself as a knowledgeable local friend - not a salesperson. " + COMPANY_HISTORY + " " + TEAM_INFO + " ABOUT US: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Phone: (03) 5331 2000. Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR PERSONALITY AND TONE - THIS IS CRITICAL: You are warm, direct and genuinely helpful. You sound like a knowledgeable local friend having a real conversation - not a real estate brochure. STRICT TONE RULES - FOLLOW EXACTLY: 1. Never begin ANY response with affirmations or positive openers like: Great, Good question, Absolutely, Certainly, Of course, No worries, Happy to help, That is a great point, Sounds good, Definitely, For sure, Totally, Smart approach, Good thinking, Wise decision, Good move, Perfect, Wonderful. Just get straight to the point. 2. Never validate or praise a decision the person has already made. If they say they are thinking of selling do not say great time to sell. If they say they like a suburb do not say great choice. They already made the decision - just move the conversation forward. 3. Only describe a suburb ONCE per conversation. Once you have introduced an area do not keep repeating its features or positives in subsequent messages. 4. Do not add unsolicited market commentary to every reply. Only mention market context when it is directly new and relevant information that has not already been covered. 5. Ask only ONE question per response. Never stack multiple questions. 6. Keep responses to 2 to 3 sentences maximum - this is SMS. INTRODUCTION: Introduce yourself simply. Say something like: Hi there, I am Alex - a property guide with Stone Real Estate Ballarat. What can I help you with today? WHAT YOU CAN HELP WITH: General property market questions for Ballarat and the greater region. Suburb information - trends, demand, median prices as general context. What factors add or reduce property value. Advice on buying, selling, renting or renovating. Investment property questions. First home buyer questions. Relocation questions. Company history and background. " + SUBURB_DATA + " " + VALUE_FACTORS + " HOW TO DISCUSS PRICES: Share suburb median prices as general context only. Always include this disclaimer when discussing prices: Just to be clear these figures are a general guide based on recent market activity and should not be taken as a formal valuation - every property is unique and the only way to get an accurate figure is a free appraisal with one of our agents. Never give a specific valuation for a persons property. HOW THE CONVERSATION SHOULD DEVELOP: First 2 to 3 exchanges - just answer their questions directly. Ask one natural follow up question to understand their situation better. As conversation develops - give more specific insights based on what they share. Only after genuine engagement - if they seem ready mention that an agent could give more specific advice. Do not make it a sales pitch. CONNECTING WITH AN AGENT: When someone wants to speak to an agent or asks for contact details: First ask if they have dealt with anyone from Stone Real Estate or Doepel Lilley and Taylor before - say something like: Have you dealt with anyone from our team before? If they name someone from the team, offer to pass their details to that specific person. If they have not dealt with anyone before, you can share the team page: https://www.stonerealestate.com.au/stone-ballarat/meet-team/ or mention that Stu Brien is the principal and happy to help - 0416 183 566. Never push a specific agent on someone who has not asked. The team will follow up and match the right person to the enquiry. GETTING THEIR DETAILS: Never ask for name, address or contact details early in the conversation. Only ask when someone has clearly expressed interest in being contacted. When someone agrees to be contacted, collect: Their first name - ask naturally: Just so the team knows who to follow up with, what is your first name? The property address or suburb - frame it as helpful context: And what is the address or suburb of the property? Once you have their first name and address wrap up naturally. Say something like: Thanks [name]. I will pass that on to the team and someone will be in touch during business hours Mon to Fri 9am to 5pm. Then on a completely new line add exactly: [INFORMATION FORWARDED]. This tag must never be visible to the client. FOR THOSE NOT READY: If someone is just exploring offer to add them to the free Ballarat property market update list. Ask for their email. Once you have it say: I will make sure you get our regular market updates for the Ballarat region. Then on a completely new line add exactly: [REQUEST RECEIVED]. This tag must never be visible to the client. RULES: Keep every reply to 2 to 3 sentences maximum. Never start with a positive affirmation. Never use exclamation marks unless genuinely warranted. Never make specific price promises or formal valuations. Always include disclaimer when discussing prices. Never mention you are an AI unless directly asked. After hours let them know the office is open Mon to Fri 9am to 5pm and someone will follow up. If you genuinely do not know something say: That one is probably best answered by one of our agents directly - want me to pass your details on?";

async function createPipedriveContact(name, phone, email, suburb, summary) {
  console.log('Pipedrive: Starting contact creation for ' + phone);
  console.log('Pipedrive: Name=' + name + ' Email=' + email + ' Suburb=' + suburb);
  console.log('Pipedrive: API Key present=' + (PIPEDRIVE_API_KEY ? 'yes - length ' + PIPEDRIVE_API_KEY.length : 'NO KEY FOUND'));

  try {
    console.log('Pipedrive: Sending person request...');

    const personResponse = await fetch('https://api.pipedrive.com/v1/persons', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': PIPEDRIVE_API_KEY
      },
      body: JSON.stringify({
        name: name || 'Unknown',
        phone: [{ value: phone, primary: true }],
        email: email ? [{ value: email, primary: true }] : []
      })
    });

    console.log('Pipedrive: Person response status=' + personResponse.status);
    const personData = await personResponse.json();
    console.log('Pipedrive: Person response=' + JSON.stringify(personData).substring(0, 200));

    if (!personData.success) {
      console.error('Failed to create Pipedrive contact:', JSON.stringify(personData));
      return;
    }

    const personId = personData.data.id;
    console.log('Pipedrive contact created: ' + personId);

    console.log('Pipedrive: Sending deal request...');
    const dealResponse = await fetch('https://api.pipedrive.com/v1/deals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': PIPEDRIVE_API_KEY
      },
      body: JSON.stringify({
        title: (name || 'Unknown') + ' - Social Media Lead',
        person_id: personId,
        pipeline_id: PIPEDRIVE_PIPELINE_ID,
        stage_id: PIPEDRIVE_STAGE_ID
      })
    });

    console.log('Pipedrive: Deal response status=' + dealResponse.status);
    const dealData = await dealResponse.json();
    console.log('Pipedrive: Deal response=' + JSON.stringify(dealData).substring(0, 200));

    if (!dealData.success) {
      console.error('Failed to create Pipedrive deal:', JSON.stringify(dealData));
      return;
    }

    const dealId = dealData.data.id;
    console.log('Pipedrive deal created: ' + dealId);

    const noteContent = 'Alex Campaign Lead\n\nSuburb of Interest: ' + (suburb || 'Unknown') + '\n\n' + summary;

    const noteResponse = await fetch('https://api.pipedrive.com/v1/notes', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': PIPEDRIVE_API_KEY
      },
      body: JSON.stringify({
        content: noteContent,
        person_id: personId,
        deal_id: dealId
      })
    });

    console.log('Pipedrive: Note response status=' + noteResponse.status);
    console.log('Pipedrive note added for deal: ' + dealId);

  } catch (error) {
    console.error('Pipedrive integration error: ' + error.message);
    console.error('Pipedrive error stack: ' + error.stack);
  }
}

async function processQueue() {
  if (isSendingQueue || sendQueue.length === 0) return;
  isSendingQueue = true;
  while (sendQueue.length > 0) {
    const job = sendQueue.shift();
    try {
      await twilioClient.messages.create({
        from: process.env.ALEX_PHONE_NUMBER,
        to: job.to,
        body: job.message
      });
      console.log('Alex queued message sent to ' + job.to + ' (' + sendQueue.length + ' remaining)');
    } catch (error) {
      console.error('Alex failed to send to ' + job.to + ': ' + error.message);
    }
    await new Promise(resolve => setTimeout(resolve, 1200));
  }
  isSendingQueue = false;
  console.log('Alex send queue complete');
}

async function generateSummary(conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const summaryResponse = await anthropic.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 300,
    system: 'You are a helpful assistant that summarises real estate enquiry conversations into a brief professional summary for a real estate agent. Extract and clearly list: the clients name, their mobile number, their email address if provided, the property address if provided, the suburb of interest, property type, their plans (selling, buying, renting, renovating, just exploring), their timeline, whether they have dealt with Stone or Doepel Lilley and Taylor before, and any other relevant details. Keep it concise and easy to scan. Use plain text with no markdown.',
    messages: [
      {
        role: 'user',
        content: 'Please summarise this property enquiry conversation:\n\n' + conversationText
      }
    ]
  });

  return summaryResponse.content[0].text;
}

function extractDetails(conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) { return msg.content; })
    .join(' ');

  const nameMatch = conversationText.match(/my name is ([A-Za-z]+)/i) ||
                    conversationText.match(/I am ([A-Za-z]+)/i) ||
                    conversationText.match(/this is ([A-Za-z]+)/i);

  const emailMatch = conversationText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  const suburbList = ['Ballarat Central', 'Ballarat East', 'Ballarat North', 'Wendouree', 'Sebastopol', 'Alfredton', 'Delacombe', 'Mount Clear', 'Lake Gardens', 'Lake Wendouree', 'Soldiers Hill', 'Buninyong', 'Mount Helen', 'Invermay Park', 'Smythes Creek', 'Canadian', 'Mitchell Park', 'Brown Hill', 'Nerrina', 'Newington', 'Black Hill', 'Redan', 'Winter Valley', 'Cardigan', 'Sulky', 'Bald Hills', 'Bunkers Hill', 'Mount Rowan', 'Nintingbool', 'Cambrian Hill', 'Miners Rest', 'Magpie', 'Scotsburn', 'Durham Lead', 'Haddon', 'Smythesdale', 'Snake Valley', 'Grenville', 'Garibaldi', 'Mount Mercer', 'Lal Lal', 'Clarendon', 'Yendon', 'Leigh Creek', 'Clarkes Hill', 'Dunnstown', 'Bungaree', 'Warrenheip', 'Wallace', 'Gordon', 'Millbrook', 'Dean', 'Wattle Flat', 'Glen Park', 'Invermay', 'Enfield', 'Dereel', 'Mount Doran', 'Elaine', 'Creswick', 'Addington', 'Learmonth', 'Blowhard'];

  let suburb = null;
  for (let i = 0; i < suburbList.length; i++) {
    if (conversationText.toLowerCase().includes(suburbList[i].toLowerCase())) {
      suburb = suburbList[i];
      break;
    }
  }

  return {
    name: nameMatch ? nameMatch[1] : null,
    email: emailMatch ? emailMatch[0] : null,
    suburb: suburb
  };
}

async function sendEmail(subject, htmlContent) {
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + process.env.RESEND_API_KEY,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: 'Stone SMS Bot <onboarding@resend.dev>',
      to: 'stu@briens.com.au',
      subject: subject,
      html: htmlContent
    })
  });

  if (response.ok) {
    console.log('Alex email sent: ' + subject);
  } else {
    console.error('Alex failed to send email:', await response.text());
  }
}

async function sendLeadEmail(fromNumber, conversationHistory, agentName) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const summary = await generateSummary(conversationHistory);
  const details = extractDetails(conversationHistory);

  await createPipedriveContact(
    details.name,
    fromNumber,
    details.email,
    details.suburb,
    summary
  );

  await sendEmail(
    'New Property Enquiry - Alex - ' + fromNumber,
    '<h2>New Property Enquiry</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Assigned Agent:</strong> ' + (agentName || 'Stu Brien') + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<h3>Summary</h3>' +
    '<div style="background:#e8f4e8;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + summary.replace(/\n/g, '<br>') + '</div>' +
    '<br>' +
    '<h3>Full Conversation Transcript</h3>' +
    '<pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + conversationText + '</pre>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Property Guide Bot</p>'
  );
}

async function sendSubscriberEmail(fromNumber, conversationHistory) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const emailMatch = conversationText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  const capturedEmail = emailMatch ? emailMatch[0] : 'Not found in transcript';

  await sendEmail(
    'New Market Update Subscriber - Alex - ' + fromNumber,
    '<h2>New Market Update Subscriber</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Email Address:</strong> ' + capturedEmail + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has requested to receive Ballarat property market updates. Please add them to your email marketing list.</p>' +
    '<hr>' +
    '<h3>Full Conversation Transcript</h3>' +
    '<pre style="background:#f4f4f4;padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + conversationText + '</pre>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Property Guide Bot</p>'
  );
}

async function sendOptOutEmail(fromNumber) {
  await sendEmail(
    'Opt Out - Alex - ' + fromNumber,
    '<h2>Contact Has Opted Out</h2>' +
    '<p><strong>Phone Number:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<p>This contact has opted out of the Alex campaign and has been removed from the active conversation list.</p>' +
    '<p style="color:#cc0000;"><strong>Please ensure this number is removed from any future campaigns.</strong></p>' +
    '<hr>' +
    '<p style="color:#888;font-size:12px;">Sent by Stone Real Estate Alex Property Guide Bot</p>'
  );
}

module.exports = function(app) {

  app.post('/campaign', async function(req, res) {
    const From = req.body.From;
    const Body = req.body.Body;
    console.log('Alex incoming from ' + From + ': ' + Body);

    if (['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'].includes(Body.trim().toUpperCase())) {
      optedOut[From] = true;
      delete conversations[From];
      delete leadDetected[From];
      delete bookingDetected[From];
      await sendOptOutEmail(From);
      console.log('Alex opt out received from ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (optedOut[From]) {
      console.log('Alex blocked message from opted out number ' + From);
      return res.type('text/xml').send('<Response></Response>');
    }

    if (!conversations[From]) {
      conversations[From] = [];
      leadDetected[From] = false;
      bookingDetected[From] = false;
    }

    conversations[From].push({ role: 'user', content: Body });

    if (conversations[From].length > 20) {
      conversations[From] = conversations[From].slice(-20);
    }

    const agentKey = conversations[From].agentKey || 'stu';
    const agentData = AGENT_DATA[agentKey] || AGENT_DATA.stu;

    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        system: SYSTEM_PROMPT,
        messages: conversations[From]
      });

      let reply = response.content[0].text;

      if (reply.includes('[INFORMATION FORWARDED]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace(/\[INFORMATION FORWARDED\]/g, '').trim();
        await sendLeadEmail(From, conversations[From], agentData.name);
      }

      if (reply.includes('[REQUEST RECEIVED]') && !bookingDetected[From]) {
        bookingDetected[From] = true;
        reply = reply.replace(/\[REQUEST RECEIVED\]/g, '').trim();
        await sendSubscriberEmail(From, conversations[From]);
      }

      conversations[From].push({ role: 'assistant', content: reply });
      console.log('Alex reply to ' + From + ': ' + reply);

      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message(reply);
      res.type('text/xml').send(twiml.toString());

    } catch (error) {
      console.error('Alex error:', error);
      const twiml = new twilio.twiml.MessagingResponse();
      twiml.message('Sorry, having a technical issue right now. Please call us during business hours and we will be happy to help.');
      res.type('text/xml').send(twiml.toString());
    }
  });

  app.post('/campaign-send', async function(req, res) {
    const rawName = req.body.name || req.body['First Name'] || req.body.first_name || '';
    const name = rawName.trim().split(/\s+/)[0];
    const to = req.body.to || req.body.To;
    const message = req.body.message || req.body.Message;
    const agentKey = req.body.agent || 'stu';

    if (!to || !message) {
      return res.status(400).json({ error: 'to and message are required' });
    }

    if (optedOut[to]) {
      console.log('Alex skipped opted out number ' + to);
      return res.json({ success: false, message: to + ' has opted out' });
    }

    conversations[to] = [
      { role: 'user', content: 'My name is ' + (name || 'there') },
      { role: 'assistant', content: message }
    ];
    conversations[to].agentKey = agentKey;
    leadDetected[to] = false;
    bookingDetected[to] = false;

    sendQueue.push({ to: to, message: message });
    processQueue();

    console.log('Alex queued message for ' + to);
    res.json({ success: true, message: 'Message queued for ' + to });
  });

  app.get('/campaign', function(req, res) {
    res.send('Alex campaign endpoint is ready!');
  });

};
