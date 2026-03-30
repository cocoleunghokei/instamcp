import { chromium } from 'playwright';
import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.NODE_ENV === 'production'
  ? path.join(__dirname, 'data')
  : path.resolve('.');
const SESSION_FILE = path.join(DATA_DIR, 'session.json');

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
    // domcontentloaded is faster and more reliable than networkidle on Instagram
    await page.goto('https://www.instagram.com/accounts/login/', { waitUntil: 'domcontentloaded' });

    // Dismiss cookie consent dialog if present (common in EU / first visit)
    try {
      const cookieBtn = page.getByRole('button', { name: /allow all cookies|accept all|only allow essential/i });
      await cookieBtn.waitFor({ timeout: 4000 });
      await cookieBtn.click();
    } catch { /* no dialog */ }

    // Instagram uses name="email" and name="pass" (not "username"/"password")
    await page.waitForSelector('input[name="email"]', { timeout: 15000 });

    await page.fill('input[name="email"]', username);
    await page.fill('input[name="pass"]', password);
    // Instagram hides the real submit input and uses a styled div[role=button]
    await page.getByRole('button', { name: 'Log In', exact: true }).click();

    // Wait for navigation away from login page
    await page.waitForURL(url => !url.toString().includes('/accounts/login'), { timeout: 20000 });

    const currentUrl = page.url();

    // Instagram sometimes redirects to a security challenge instead of home
    if (currentUrl.includes('/challenge')) {
      throw new Error('Instagram requires identity verification (suspicious login). Complete the challenge manually at instagram.com first, then try again.');
    }
    if (currentUrl.includes('/two_factor')) {
      throw new Error('Two-factor authentication is enabled. Disable 2FA on your account or complete it at instagram.com first.');
    }

    // Check for inline login error (wrong password, etc.)
    // Instagram renders the error inside a div with a warning icon — match by color class or any visible error text
    const errorEl = await page.$(
      'p[data-testid="login-error-message"], #slfErrorAlert, [role="alert"], div[id*="error"], span[style*="color: rgb(237"]'
    );
    if (errorEl) {
      const msg = await errorEl.textContent();
      throw new Error(msg?.trim() || 'Login failed — check your credentials.');
    }
    // Fallback: if we're still on the login page after submit, credentials were rejected
    if (page.url().includes('/accounts/login')) {
      throw new Error('Login failed — incorrect username or password.');
    }

    // Dismiss "Save login info" and notification dialogs that block navigation
    for (const label of ['Not Now', 'Not now', 'Skip']) {
      try {
        const btn = page.getByRole('button', { name: label });
        await btn.waitFor({ timeout: 3000 });
        await btn.click();
      } catch { /* no dialog */ }
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

    // Instagram's saved posts page
    await page.goto('https://www.instagram.com/saved/', { waitUntil: 'domcontentloaded', timeout: 30000 });

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

        // Scrape visible comments (best-effort — Instagram uses dynamic class names)
        const comments = await page.$$eval(
          'ul li span[dir="auto"]',
          (els) => els
            .map(el => el.textContent?.trim())
            .filter(t => t && t.length > 15 && !t.startsWith('#'))
            .slice(1, 10) // skip first item (the caption itself)
        ).catch(() => []);

        const hashtags = (caption.match(/#\w+/g) || []).map(h => h.toLowerCase());
        const shortcode = link.href.match(/\/(p|reel)\/([\w-]+)/)?.[2] || '';

        posts.push({
          id: shortcode,
          caption,
          hashtags,
          comments,
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
