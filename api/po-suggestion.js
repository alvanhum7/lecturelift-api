export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(200).end();
    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  
    const { exerciseName, history, targetSets, targetReps } = req.body;
  
    const prompt = `You are a strength coach giving a progressive overload suggestion.
  
  Exercise: ${exerciseName}
  Target: ${targetSets} sets of ${targetReps} reps
  Recent history (most recent first):
  ${history.length > 0 ? history.map((h, i) => `- Session ${i + 1}: ${h.weight}kg × ${h.reps} reps × ${h.sets} sets`).join('\n') : '- No history yet'}
  
  Respond ONLY with a JSON object, no markdown, no extra text:
  {"weight": <number in kg>, "reps": <number>, "rir": <number 0-3>, "reason": "<one concise sentence>"}`;
  
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });
  
    const data = await response.json();
    const text = data.content?.[0]?.text || '';
  
    try {
      const suggestion = JSON.parse(text);
      return res.status(200).json(suggestion);
    } catch {
      return res.status(500).json({ error: 'Failed to parse response', raw: text });
    }
  }