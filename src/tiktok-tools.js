import { connectTikTokAds } from './tiktok.js';

try {
  const client = await connectTikTokAds();
  try {
    console.log(JSON.stringify(await client.listTools(), null, 2));
  } finally {
    await client.close();
  }
} catch {
  console.error('TikTok connection failed. Run npm run tiktok:login to authorize or reconnect, and check network access.');
  process.exitCode = 1;
}
