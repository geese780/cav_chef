const test = require('node:test');
const assert = require('node:assert/strict');
const { parseLocations } = require('../locations');

function withLocationsJson(value, fn) {
  const saved = process.env.LOCATIONS_JSON;
  try {
    process.env.LOCATIONS_JSON = value;
    fn();
  } finally {
    process.env.LOCATIONS_JSON = saved;
  }
}

test('parseLocations', async t => {
  await t.test('parses a single location', () => {
    withLocationsJson('[{"name":"WeHo","listId":"F0BLN7YRUDN","calendarId":""}]', () => {
      const locations = parseLocations();
      assert.deepEqual(locations, [{ name: 'WeHo', listId: 'F0BLN7YRUDN', calendarId: '' }]);
    });
  });

  await t.test('parses multiple locations', () => {
    withLocationsJson(
      '[{"name":"WeHo","listId":"F1"},{"name":"DTLA","listId":"F2"},{"name":"Malibu","listId":"F3"}]',
      () => {
        const locations = parseLocations();
        assert.equal(locations.length, 3);
        assert.deepEqual(locations.map(l => l.name), ['WeHo', 'DTLA', 'Malibu']);
      }
    );
  });

  await t.test('defaults a missing calendarId to an empty string', () => {
    withLocationsJson('[{"name":"WeHo","listId":"F1"}]', () => {
      assert.equal(parseLocations()[0].calendarId, '');
    });
  });

  await t.test('throws when unset', () => {
    withLocationsJson('', () => {
      assert.throws(() => parseLocations(), /LOCATIONS_JSON is not set/);
    });
  });

  await t.test('throws on invalid JSON', () => {
    withLocationsJson('not json', () => {
      assert.throws(() => parseLocations(), /not valid JSON/);
    });
  });

  await t.test('throws on an empty array', () => {
    withLocationsJson('[]', () => {
      assert.throws(() => parseLocations(), /non-empty JSON array/);
    });
  });

  await t.test('throws on a non-array', () => {
    withLocationsJson('{"name":"WeHo"}', () => {
      assert.throws(() => parseLocations(), /non-empty JSON array/);
    });
  });

  await t.test('throws naming an entry missing "name"', () => {
    withLocationsJson('[{"listId":"F1"}]', () => {
      assert.throws(() => parseLocations(), /entry 0 is missing "name"/);
    });
  });

  await t.test('throws naming an entry missing "listId"', () => {
    withLocationsJson('[{"name":"WeHo"}]', () => {
      assert.throws(() => parseLocations(), /"WeHo".*missing "listId"/);
    });
  });
});
