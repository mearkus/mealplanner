import { openDb } from './db.js';
import { createApp } from './app.js';
import { aiEnabled } from './ai.js';

openDb();
const port = Number(process.env.PORT) || 3000;
createApp().listen(port, () => {
  console.log(`Meal planner running on http://localhost:${port}`);
  if (process.env.ALLOW_NEW_FAMILIES === 'true') console.warn('⚠  ALLOW_NEW_FAMILIES=true — anyone who can reach this server can sign up and start a family.');
  if (process.env.APP_PASSWORD) console.warn('ℹ  APP_PASSWORD is no longer used: everyone now has their own account. See README.');
  console.log(aiEnabled() ? 'Claude recipe extraction: on' : 'Claude recipe extraction: off (set ANTHROPIC_API_KEY to enable PDFs/photos)');
});
