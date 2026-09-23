/**
 * SUMods live seats — a Cloudflare Worker that reads BannerWeb's detailed class information
 * page for a handful of CRNs and answers with JSON the site is allowed to fetch.
 *
 *   GET /?term=202601&crns=13602,10189
 *   -> { "term": "202601", "updated": "...", "seats": { "13602": [120, 117, 3, 10, 0, 10] } }
 *      [capacity, taken, remaining, waitlist capacity, waiting, waitlist remaining]
 *
 * Deploy: `npx wrangler deploy worker/seats-worker.js --name sumods-seats`, then put the URL
 * in config.js (seatsEndpoint). Each CRN is cached for 60 seconds and a request may ask for
 * at most 12, so a busy registration morning stays gentle on BannerWeb.
 */
const DETAIL = 'https://suis.sabanciuniv.edu/prod/bwckschd.p_disp_detail_sched';
const MAX_CRNS = 12;
const TTL = 60;

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': `public, max-age=${TTL}`,
    },
  });
}

function row(html, label) {
  const pattern = new RegExp(`>\\s*${label}\\s*</span>\\s*</th>\\s*<td[^>]*>\\s*(-?\\d+)\\s*</td>\\s*<td[^>]*>\\s*(-?\\d+)\\s*</td>\\s*<td[^>]*>\\s*(-?\\d+)`, 'i');
  const m = html.match(pattern);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') return reply({}, 204);
    const url = new URL(request.url);
    const term = url.searchParams.get('term') || '';
    const crns = [...new Set((url.searchParams.get('crns') || '').split(','))].filter((c) => /^\d{5}$/.test(c)).slice(0, MAX_CRNS);
    if (!/^\d{6}$/.test(term) || !crns.length) return reply({ error: 'term (6 digits) and crns (comma-separated) are required' }, 400);

    const cache = caches.default;
    const seats = {};
    await Promise.all(crns.map(async (crn) => {
      const key = new Request(`https://sumods-seats.cache/${term}/${crn}`);
      const hit = await cache.match(key);
      if (hit) {
        seats[crn] = await hit.json();
        return;
      }
      try {
        const res = await fetch(`${DETAIL}?term_in=${term}&crn_in=${crn}`, { headers: { 'User-Agent': 'SUMods live seats' } });
        const html = await res.text();
        const main = row(html, 'Seats');
        const wait = row(html, 'Waitlist Seats');
        seats[crn] = main ? main.concat(wait || []) : null;
        ctx.waitUntil(cache.put(key, new Response(JSON.stringify(seats[crn]), { headers: { 'Cache-Control': `max-age=${TTL}` } })));
      } catch {
        seats[crn] = null;
      }
    }));
    return reply({ term, updated: new Date().toISOString(), seats });
  },
};
