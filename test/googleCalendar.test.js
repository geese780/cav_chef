const test = require('node:test');
const assert = require('node:assert/strict');
const { matchesLocation } = require('../googleCalendar');

test('matchesLocation', async t => {
  await t.test('matches when the location field starts with the match text', () => {
    assert.equal(matchesLocation({ location: 'WeHo Nashville VizLab 1' }, 'WeHo Nashville'), true);
  });

  await t.test('matches case-insensitively', () => {
    assert.equal(matchesLocation({ location: 'weho nashville vizlab 1' }, 'WeHo Nashville'), true);
  });

  await t.test('does not cross-match two similarly-prefixed sites', () => {
    assert.equal(matchesLocation({ location: 'Rock Lititz VizLab 1' }, 'Rock Nashville'), false);
    assert.equal(matchesLocation({ location: 'Rock Nashville VizLab 1' }, 'Rock Lititz'), false);
  });

  await t.test('does not match an unrelated "Remote" booking', () => {
    assert.equal(matchesLocation({ location: 'Remote' }, 'WeHo Nashville'), false);
  });

  await t.test('does not match a missing location field', () => {
    assert.equal(matchesLocation({}, 'WeHo Nashville'), false);
    assert.equal(matchesLocation({ location: undefined }, 'WeHo Nashville'), false);
  });
});
