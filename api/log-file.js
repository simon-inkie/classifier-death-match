// Vercel Function: GET /logs/<name> via a rewrite, bundled examples only. The logic lives in lib/hosted.js.
import { handler } from '../lib/hosted.js';
export default handler('logFile');
