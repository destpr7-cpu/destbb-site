module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return res.status(503).json({ error: 'Catalog storage is not configured' });
  try {
    const base = url.replace(/\/$/, '');
    const r = await fetch(`${base}/rest/v1/products?select=*&order=sort_order.asc,id.asc`, {
      headers: { apikey: key, Authorization: `Bearer ${key}` }
    });
    const data = await r.json();
    if (!r.ok) return res.status(502).json({ error: 'Catalog unavailable' });
    const products = {}, disabledIds = [];
    for (const p of data) {
      if (!p.active) { disabledIds.push(p.id); continue; }
      products[p.id] = {
      name: p.name, price: p.price, salePrice: p.sale_price,
      tag: p.tag, images: p.images, sizes: p.sizes,
      sizeHints: p.size_hints || {}, description: p.description || '',
      active: p.active, preorder: p.preorder, stock: p.stock || {}, category: p.category || 'apparel'
      };
    }
    return res.status(200).json({ products, disabledIds });
  } catch (error) {
    console.error('catalog api:', error.message);
    return res.status(502).json({ error: 'Catalog unavailable' });
  }
};
