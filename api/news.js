export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-store');

  const KEY = process.env.ANTHROPIC_API_KEY;

  const FEEDS = [
    { url: 'https://cointelegraph.com/rss', name: 'CoinTelegraph' },
    { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'CoinDesk' },
    { url: 'https://decrypt.co/feed', name: 'Decrypt' },
    { url: 'https://www.theblock.co/rss.xml', name: 'The Block' },
    { url: 'https://feeds.reuters.com/reuters/businessNews', name: 'Reuters' },
    { url: 'https://www.cnbc.com/id/10000664/device/rss/rss.html', name: 'CNBC' },
    { url: 'http://feeds.bbci.co.uk/news/world/rss.xml', name: 'BBC' },
    { url: 'http://rss.cnn.com/rss/edition.rss', name: 'CNN' },
    { url: 'https://www.tmz.com/rss.xml', name: 'TMZ' },
    { url: 'https://techcrunch.com/feed/', name: 'TechCrunch' },
    { url: 'https://www.theverge.com/rss/index.xml', name: 'The Verge' },
  ];

  try {
    const results = await Promise.all(
      FEEDS.map(f =>
        fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) })
          .then(r => r.text())
          .then(xml => ({ xml, name: f.name }))
          .catch(() => ({ xml: '', name: f.name }))
      )
    );

    const articles = [];
    const seen = new Set();
    const SIX_H = 6 * 60 * 60 * 1000;
    const now = Date.now();

    results.forEach(({ xml, name }) => {
      if (!xml) return;
      const items = xml.match(/<item[\s\S]*?<\/item>/g) || [];
      items.slice(0, 5).forEach(item => {
        const g = (patterns) => { for (const p of patterns) { const m = item.match(p); if (m?.[1]) return m[1].trim(); } return null; };

        const title = g([/<title><!\[CDATA\[(.*?)\]\]><\/title>/, /<title>([^<]+)<\/title>/])
          ?.replace(/&amp;/g,'&').replace(/&#039;/g,"'").replace(/&quot;/g,'"').replace(/&#8217;/g,"'");

        const url = g([/<link>(https?:\/\/[^<\s]+)/, /<link href="(https?:\/\/[^"]+)"/, /<guid[^>]*>(https?:\/\/[^<]+)<\/guid>/]);

        const pubDate = g([/<pubDate>([^<]+)<\/pubDate>/, /<published>([^<]+)<\/published>/, /<updated>([^<]+)<\/updated>/]);

        const image = g([
          /<media:content[^>]*url="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/,
          /<media:thumbnail[^>]*url="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/,
          /<enclosure[^>]*url="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/
        ]);

        const desc = g([/<description><!\[CDATA\[([\s\S]*?)\]\]>/, /<description>([^<]{10,})<\/description>/])
          ?.replace(/<[^>]*>/g,'').trim().slice(0,200);

        if (!title || !url || seen.has(title)) return;

        let pubMs = now;
        if (pubDate) { const p = Date.parse(pubDate); if (!isNaN(p)) pubMs = p; }
        if (now - pubMs > SIX_H) return;

        seen.add(title);
        articles.push({ title, url, description: desc||'', image: image||null, source: name, publishedAt: new Date(pubMs).toISOString() });
      });
    });

    if (articles.length === 0) {
      return res.json({ success: true, articles: [], total: 0 });
    }

    const prompt = `Rate these ${articles.length} news headlines for meme coin viral potential.

${articles.map((a,i) => `${i+1}. [${a.source}] ${a.title}`).join('\n')}

5 = Shocking/hilarious/ironic - perfect meme coin (rare)
4 = Celebrity drama, scandal, funny fail
3 = Interesting crypto or tech news
2 = Routine update
1 = Boring/irrelevant

Rate ALL ${articles.length} headlines. Return ONLY JSON array:
[{"index":1,"rating":4,"coin":"$TICKER","reason":"why viral","window":"now"}]
window = now/good/ok`;

    const aiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] })
    });

    const aiData = await aiRes.json();
    console.log('STATUS:', aiRes.status, 'ERROR:', JSON.stringify(aiData.error));

    const text = aiData.content?.[0]?.text || '[]';
    const match = text.match(/\[[\s\S]*\]/);
    const ratings = match ? JSON.parse(match[0]) : [];

    const scored = ratings.length > 0
      ? ratings.sort((a,b) => b.rating - a.rating).slice(0,10).map(r => {
          const a = articles[r.index-1];
          if (!a) return null;
          return { rating: r.rating, title: a.title, description: a.description, url: a.url, image: a.image, source: a.source, publishedAt: a.publishedAt, coin: r.coin||'$COIN', reason: r.reason||'', window: r.window||'ok' };
        }).filter(Boolean)
      : articles.slice(0,10).map(a => ({ rating: 3, title: a.title, description: a.description, url: a.url, image: a.image, source: a.source, publishedAt: a.publishedAt, coin: '$'+a.title.split(' ').find(w=>w.length>4)?.replace(/[^A-Za-z]/g,'').toUpperCase().slice(0,8)||'COIN', reason: 'Auto-rated', window: 'ok' }));

    res.json({ success: true, articles: scored, total: articles.length, rated: ratings.length });

  } catch(err) {
    console.error(err.message);
    res.status(500).json({ success: false, error: err.message });
  }
}
