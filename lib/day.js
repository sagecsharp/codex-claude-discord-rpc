'use strict';
// local calendar day helpers shared by the history index and the presence card.
const pad = (n) => String(n).padStart(2, '0');
function localDay(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function dayBounds(ms) {
  const d = new Date(ms);
  return {
    day: localDay(ms),
    start: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(),
    end: new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime(),
  };
}
module.exports = { localDay, dayBounds };
