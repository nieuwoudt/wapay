export default function handler(req, res) {
  res.status(200).json({ 
    ok: true, 
    message: 'WaPay Health Check - Working!',
    timestamp: new Date().toISOString(),
    method: req.method,
    url: req.url
  });
}
