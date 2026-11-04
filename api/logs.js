// Vercel Function: GET /api/logs (bundled examples), POST /api/logs (not stored). The logic lives in lib/hosted.js.
import { handler } from '../lib/hosted.js';
export default handler('logs');
