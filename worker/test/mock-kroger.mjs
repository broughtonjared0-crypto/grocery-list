// A stand-in for api.kroger.com, shaped like the documented responses, for local tests only.
//   node test/mock-kroger.mjs            (listens on :8789)
//   wrangler dev --var KROGER_BASE:http://127.0.0.1:8789/v1
// Accepts client "test-id" / "test-secret". The first token it hands out is rejected once
// by /products, so the Worker's refresh-and-retry path gets exercised.
import http from 'node:http';

const PORT = +process.env.PORT || 8789;
const IMG = upc => ['thumbnail', 'small', 'medium', 'large', 'xlarge']
  .map(size => ({ size, url: `https://www.kroger.com/product/images/${size}/front/${upc}` }));

const PRODUCTS = [
  { productId: '0001111041700', upc: '0001111041700', brand: 'Kroger', description: 'Kroger® 2% Reduced Fat Milk', size: '1 gal', regular: 3.49, promo: 2.99 },
  { productId: '0001111041600', upc: '0001111041600', brand: 'Kroger', description: 'Kroger® Vitamin D Whole Milk', size: '1 gal', regular: 3.59, promo: 0 },
  { productId: '0007225003706', upc: '0007225003706', brand: 'Fairlife', description: 'fairlife® 2% Reduced Fat Ultra-Filtered Milk', size: '52 fl oz', regular: 4.99, promo: 0, badImage: true },
  { productId: '0001111008741', upc: '0001111008741', brand: 'Kroger', description: 'Kroger® Round Top White Bread', size: '20 oz', regular: 1.79, promo: 1.25, noImage: true },
];

let issued = 0;
const rejectedOnce = new Set();

const send = (res, status, body) => {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
};

http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host}`);
  const auth = req.headers.authorization || '';
  if (req.method === 'POST' && u.pathname === '/v1/connect/oauth2/token') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const ok = auth === 'Basic ' + Buffer.from('test-id:test-secret').toString('base64');
      if (!ok) return send(res, 401, { error: 'invalid_client' });
      if (!/grant_type=client_credentials/.test(body) || !/scope=product\.compact/.test(body)) return send(res, 400, { error: 'invalid_request' });
      issued++;
      console.log('token issued #' + issued);
      send(res, 200, { access_token: 'tok' + issued, expires_in: 1800, token_type: 'bearer' });
    });
    return;
  }
  const tok = auth.replace(/^Bearer /, '');
  if (!/^tok\d+$/.test(tok)) return send(res, 401, { error: 'unauthorized' });

  if (u.pathname === '/v1/locations') {
    const zip = u.searchParams.get('filter.zipCode.near');
    console.log('locations', zip);
    return send(res, 200, {
      data: [
        { locationId: '02400752', storeNumber: '00752', divisionNumber: '024', chain: 'KROGER', name: 'Kroger - Richmond Centre', phone: '8596240000',
          address: { addressLine1: '1001 Eastern Bypass', city: 'Richmond', state: 'KY', zipCode: '40475', county: 'Madison' } },
        { locationId: '02400388', chain: 'KROGER', name: 'Kroger - Berea',
          address: { addressLine1: '305 Plaza Dr', city: 'Berea', state: 'KY', zipCode: '40403' } },
      ],
      meta: { pagination: { start: 0, limit: 10, total: 2 } },
    });
  }
  if (u.pathname === '/v1/products') {
    if (tok === 'tok1' && !rejectedOnce.has(tok)) { rejectedOnce.add(tok); console.log('rejecting tok1 once'); return send(res, 401, { error: 'expired' }); }
    const term = (u.searchParams.get('filter.term') || '').toLowerCase();
    const loc = u.searchParams.get('filter.locationId');
    const limit = +u.searchParams.get('filter.limit') || 10;
    console.log('products', JSON.stringify(term), loc, limit);
    const words = term.split(/\s+/).filter(w => w.length > 1 && !/%/.test(w));
    const hits = PRODUCTS.filter(p => words.some(w => p.description.toLowerCase().includes(w)));
    return send(res, 200, {
      data: hits.slice(0, limit).map(p => ({
        productId: p.productId, upc: p.upc, brand: p.brand, description: p.description,
        categories: ['Dairy'],
        images: p.noImage ? [] : [
          { perspective: 'back', sizes: IMG('0000000000000') },
          { perspective: 'front', featured: true, sizes: IMG(p.badImage ? '0009999999999' : p.upc) },
        ],
        items: [{ itemId: p.upc, size: p.size, soldBy: 'UNIT', ...(loc ? { price: { regular: p.regular, promo: p.promo } } : {}) }],
      })),
      meta: { pagination: { start: 0, limit, total: hits.length } },
    });
  }
  send(res, 404, { error: 'not found' });
}).listen(PORT, () => console.log('mock kroger on :' + PORT));
