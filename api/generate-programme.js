export default async function handler(req, res) {
  // CORS headers on every response
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Handle preflight
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body;
    const type = body.type || 'generate';

    // ── CHAT MODE ──────────────────────────────────────────────────────────────
    if (type === 'chat') {
      const { systemPrompt, messages } = body;

      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          system: systemPrompt,
          messages: messages
        })
      });

      const data = await response.json();
      const replyText = data.content
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('');

      return res.status(200).json({ coachReply: replyText });
    }

    // ── GENERATE MODE (original) ───────────────────────────────────────────────
    const { quizAnswers } = body;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4000,
        messages: [
          {
            role: 'user',
            content: `You are a professional fitness coach. Based on the following quiz answers, generate a personalised workout programme. Return ONLY a JSON object with no markdown or extra text.
Quiz answers:
- Primary goal: ${quizAnswers['primary-goal'] || 'not specified'}
- Experience level: ${quizAnswers['experience-level'] || 'not specified'}
- Days per week available to train: ${quizAnswers['days-per-week'] || 'not specified'}
- Session duration: ${quizAnswers['session-duration'] || 'not specified'}
- Equipment available: ${quizAnswers['equipment'] || 'not specified'}${quizAnswers['equipment-other'] ? ` (specifically: ${quizAnswers['equipment-other']} — ONLY use exercises that can be done with this equipment, nothing else)` : ''}
- Does outside activity outside gym: ${quizAnswers['outside-activity'] || 'No'}
- Hours of outside activity per week: ${quizAnswers['activity-hours'] || 'none'}
- Sports played (these affect fatigue and volume, do NOT treat as injuries): ${Object.keys(quizAnswers.checkboxes || {}).filter(k => k.startsWith('sport')).join(', ') || 'none'}${quizAnswers['sport-other-text'] ? ` (specifically: ${quizAnswers['sport-other-text']})` : ''}
- Current fatigue level: ${quizAnswers['fatigue-level'] || 'not specified'}
- Academic busyness: ${quizAnswers['academic-busy'] || 'not specified'}
- Has injuries: ${quizAnswers['injured'] || 'No'}
- INJURIES (avoid exercises that stress these areas): ${Object.keys(quizAnswers.checkboxes || {}).filter(k => k.startsWith('injury')).join(', ') || 'none'}
- Additional injury details (strictly avoid any exercises mentioned here): ${quizAnswers['injury-other-text'] || 'none'}
- MUSCLE GROUPS TO PRIORITISE (do slightly MORE volume for these muscles and train them earlier in the session, not avoid them): ${Object.keys(quizAnswers.checkboxes || {}).filter(k => k.startsWith('muscle')).join(', ') || 'none'}
- Exercises to avoid: ${quizAnswers['avoid-exercises'] || 'none'}
Important rules:
- INJURIES mean avoid or modify exercises for that body part
- MUSCLE GROUPS TO PRIORITISE mean do slightly MORE volume for those muscles (and train them earlier in the session), not avoid them
- If a specific exercise is listed in avoid-exercises, never include it
Return this exact JSON structure:
{
  "planTitle": "Programme name",
  "planSubtitle": "Short description",
  "weeks": 8,
  "sessionsPerWeek": 3,
  "sessionDuration": 45,
  "coachNote": "Personalised note to the user",
  "workouts": [
    {
      "week": 1,
      "day": "Monday",
      "sessionTitle": "Session name",
      "exercises": [
        {
          "name": "Exercise name",
          "sets": 3,
          "reps": "8-10",
          "rest": "60s",
          "notes": "Form tip"
        }
      ]
    }
  ]
}`
          }
        ]
      })
    });

    const data = await response.json();
    const text = data.content[0].text;
    const clean = text.replace(/```json|```/g, '').trim();
    const programme = JSON.parse(clean);
    return res.status(200).json(programme);

  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ error: 'Failed to generate programme' });
  }
}
