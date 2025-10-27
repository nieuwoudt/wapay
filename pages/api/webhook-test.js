export default function handler(req, res) {
  if (req.method === 'GET') {
    const challenge = req.query['hub.challenge'];
    if (challenge) {
      return res.status(200).send(challenge);
    }
    return res.status(200).json({ 
      ok: true, 
      message: 'Webhook test endpoint', 
      method: 'GET' 
    });
  }
  
  return res.status(200).json({ 
    ok: true, 
    message: 'Webhook received',
    method: req.method 
  });
}

