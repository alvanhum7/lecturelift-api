export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { exerciseName, history = [], targetSets, targetReps } = req.body || {};
    if (!exerciseName) return res.status(400).json({ error: 'exerciseName required' });

    const recent = history.length
      ? history.map((h, i) => `${i + 1}. ${h.weight} x ${h.reps} reps` + (h.rir !== undefined && h.rir !== '' ? `, RIR ${h.rir}` : '')).join('\n')
      : 'No history yet.';

    const prompt = `You are a strength coach giving one progressive overload suggestion.
Exercise: ${exerciseName}
Target: ${targetSets || 3} sets of ${targetReps || 8} reps
Recent sets, most recent first:
${recent}

Rules:
- Use the same unit as the history weights. Do not convert.
- Double progression: if the lifter reached the top of the rep range with at least 2 reps in reserve, raise the weight by the smallest sensible jump (about 2.5% to 5%, rounded to a loadable number) and aim for the bottom of the rep range. Otherwise keep the weight and aim for more reps, up to the top of the range.
- If RIR is missing, assume 2.
- If there is no history, set weight to null, reps to the lower end of the target range as a number, rir to 2, and tell them to pick a weight they can lift for that many reps with about 2 in reserve.
- reps must be a number. rir must be a string: either a single value like "2", or a narrow range like "0-1" or "1-2" (values 0 to 4, never more than 2 apart). Use a range when the suggestion asks for a jump up in weight or the lifter's recent RIR was inconsistent, and a single value when they should stay steady. reason at most 14 words.
Return ONLY this JSON, no markdown: {"weight": number or null, "reps": number, "rir": "string", "reason": "short reason"}
`;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 300,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    const text = (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
    const clean = text.replace(/```json|```/g, '').trim();
    const out = JSON.parse(clean);

    return res.status(200).json({
      weight: out.weight === undefined ? null : out.weight,
      reps: out.reps,
      rir: String(out.rir),
      reason: out.reason || ''
    });
  } catch (error) {
    console.error('po-suggestion error:', error);
    return res.status(500).json({ error: 'Failed to generate suggestion' });
  }
}
