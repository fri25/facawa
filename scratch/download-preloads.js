const fs = require('fs');

async function downloadPreloads() {
  const htmlRes = await fetch('https://fecawa-hub.lovable.app/');
  const html = await htmlRes.text();
  const preloadRegex = /href="(\/assets\/[^"]+)"/g;
  let match;
  const urls = [];
  while ((match = preloadRegex.exec(html)) !== null) {
    urls.push(match[1]);
  }
  console.log('Preload URLs:', urls);

  for (const u of urls) {
    const full = 'https://fecawa-hub.lovable.app' + u;
    const res = await fetch(full);
    const text = await res.text();
    const fname = u.split('/').pop();
    fs.writeFileSync('scratch/' + fname, text);
    console.log(`Saved ${fname} (${text.length} bytes)`);
  }
}

downloadPreloads().catch(console.error);
