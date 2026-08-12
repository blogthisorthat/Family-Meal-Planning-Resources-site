const recipeUrl = document.getElementById('recipeUrl');
const importBtn = document.getElementById('importBtn');
const statusBox = document.getElementById('status');
const resultBox = document.getElementById('recipeResult');
const recipeName = document.getElementById('recipeName');
const recipeSource = document.getElementById('recipeSource');
const sourceServings = document.getElementById('sourceServings');
const targetServings = document.getElementById('targetServings');
const ingredientsBox = document.getElementById('ingredients');
const copyBtn = document.getElementById('copyBtn');
const printBtn = document.getElementById('printBtn');
const plannerBtn = document.getElementById('plannerBtn');
const plannerDay = document.getElementById('plannerDay');

let imported = null;
let scaledIngredients = [];

const FRACTIONS = {
  '¼': 1/4, '½': 1/2, '¾': 3/4,
  '⅓': 1/3, '⅔': 2/3,
  '⅛': 1/8, '⅜': 3/8, '⅝': 5/8, '⅞': 7/8
};

const UNIT_RE = /^(cups?|c\.|tablespoons?|tbsp\.?|teaspoons?|tsp\.?|ounces?|oz\.?|pounds?|lbs?\.?|grams?|g\.?|kilograms?|kg\.?|milliliters?|ml\.?|liters?|litres?|l\.?|cloves?|cans?|packages?|packs?|slices?|pieces?|heads?|bunches?|stalks?)\b/i;

importBtn.addEventListener('click', importRecipe);
recipeUrl.addEventListener('keydown', e => { if (e.key === 'Enter') importRecipe(); });
sourceServings.addEventListener('input', renderScaled);
targetServings.addEventListener('input', renderScaled);
copyBtn.addEventListener('click', copyIngredients);
printBtn.addEventListener('click', () => window.print());
plannerBtn.addEventListener('click', addToPlanner);

function showStatus(message, error = false) {
  statusBox.textContent = message;
  statusBox.classList.remove('hidden', 'error');
  if (error) statusBox.classList.add('error');
}

function hideStatus() {
  statusBox.classList.add('hidden');
}

async function importRecipe() {
  const url = recipeUrl.value.trim();
  if (!url) return showStatus('Paste a recipe URL first.', true);

  importBtn.disabled = true;
  resultBox.classList.add('hidden');
  showStatus('Opening the recipe page and looking for its ingredient data…');

  try {
    const response = await fetch('/api/extract-recipe', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Unable to import that recipe.');

    imported = data;
    recipeName.textContent = data.name || 'Imported recipe';
    recipeSource.innerHTML = `<a href="${escapeAttr(data.sourceUrl)}" target="_blank" rel="noopener">Open original recipe</a>${data.recipeYield ? ` · Published yield: ${escapeHtml(data.recipeYield)}` : ''}`;
    sourceServings.value = data.servings || 4;

    const savedFamilySize = readSavedFamilySize();
    targetServings.value = savedFamilySize || 4;
    renderScaled();
    resultBox.classList.remove('hidden');
    showStatus(`Found ${data.ingredients.length} ingredient${data.ingredients.length === 1 ? '' : 's'}. Review the serving counts and scaled quantities below.`);
  } catch (error) {
    imported = null;
    showStatus(error instanceof Error ? error.message : 'Unable to import that recipe.', true);
  } finally {
    importBtn.disabled = false;
  }
}

function renderScaled() {
  if (!imported) return;
  const from = positiveNumber(sourceServings.value, 1);
  const to = positiveNumber(targetServings.value, 1);
  const factor = to / from;

  scaledIngredients = imported.ingredients.map(text => ({
    original: text,
    scaled: scaleIngredient(text, factor)
  }));

  ingredientsBox.innerHTML = scaledIngredients.map((item, index) => `
    <label class="ingredient">
      <input type="checkbox" checked data-index="${index}">
      <span><strong>${escapeHtml(item.scaled)}</strong><div class="original">Original: ${escapeHtml(item.original)}</div></span>
    </label>
  `).join('');
}

function scaleIngredient(text, factor) {
  const source = String(text || '').trim();
  if (!source || !Number.isFinite(factor) || factor <= 0 || Math.abs(factor - 1) < 0.0001) return source;

  const parsed = parseLeadingQuantity(source);
  if (!parsed) return source;

  const scaledStart = formatQuantity(parsed.start * factor);
  const scaledEnd = parsed.end == null ? null : formatQuantity(parsed.end * factor);
  const quantity = scaledEnd == null ? scaledStart : `${scaledStart}–${scaledEnd}`;
  return `${quantity}${parsed.separator}${parsed.rest}`.trim();
}

function parseLeadingQuantity(text) {
  const normalized = normalizeFractionText(text);
  const token = '(?:\\d+\\s+[¼½¾⅓⅔⅛⅜⅝⅞]|\\d+\\s+\\d+\\/\\d+|\\d+\\/\\d+|\\d+(?:\\.\\d+)?|[¼½¾⅓⅔⅛⅜⅝⅞])';
  const match = normalized.match(new RegExp(`^\\s*(${token})(?:\\s*(?:-|–|—|to)\\s*(${token}))?(\\s*)(.*)$`, 'i'));
  if (!match) return null;
  const start = quantityToNumber(match[1]);
  const end = match[2] ? quantityToNumber(match[2]) : null;
  if (!Number.isFinite(start) || start <= 0 || (end != null && (!Number.isFinite(end) || end <= 0))) return null;
  return { start, end, separator: match[3] || ' ', rest: match[4] || '' };
}

function normalizeFractionText(text) {
  return String(text).replace(/(\d)([¼½¾⅓⅔⅛⅜⅝⅞])/g, '$1 $2');
}

function quantityToNumber(value) {
  const text = String(value).trim();
  const unicode = text.match(/^(\d+\s+)?([¼½¾⅓⅔⅛⅜⅝⅞])$/);
  if (unicode) return (unicode[1] ? Number(unicode[1].trim()) : 0) + FRACTIONS[unicode[2]];
  if (/^\d+\s+\d+\/\d+$/.test(text)) {
    const [whole, fraction] = text.split(/\s+/);
    return Number(whole) + fractionToNumber(fraction);
  }
  if (/^\d+\/\d+$/.test(text)) return fractionToNumber(text);
  return Number(text);
}

function fractionToNumber(text) {
  const [a, b] = text.split('/').map(Number);
  return b ? a / b : NaN;
}

function formatQuantity(value) {
  if (!Number.isFinite(value)) return '';
  if (value >= 20) return String(Math.round(value * 10) / 10).replace(/\.0$/, '');

  const whole = Math.floor(value + 1e-9);
  const remainder = value - whole;
  const candidates = [
    [0, ''], [1/8, '⅛'], [1/4, '¼'], [1/3, '⅓'], [3/8, '⅜'], [1/2, '½'],
    [5/8, '⅝'], [2/3, '⅔'], [3/4, '¾'], [7/8, '⅞'], [1, '']
  ];
  let best = candidates[0];
  let error = Infinity;
  for (const candidate of candidates) {
    const diff = Math.abs(remainder - candidate[0]);
    if (diff < error) { error = diff; best = candidate; }
  }

  if (best[0] === 1) return String(whole + 1);
  if (whole === 0 && best[1]) return best[1];
  if (best[1]) return `${whole} ${best[1]}`;
  return String(whole);
}

function selectedScaledIngredients() {
  const checks = [...ingredientsBox.querySelectorAll('input[type="checkbox"]')];
  return checks.filter(c => c.checked).map(c => scaledIngredients[Number(c.dataset.index)]).filter(Boolean);
}

async function copyIngredients() {
  if (!imported) return;
  const selected = selectedScaledIngredients();
  const text = `${imported.name}\nScaled for ${targetServings.value} servings\n\n${selected.map(x => `- ${x.scaled}`).join('\n')}\n\nSource: ${imported.sourceUrl}`;
  try {
    await navigator.clipboard.writeText(text);
    showStatus('Scaled ingredients copied to your clipboard.');
  } catch {
    window.prompt('Copy the scaled ingredients:', text);
  }
}

function addToPlanner() {
  if (!imported) return;
  const selected = selectedScaledIngredients();
  if (!selected.length) return showStatus('Select at least one ingredient before adding the recipe.', true);

  const day = plannerDay.value;
  let saved;
  try { saved = JSON.parse(localStorage.getItem('familyMealPlanner') || 'null'); } catch { saved = null; }
  if (!saved || typeof saved !== 'object') saved = {};
  if (!saved.state || typeof saved.state !== 'object') saved.state = { days: {}, custom: [], checked: {} };
  if (!saved.state.days || typeof saved.state.days !== 'object') saved.state.days = {};
  if (!Array.isArray(saved.state.custom)) saved.state.custom = [];
  if (!saved.state.checked || typeof saved.state.checked !== 'object') saved.state.checked = {};

  const plannerIngredients = selected.map(item => splitForPlanner(item.scaled));
  saved.state.days[day] = {
    meal: imported.name,
    notes: `Imported from ${imported.sourceUrl} · Scaled for ${targetServings.value} servings`,
    ingredients: plannerIngredients
  };
  saved.familySize = String(Math.round(positiveNumber(targetServings.value, 4)));
  if (!saved.planName) saved.planName = 'Imported Recipe Week';

  localStorage.setItem('familyMealPlanner', JSON.stringify(saved));
  showStatus(`${imported.name} was added to ${day}. Opening your weekly planner…`);
  setTimeout(() => { location.href = '/#planner'; }, 450);
}

function splitForPlanner(text) {
  const parsed = parseLeadingQuantity(text);
  if (!parsed) return { name: text, qty: '', category: guessCategory(text) };
  const quantityText = parsed.end == null ? formatQuantity(parsed.start) : `${formatQuantity(parsed.start)}–${formatQuantity(parsed.end)}`;
  const rest = parsed.rest.trim();
  const unitMatch = rest.match(UNIT_RE);
  let name = rest;
  let qty = quantityText;
  if (unitMatch) {
    qty = `${quantityText} ${unitMatch[0]}`;
    name = rest.slice(unitMatch[0].length).replace(/^[,\s]+/, '').trim() || rest;
  }
  return { name, qty, category: guessCategory(name) };
}

function guessCategory(text) {
  const s = String(text).toLowerCase();
  if (/chicken|beef|pork|turkey|bacon|sausage|ham|steak|shrimp|salmon|fish|tuna/.test(s)) return 'Meat & Seafood';
  if (/milk|cheese|cream|yogurt|butter|egg|mozzarella|parmesan|cheddar/.test(s)) return 'Dairy & Eggs';
  if (/bread|bun|roll|tortilla|pita|bagel|dough/.test(s)) return 'Bakery';
  if (/frozen|ice cream/.test(s)) return 'Frozen';
  if (/soda|juice|water|coffee|tea/.test(s)) return 'Drinks';
  if (/apple|banana|onion|garlic|lettuce|tomato|potato|pepper|carrot|broccoli|spinach|avocado|lime|lemon|cilantro|parsley|celery|mushroom|zucchini|corn|cabbage|fruit|vegetable/.test(s)) return 'Produce';
  return 'Pantry';
}

function readSavedFamilySize() {
  try {
    const saved = JSON.parse(localStorage.getItem('familyMealPlanner') || 'null');
    const value = Number(saved?.familySize);
    return Number.isFinite(value) && value > 0 ? Math.round(value) : null;
  } catch { return null; }
}

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function escapeHtml(value) {
  return String(value || '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
}

function escapeAttr(value) {
  return escapeHtml(value).replace(/`/g, '&#96;');
}
