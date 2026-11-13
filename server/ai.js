// Optional: use Claude to turn messy recipe files (text, PDFs, photos of cards) into structured recipes.
// Enabled when ANTHROPIC_API_KEY is set. Without it the app falls back to the heuristic parser.
import Anthropic from '@anthropic-ai/sdk';
import { CATEGORY_ORDER } from './ingredients.js';

const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5-5';
let client;

export function aiEnabled() {
  return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

function getClient() {
  if (!client) client = new Anthropic();
  return client;
}

const nullable = (type) => ({ anyOf: [{ type }, { type: 'null' }] });

const RECIPE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['recipes'],
  properties: {
    recipes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'servings', 'prep_minutes', 'ingredients', 'instructions', 'notes', 'tags', 'health', 'health_reason'],
        properties: {
          title: { type: 'string' },
          servings: nullable('integer'),
          prep_minutes: nullable('integer'),
          ingredients: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['raw', 'qty', 'unit', 'name', 'note', 'category', 'staple'],
              properties: {
                raw: { type: 'string', description: 'The ingredient line as written' },
                qty: nullable('number'),
                unit: nullable('string'),
                name: { type: 'string', description: 'Short generic shopping name, e.g. "yellow onion", "chicken thigh", "cilantro"' },
                note: { type: 'string', description: 'Preparation notes, e.g. "finely chopped"' },
                category: { type: 'string', enum: CATEGORY_ORDER },
                staple: { type: 'boolean', description: 'True for pantry staples most homes already have (salt, pepper, cooking oil, flour, sugar, common dried spices)' },
              },
            },
          },
          instructions: { type: 'array', items: { type: 'string' } },
          notes: { type: 'string' },
          tags: { type: 'array', items: { type: 'string' }, description: 'A few tags like cuisine, "vegetarian", "quick", "slow cooker"' },
          health: { type: 'integer', description: '1=indulgent, 2=comfort, 3=balanced, 4=healthy, 5=very healthy' },
          health_reason: { type: 'string' },
        },
      },
    },
  },
};

const PROMPT = `Extract every recipe in this file for a household meal-planning app.
- Keep the original wording in "raw" for each ingredient line, and give a short generic "name" a shopper would look for (no quantities or prep words).
- qty is a number (convert fractions, use the top of a range); unit is a short unit like cup, tbsp, tsp, oz, lb, g, ml, clove, can, bunch, or null for counted items.
- Rate healthiness 1-5 for a typical home cook's portion and give a one-sentence reason.
- If the file contains no recipe, return an empty "recipes" array.
- Do not invent ingredients or steps that are not in the file.`;

/**
 * @param {{text?: string, pdf?: Buffer, image?: Buffer, mediaType?: string, filename?: string}} input
 * @returns {Promise<Array>} recipes in the app's input shape
 */
export async function extractRecipes({ text, pdf, image, mediaType, filename }) {
  const content = [];
  if (pdf) content.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: pdf.toString('base64') } });
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: image.toString('base64') } });
  content.push({ type: 'text', text: `${PROMPT}\n\nFile name: ${filename || 'unknown'}${text ? `\n\n<file>\n${text}\n</file>` : ''}` });

  const response = await getClient().beta.messages.create({
    model: MODEL,
    max_tokens: 16000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    output_config: {
      effort: process.env.CLAUDE_EFFORT || 'medium',
      format: { type: 'json_schema', schema: RECIPE_SCHEMA },
    },
    messages: [{ role: 'user', content }],
  });

  if (response.stop_reason === 'refusal') throw new Error('Claude declined to process this file');
  if (response.stop_reason === 'max_tokens') throw new Error('Recipe file too long to extract in one pass');
  const textBlock = response.content.find((b) => b.type === 'text');
  if (!textBlock) throw new Error('No structured output returned');
  const parsed = JSON.parse(textBlock.text);
  return (parsed.recipes || []).map((r) => ({
    title: r.title,
    servings: r.servings || 4,
    prepMinutes: r.prep_minutes,
    ingredients: r.ingredients.map((i) => ({
      raw: i.raw, qty: i.qty, unit: i.unit, name: i.name, note: i.note, category: i.category, staple: i.staple,
    })),
    instructions: r.instructions.map((s, i) => `${i + 1}. ${s.replace(/^\d+[.)]\s*/, '')}`).join('\n'),
    notes: [r.notes, r.health_reason ? `Healthiness: ${r.health_reason}` : ''].filter(Boolean).join('\n'),
    tags: r.tags,
    health: Math.max(1, Math.min(5, Math.round(r.health || 3))),
    healthSource: 'ai',
  }));
}
