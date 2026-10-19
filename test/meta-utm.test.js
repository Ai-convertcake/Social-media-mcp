import assert from 'node:assert/strict';
import test from 'node:test';
import { creativeLinks, getUtmLinks } from '../src/meta-utm.js';

const page1 = {
  data: [
    {
      id: '1',
      name: 'video ad',
      effective_status: 'ACTIVE',
      campaign: { name: 'C1' },
      creative: {
        id: 'c1',
        object_story_spec: { video_data: { call_to_action: { value: { link: 'http://slhp.cc/deal' } } } },
      },
    },
    {
      id: '2',
      name: 'link ad',
      effective_status: 'PAUSED',
      campaign: { name: 'C1' },
      creative: {
        id: 'c2',
        object_story_spec: { link_data: { link: 'https://slhp.cc/deal' } },
      },
    },
  ],
  paging: { next: 'https://graph.facebook.com/v23.0/act_123/ads?after=p2' },
};
const page2 = {
  data: [
    {
      id: '3',
      name: 'dynamic ad',
      effective_status: 'ACTIVE',
      campaign: { name: 'C2' },
      creative: {
        id: 'c3',
        url_tags: 'utm_source=facebook&utm_medium=paid',
        asset_feed_spec: { link_urls: [{ website_url: 'https://shop.example/p' }] },
      },
    },
    {
      id: '4',
      name: 'no utm',
      effective_status: 'ACTIVE',
      creative: { id: 'c4', object_story_spec: { link_data: { link: 'https://shop.example/' } } },
    },
  ],
};

function fakeFetch(calls) {
  return async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? 'GET' });
    const u = new URL(url);
    if (u.hostname === 'graph.facebook.com') {
      return Response.json(u.searchParams.get('after') === 'p2' ? page2 : page1);
    }
    const redirects = {
      'http://slhp.cc/deal': 'https://slhp.cc/deal',
      'https://slhp.cc/deal': 'https://shop.example/deals?utm_source=shortlink&utm_campaign=deals',
    };
    const location = redirects[String(url)];
    return new Response(null, { status: location ? 301 : 404, headers: location ? { location } : {} });
  };
}

test('collects UTM destinations across pages, resolving short links and url_tags', async () => {
  const calls = [];
  const result = await getUtmLinks({ adAccountId: 'act_123', token: 'secret', fetchImpl: fakeFetch(calls) });

  assert.equal(result.ads_checked, 4);
  assert.equal(result.ads_with_utm, 3);
  assert.equal(result.active_ads_with_utm, 2);
  assert.deepEqual(result.utm_urls, [
    {
      utm_url: 'https://shop.example/deals?utm_source=shortlink&utm_campaign=deals',
      source_links: ['http://slhp.cc/deal', 'https://slhp.cc/deal'],
      ads: 2,
      active_ads: 1,
    },
    {
      utm_url: 'https://shop.example/p?utm_source=facebook&utm_medium=paid',
      source_links: [],
      ads: 1,
      active_ads: 1,
    },
  ]);
  assert.deepEqual(result.ads.map((ad) => [ad.ad_id, ad.creative_id, ad.campaign_name]), [
    ['1', 'c1', 'C1'],
    ['2', 'c2', 'C1'],
    ['3', 'c3', 'C2'],
  ]);

  // Graph API: GET only. Short links: HEAD only, token never sent, final host never requested.
  const graph = calls.filter((c) => c.url.includes('graph.facebook.com'));
  assert.equal(graph.length, 2);
  assert.ok(graph.every((c) => c.method === 'GET'));
  const other = calls.filter((c) => !c.url.includes('graph.facebook.com'));
  assert.deepEqual(other.map((c) => c.method), ['HEAD', 'HEAD', 'HEAD']);
  assert.ok(other.every((c) => new URL(c.url).hostname === 'slhp.cc' && !c.url.includes('secret')));
});

test('rejects bad input before any request and surfaces Graph errors', async () => {
  const calls = [];
  await assert.rejects(getUtmLinks({ adAccountId: 'abc', token: 't', fetchImpl: fakeFetch(calls) }), /numeric/);
  await assert.rejects(getUtmLinks({ adAccountId: '123', token: '', fetchImpl: fakeFetch(calls) }), /META_ACCESS_TOKEN/);
  assert.equal(calls.length, 0);

  const failing = async () => Response.json({ error: { message: 'Invalid OAuth access token' } }, { status: 400 });
  await assert.rejects(getUtmLinks({ adAccountId: '123', token: 't', fetchImpl: failing }), /Invalid OAuth/);
});

test('creativeLinks reads every destination field once', () => {
  assert.deepEqual(
    creativeLinks({
      object_story_spec: {
        link_data: {
          link: 'https://a.example/',
          call_to_action: { value: { link: 'https://a.example/' } },
          child_attachments: [{ link: 'https://b.example/' }],
        },
        template_data: { link: 'https://c.example/?x=1' },
      },
      url_tags: 'utm_source=fb',
    }),
    ['https://a.example/?utm_source=fb', 'https://b.example/?utm_source=fb', 'https://c.example/?x=1&utm_source=fb'],
  );
});
