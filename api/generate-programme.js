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
    const { quizAnswers } = req.body;

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

Quiz answers: ${JSON.stringify(quizAnswers)}

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
