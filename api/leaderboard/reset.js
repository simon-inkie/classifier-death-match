// Vercel Function: POST /api/leaderboard/reset (needs ARENA_ADMIN_TOKEN). The logic lives in lib/hosted.js.
import { handler } from '../../lib/hosted.js';
export default handler('reset');
