// Heuristic parser for plain-text / markdown recipes (no AI required).
import { parseIngredientLine } from './ingredients.js';

const ING_HEADERS = /^(#+\s*)?(ingredients?|you('| wi)ll need|shopping list|what you need)\b[:\s]*$/i;
const STEP_HEADERS = /^(#+\s*)?(instructions?|directions?|method|steps?|preparation|how to make( it)?|to make)\b[:\s]*$/i;
const OTHER_HEADERS = /^(#+\s*)?(notes?|tips?|serving suggestions?|nutrition.*|equipment)\b[:\s]*$/i;
const SUB_HEADER = /^(#+\s*)?(for the [\w\s]+|[A-Z][\w\s]{1,30}):\s*$/;

function looksLikeIngredient(line) {
  return /^[\s•*\-–·▢□☐]*([\d¼½¾⅓⅔⅛]|a\s|an\s|one\s|pinch|handful|salt|pepper|juice)/i.test(line) && line.length < 120;
}

/** Parse free text into { title, servings, ingredients[], instructions, notes } */
export function parseRecipeText(text, fallbackTitle = 'Untitled recipe') {
  const lines = text.replace(/\r/g, '').split('\n').map((l) => l.trim());
  let title = '';
  let servings = null;
  let prepMinutes = null;
  const ingredientLines = [];
  const steps = [];
  const notes = [];
  let mode = 'header';

  for (const line of lines) {
    if (!line) continue;
    const plain = line.replace(/^#+\s*/, '').replace(/\*\*/g, '').trim();
    if (!title && mode === 'header' && !ING_HEADERS.test(plain) && plain.length < 100) {
      title = plain.replace(/^title:\s*/i, '');
      continue;
    }
    const serv = plain.match(/\b(?:serves|servings|yield|makes)\b[:\s]*(\d+)/i);
    if (serv && mode !== 'steps') { servings = Number(serv[1]); if (plain.length < 40) continue; }
    const time = plain.match(/\b(?:total time|cook time|time|ready in)\b[:\s]*(?:(\d+)\s*h(?:ours?|rs?)?)?\s*(?:(\d+)\s*m(?:in(?:utes?)?)?)?/i);
    if (time && (time[1] || time[2]) && plain.length < 60 && mode !== 'steps') {
      prepMinutes = Number(time[1] || 0) * 60 + Number(time[2] || 0);
      continue;
    }
    if (ING_HEADERS.test(plain)) { mode = 'ingredients'; continue; }
    if (STEP_HEADERS.test(plain)) { mode = 'steps'; continue; }
    if (OTHER_HEADERS.test(plain)) { mode = 'notes'; continue; }

    if (mode === 'header') {
      // No explicit header yet: guess from the shape of the line
      if (looksLikeIngredient(line)) { mode = 'ingredients'; } else { notes.push(plain); continue; }
    }
    if (mode === 'ingredients') {
      if (SUB_HEADER.test(plain) && !looksLikeIngredient(line)) continue;
      if (/^\d+[.)]\s+\w+.{40,}/.test(plain)) { mode = 'steps'; } // a long numbered line: steps began
      else { ingredientLines.push(line); continue; }
    }
    if (mode === 'steps') {
      const numbered = /^(step\s*)?\d+[.):]\s*/i.test(plain) || /^[•*\-–·]\s/.test(plain);
      const prev = steps[steps.length - 1];
      // A line that isn't numbered and follows an unfinished sentence is the same step wrapped onto a new line (common in PDFs).
      if (!numbered && prev && !/[.!?:)]$/.test(prev)) steps[steps.length - 1] = `${prev} ${plain}`;
      else steps.push(plain.replace(/^(step\s*)?\d+[.):]\s*/i, '').replace(/^[•*\-–·]\s/, ''));
    }
    else if (mode === 'notes') notes.push(plain);
  }

  const ingredients = ingredientLines.map(parseIngredientLine).filter(Boolean);
  return {
    title: title || fallbackTitle,
    servings: servings || 4,
    prepMinutes,
    ingredients,
    instructions: steps.map((s, i) => `${i + 1}. ${s}`).join('\n'),
    notes: notes.join('\n'),
  };
}
