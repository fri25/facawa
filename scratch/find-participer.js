const fs = require('fs');

const code = fs.readFileSync('scratch/index-BGXfF5KX.js', 'utf8');

// Find occurrences of "Je souhaite participer"
const pos = code.indexOf('Je souhaite participer');
console.log('Pos of "Je souhaite participer":', pos);
if (pos !== -1) {
  console.log(code.substring(pos - 300, pos + 1500));
} else {
  // Let's search in all other files
  const files = fs.readdirSync('scratch');
  for (const f of files) {
    if (!f.endsWith('.js')) continue;
    const c = fs.readFileSync('scratch/' + f, 'utf8');
    const p = c.indexOf('Je souhaite participer');
    if (p !== -1) {
      console.log('Found in', f, 'at', p);
      console.log(c.substring(p - 200, p + 1500));
    }
  }
}
