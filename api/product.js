// api/product.js — отдаёт страницу товара с тегами для превью ссылки (Instagram, Telegram и т.д.)
const SITE = 'https://destbb.com';
const PRODUCTS = {
  scarf2r:      { name: 'DESIGNER SCARF «2R»',       price: '775 грн / $17', image: '/assets/scarf_2r_1.png',          desc: '205×21 см. 100% Acrylic. Сроки от 3 до 14 рабочих дней.' },
  scarfhinge:   { name: 'DESIGNER SCARF «UNTITLED»', price: '775 грн / $17', image: '/assets/scarf_untitled_1.png',    desc: '205×21 см. 100% Acrylic. Сроки от 3 до 14 рабочих дней.' },
  redline:      { name: 'LONGSLEEVE «REDLINE»',      price: '1 720 грн / $38', image: '/assets/redline_main.webp',     desc: 'Лонгслив dest.bb.' },
  jesus:        { name: 'LONGSLEEVE «JESUS»',        price: '1 520 грн / $33', image: '/assets/jesus_1.jpg',           desc: 'Лонгслив dest.bb.' },
  'great-schema': { name: 'SCARF «GREAT SCHEMA»',    price: '888 грн / $20', image: '/assets/great_schema_1.jpg',      desc: 'Шарф dest.bb.' }
};
PRODUCTS.scarf = PRODUCTS['great-schema'];

const esc = v => String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

module.exports = async function handler(req, res) {
  const slug = String((req.query && req.query.slug) || '').toLowerCase();
  const p = PRODUCTS[slug];
  try {
    const r = await fetch(`${SITE}/index.html`);
    let html = await r.text();
    if (!r.ok || !html.includes('</head>')) throw new Error('index.html unavailable');
    if (p) {
      const title = `${p.name} — dest.bb`;
      const description = `${p.price}. ${p.desc}`;
      const url = `${SITE}/products/${slug}`;
      const image = SITE + p.image;
      const tags = [
        ['property', 'og:type', 'product'], ['property', 'og:site_name', 'dest.bb'],
        ['property', 'og:title', title], ['property', 'og:description', description],
        ['property', 'og:url', url], ['property', 'og:image', image],
        ['name', 'twitter:card', 'summary_large_image'], ['name', 'twitter:title', title],
        ['name', 'twitter:description', description], ['name', 'twitter:image', image],
        ['name', 'description', description]
      ].map(([k, n, v]) => `<meta ${k}="${n}" content="${esc(v)}">`).join('');
      html = html.replace(/<title>.*?<\/title>/, `<title>${esc(title)}</title>`).replace('</head>', tags + '</head>');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=600');
    return res.status(200).send(html);
  } catch (e) {
    console.error('product page:', e.message);
    res.setHeader('Location', '/');
    return res.status(302).end();
  }
};
