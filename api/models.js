// Vercel Function: GET /api/models (model picker, behind ENABLE_MODEL_PICKER). The logic lives in lib/hosted.js.
import { handler } from '../lib/hosted.js';
export default handler('models');
