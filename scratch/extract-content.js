const fs = require('fs');

const code = fs.readFileSync('scratch/index-BGXfF5KX.js', 'utf8');

// Look for JSX / strings related to FeCAWa
const frenchStrings = code.match(/["'`]([^"'`]{10,120})["'`]/g) || [];
const uniqueStrings = [...new Set(frenchStrings)]
  .map(s => s.slice(1, -1))
  .filter(s => /[éèàùâêîôûçÉÈÀÙÂÊÎÔÛÇ]|FeCAWa|Waaba|souscription|festival|montant/i.test(s));

console.log('Found', uniqueStrings.length, 'meaningful text strings');
fs.writeFileSync('scratch/extracted-strings.txt', uniqueStrings.join('\n'));
console.log('Top 60 strings:\n' + uniqueStrings.slice(0, 60).join('\n'));
