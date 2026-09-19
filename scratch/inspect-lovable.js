const fs = require('fs');

async function inspect() {
  const res = await fetch('https://fecawa-hub.lovable.app/');
  const html = await res.text();
  console.log('HTML loaded, length:', html.length);

  // find script tags
  const scriptRegex = /src="([^"]+\.js)"/g;
  let match;
  const scripts = [];
  while ((match = scriptRegex.exec(html)) !== null) {
    scripts.push(match[1]);
  }
  console.log('Scripts:', scripts);

  for (const s of scripts) {
    const sUrl = s.startsWith('http') ? s : 'https://fecawa-hub.lovable.app' + s;
    const sRes = await fetch(sUrl);
    const sText = await sRes.text();
    fs.writeFileSync('scratch/' + s.split('/').pop(), sText);
    console.log(`Saved ${s.split('/').pop()} (${sText.length} bytes)`);
  }
}

inspect().catch(console.error);
