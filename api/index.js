// Simple test endpoint to verify Vercel is working
export default function handler(req, res) {
  res.status(200).json({ 
    ok: true, 
    message: 'WaPay API is alive!',
    timestamp: new Date().toISOString()
  });
}

