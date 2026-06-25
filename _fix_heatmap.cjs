const fs = require('fs');
const f = 'options/options.js';
let t = fs.readFileSync(f, 'utf8');

// Detect line ending
const crlf = t.includes('\r\n');
const nl = crlf ? '\r\n' : '\n';

// The new bulletproof implementation using inline-styled CSS grid.
// GitHub's actual technique: grid with 7 rows, grid-auto-flow: column.
// Inline styles eliminate any chance of CSS override/conflict.
const oldStart = 'function renderDayHeatmap(stats, grid) {';
const oldEnd = 'return { monthCols, total, activeDays, peak };';

const si = t.indexOf(oldStart);
const ei = t.indexOf(oldEnd);
if (si === -1 || ei === -1) { console.error('markers not found'); process.exit(1); }
const funcEnd = t.indexOf('}', ei) + 1;

const newFunc = [
  'function renderDayHeatmap(stats, grid) {',
  '    // 0.4.29: GitHub-style horizontal heatmap using inline-styled CSS grid.',
  '    // grid-template-rows: repeat(7, 13px) + grid-auto-flow: column => cells fill',
  '    // top-to-bottom then wrap to next column. This is bulletproof horizontal layout.',
  '    const year = Number(stats.heatmapYear) || new Date().getFullYear();',
  '    const daily = stats.daily || [];',
  '    const counts = new Map(daily.map((d) => [d.date, Number(d.count) || 0]));',
  '    const max = Math.max(1, ...daily.map((d) => Number(d.count) || 0));',
  '    const start = new Date(year, 0, 1);',
  '    const end = new Date(year + 1, 0, 1);',
  '    const leading = (start.getDay() + 6) % 7;',
  '    const monthNames = [\'1\u6708\', \'2\u6708\', \'3\u6708\', \'4\u6708\', \'5\u6708\', \'6\u6708\', \'7\u6708\', \'8\u6708\', \'9\u6708\', \'10\u6708\', \'11\u6708\', \'12\u6708\'];',
  '',
  '    const monthCols = [];',
  '    let lastMonth = -1;',
  '    let total = 0;',
  '    let activeDays = 0;',
  '    let peak = { count: 0, key: \'\' };',
  '',
  '    // Inline-style the grid to guarantee horizontal layout regardless of CSS.',
  '    // This is the key fix: no reliance on external .heatWeek / .heatmapGrid rules.',
  '    grid.setAttribute(\'style\', [',
  '      \'display: grid\',',
  '      \'grid-template-rows: repeat(7, 13px)\',',
  '      \'grid-auto-flow: column\',',
  '      \'grid-auto-columns: 13px\',',
  '      \'gap: 3px\',',
  '      \'padding: 0\',',
  '      \'margin: 0\',',
  '      \'width: max-content\',',
  '      \'align-content: stretch\',',
  '    ].join(\'; \') + \';\');',
  '',
  '    // Build the flat cell array (leading blanks for first-week offset).',
  '    const allCells = [];',
  '    for (let i = 0; i < leading; i++) allCells.push({ blank: true });',
  '    for (const d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {',
  '      const day = new Date(d);',
  '      const key = dateKeyFromDate(day);',
  '      const count = counts.get(key) || 0;',
  '      allCells.push({',
  '        key, count, day,',
  '        month: day.getMonth(),',
  '        empty: count === 0,',
  '      });',
  '    }',
  '    while (allCells.length % 7 !== 0) allCells.push({ blank: true });',
  '',
  '    // Append cells directly to the grid. grid-auto-flow: column makes them',
  '    // flow top-to-bottom (7 rows) then wrap rightward => horizontal layout.',
  '    for (let i = 0; i < allCells.length; i++) {',
  '      const cd = allCells[i];',
  '      const cell = document.createElement(\'i\');',
  '      // inline style on each cell too, to be 100% safe',
  '      cell.style.cssText = \'display:block;width:13px;height:13px;border-radius:2px;box-sizing:border-box;\'',
  '      if (cd.blank) {',
  '        cell.style.background = \'rgba(27,31,35,0.06)\';',
  '      } else if (cd.empty) {',
  '        cell.style.background = \'rgba(27,31,35,0.06)\';',
  '        cell.title = cd.key + \'\uff1a\u65e0\u6536\u85cf\';',
  '      } else {',
  '        const bucket = makeDayBucket(cd.day, cd.count);',
  '        const level = heatLevel(cd.count, max);',
  '        const colors = [\'#ebedf0\', \'#9be9a8\', \'#40c463\', \'#30a14e\', \'#216e39\'];',
  '        cell.style.background = colors[level] || colors[0];',
  '        cell.style.cursor = \'pointer\';',
  '        cell.dataset.timeBucket = bucketDomKey(bucket);',
  '        cell.title = cd.key + \'\uff1a\' + cd.count + \' \u6761\uff0c\u70b9\u51fb\u67e5\u770b\';',
  '        const cap = cd;',
  '        const bkt = bucket;',
  '        cell.addEventListener(\'click\', () => applyTimeBucketFocus(bkt, \'day\'));',
  '        total += cap.count;',
  '        activeDays++;',
  '        if (cap.count > peak.count) peak = { count: cap.count, key: cap.key };',
  '        const m = cap.month;',
  '        if (m !== lastMonth) {',
  '          const col = Math.floor(i / 7);',
  '          if (!monthCols.length || monthCols[monthCols.length - 1].month !== m) {',
  '            monthCols.push({ month: m, label: monthNames[m], col: col });',
  '          }',
  '          lastMonth = m;',
  '        }',
  '      }',
  '      grid.appendChild(cell);',
  '    }',
  '',
  '    return { monthCols, total, activeDays, peak };',
  '}',
].join(nl);

const before = t.slice(0, si);
const after = t.slice(funcEnd);
t = before + newFunc + nl + after;
fs.writeFileSync(f, t, 'utf8');
console.log('replaced renderDayHeatmap, file length', t.length);
