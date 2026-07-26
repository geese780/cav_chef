/**
 * Per-location config (FR-27). Each location has its own inventory List, but
 * all locations share one APPROVAL_CHANNEL_ID (prompts are tagged with the
 * location name to stay distinguishable) and one shared bookings calendarId
 * (FR-28) — `locationMatch` (defaults to `name`) is the text matched against
 * an event's `location` field to attribute a booking to this location.
 */

function parseLocations() {
  const raw = (process.env.LOCATIONS_JSON || '').trim();
  if (!raw) throw new Error('LOCATIONS_JSON is not set in .env');

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`LOCATIONS_JSON is not valid JSON: ${err.message}`, { cause: err });
  }

  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('LOCATIONS_JSON must be a non-empty JSON array');
  }

  return parsed.map((loc, i) => {
    const name = String((loc && loc.name) || '').trim();
    const listId = String((loc && loc.listId) || '').trim();
    const calendarId = String((loc && loc.calendarId) || '').trim();
    const locationMatch = String((loc && loc.locationMatch) || name).trim();
    if (!name) throw new Error(`LOCATIONS_JSON entry ${i} is missing "name"`);
    if (!listId) throw new Error(`LOCATIONS_JSON entry ${i} ("${name}") is missing "listId"`);
    return { name, listId, calendarId, locationMatch };
  });
}

module.exports = { parseLocations };
