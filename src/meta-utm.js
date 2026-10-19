// Read-only UTM link report for one Meta ad account, built on the Graph API directly because
// the official Meta MCP's ads_get_creatives returns an empty link_url for most creatives.
// Only GET requests go to graph.facebook.com; short links are resolved with HEAD requests
// to SHORT_LINK_HOSTS only, and the access token is never sent there.

const GRAPH = 'https://graph.facebook.com/v23.0';
const SHORT_LINK_HOSTS = new Set(['slhp.cc', 'sleephappy.me']);
const MAX_HOPS = 5;
const CREATIVE_FIELDS = 'id,link_url,url_tags,object_story_spec,asset_feed_spec';
const AD_FIELDS = `id,name,effective_status,campaign{name},creative{${CREATIVE_FIELDS}}`;

export const utmLinksTool = {
  name: 'get_utm_links',
  description:
    'List the real click-destination UTM URLs for a Meta ad account: reads every ad creative ' +
    'destination (object_story_spec, asset_feed_spec, url_tags) via the Graph API and resolves ' +
    'slhp.cc / sleephappy.me short links. Returns unique UTM URLs with ad and active-ad counts, ' +
    'plus a per-ad mapping.',
  inputSchema: {
    type: 'object',
    properties: {
      ad_account_id: { type: 'string', description: 'Ad account id, with or without the act_ prefix.' },
    },
    required: ['ad_account_id'],
  },
  annotations: { readOnlyHint: true },
};

async function graphGet(url, fetchImpl) {
  const response = await fetchImpl(url);
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.error) {
    throw new Error(`Graph API error: ${body.error?.message ?? response.status}`);
  }
  return body;
}

async function listAds(accountId, token, fetchImpl) {
  const params = new URLSearchParams({ fields: AD_FIELDS, limit: '200', access_token: token });
  let url = `${GRAPH}/act_${accountId}/ads?${params}`;
  const ads = [];
  while (url) {
    const page = await graphGet(url, fetchImpl);
    ads.push(...(page.data ?? []));
    url = page.paging?.next;
  }
  return ads;
}

// Every destination a creative can send a click to.
export function creativeLinks(creative = {}) {
  const spec = creative.object_story_spec ?? {};
  const links = [
    creative.link_url,
    spec.link_data?.link,
    spec.link_data?.call_to_action?.value?.link,
    ...(spec.link_data?.child_attachments ?? []).flatMap((c) => [c.link, c.call_to_action?.value?.link]),
    spec.video_data?.call_to_action?.value?.link,
    spec.template_data?.link,
    spec.template_data?.call_to_action?.value?.link,
    ...(creative.asset_feed_spec?.link_urls ?? []).map((l) => l.website_url),
  ];
  const tags = creative.url_tags?.trim();
  return [...new Set(links.filter(Boolean).map((link) => (tags ? withTags(link, tags) : link)))];
}

function withTags(link, tags) {
  return link + (link.includes('?') ? '&' : '?') + tags.replace(/^[?&]/, '');
}

function isShortLink(link) {
  try {
    return SHORT_LINK_HOSTS.has(new URL(link).hostname.replace(/^www\./, ''));
  } catch {
    return false;
  }
}

function hasUtm(link) {
  try {
    return [...new URL(link).searchParams.keys()].some((key) => key.startsWith('utm_'));
  } catch {
    return false;
  }
}

// Follows redirects with HEAD while they stay on short-link hosts; the first URL off those
// hosts is the destination (it is not requested).
export async function resolveShortLink(link, fetchImpl = fetch) {
  let current = link;
  for (let hop = 0; hop < MAX_HOPS && isShortLink(current); hop += 1) {
    const response = await fetchImpl(current, {
      method: 'HEAD',
      redirect: 'manual',
      signal: AbortSignal.timeout(10_000),
    });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) break;
    current = new URL(location, current).href;
  }
  return current;
}

export async function getUtmLinks({ adAccountId, token, fetchImpl = fetch }) {
  const accountId = String(adAccountId ?? '').trim().replace(/^act_/, '');
  if (!/^\d+$/.test(accountId)) throw new Error('ad_account_id must be a numeric Meta ad account id.');
  if (!token) throw new Error('META_ACCESS_TOKEN is not set on the server.');

  const ads = await listAds(accountId, token, fetchImpl);
  const resolved = new Map();
  const resolve = (link) => {
    if (!isShortLink(link)) return Promise.resolve(link);
    if (!resolved.has(link)) {
      resolved.set(link, resolveShortLink(link, fetchImpl).catch(() => link));
    }
    return resolved.get(link);
  };

  const urls = new Map();
  const perAd = [];
  for (const ad of ads) {
    const destinations = [];
    for (const link of creativeLinks(ad.creative)) {
      const utmUrl = await resolve(link);
      if (!hasUtm(utmUrl)) continue;
      destinations.push({ link, utm_url: utmUrl });
    }
    if (destinations.length === 0) continue;
    const active = ad.effective_status === 'ACTIVE';
    perAd.push({
      ad_id: ad.id,
      ad_name: ad.name,
      campaign_name: ad.campaign?.name,
      effective_status: ad.effective_status,
      creative_id: ad.creative?.id,
      destinations,
    });
    for (const utmUrl of new Set(destinations.map((d) => d.utm_url))) {
      const entry = urls.get(utmUrl) ?? { utm_url: utmUrl, source_links: new Set(), ads: 0, active_ads: 0 };
      for (const d of destinations) if (d.utm_url === utmUrl && d.link !== utmUrl) entry.source_links.add(d.link);
      entry.ads += 1;
      if (active) entry.active_ads += 1;
      urls.set(utmUrl, entry);
    }
  }

  const utmUrls = [...urls.values()]
    .map((entry) => ({ ...entry, source_links: [...entry.source_links] }))
    .sort((a, b) => b.ads - a.ads || a.utm_url.localeCompare(b.utm_url));
  return {
    ad_account_id: accountId,
    ads_checked: ads.length,
    ads_with_utm: perAd.length,
    active_ads_with_utm: perAd.filter((ad) => ad.effective_status === 'ACTIVE').length,
    unique_utm_urls: utmUrls.length,
    utm_urls: utmUrls,
    ads: perAd,
  };
}
