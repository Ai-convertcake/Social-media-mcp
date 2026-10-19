import { connectGoogleAds } from './google.js';

try {
  const client = await connectGoogleAds();
  try {
    console.log(JSON.stringify(await client.listTools(), null, 2));
  } finally {
    await client.close();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
