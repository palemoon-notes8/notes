'use strict';

import { DurableObject } from 'cloudflare:workers';

// Hourly collector commits fresh data files here; deployed assets are the fallback.
const RAW_BASES = [
  'https://raw.githubusercontent.com/palemoon-notes8/notes/main/public'
];
// Background collectors keep copies of tender details (data branch) and award details (main).
const REPO_RAW = 'https://raw.githubusercontent.com/palemoon-notes8/notes';
const KPPP_BASE = 'https://kppp.karnataka.gov.in';
const KPPP_WORKS = KPPP_BASE + '/supplier-registration-service/v1/api/portal-service/works/search-eproc-tenders';

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36';

function json(payload, status = 200, cache = 'no-store') {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': cache,
      'Access-Control-Allow-Origin': '*'
    }
  });
}

async function proxyRaw(filename, ctx, ttl = 60, env = null) {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-data.local/${filename}`, { method: 'GET' });
  let response = await cache.match(cacheKey);
  if (response) return response;

  const headersFor = (source) => new Headers({
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`,
    'Access-Control-Allow-Origin': '*',
    'X-KPPP-Data-Source': source
  });

  // Stream the data files as they are — do NOT JSON.parse them here (CPU/memory limit).
  const tryUpstream = async (sourceUrl) => {
    const upstream = await fetch(sourceUrl, {
      headers: { Accept: 'application/json' },
      cf: { cacheEverything: true, cacheTtl: ttl }
    });
    if (!upstream.ok) return null;
    const ctype = String(upstream.headers.get('content-type') || '');
    if (ctype.includes('text/html')) return null;
    return new Response(upstream.body, { status: 200, headers: headersFor(sourceUrl) });
  };

  for (const base of RAW_BASES) {
    try {
      response = await tryUpstream(`${base}/${filename}?ts=${Date.now()}`);
      if (response) break;
    } catch {}
  }

  if (!response && env?.ASSETS) {
    try {
      const assetResp = await env.ASSETS.fetch(new Request(`https://assets.local/${filename}`));
      if (assetResp.ok) {
        response = new Response(assetResp.body, {
          status: 200,
          headers: headersFor('assets')
        });
      }
    } catch {}
  }

  if (!response) return json({ success: false, message: `${filename} is temporarily unavailable.` }, 502);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

const KPPP_API = KPPP_BASE + '/supplier-registration-service/v1/api/portal-service';
// KPPP's own tender page loads these per-category endpoints without a login.
const SECTIONS = {
  WORKS: { view: 'works-tender-full-view', info: 'get-works-tender-general-info', files: 'get-works-tender-files', file: 'works-tender-file' },
  GOODS: { view: 'goods-tender-full-view', info: 'get-goods-tender-general-info', files: 'get-goods-tender-files', file: 'goods-tender-file' },
  SERVICES: { view: 'service-tender-full-view', info: 'get-services-tender-general-info', files: 'get-services-tender-files', file: 'services-tender-file' }
};
const KPPP_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  Origin: KPPP_BASE,
  Referer: KPPP_BASE + '/',
  Post: 'CONTRACTOR-EPROC-CONTRACTOR',
  'User-Agent': USER_AGENT
};

// KPPP is sometimes slow or briefly fails, so each call has a time limit and is retried.
async function kpppJson(path, { timeoutMs = 20000, tries = 2 } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= tries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${KPPP_API}/${path}`, { headers: KPPP_HEADERS, signal: controller.signal, cf: { cacheTtl: 1800, cacheEverything: true } });
      if (!response.ok) throw new Error(`KPPP returned HTTP ${response.status}`);
      return await response.json();
    } catch (error) {
      lastError = controller.signal.aborted ? new Error(`KPPP took longer than ${timeoutMs / 1000}s`) : error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError;
}

const clean = (v) => {
  const text = String(v ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  return text || null;
};
const amount = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};
const list = (v) => (Array.isArray(v) ? v : []);

// Reshape KPPP's full view into only what the tender page shows.
function shapeTender(category, full, files, nitId) {
  const nit = full.noticeInvitingTenderDTO || {};
  const sched = full.tenderSchedule || {};
  const addr = full.tenderAddress || {};
  const eligibility = [...list(full.generalCriterionList), ...list(full.tenderEligibilityCriterionList)]
    .filter((c) => !c.criterionType || c.criterionType === 'ELIGIBILITY')
    .map((c) => clean(c.description)).filter(Boolean);
  const technical = [...list(full.technicalCriterionList), ...list(full.tenderTechnicalCriterionList)].map((c) => ({
    category: clean(c.criterionCategoryText),
    text: clean(c.criterionTypeOthersValue && c.criterionCategoryText === 'Others' ? c.criterionTypeOthersValue : c.description),
    weight: amount(c.weight),
    documents: list(c.tenderTechnicalCriterionDocumentList).map((d) => clean(d.documentName)).filter(Boolean)
  })).filter((c) => c.text);
  const documents = list(full.tenderCriterionDocumentList).map((d) => ({
    name: clean(d.documentName), cover: clean(d.documentTypeText), optional: Boolean(d.optional)
  })).filter((d) => d.name);

  let groups = [];
  if (category === 'WORKS') {
    groups = list(full.tenderSubEstimateList).map((g) => ({
      name: clean(g.subEstimateName), note: clean(g.workCategoryName), total: amount(g.estimateTotal),
      items: list(g.itemList).filter((i) => !i.hideYn).map((i) => ({
        code: clean(i.itemCode), section: clean(i.categoryName), name: clean(i.description),
        qty: amount(i.quantity), unit: clean(i.uomName), rate: amount(i.finalRate ?? i.baseRate), amount: amount(i.netAmount)
      }))
    }));
  } else {
    groups = list(full.tenderGroups).map((g) => ({
      name: clean(g.groupName === 'Default' ? null : g.groupName), total: null,
      items: list(g.itemList).map((i) => ({
        code: clean(i.itemCode), name: clean(i.itemName), spec: clean(i.specifications),
        qty: amount(i.quantity), unit: clean(i.uomName || i.biddingUnit),
        rate: amount(i.price ?? i.estimateUnitRate), amount: amount(i.netAmt ?? i.estimateItemPrice)
      }))
    }));
  }

  return {
    success: true,
    nit: String(nitId),
    ref: clean(sched.tenderNumber),
    description: clean(sched.description),
    fileNumber: clean(sched.fileNumber),
    dates: {
      published: clean(nit.publishedDate),
      queries: clean(nit.tenderQueryClose),
      preBid: nit.preBidMeetingYn ? clean(nit.preBidMeetingDate) : null,
      submission: clean(nit.tenderReceiptClose),
      opening: clean(nit.technicalBidOpen)
    },
    money: {
      emd: amount(nit.emd), emdCash: amount(nit.emdCash), emdGuarantee: amount(nit.emdBankGuarantee),
      fee: amount(nit.tenderFee), provisional: amount(sched.provisionalAmount)
    },
    terms: {
      evaluation: clean(nit.evaluationTypeText),
      bidType: clean(nit.bidValueTypeText),
      tax: nit.taxType ? clean(String(nit.taxType).replace(/_/g, ' ').toLowerCase()) : null,
      validityDays: amount(nit.bidValidityPeriod),
      call: amount(nit.noOfCalls),
      retender: Boolean(nit.retenderedYn),
      techWeight: nit.hideWeightage ? null : amount(nit.techWeightage)
    },
    contact: {
      person: clean(nit.contactPerson),
      mobile: clean(nit.mobileNumber),
      address: [addr.blockNumber, addr.street, addr.area, addr.city, addr.state, addr.pin].map(clean).filter(Boolean).join(', ') || null
    },
    eligibility,
    technical,
    documents,
    groups,
    files: list(files).map((f) => ({
      name: clean(f.fileName), type: clean(f.documentType),
      url: `/api/tender-file/${category}/${nitId}/${encodeURIComponent(f.uuid)}?name=${encodeURIComponent(f.fileName || 'document')}`
    })).filter((f) => f.name)
  };
}

// The copy collected in the background by collect_details.py, if there is one.
async function storedDetail(category, nitId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6000);
  try {
    const response = await fetch(`${REPO_RAW}/data/details/${category}/${nitId}.json`, { signal: controller.signal, cf: { cacheTtl: 300, cacheEverything: true } });
    if (!response.ok) return null;
    const stored = await response.json();
    return stored && stored.full ? stored : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function savedConditions(nitId) {
  try {
    const upstream = await fetch(`${REPO_RAW}/main/data/awards/${nitId}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!upstream.ok) return null;
    const award = await upstream.json();
    return award.tender && award.tender.noticeInvitingTenderDTO ? award.tender : null;
  } catch {
    return null;
  }
}

async function tenderDetail(category, nitId, ctx) {
  const section = SECTIONS[category];
  if (!section || !/^\d+$/.test(nitId)) return json({ success: false, message: 'Unknown tender.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-detail.local/v3/${category}/${nitId}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let shaped;
  const stored = await storedDetail(category, nitId);
  if (stored) {
    shaped = { ...shapeTender(category, stored.full, [], nitId), checkedAt: stored.fetched || null, changes: list(stored.changes), past: stored.past || null };
    delete shaped.files;
    const response = json(shaped, 200, 'public, max-age=600, s-maxage=600');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  // A past result: its conditions were saved with the award (collect_results.py), no need to ask KPPP.
  const saved = await savedConditions(nitId);
  if (saved) {
    shaped = { ...shapeTender(category, saved, [], nitId), checkedAt: null };
    delete shaped.files;
    const response = json(shaped, 200, 'public, max-age=86400, s-maxage=86400');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  try {
    shaped = shapeTender(category, await kpppJson(`${nitId}/${section.view}`), [], nitId);
  } catch (fullError) {
    // Fall back to the small "general info" call: dates, money, terms and contact, without lists.
    try {
      const info = await kpppJson(`${nitId}/${section.info}`, { timeoutMs: 12000 });
      shaped = { ...shapeTender(category, { noticeInvitingTenderDTO: info.invitingTenderDTO, tenderSchedule: info.tenderScheduleDTO }, [], nitId), partial: true };
    } catch {
      return json({ success: false, message: `Could not load details from KPPP (${String(fullError.message || fullError).slice(0, 80)}).` }, 502);
    }
  }
  delete shaped.files;
  const response = json(shaped, 200, `public, max-age=${shaped.partial ? 120 : 1800}, s-maxage=${shaped.partial ? 120 : 1800}`);
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// The documents list can take KPPP 30s+, so it is fetched separately from the details.
async function tenderFiles(category, nitId, ctx) {
  const section = SECTIONS[category];
  if (!section || !/^\d+$/.test(nitId)) return json({ success: false, message: 'Unknown tender.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-files.local/v2/${category}/${nitId}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const stored = await storedDetail(category, nitId);
  if (stored && Array.isArray(stored.files)) {
    const response = json({ success: true, files: shapeTender(category, {}, stored.files, nitId).files }, 200, 'public, max-age=600, s-maxage=600');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  }
  try {
    const files = await kpppJson(`${nitId}/${section.files}`, { timeoutMs: 45000 });
    const response = json({ success: true, files: shapeTender(category, {}, files, nitId).files }, 200, 'public, max-age=21600, s-maxage=21600');
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json({ success: false, message: `KPPP did not send the documents list (${String(error.message || error).slice(0, 80)}).` }, 502);
  }
}

async function tenderFile(category, nitId, uuid, name, forceDownload = false) {
  const section = SECTIONS[category];
  if (!section || !/^\d+$/.test(nitId) || !/^[0-9a-f-]{36}$/i.test(uuid)) return json({ success: false, message: 'Unknown file.' }, 400);
  const upstream = await fetch(`${KPPP_API}/${nitId}/${section.file}/${uuid}/download-file`, { headers: { ...KPPP_HEADERS, Accept: '*/*' } });
  if (!upstream.ok) return json({ success: false, message: `KPPP returned HTTP ${upstream.status} for this file.` }, 502);
  const safeName = String(name || 'tender-document').replace(/[^\w.\- ()&]+/g, '_').slice(0, 150);
  // KPPP sends every file as octet-stream; label PDFs so the browser can open them directly.
  const isPdf = /\.pdf$/i.test(safeName);
  const inline = isPdf && !forceDownload;
  return new Response(upstream.body, {
    headers: {
      'Content-Type': isPdf ? 'application/pdf' : (upstream.headers.get('content-type') || 'application/octet-stream'),
      'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
      'Cache-Control': 'public, max-age=86400'
    }
  });
}

// Award details (timeline, officers, every bidder's item rates) saved by collect_results.py.
async function awardDetail(nitId, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-award.local/v1/${nitId}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  try {
    const upstream = await fetch(`${REPO_RAW}/main/data/awards/${nitId}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (!upstream.ok) return json({ success: false, message: 'Award details are not collected for this tender yet.' }, 404, 'public, max-age=300');
    const response = new Response(upstream.body, {
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600, s-maxage=3600', 'Access-Control-Allow-Origin': '*' }
    });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (error) {
    return json({ success: false, message: 'Award details are unavailable right now.' }, 502);
  }
}

// Works history (collect_history.py): comparison figures and Excel downloads, streamed as-is.
const HISTORY_TYPES = { json: 'application/json; charset=utf-8', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' };
async function historyFile(path, ctx, ttl, download = false, branch = 'history') {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-history.local/v1/${branch}/${path}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let upstream;
  try {
    upstream = await fetch(`${REPO_RAW}/${branch}/${path}`, { cf: { cacheTtl: ttl, cacheEverything: true } });
  } catch {}
  if (!upstream || !upstream.ok) return json({ success: false, message: 'Past works history is still being collected.' }, 404, 'public, max-age=120');
  const ext = path.split('.').pop();
  const headers = { 'Content-Type': HISTORY_TYPES[ext] || 'application/octet-stream', 'Cache-Control': `public, max-age=${ttl}, s-maxage=${ttl}`, 'Access-Control-Allow-Origin': '*' };
  if (download) headers['Content-Disposition'] = `attachment; filename="${path.split('/').pop()}"`;
  const response = new Response(upstream.body, { headers });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// A bidder's record across the whole works history (collect_history.py build_contractors).
// KPPP writes one bidder in several ways; this key matches name_key() there and nameKey() in app.js.
const nameKey = (n) => String(n || '').toUpperCase().replace(/\(\s*\d+\s*\)/g, ' ').replace(/[^A-Z0-9()]+/g, ' ').replace(/\s+/g, ' ').trim();
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
function crc32(text) {
  let c = 0xffffffff;
  for (const byte of new TextEncoder().encode(text)) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
// One office's awarded works of the last 3 years (collect_history.py write_offices).
async function officeWorks(name, ctx) {
  const office = String(name || '').trim();
  if (!office || office.length > 300) return json({ success: false, message: 'Unknown office.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-office.local/v1/${encodeURIComponent(office)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const shard = (crc32(office) & 0xff).toString(16).padStart(2, '0');
  let entries = null;
  try {
    const upstream = await fetch(`${REPO_RAW}/history/offices/${shard}.json`, { cf: { cacheTtl: 1800, cacheEverything: true } });
    if (upstream.ok) entries = await upstream.json();
  } catch {}
  if (!entries) return json({ success: false, message: 'Office history is not ready yet.' }, 404, 'public, max-age=300');
  const response = json({ success: true, office, works: entries[office] || [] }, 200, 'public, max-age=3600, s-maxage=3600');
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

async function contractorRecord(name, ctx) {
  const key = nameKey(name);
  if (!key || key.length > 200) return json({ success: false, message: 'Unknown contractor.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-contractor.local/v1/${encodeURIComponent(key)}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const shard = (crc32(key) & 0xff).toString(16).padStart(2, '0');
  let entries = null;
  try {
    const upstream = await fetch(`${REPO_RAW}/history/contractors/${shard}.json`, { cf: { cacheTtl: 1800, cacheEverything: true } });
    if (upstream.ok) entries = await upstream.json();
  } catch {}
  if (!entries) return json({ success: false, message: 'The full history is still being collected.' }, 404, 'public, max-age=300');
  const record = entries[key];
  const response = record
    ? json({ success: true, key, ...record }, 200, 'public, max-age=3600, s-maxage=3600')
    : json({ success: false, message: 'No past bids found for this name.' }, 404, 'public, max-age=3600');
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// Item-wise Excel files (one per month) live in the "itemwise" GitHub release, not the repository.
async function itemwiseFile(file, ctx) {
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-itemwise.local/v1/${file}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  let upstream;
  try {
    upstream = await fetch(`https://github.com/palemoon-notes8/notes/releases/download/itemwise/${file}`, { redirect: 'follow' });
  } catch {}
  if (!upstream || !upstream.ok) return json({ success: false, message: 'This item-wise file is not ready yet.' }, 404, 'public, max-age=120');
  const response = new Response(upstream.body, {
    headers: {
      'Content-Type': HISTORY_TYPES.xlsx,
      'Content-Disposition': `attachment; filename="${file}"`,
      'Cache-Control': 'private, max-age=21600'
    }
  });
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

// One past tender's bidders and item-wise rates (collect_history.py write_tender_bids).
async function tenderBids(nit, month, ctx) {
  if (!/^\d+$/.test(nit) || !/^\d{4}-\d{2}$/.test(month || '')) return json({ success: false, message: 'Unknown tender.' }, 400);
  const cache = caches.default;
  const cacheKey = new Request(`https://kppp-bids.local/v1/${month}/${nit}`);
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  const bucket = (crc32(nit) % 128).toString(16).padStart(2, '0');
  let data = null;
  try {
    const upstream = await fetch(`${REPO_RAW}/history/bids/${month}/${bucket}.json`, { cf: { cacheTtl: 3600, cacheEverything: true } });
    if (upstream.ok) data = await upstream.json();
  } catch {}
  const entry = data?.[nit];
  if (!entry) return json({ success: false, message: 'Bids for this tender are not collected yet.' }, 404, 'private, max-age=300');
  const response = json({ success: true, nit, bidders: entry.b || [], items: entry.i || [] }, 200, 'private, max-age=86400');
  ctx.waitUntil(cache.put(cacheKey, response.clone()));
  return response;
}

function ageHours(value) {
  const ms = Date.parse(String(value || ''));
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, (Date.now() - ms) / 3600000);
}

async function systemHealth(ctx, env = {}) {
  let snapshot = {};
  try {
    const response = await proxyRaw('health.json', ctx, 30, env);
    if (response.ok) snapshot = await response.json();
  } catch {}
  const stamp = snapshot.last_success_at || snapshot.generated_at;
  const age = ageHours(stamp);
  const count = Number(snapshot.count || 0);
  const counts = snapshot.category_counts || {};
  const database = {
    ok: count > 0 && age !== null && age <= 6,
    status: age !== null && age <= 2 ? 'fresh' : (age !== null && age <= 6 ? 'stale' : 'very_stale'),
    age_hours: age === null ? null : Math.round(age * 100) / 100,
    count,
    emd_known: Number(snapshot.emd_known || 0),
    category_counts: {
      WORKS: Number(counts.WORKS || 0),
      GOODS: Number(counts.GOODS || 0),
      SERVICES: Number(counts.SERVICES || 0)
    },
    generated_at: snapshot.generated_at || null,
    last_success_at: snapshot.last_success_at || null,
    collector: snapshot
  };

  const kppp = await (async () => {
    try {
      const response = await fetch(KPPP_WORKS + '?page=0&size=1&order-by-tender-publish=true', {
        method: 'POST',
        headers: {
          Accept: 'application/json, text/plain, */*',
          'Content-Type': 'application/json',
          Origin: KPPP_BASE,
          Referer: KPPP_BASE + '/',
          Post: 'CONTRACTOR-EPROC-CONTRACTOR',
          'User-Agent': USER_AGENT
        },
        body: JSON.stringify({ category: 'WORKS', status: 'PUBLISHED', title: '' })
      });
      const reported = Number(response.headers.get('X-Total-Count'));
      return { ok: response.ok, http: response.status, reported_works: Number.isFinite(reported) && reported > 0 ? reported : null };
    } catch (error) { return { ok: false, error: String(error).slice(0, 160) }; }
  })();

  return json({
    success: true,
    checked_at: new Date().toISOString(),
    overall: database.ok && kppp.ok ? 'healthy' : 'attention',
    database,
    kppp,
    hosting: { platform: 'Cloudflare Workers', live_data_source: 'GitHub hourly collector + deployed assets fallback' }
  }, 200, 'public, max-age=60, s-maxage=60');
}

// ---------- Private site: one password, remembered on each device for a year ----------
// Only a hash of a hash of the password is stored here, so the code being public does not reveal it.
const SESSION_CHECK = '957ec036a47b5f8c5ee58bd189b81bb1e31bcdb6b3abebe77f55adedbfd1ad9b';
const SESSION_COOKIE = 't1s';
// The sign-in page lives at a secret address; only its hash is here. Everyone else gets a plain 404.
const LOGIN_PATH_HASH = '0bc8a761dcf1cef08cc1c26a64e060303bf218d4f466a2e7e86f540ea2617b67';
const OPEN_PATHS = new Set(['/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-512.png', '/icons/apple-touch-icon.png',
  '/finance/icon-192.png', '/finance/icon-512.png', '/finance/maskable-512.png']);
function notFound() {
  return new Response('<!doctype html><html><head><meta name="robots" content="noindex"><title>404 Not Found</title></head><body><h1>404 Not Found</h1></body></html>', {
    status: 404, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Robots-Tag': 'noindex, nofollow' }
  });
}
async function sha256Hex(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
function readCookie(request, name) {
  const match = (request.headers.get('Cookie') || '').match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`));
  return match ? match[1] : null;
}
async function signedIn(request) {
  const token = readCookie(request, SESSION_COOKIE);
  return Boolean(token && /^[0-9a-f]{64}$/.test(token) && (await sha256Hex(token)) === SESSION_CHECK);
}
function loginPage(message = '', status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sign in</title><meta name="robots" content="noindex"><meta name="theme-color" content="#3730a3">
<style>
  *{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:linear-gradient(135deg,#312e81,#6d28d9);color:#0e1330;padding:16px}
  form{background:#fff;border-radius:18px;padding:28px 24px;width:100%;max-width:380px;box-shadow:0 20px 50px rgba(0,0,0,.25);display:grid;gap:14px}
  h1{margin:0;font-size:22px}p{margin:0;color:#5b6285;font-size:14px;line-height:1.5}
  input{width:100%;height:48px;border:1px solid #d9dcea;border-radius:12px;padding:0 14px;font-size:16px}
  input:focus{outline:2px solid #4f46e5;border-color:transparent}
  button{height:48px;border:0;border-radius:12px;background:linear-gradient(90deg,#4f46e5,#7c3aed);color:#fff;font-size:16px;font-weight:700;cursor:pointer}
  .err{color:#dc2626;font-weight:600}
  .logo{width:44px;height:44px;border-radius:12px;background:linear-gradient(135deg,#4f46e5,#7c3aed);display:grid;place-items:center;color:#fff;font-weight:800;font-size:22px}
</style></head><body>
<form method="post">
  <div class="logo">T</div>
  <h1>TenderOne</h1>
  <p>Private website. Enter your password once — this device stays signed in for a year.</p>
  ${message ? `<p class="err">${message}</p>` : ''}
  <input type="password" name="password" autocomplete="current-password" placeholder="Password" required autofocus>
  <button type="submit">Sign in</button>
</form></body></html>`;
  return new Response(html, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } });
}
async function handleLogin(request) {
  let password = '';
  try { password = String((await request.formData()).get('password') || '').trim(); } catch {}
  const token = await sha256Hex('tenderone-session:' + password);
  if ((await sha256Hex(token)) !== SESSION_CHECK) return loginPage('That password is not right. Please try again.', 401);
  return new Response(null, {
    status: 303,
    headers: { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=${token}; Path=/; Max-Age=31536000; HttpOnly; Secure; SameSite=Lax`, 'Cache-Control': 'no-store' }
  });
}

// Your own lists (saved tenders and results, notes, watched contractors, profile), kept in your
// Cloudflare account so every phone and computer you sign in on shows the same ones.
const PREF_KEYS = new Set(['kppp_saved_tenders', 'tenderone_saved_results', 'tenderone_notes', 'tenderone_watch', 'tenderone_profile', 'tenderone_prep', 'tenderone_costs']);
export class Prefs extends DurableObject {
  async read() {
    return (await this.ctx.storage.get('prefs')) || {};
  }
  // Newest change wins, one list at a time.
  async merge(incoming) {
    const current = await this.read();
    for (const [key, entry] of Object.entries(incoming)) {
      if (!current[key] || entry.t > current[key].t) current[key] = entry;
    }
    await this.ctx.storage.put('prefs', current);
    return current;
  }
  // Saved AI summaries of tenders, so each is made once.
  async getSummary(key) {
    return (await this.ctx.storage.get(`sum:${key}`)) || null;
  }
  async putSummary(key, value) {
    await this.ctx.storage.put(`sum:${key}`, value);
  }
  // My Money (/finance/): one stored entry per record, newest change wins. Deleted records stay
  // as small markers so the deletion reaches every device.
  async financeAll() {
    return [...(await this.ctx.storage.list({ prefix: 'fin:' })).values()];
  }
  async financeMerge(records) {
    const keys = [...new Set(records.map((r) => `fin:${r.id}`))];
    const current = new Map();
    for (let i = 0; i < keys.length; i += 128) {
      for (const [key, value] of await this.ctx.storage.get(keys.slice(i, i + 128))) current.set(key, value);
    }
    const updates = new Map();
    for (const r of records) {
      const key = `fin:${r.id}`;
      const have = updates.get(key) || current.get(key);
      if (!have || r.t > have.t) updates.set(key, r);
    }
    const entries = [...updates];
    for (let i = 0; i < entries.length; i += 128) await this.ctx.storage.put(Object.fromEntries(entries.slice(i, i + 128)));
    return this.financeAll();
  }
}

// A short plain-language summary of a tender's conditions, made by Cloudflare's built-in AI (free daily
// allowance). Made only when asked, then kept in the Prefs store.
const SUMMARY_MODELS = [
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
  '@cf/meta/llama-4-scout-17b-16e-instruct',
  '@cf/mistralai/mistral-small-3.1-24b-instruct',
  '@cf/meta/llama-3.1-8b-instruct-fast',
  '@cf/meta/llama-3.1-8b-instruct',
];
const SUMMARY_PROMPT = 'You summarise Karnataka government tender conditions for a small contractor. Use ONLY the facts given; never guess numbers, dates or requirements that are not there. Reply in simple English as 4 to 7 short bullet points starting with "- ": what the work is; money (sanctioned amount, EMD, fee); who can bid (registration class, experience, turnover, reservation); certificates or documents they must submit; key dates; and anything unusual or risky (re-tender, pre-bid meeting, site visit, strict conditions). No introduction, no closing line.';
async function tenderSummary(category, nitId, env, ctx) {
  if (!SECTIONS[category] || !/^\d+$/.test(nitId)) return json({ success: false, message: 'Unknown tender.' }, 400);
  if (!env.AI || !env.PREFS) return json({ success: false, message: 'AI summaries are not set up.' }, 503);
  const store = env.PREFS.get(env.PREFS.idFromName('me'));
  const key = `${category}/${nitId}`;
  const saved = await store.getSummary(key);
  if (saved) return json({ success: true, saved: true, ...saved });
  const detail = await (await tenderDetail(category, nitId, ctx)).json().catch(() => null);
  if (!detail?.success) return json({ success: false, message: 'The tender details could not be read from KPPP right now.' }, 502);
  const m = detail.money || {};
  const d = detail.dates || {};
  const lines = [
    `Work: ${detail.description || ''} (${detail.ref || ''})`,
    m.provisional ? `Sanctioned amount: Rs ${m.provisional}` : '',
    m.emd ? `EMD: Rs ${m.emd}` : '', m.fee ? `Tender fee: Rs ${m.fee}` : '',
    d.submission ? `Bid submission ends: ${d.submission}` : '', d.opening ? `Bids open: ${d.opening}` : '',
    d.preBid ? `Pre-bid meeting: ${d.preBid}` : '',
    detail.terms?.call > 1 ? `This is call number ${detail.terms.call} (re-tender).` : '',
    detail.terms?.evaluation ? `Evaluation: ${detail.terms.evaluation}` : '',
    ...(detail.eligibility || []).map((e) => `Eligibility: ${e}`),
    ...(detail.technical || []).map((t) => `Technical condition (${t.category || 'general'}): ${t.text}${t.documents?.length ? ` [documents: ${t.documents.join('; ')}]` : ''}`),
    ...(detail.documents || []).filter((x) => !x.optional).map((x) => `Required document: ${x.name}`),
  ].filter(Boolean).join('\n').slice(0, 9000);
  const messages = [
    { role: 'system', content: SUMMARY_PROMPT },
    { role: 'user', content: lines },
  ];
  // Models are tried in turn: Cloudflare retires older ones, and any of these is free within the allowance.
  let text = '';
  const errors = [];
  for (const model of SUMMARY_MODELS) {
    try {
      const out = await env.AI.run(model, { max_tokens: 500, messages });
      text = String(out?.response ?? out?.result?.response ?? out?.choices?.[0]?.message?.content ?? '').trim();
      if (text) break;
      errors.push(`${model}: empty answer`);
    } catch (error) {
      const why = String(error?.message || error);
      errors.push(`${model.split('/').pop()}: ${why.slice(0, 120)}`);
      if (/limit|quota|neuron|429|4006/i.test(why)) {
        return json({ success: false, message: 'Today\'s free AI allowance is used up. Try again tomorrow.' }, 429);
      }
    }
  }
  if (!text) return json({ success: false, message: `The AI could not make a summary right now (${errors.join(' | ').slice(0, 400)}).` }, 502);
  const value = { text, at: new Date().toISOString() };
  ctx.waitUntil(store.putSummary(key, value));
  return json({ success: true, saved: false, ...value });
}

async function prefs(request, env) {
  if (!env.PREFS) return json({ success: false, message: 'Sync is not set up.' }, 503);
  const stub = env.PREFS.get(env.PREFS.idFromName('me'));
  if (request.method === 'GET') return json(await stub.read());
  if (request.method !== 'PUT') return json({ success: false, message: 'Method not allowed.' }, 405);
  const text = await request.text();
  if (text.length > 1_000_000) return json({ success: false, message: 'Too large.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ success: false, message: 'Bad data.' }, 400); }
  const clean = {};
  for (const [key, entry] of Object.entries(body || {})) {
    if (PREF_KEYS.has(key) && entry && Number.isFinite(entry.t) && 'v' in entry) clean[key] = { t: entry.t, v: entry.v };
  }
  return json(await stub.merge(clean));
}

// My Money records (see public/finance/app.js): GET returns them all, PUT merges changed ones.
const FINANCE_KINDS = new Set(['tx', 'acc', 'cat', 'bill', 'due']);
async function finance(request, env) {
  if (!env.PREFS) return json({ success: false, message: 'Sync is not set up.' }, 503);
  const stub = env.PREFS.get(env.PREFS.idFromName('me'));
  if (request.method === 'GET') return json({ success: true, records: await stub.financeAll() });
  if (request.method !== 'PUT') return json({ success: false, message: 'Method not allowed.' }, 405);
  const text = await request.text();
  if (text.length > 2_000_000) return json({ success: false, message: 'Too large.' }, 413);
  let body;
  try { body = JSON.parse(text); } catch { return json({ success: false, message: 'Bad data.' }, 400); }
  const records = (Array.isArray(body?.records) ? body.records : []).filter((r) => r && typeof r === 'object'
    && typeof r.id === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(r.id) && FINANCE_KINDS.has(r.k)
    && Number.isFinite(r.t) && JSON.stringify(r).length <= 4000).slice(0, 2000);
  return json({ success: true, records: await stub.financeMerge(records) });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,OPTIONS', 'Access-Control-Allow-Headers': '*' } });
    }

    if ((await sha256Hex(url.pathname)) === LOGIN_PATH_HASH) {
      if (request.method === 'POST') return handleLogin(request);
      return (await signedIn(request)) ? Response.redirect(new URL('/', url).toString(), 302) : loginPage();
    }
    if (url.pathname === '/logout') {
      return new Response(null, { status: 303, headers: { Location: '/', 'Set-Cookie': `${SESSION_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax` } });
    }
    const allowed = OPEN_PATHS.has(url.pathname) || (await signedIn(request));
    if (!allowed) return notFound();
    if (url.pathname === '/api/prefs') return prefs(request, env);
    if (url.pathname === '/api/finance') return finance(request, env);
    const summary = url.pathname.match(/^\/api\/summary\/(WORKS|GOODS|SERVICES)\/(\d+)$/);
    if (summary) return tenderSummary(summary[1], summary[2], env, ctx);
    if (request.method !== 'GET' && request.method !== 'HEAD') return json({ success: false, message: 'Method not allowed.' }, 405);

    if (['/tenders-lite.json', '/results-lite.json', '/rates-lite.json'].includes(url.pathname)) {
      return proxyRaw(url.pathname.slice(1), ctx, 300, env);
    }
    if (url.pathname === '/history-index.json') return historyFile('index.json', ctx, 600);
    if (url.pathname === '/similar-lite.json') return historyFile('similar.json', ctx, 1800);
    if (url.pathname === '/leaders.json') return historyFile('leaders.json', ctx, 1800);
    if (url.pathname === '/bidders.json') return historyFile('bidders.json', ctx, 1800);
    if (url.pathname === '/quick.json') return historyFile('quick.json', ctx, 1800);
    if (url.pathname === '/competitors.json') return historyFile('competitors.json', ctx, 1800);
    if (url.pathname === '/districts.json') return historyFile('districts.json', ctx, 1800);
    if (url.pathname === '/api/office') return officeWorks(url.searchParams.get('name'), ctx);
    if (url.pathname === '/reserved.json') return historyFile('details/reserved.json', ctx, 600, false, 'data');
    if (url.pathname === '/paperwork.json') return historyFile('details/paperwork.json', ctx, 600, false, 'data');
    const bids = url.pathname.match(/^\/api\/tender-bids\/(\d+)$/);
    if (bids) return tenderBids(bids[1], url.searchParams.get('m'), ctx);
    const itemwise = url.pathname.match(/^\/downloads\/(itemwise-\d{4}-\d{2}\.xlsx)$/);
    if (itemwise) return itemwiseFile(itemwise[1], ctx);
    const download = url.pathname.match(/^\/downloads\/(works-[a-z0-9-]+\.xlsx)$/);
    if (download) return historyFile(`excel/${download[1]}`, ctx, 1800, true);
    if (url.pathname === '/health.json') return proxyRaw('health.json', ctx, 30, env);
    if (url.pathname === '/api/system_health') return systemHealth(ctx, env);
    const detail = url.pathname.match(/^\/api\/tender\/(WORKS|GOODS|SERVICES)\/(\d+)$/);
    if (detail) return tenderDetail(detail[1], detail[2], ctx);
    if (url.pathname === '/api/contractor') return contractorRecord(url.searchParams.get('name'), ctx);
    const award = url.pathname.match(/^\/api\/award\/(\d+)$/);
    if (award) return awardDetail(award[1], ctx);
    const fileList = url.pathname.match(/^\/api\/tender-files\/(WORKS|GOODS|SERVICES)\/(\d+)$/);
    if (fileList) return tenderFiles(fileList[1], fileList[2], ctx);
    const file = url.pathname.match(/^\/api\/tender-file\/(WORKS|GOODS|SERVICES)\/(\d+)\/([0-9a-fA-F-]+)$/);
    if (file) return tenderFile(file[1], file[2], file[3], url.searchParams.get('name'), url.searchParams.has('dl'));
    // Old bookmarks to the removed login/admin pages go to the tender list.
    if (['/login.html', '/admin', '/admin.html'].includes(url.pathname)) {
      return Response.redirect(new URL('/', url).toString(), 301);
    }
    if (url.pathname.startsWith('/api/')) {
      return json({ success: false, message: 'Not found.' }, 404);
    }
    return env.ASSETS.fetch(request);
  }
};
