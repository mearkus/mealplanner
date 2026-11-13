import { openDb } from './db.js';
import { createApp } from './app.js';
import { authEnabled } from './auth.js';
import { aiEnabled } from './ai.js';

openDb();
const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`Meal planner running on http://localhost:${port}`);
  if (!authEnabled()) console.warn('⚠  APP_PASSWORD is not set — anyone who can reach this server can use it.');
  console.log(aiEnabled() ? 'Claude recipe extraction: on' : 'Claude recipe extraction: off (set ANTHROPIC_API_KEY to enable PDFs/photos)');
});
