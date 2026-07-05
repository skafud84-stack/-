// 제품 페이지에서 이미지·가격 자동 추출 (Vercel 서버리스)
// GET /api/fetch?url=https://shein.top/xxx  → { image, price, title, finalUrl }
// GET /api/fetch?img=<이미지URL>            → 이미지 바이트 프록시 (canvas 오염 방지)

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const ALLOW_PAGE = /(^|\.)shein\.[a-z.]+$|(^|\.)shein\.top$|(^|\.)sheinoutlet\.com$|(^|\.)onelink\.me$/i;
const ALLOW_IMG = /(^|\.)ltwebstatic\.com$|(^|\.)shein\.com$|sheinsz|img\.shein/i;

function pickPrice(html) {
  // 여러 패턴 순서대로 시도 → 숫자만 반환
  const pats = [
    /"salePrice"\s*:\s*{[^}]*?"amount"\s*:\s*"?([\d.]+)"?/i,
    /"retailPrice"\s*:\s*{[^}]*?"amount"\s*:\s*"?([\d.]+)"?/i,
    /property=["']og:price:amount["']\s+content=["']([\d.,]+)["']/i,
    /content=["']([\d.,]+)["']\s+property=["']og:price:amount["']/i,
    /itemprop=["']price["']\s+content=["']([\d.,]+)["']/i,
    /₩\s*([\d,]{3,})/,
    /"price"\s*:\s*"?([\d.]+)"?/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) {
      const n = m[1].replace(/[^\d.]/g, '');
      const num = Math.round(parseFloat(n));
      if (num > 0) return String(num);
    }
  }
  return '';
}

function pickImage(html) {
  const pats = [
    /property=["']og:image["']\s+content=["']([^"']+)["']/i,
    /content=["']([^"']+)["']\s+property=["']og:image["']/i,
    /"goods_img"\s*:\s*"([^"]+)"/i,
    /"imgUrl"\s*:\s*"([^"]+)"/i,
  ];
  for (const p of pats) {
    const m = html.match(p);
    if (m) {
      let u = m[1].replace(/\\u002F/g, '/').replace(/\\\//g, '/');
      if (u.startsWith('//')) u = 'https:' + u;
      if (/^https?:\/\//.test(u)) return u;
    }
  }
  return '';
}

function pickTitle(html) {
  const m = html.match(/property=["']og:title["']\s+content=["']([^"']+)["']/i)
    || html.match(/<title>([^<]+)<\/title>/i);
  return m ? m[1].trim().slice(0, 120) : '';
}

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=3600');
  const { url, img } = req.query;

  try {
    // ── 이미지 프록시 모드 ──
    if (img) {
      let host;
      try { host = new URL(img).hostname; } catch (e) { return res.status(400).json({ error: 'bad img url' }); }
      if (!ALLOW_IMG.test(host)) return res.status(400).json({ error: 'img host not allowed' });
      const r = await fetch(img, { headers: { 'User-Agent': UA, 'Referer': 'https://www.shein.com/' } });
      if (!r.ok) return res.status(502).json({ error: 'img fetch ' + r.status });
      const buf = Buffer.from(await r.arrayBuffer());
      res.setHeader('Content-Type', r.headers.get('content-type') || 'image/jpeg');
      return res.status(200).send(buf);
    }

    // ── 메타 추출 모드 ──
    if (!url) return res.status(400).json({ error: 'url required' });
    let host;
    try { host = new URL(url).hostname; } catch (e) { return res.status(400).json({ error: 'bad url' }); }
    if (!ALLOW_PAGE.test(host)) return res.status(400).json({ error: 'host not allowed: ' + host });

    const HEADERS = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
    };

    // 1차: 직접 접근 (shein.top 리다이렉트 따라감)
    let r = await fetch(url, { redirect: 'follow', headers: HEADERS });
    let html = await r.text();
    let finalUrl = r.url;

    // 캡차 챌린지로 튕기면 → 챌린지 URL 속 redirection 파라미터에 진짜 상품 URL이 있음 → 재시도
    if (/\/risk\/challenge/i.test(finalUrl)) {
      try {
        const real = new URL(finalUrl).searchParams.get('redirection');
        if (real && ALLOW_PAGE.test(new URL(real).hostname)) {
          finalUrl = real;
          r = await fetch(real, { redirect: 'follow', headers: HEADERS });
          if (!/\/risk\/challenge/i.test(r.url)) { html = await r.text(); finalUrl = r.url; }
          else html = '';
        }
      } catch (e) { /* 무시 */ }
    }

    let image = pickImage(html);
    let price = pickPrice(html);
    let title = pickTitle(html);
    let via = 'direct';

    // 2차 폴백: microlink.io (무료 미리보기 서비스 — 헤드리스 브라우저로 렌더)
    if (!image) {
      try {
        const target = /\/risk\/challenge/i.test(finalUrl) || !finalUrl ? url : finalUrl;
        const mr = await fetch('https://api.microlink.io/?url=' + encodeURIComponent(target), { headers: { 'User-Agent': UA } });
        const mj = await mr.json();
        if (mj && mj.status === 'success' && mj.data) {
          if (mj.data.image && mj.data.image.url) { image = mj.data.image.url; via = 'microlink'; }
          if (!title && mj.data.title) title = mj.data.title;
          // microlink 설명란에 가격이 섞여있는 경우
          if (!price && mj.data.description) {
            const pm = (mj.data.description).match(/₩\s*([\d,]{3,})/) || (mj.data.description).match(/([\d,]{4,})\s*원/);
            if (pm) price = pm[1].replace(/[^\d]/g, '');
          }
        }
      } catch (e) { /* 무시 */ }
    }

    return res.status(200).json({
      ok: true,
      finalUrl,
      status: r.status,
      image,
      price,
      title,
      via,
      blocked: /\/risk\/challenge/i.test(r.url || ''),
    });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
