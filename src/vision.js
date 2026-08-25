// Reading a photograph of a flyer into a task.
//
// Point the camera at a conference poster, a save-the-date, a printed schedule;
// Claude reads it and proposes a task or event. Nothing is ever created without
// the user confirming what was read - a wrong date added silently is worse than
// no feature at all.
//
// Raw fetch rather than the SDK: this Worker has zero runtime dependencies by
// design (the push encryption and the iCalendar parser are hand-rolled for the
// same reason), and the surface needed here is a single POST.

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

/** Opus reads poor photographs markedly better, which is the entire job. */
export const DEFAULT_MODEL = 'claude-opus-5';

/**
 * `effort` is not universal. The 4.5-era models - Haiku 4.5 and Sonnet 4.5 -
 * reject it outright ("This model does not support the effort parameter"), and
 * the demo runs on Haiku to keep costs down. Send it only where it is
 * understood, rather than assuming every model takes the same options.
 */
const SUPPORTS_EFFORT = /^claude-(fable|mythos|opus|sonnet)-(5|4-6|4-7|4-8)\b/;

export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const ALLOWED_MEDIA = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

/**
 * Forced tool use rather than free text: the response has to be a shape this
 * app can act on, and `strict` guarantees the arguments validate.
 */
const EXTRACT_TOOL = {
  name: 'record_what_you_see',
  description: 'Record the event or deadline shown in the photograph.',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['found', 'kind', 'title', 'date', 'time', 'end_time',
      'location', 'notes', 'confidence', 'contains_personal_data'],
    properties: {
      found: {
        type: 'boolean',
        description: 'False if the image contains no event, deadline or task.',
      },
      kind: {
        type: 'string',
        enum: ['event', 'task', 'none'],
        description: 'An "event" happens at a time; a "task" is something to do by a date.',
      },
      title: { type: 'string', description: 'Short title, as a person would write it. Empty if none.' },
      date: {
        type: 'string',
        description: 'YYYY-MM-DD, resolved against today\'s date. Empty string if no date is shown.',
      },
      time: { type: 'string', description: '24-hour HH:MM, or empty string.' },
      end_time: { type: 'string', description: '24-hour HH:MM, or empty string.' },
      location: { type: 'string', description: 'Room, building or address. Empty string if none.' },
      notes: { type: 'string', description: 'Anything else worth keeping. Empty string if nothing.' },
      confidence: {
        type: 'string',
        enum: ['high', 'medium', 'low'],
        description: 'How legible and unambiguous the source was.',
      },
      contains_personal_data: {
        type: 'boolean',
        description:
          'True if the image appears to contain any identifiable person\'s information - '
          + 'a name, date of birth, record or chart number, address, or anything resembling '
          + 'clinical information about an individual. Err towards true.',
      },
    },
  },
};

function buildPrompt(todayISO, timezone) {
  return [
    `Today is ${todayISO} (${timezone}).`,
    '',
    'Read this photograph and record any single event, deadline, or task it announces',
    '- a conference flyer, a poster, an invitation, a printed schedule, a note.',
    '',
    'Resolve relative dates ("next Thursday", "this Friday") against today. If a date',
    'has no year, choose the next occurrence rather than a past one. If the image shows',
    'several items, record the most prominent one only.',
    '',
    'Set found=false when the image announces nothing datable.',
    '',
    'Set contains_personal_data=true if the image contains any identifiable person\'s',
    'details. This is a safety check, not an extraction task: do not transcribe such',
    'details into any other field.',
  ].join('\n');
}

/**
 * Ask Claude to read one image.
 *
 * Returns { ok, data } or { ok: false, error }. Never throws: a failed reading
 * should surface as a message under the camera button, not a 500.
 */
export async function readImage(env, { base64, mediaType, todayISO, timezone }) {
  if (!env.ANTHROPIC_API_KEY) {
    return { ok: false, error: 'No ANTHROPIC_API_KEY is set on the server.' };
  }
  if (!ALLOWED_MEDIA.includes(mediaType)) {
    return { ok: false, error: `Unsupported image type: ${mediaType}` };
  }
  // base64 inflates by about a third, so bound the decoded size.
  if (!base64 || base64.length * 0.75 > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'That photo is too large. Try again with a smaller one.' };
  }

  const model = env.VISION_MODEL || DEFAULT_MODEL;

  const body = {
    model,
    max_tokens: 8192,
    // Thinking stays on where it exists: disabling it on Opus 5 can put a tool
    // call into the visible text instead of a tool_use block. Low effort keeps
    // it quick - on the models that accept the parameter at all.
    ...(SUPPORTS_EFFORT.test(model) ? { output_config: { effort: 'low' } } : {}),
    tools: [EXTRACT_TOOL],
    tool_choice: { type: 'tool', name: EXTRACT_TOOL.name },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } },
        { type: 'text', text: buildPrompt(todayISO, timezone) },
      ],
    }],
  };

  let response;
  try {
    response = await fetch(API_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'anthropic-version': API_VERSION,
        'x-api-key': env.ANTHROPIC_API_KEY,
      },
      body: JSON.stringify(body),
    });
  } catch (error) {
    return { ok: false, error: `Could not reach the API: ${String(error).slice(0, 120)}` };
  }

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    const detail = payload?.error?.message || `HTTP ${response.status}`;
    return { ok: false, error: `The reader refused that request: ${String(detail).slice(0, 200)}` };
  }

  // A safety decline arrives as HTTP 200 with stop_reason "refusal".
  if (payload?.stop_reason === 'refusal') {
    return { ok: false, error: 'The reader declined to process that image.' };
  }

  const block = (payload?.content ?? []).find((b) => b.type === 'tool_use');
  if (!block?.input) {
    return { ok: false, error: 'The reader returned nothing usable for that image.' };
  }

  return { ok: true, data: normalise(block.input) };
}

const cleanDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v ?? '').trim()) ? String(v).trim() : null);
const cleanTime = (v) => (/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v ?? '').trim()) ? String(v).trim() : null);

/** Never trust the shape coming back, even with strict tool use. */
function normalise(input) {
  return {
    found: Boolean(input.found),
    kind: ['event', 'task', 'none'].includes(input.kind) ? input.kind : 'none',
    title: String(input.title ?? '').trim().slice(0, 200),
    date: cleanDate(input.date),
    time: cleanTime(input.time),
    endTime: cleanTime(input.end_time),
    location: String(input.location ?? '').trim().slice(0, 200),
    notes: String(input.notes ?? '').trim().slice(0, 2000),
    confidence: ['high', 'medium', 'low'].includes(input.confidence) ? input.confidence : 'low',
    containsPersonalData: Boolean(input.contains_personal_data),
  };
}
