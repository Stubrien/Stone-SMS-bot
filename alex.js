const Anthropic = require('@anthropic-ai/sdk');
const twilio = require('twilio');

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);

const conversations = {};
const leadDetected = {};
const optedOut = {};
const sendQueue = [];
let isSendingQueue = false;

const PIPEDRIVE_API_KEY = process.env.PIPEDRIVE_API_KEY;
const PIPEDRIVE_PIPELINE_ID = 5;

const STAGES = {
  APPRAISAL_REQUESTED: 45,
  CONTACT_REQUEST: 44,
  MARKET_REPORT: 48,
  EARLY_INTEREST: 49
};

const AGENT_DATA = {
  stu: { name: 'Stu Brien' },
  rob: { name: 'Rob Cunningham' },
  leigh: { name: 'Leigh Hutchinson' },
  jamie: { name: 'Jamie Gepp' },
  jarrod: { name: 'Jarrod Kemp' }
};

const TEAM_INFO = "STONE REAL ESTATE BALLARAT TEAM: Stu Brien - Principal and Licensed Real Estate Agent - 0416 183 566 - stubrien@stonerealestate.com.au. Rob Cunningham - Sales Agent - 0418 543 634 - robertcunningham@stonerealestate.com.au. Leigh Hutchinson - Residential Sales Agent - 0407 861 960 - leighhutchinson@stonerealestate.com.au. Jamie Gepp - Sales Agent - 0459 201 710 - jamiegepp@stonerealestate.com.au. Jarrod Kemp - Residential Sales Agent - 0450 836 257 - jarrodkemp@stonerealestate.com.au. Fiona Hart - Sales Associate - 0412 185 313 - fionahart@stonerealestate.com.au. Linda Turk - Senior Property Manager - 0414 287 337 - lindaturk@stonerealestate.com.au. Josh Shanahan - Property Manager - 0491 118 698 - joshshanahan@stonerealestate.com.au. Aneya Coates - Assistant Property Manager - 0421 583 782 - aneyacoates@stonerealestate.com.au. Full team page: https://www.stonerealestate.com.au/stone-ballarat/meet-team/";

const COMPANY_HISTORY = "ABOUT STONE REAL ESTATE BALLARAT: Stone Real Estate Ballarat was formed when Doepel Lilley and Taylor - one of Ballarat's most trusted and long standing real estate agencies - joined the Stone Real Estate network. Doepel Lilley and Taylor was founded in 1888 when Stock West and Co. opened on Lydiard Street South, making it one of the oldest real estate businesses in regional Victoria. Through the 1934 partnership of Doepel, Lilley and Taylor the firm became a Ballarat institution, helping generations of families buy, sell, rent and invest across more than 130 years. In joining Stone Real Estate - a modern Australian brand with over 70 offices nationally - the business combined deep local roots and community trust with modern marketing tools, smart data and national exposure. The same faces, the same personal service, the same connection to Ballarat - now empowered by Stone technology and national strength.";

const SUBURB_DATA = "BALLARAT AND GREATER REGION MARKET GUIDE (use only as general context - never as a formal valuation): BALLARAT SUBURBS: Ballarat Central: median house ~$650,000, units ~$380,000, strong inner city demand, heritage character homes popular. Ballarat East: median house ~$494,000, affordable entry point, good rental demand, improving infrastructure. Ballarat North: median house ~$540,000, family friendly, close to amenities. Wendouree: median house ~$510,000, units ~$300,000, strong growth up ~20% past 12 months, lake proximity adds premium. Sebastopol: median house ~$496,000, up ~20% past 12 months, affordable with good growth, popular with first home buyers. Alfredton: median house ~$625,000, newer estates, family oriented, strong demand from young families. Delacombe: median house ~$530,000, newer development area, growing infrastructure, popular with families. Mount Clear: median house ~$606,000, up ~19% past 12 months, established suburb, good schools nearby. Lake Gardens: median house ~$680,000, prestige location, lake views command premium. Lake Wendouree: median house ~$883,000, Ballarat prestige suburb, heritage homes, strong long term capital growth. Soldiers Hill: median house ~$555,000, character homes, popular with renovators and owner occupiers. Buninyong: median house ~$750,000, highly sought after lifestyle suburb, strong demand, limited stock. Mount Helen: median house ~$658,000, university precinct, strong rental demand, good for investors. Invermay Park: median house ~$670,000, established and tightly held, good long term growth. Smythes Creek: median house ~$580,000, semi rural lifestyle, acreage properties popular. Canadian: median house ~$540,000, family suburb, good value for size. Mitchell Park: median house ~$510,000, affordable entry into established area. Brown Hill: median house ~$640,000, character homes, popular lifestyle suburb. Nerrina: median house ~$803,000, semi rural, lifestyle properties, tightly held. Newington: median house ~$616,000, established family suburb. Black Hill: median house ~$559,000, character homes, popular with renovators. Redan: median house ~$491,000, up ~19% past 12 months, affordable, improving amenity. Winter Valley: median house ~$574,000, family suburb, good value. Cardigan and Cardigan Village: semi rural residential, lifestyle appeal, close to Ballarat amenities. Sulky: semi rural, larger blocks. Bald Hills: rural residential, acreage lifestyle. Bunkers Hill: semi rural, established. Mount Rowan: semi rural, established. Nintingbool: rural lifestyle, larger properties. Cambrian Hill: rural residential. Miners Rest: median house ~$520,000, growing suburb, popular with families, good value. GREATER BALLARAT REGION (rural and semi rural - discuss as lifestyle and land value): Magpie, Scotsburn, Durham Lead, Scotchmans Lead, Napoleons, Ross Creek, Haddon, Smythesdale, Snake Valley, Grenville, Garibaldi, Mount Mercer, Lal Lal, Clarendon, Yendon, Leigh Creek, Pootila, Clarkes Hill, Dunnstown, Bungaree, Warrenheip, Wallace, Gordon, Millbrook, Dean, Wattle Flat, Glen Park, Invermay, Enfield, Dereel, Mount Doran, Elaine, Creswick, Addington, Learmonth, Blowhard.";

const VALUE_FACTORS = "PROPERTY VALUE FACTORS - only raise when directly relevant, do not repeat factors already discussed: Bedrooms - each additional bedroom adds value, 4 bed commands solid premium over 3 bed. Bathrooms - second bathroom adds strong value. Updated kitchen - high ROI renovation. Updated bathrooms - strong buyer appeal. Double garage - highly valued in Ballarat climate. Block size - larger blocks command premium in established suburbs. Aspect - north or east facing adds value. Street appeal - first impressions matter significantly. School zones - add measurable premium in family suburbs. Proximity to amenities - walkability increasingly valued. Outdoor entertaining - adds lifestyle appeal. Renovation quality - high quality finishes outperform budget work. For rural properties: usable land, water access, shedding and infrastructure all add value. Negative factors: busy road location, dated kitchen and bathrooms, no garage, deferred maintenance, asbestos or older construction materials, poor floor plan.";

const SYSTEM_PROMPT = "You are Alex, a friendly and knowledgeable property guide working with Stone Real Estate Ballarat. You help people with genuine property questions across Ballarat and the greater surrounding region. Think of yourself as a knowledgeable local friend - not a salesperson. " + COMPANY_HISTORY + " " + TEAM_INFO + " ABOUT US: Stone Real Estate Ballarat. Address: 44 Armstrong St South, Ballarat Central (corner of Dana St). Phone: (03) 5331 2000. Website: https://www.stonerealestate.com.au/stone-ballarat/. Hours: Monday to Friday, 9am to 5pm AEST (closed public holidays). YOUR PERSONALITY AND TONE - THIS IS CRITICAL: You are warm, direct and genuinely helpful. You sound like a knowledgeable local friend - not a real estate brochure. STRICT TONE RULES: 1. Never begin any response with affirmations like: Great, Good question, Absolutely, Certainly, Of course, No worries, Happy to help, Sounds good, Definitely, For sure, Smart approach, Good thinking, Wise decision, Perfect, Wonderful. Just get straight to the point. 2. Never validate a decision the person has already made. 3. Only describe a suburb ONCE per conversation - do not repeat its features in subsequent messages. 4. Only mention market context when it is directly new and relevant. 5. Ask only ONE question per response - never stack multiple questions. 6. Keep responses to 2 to 3 sentences maximum - this is SMS. YOUR THREE GOALS IN ORDER OF PRIORITY: You have three goals with every conversation. Work towards them naturally in this order - never be pushy about any of them. CRITICAL RULE BEFORE ANY TAG: Before adding ANY tag you must have the persons first name. If you do not know their name yet, always ask: Just so the team knows who to follow up with, what is your first name? Wait for their reply before adding any tag. Never skip this step under any circumstances. GOAL 1 - APPRAISAL: Your primary goal is to arrange a free property appraisal. When someone has a property and seems open to understanding its value, naturally guide toward offering a free appraisal. To complete this goal you need: their first name AND their full property address including street number, street name and suburb. Once you have both say something like: Thanks [name], I will pass that on to the team and arrange for someone to be in touch about a free appraisal. Then on a completely new line add exactly: [APPRAISAL REQUESTED]. GOAL 2 - AGENT CONTACT: If someone is not ready for an appraisal but wants to talk to someone, offer to have an agent contact them. You need their first name and confirmation they want to be contacted. Once confirmed say: I will pass that on and someone will be in touch during business hours. Then on a completely new line add exactly: [CONTACT REQUEST]. GOAL 3 - MARKET REPORT: If someone is not ready for an appraisal or agent contact but is still interested, offer a free Ballarat property market report. You need their first name and email address. Once you have both say: I will get that sent out to you. Then on a completely new line add exactly: [MARKET REPORT]. EARLY INTEREST - NO ACTION: If someone has shared information but is not interested in any of the three goals above, wrap up warmly. You still need their first name before adding this tag. Then on a completely new line add exactly: [EARLY INTEREST]. IMPORTANT RULES FOR ALL TAGS: All tags must be on their own completely separate line. Tags must never be visible to the client. Each tag fires only once per conversation. Never add a tag until you have the persons first name confirmed. INTRODUCTION: Say something like: Hi there, I am Alex - a property guide with Stone Real Estate Ballarat. What can I help you with today? WHAT YOU CAN HELP WITH: General property market questions for Ballarat and the greater region. Suburb information - trends, demand, median prices as general context. What factors add or reduce property value. Advice on buying, selling, renting or renovating. Investment property questions. First home buyer questions. Relocation questions. Company history and background. " + SUBURB_DATA + " " + VALUE_FACTORS + " HOW TO DISCUSS PRICES: Share suburb median prices as general context only. Always include this disclaimer when discussing prices: Just to be clear these figures are a general guide based on recent market activity and should not be taken as a formal valuation - every property is unique and the only way to get an accurate figure is a free appraisal with one of our agents. Never give a specific valuation for a persons property. CONNECTING WITH AN AGENT: When someone wants to speak to an agent, first ask if they have dealt with anyone from our team or Doepel Lilley and Taylor before. If they name someone match them to that agent. If not share the team page: https://www.stonerealestate.com.au/stone-ballarat/meet-team/ or mention Stu Brien is the principal - 0416 183 566. GETTING DETAILS NATURALLY: Never ask for name or address early in the conversation. Only collect details when it feels natural and the person is clearly engaged. When collecting the address make sure you get the full address including street number - not just the suburb. RULES: Keep every reply to 2 to 3 sentences maximum. Never start with a positive affirmation. Never use exclamation marks unless genuinely warranted. Never make specific price promises or formal valuations. Always include disclaimer when discussing prices. Never mention you are an AI unless directly asked. After hours let them know the office is open Mon to Fri 9am to 5pm.";

async function createPipedriveRecord(name, phone, email, address, suburb, summary, stageId) {
  console.log('Pipedrive: Starting record creation');
  console.log('Pipedrive: Name=' + name + ' Phone=' + phone + ' Stage=' + stageId);
  console.log('Pipedrive: API Key present=' + (PIPEDRIVE_API_KEY ? 'yes - length ' + PIPEDRIVE_API_KEY.length : 'NO KEY FOUND'));

  try {
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

    console.log('Pipedrive: Person status=' + personResponse.status);
    const personData = await personResponse.json();

    if (!personData.success) {
      console.error('Pipedrive person failed:', JSON.stringify(personData));
      return;
    }

    const personId = personData.data.id;
    console.log('Pipedrive contact created: ' + personId);

    const dealTitle = (name && name !== 'Unknown' ? name : 'Unknown') + ' - ' + (address || suburb || 'Ballarat Region');

    const dealResponse = await fetch('https://api.pipedrive.com/v1/deals', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-token': PIPEDRIVE_API_KEY
      },
      body: JSON.stringify({
        title: dealTitle,
        person_id: personId,
        pipeline_id: PIPEDRIVE_PIPELINE_ID,
        stage_id: stageId
      })
    });

    console.log('Pipedrive: Deal status=' + dealResponse.status);
    const dealData = await dealResponse.json();

    if (!dealData.success) {
      console.error('Pipedrive deal failed:', JSON.stringify(dealData));
      return;
    }

    const dealId = dealData.data.id;
    console.log('Pipedrive deal created: ' + dealId);

    const noteContent = 'Alex Campaign Lead\n\nProperty Address: ' + (address || 'Not provided') + '\nSuburb: ' + (suburb || 'Unknown') + '\nEmail: ' + (email || 'Not provided') + '\n\n' + summary;

    await fetch('https://api.pipedrive.com/v1/notes', {
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

    console.log('Pipedrive note added for deal: ' + dealId);

  } catch (error) {
    console.error('Pipedrive error: ' + error.message);
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
    system: 'You are a helpful assistant that summarises real estate enquiry conversations into a brief professional summary for a real estate agent. Extract and clearly list: the clients name, their mobile number, their email address if provided, the full property address if provided, the suburb of interest, property type, their plans (selling, buying, renting, renovating, just exploring), their timeline, whether they have dealt with Stone or Doepel Lilley and Taylor before, and any other relevant details. Keep it concise and easy to scan. Use plain text with no markdown.',
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
  const clientMessages = conversationHistory
    .filter(function(msg) { return msg.role === 'user'; })
    .map(function(msg) { return msg.content; })
    .join(' ');

  const allText = conversationHistory
    .map(function(msg) { return msg.content; })
    .join(' ');

  const emailMatch = allText.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);

  const suburbList = ['Ballarat Central', 'Ballarat East', 'Ballarat North', 'Wendouree', 'Sebastopol', 'Alfredton', 'Delacombe', 'Mount Clear', 'Lake Gardens', 'Lake Wendouree', 'Soldiers Hill', 'Buninyong', 'Mount Helen', 'Invermay Park', 'Smythes Creek', 'Canadian', 'Mitchell Park', 'Brown Hill', 'Nerrina', 'Newington', 'Black Hill', 'Redan', 'Winter Valley', 'Cardigan', 'Sulky', 'Bald Hills', 'Bunkers Hill', 'Mount Rowan', 'Nintingbool', 'Cambrian Hill', 'Miners Rest', 'Magpie', 'Scotsburn', 'Durham Lead', 'Haddon', 'Smythesdale', 'Snake Valley', 'Grenville', 'Garibaldi', 'Mount Mercer', 'Lal Lal', 'Clarendon', 'Yendon', 'Leigh Creek', 'Clarkes Hill', 'Dunnstown', 'Bungaree', 'Warrenheip', 'Wallace', 'Gordon', 'Millbrook', 'Dean', 'Wattle Flat', 'Glen Park', 'Invermay', 'Enfield', 'Dereel', 'Mount Doran', 'Elaine', 'Creswick', 'Addington', 'Learmonth', 'Blowhard'];

  let suburb = null;
  for (let i = 0; i < suburbList.length; i++) {
    if (clientMessages.toLowerCase().includes(suburbList[i].toLowerCase())) {
      suburb = suburbList[i];
      break;
    }
  }

  const addressMatch = clientMessages.match(/\d+\s+[A-Za-z]+(\s+[A-Za-z]+)?\s+(Street|St|Road|Rd|Avenue|Ave|Drive|Dr|Court|Ct|Place|Pl|Lane|Ln|Way|Crescent|Cres|Boulevard|Blvd|Terrace|Tce|Close|Cl|Highway|Hwy|Parade|Pde)/i);

  const namePatterns = [
    /my name is ([A-Za-z]+)/i,
    /i am ([A-Za-z]+)/i,
    /this is ([A-Za-z]+)/i,
    /call me ([A-Za-z]+)/i
  ];

  let name = null;
  for (let i = 0; i < namePatterns.length; i++) {
    const match = clientMessages.match(namePatterns[i]);
    if (match) {
      name = match[1];
      break;
    }
  }

  if (!name) {
    const assistantMessages = conversationHistory
      .filter(function(msg) { return msg.role === 'assistant'; });
    const userMessages = conversationHistory
      .filter(function(msg) { return msg.role === 'user'; });

    for (let i = 0; i < assistantMessages.length; i++) {
      const assistantText = assistantMessages[i].content.toLowerCase();
      if (assistantText.includes('first name') || assistantText.includes('who to follow up') || assistantText.includes('who to ask for')) {
        const nextUserIndex = conversationHistory.indexOf(assistantMessages[i]) + 1;
        if (conversationHistory[nextUserIndex] && conversationHistory[nextUserIndex].role === 'user') {
          const possibleName = conversationHistory[nextUserIndex].content.trim();
          if (possibleName.length > 0 && possibleName.length < 25 && /^[A-Za-z\s]+$/.test(possibleName)) {
            name = possibleName.split(' ')[0];
            break;
          }
        }
      }
    }
  }

  return {
    name: name,
    email: emailMatch ? emailMatch[0] : null,
    suburb: suburb,
    address: addressMatch ? addressMatch[0] : null
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
    console.error('Alex email failed:', await response.text());
  }
}

async function handleOutcome(tag, fromNumber, conversationHistory, agentName) {
  const conversationText = conversationHistory
    .map(function(msg) {
      return (msg.role === 'user' ? 'Client' : 'Alex') + ': ' + msg.content;
    })
    .join('\n\n');

  const summary = await generateSummary(conversationHistory);
  const details = extractDetails(conversationHistory);

  const name = details.name || 'Unknown';
  const email = details.email;
  const suburb = details.suburb;
  const address = details.address;

  let stageId;
  let emailSubject;
  let emailHeading;
  let emailColour;

  if (tag === 'APPRAISAL_REQUESTED') {
    stageId = STAGES.APPRAISAL_REQUESTED;
    emailSubject = 'Appraisal Requested - ' + name + ' - ' + fromNumber;
    emailHeading = 'Appraisal Requested';
    emailColour = '#e8f4e8';
  } else if (tag === 'CONTACT_REQUEST') {
    stageId = STAGES.CONTACT_REQUEST;
    emailSubject = 'Contact Request - ' + name + ' - ' + fromNumber;
    emailHeading = 'Agent Contact Requested';
    emailColour = '#e8f0f4';
  } else if (tag === 'MARKET_REPORT') {
    stageId = STAGES.MARKET_REPORT;
    emailSubject = 'Market Report - ' + name + ' - ' + fromNumber;
    emailHeading = 'Market Report Request';
    emailColour = '#f4f0e8';
  } else if (tag === 'EARLY_INTEREST') {
    stageId = STAGES.EARLY_INTEREST;
    emailSubject = 'Early Interest - ' + name + ' - ' + fromNumber;
    emailHeading = 'Early Interest - No Action Taken';
    emailColour = '#f4f4f4';
  }

  await createPipedriveRecord(name, fromNumber, email, address, suburb, summary, stageId);

  await sendEmail(
    emailSubject,
    '<h2>' + emailHeading + '</h2>' +
    '<p><strong>Client Phone:</strong> ' + fromNumber + '</p>' +
    '<p><strong>Client Name:</strong> ' + name + '</p>' +
    '<p><strong>Property Address:</strong> ' + (address || 'Not provided') + '</p>' +
    '<p><strong>Suburb:</strong> ' + (suburb || 'Not provided') + '</p>' +
    '<p><strong>Email:</strong> ' + (email || 'Not provided') + '</p>' +
    '<p><strong>Assigned Agent:</strong> ' + (agentName || 'Stu Brien') + '</p>' +
    '<p><strong>Time:</strong> ' + new Date().toLocaleString('en-AU', { timeZone: 'Australia/Melbourne' }) + '</p>' +
    '<hr>' +
    '<h3>Summary</h3>' +
    '<div style="background:' + emailColour + ';padding:15px;border-radius:5px;font-family:sans-serif;font-size:14px;line-height:1.6;">' + summary.replace(/\n/g, '<br>') + '</div>' +
    '<br>' +
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
    '<p>This contact has opted out and has been removed from the active conversation list.</p>' +
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

  if (Body.trim().toUpperCase() === 'RESET') {
  delete conversations[From];
  delete leadDetected[From];
  console.log('Conversation reset for ' + From);
  return res.type('text/xml').send('<Response></Response>');
}
    if (['STOP', 'UNSUBSCRIBE', 'QUIT', 'CANCEL', 'END'].includes(Body.trim().toUpperCase())) {
      optedOut[From] = true;
      delete conversations[From];
      delete leadDetected[From];
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

      if (reply.includes('[APPRAISAL REQUESTED]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace(/\[APPRAISAL REQUESTED\]/g, '').trim();
        await handleOutcome('APPRAISAL_REQUESTED', From, conversations[From], agentData.name);
      } else if (reply.includes('[CONTACT REQUEST]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace(/\[CONTACT REQUEST\]/g, '').trim();
        await handleOutcome('CONTACT_REQUEST', From, conversations[From], agentData.name);
      } else if (reply.includes('[MARKET REPORT]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace(/\[MARKET REPORT\]/g, '').trim();
        await handleOutcome('MARKET_REPORT', From, conversations[From], agentData.name);
      } else if (reply.includes('[EARLY INTEREST]') && !leadDetected[From]) {
        leadDetected[From] = true;
        reply = reply.replace(/\[EARLY INTEREST\]/g, '').trim();
        await handleOutcome('EARLY_INTEREST', From, conversations[From], agentData.name);
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

    sendQueue.push({ to: to, message: message });
    processQueue();

    console.log('Alex queued message for ' + to);
    res.json({ success: true, message: 'Message queued for ' + to });
  });

  app.get('/campaign', function(req, res) {
    res.send('Alex campaign endpoint is ready!');
  });

};
