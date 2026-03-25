import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';

const SESSION_FILE = path.resolve('./session.json');

/**
 * Launch a browser and log in to Instagram, saving the session cookie.
 * Returns { ok, error }.
 */
export async function loginInstagram(username, password) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  const page = await context.newPage();

  try {
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'networkidle' });
    await page.waitForSelector('input[name="username"]', { timeout: 10000 });

    await page.fill('input[name="username"]', username);
    await page.fill('input[name="password"]', password);
    await page.click('button[type="submit"]');

    // Wait for either home page or error
    await page.waitForURL(url => !url.includes('/accounts/login'), { timeout: 15000 });

    // Check for login error
    const errorEl = await page.$('p[data-testid="login-error-message"]');
    if (errorEl) {
      const msg = await errorEl.textContent();
      throw new Error(msg || 'Login failed');
    }

    // Save cookies
    const cookies = await context.cookies();
    await fs.writeFile(SESSION_FILE, JSON.stringify(cookies, null, 2));

    await browser.close();
    return { ok: true };
  } catch (err) {
    await browser.close();
    return { ok: false, error: err.message };
  }
}

/**
 * Fetch saved posts from Instagram using a saved session.
 * Returns array of { id, caption, mediaUrl, postUrl, timestamp, hashtags }.
 */
export async function fetchSavedPosts({ limit = 100, includeReels = true } = {}) {
  let cookies;
  try {
    cookies = JSON.parse(await fs.readFile(SESSION_FILE, 'utf8'));
  } catch {
    throw new Error('No saved session. Log in first via Settings.');
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  });
  await context.addCookies(cookies);
  const page = await context.newPage();

  const posts = [];

  try {
    // Instagram's saved posts page
    await page.goto('https://www.instagram.com/saved/', { waitUntil: 'networkidle' });

    // Intercept the GraphQL API calls Instagram makes for saved posts
    const savedPostsData = [];

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('graphql/query') && url.includes('saved')) {
        try {
          const json = await response.json();
          const edges = json?.data?.user?.edge_saved_media?.edges || [];
          savedPostsData.push(...edges);
        } catch {}
      }
    });

    // Scroll to trigger pagination
    let scrollCount = 0;
    const maxScrolls = Math.ceil(limit / 12);

    while (scrollCount < maxScrolls) {
      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(1500);
      scrollCount++;

      // Check if we've hit the end
      const noMore = await page.$('[data-testid="end-of-feed-icon"]');
      if (noMore) break;
    }

    // Also scrape visible post links as fallback
    const postLinks = await page.$$eval('a[href*="/p/"], a[href*="/reel/"]', (els) =>
      els.map(el => ({
        href: el.href,
        isReel: el.href.includes('/reel/'),
      }))
    );

    // Visit each post to get caption and metadata
    const toVisit = postLinks.slice(0, limit);
    for (const link of toVisit) {
      if (!includeReels && link.isReel) continue;

      try {
        await page.goto(link.href, { waitUntil: 'domcontentloaded', timeout: 10000 });

        const caption = await page.$eval(
          'h1, [data-testid="post-comment-root"] span, ._a9zs span',
          el => el?.textContent?.trim() || ''
        ).catch(() => '');

        const timestamp = await page.$eval(
          'time',
          el => el?.getAttribute('datetime') || ''
        ).catch(() => '');

        const imgSrc = await page.$eval(
          'article img',
          el => el?.src || ''
        ).catch(() => '');

        const hashtags = (caption.match(/#\w+/g) || []).map(h => h.toLowerCase());
        const shortcode = link.href.match(/\/(p|reel)\/([\w-]+)/)?.[2] || '';

        posts.push({
          id: shortcode,
          caption,
          hashtags,
          mediaUrl: imgSrc,
          postUrl: link.href,
          isReel: link.isReel,
          timestamp,
        });
      } catch {
        // Skip posts that fail to load
      }
    }

    await browser.close();
    return posts;
  } catch (err) {
    await browser.close();
    throw err;
  }
}
