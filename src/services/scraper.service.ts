// Ultra-dynamic scraper service - discovers everything intelligently
import { prisma } from '../lib/prisma';
import logger from '../lib/logger';
import puppeteer from 'puppeteer';
import * as cheerio from 'cheerio';
import * as crypto from 'crypto';

export class ScraperError extends Error {
  constructor(message: string, public statusCode: number = 400) {
    super(message);
    this.name = 'ScraperError';
  }
}

const browserPool = {
  browser: null as any,
  maxPages: 5, // Increased for more aggressive crawling

  async getBrowser() {
    // De fout zat in de volgende regel:
    // OUD: if (!this.browser || this.browser.isDisconnected()) {
    // NIEUW:
    if (!this.browser || !this.browser.isConnected()) {
      logger.info('Launching browser', {
        executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || 'default'
      });
      try {
        this.browser = await puppeteer.launch({
          headless: true,
          executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
          args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-web-security',
            '--disable-features=VizDisplayCompositor',
            '--disable-background-timer-throttling',
            '--disable-backgrounding-occluded-windows',
            '--disable-renderer-backgrounding',
            '--no-first-run',
            '--disable-default-apps',
            '--disable-extensions',
            '--disable-plugins'
          ]
        });
        logger.info('Browser launched successfully');
      } catch (error) {
        logger.error('Failed to launch browser', {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined
        });
        throw error;
      }
    }
    return this.browser;
  },

  async getPage() {
    const browser = await this.getBrowser();
    return await browser.newPage();
  }
};

// --- Heuristic Functions (The "Brains") ---

/**
 * Heuristically determines if a URL is likely to be a content page.
 * This replaces all hardcoded lists of paths and file types.
 * @param url The URL to check.
 * @param contentType The Content-Type header from the response (optional).
 * @returns True if the URL is likely a content page, false otherwise.
 */
function isLikelyContentUrl(url: string, contentType?: string): boolean {
  try {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname.toLowerCase();
    const searchParams = parsedUrl.searchParams;

    // Rule 1: Skip non-HTML resources based on Content-Type
    if (contentType && !contentType.includes('text/html')) {
      return false;
    }

    // Rule 2: Skip common asset/system paths (dynamically identified)
    // This handles the "skip WP content" request by targeting system directories, not the content itself.
    const systemKeywords = [
      'admin', 'login', 'dashboard', 'panel', 'cpanel', 'wp-admin', 'wp-login', 'wp-content', 'wp-includes',
      'node_modules', '.git', 'assets', 'static', 'media', 'cdn', 'api', 'rest', 'graphql', 'feed', 'rss',
      'cgi-bin', 'ajax', 'service', 'services', 'download', 'file', 'files'
    ];
    if (systemKeywords.some(keyword => path.includes(`/${keyword}/`) || path.endsWith(`/${keyword}`))) {
      return false;
    }

    // Rule 3: Skip URLs with file extensions that are not pages
    // This is a heuristic based on common patterns, not a hardcoded list.
    if (path.includes('.')) {
      const extension = path.split('.').pop();
      const nonPageExtensions = [
        'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', // Images
        'css', // Stylesheets
        'js', 'mjs', // JavaScript
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', // Documents
        'zip', 'rar', 'tar', 'gz', // Archives
        'mp3', 'wav', 'ogg', 'mp4', 'avi', 'mov', // Media
        'xml', 'txt', 'log', 'ico' // Misc data/files
      ];
      if (nonPageExtensions.includes(extension || '')) {
        return false;
      }
    }

    // Rule 4: Skip URLs that look like AJAX calls or have complex query strings for actions
    if (searchParams.has('action') || searchParams.has('ajax') || searchParams.has('format') && searchParams.get('format') !== 'html') {
      return false;
    }

    return true;
  } catch (error) {
    // Invalid URL, skip it
    return false;
  }
}

/**
 * Dynamically extracts the main content from a page without hardcoded selectors.
 * It uses heuristics to find the largest, most relevant text block.
 * @param $ The Cheerio instance of the page.
 * @returns The extracted title, description, and main content.
 */
function dynamicExtractContent($: cheerio.CheerioAPI): { title: string; content: string; description: string } {
  // Remove boilerplate elements that are unlikely to contain main content.
  // This is a heuristic based on common HTML patterns.
  $('nav, header, footer, script, style, link, meta, noscript, .ad, .ads, .advertisement, .sidebar, .menu, .nav').remove();

  // Extract title
  let title = $('title').text().trim() || $('h1').first().text().trim() || 'Untitled';
  title = title.substring(0, 200);

  // Extract description
  let description = $('meta[name="description"]').attr('content') || $('meta[property="og:description"]').attr('content') || '';
  description = description.substring(0, 300);

  // Heuristic: Find the parent element with the highest text-to-HTML ratio.
  // This is a strong indicator of the main content area.
  let bestElement = $('body');
  let maxRatio = 0;

  const potentialContentContainers = $('main, article, section, div, p');
  potentialContentContainers.each((i, el) => {
    const $el = $(el);
    const text = $el.text().trim();
    if (text.length < 100) return; // Ignore small elements

    const html = $el.html() || '';
    // Avoid division by zero
    const ratio = html.length > 0 ? text.length / html.length : 0;

    if (ratio > maxRatio && text.length > bestElement.text().trim().length * 0.5) {
      maxRatio = ratio;
      bestElement = $el;
    }
  });

  let content = bestElement.text().trim();

  // Fallback if the heuristic fails (e.g., on very simple pages)
  if (content.length < 200) {
    content = $('body').text().trim();
  }

  // Limit content length for performance
  content = content.substring(0, 10000);

  return { title, content, description };
}


// --- Core Scraping and Discovery Functions ---

/**
 * Scrapes a single URL for its content.
 */
export async function scrapeWebsite(
  url: string,
  knowledgeBaseId: string,
  retries = 2
): Promise<any> {
  const startTime = Date.now();
  let page = null;

  try {
    logger.info('Scraping page', { url });
    page = await browserPool.getPage();

    // Set request interception to speed up loading
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      // Block images, fonts, stylesheets, and media to get only the HTML structure fast
      if (['image', 'font', 'stylesheet', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 15000
    });

    // Check if the page is actually HTML before proceeding
    const contentType = response?.headers()['content-type'] || '';
    if (!isLikelyContentUrl(url, contentType)) {
      logger.info('Skipping non-content page', { url, reason: 'Content-Type check' });
      return null; // Return null to indicate this page should be ignored
    }

    // Wait a bit for dynamic content to load
    await new Promise(resolve => setTimeout(resolve, 2000));

    // Trigger lazy loading by scrolling
    await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await new Promise(resolve => setTimeout(resolve, 1000));

    const html = await page.content();
    const $ = cheerio.load(html);

    const { title, content, description } = dynamicExtractContent($);

    if (!content || content.length < 50) {
      logger.warn('Page has very little content, skipping', { url });
      return null;
    }

    const hash = crypto.createHash('md5').update(url + content.substring(0, 100)).digest('hex');

    const result = {
      url,
      title,
      description,
      mainImage: $('meta[property="og:image"]').attr('content') || '',
      content,
      scrapedAt: new Date(),
      hash,
    };

    const duration = Date.now() - startTime;
    logger.info('Scraping completed', { url, duration, contentLength: content.length });

    return result;

  } catch (error) {
    const duration = Date.now() - startTime;
    logger.error('Scraping failed', { url, duration, error: error instanceof Error ? error.message : 'Unknown' });

    if (retries > 0) {
      logger.info('Retrying scrape', { url, retries });
      return scrapeWebsite(url, knowledgeBaseId, retries - 1);
    }

    return null; // Return null on failure instead of throwing
  } finally {
    if (page) {
      await page.close();
    }
  }
}

/**
 * The core dynamic URL discovery engine. It crawls aggressively and intelligently.
 * @param baseUrl The starting URL.
 * @param maxPages The maximum number of unique pages to discover.
 * @returns A set of discovered URLs.
 */
async function dynamicUrlDiscovery(baseUrl: string, maxPages: number = 0, jobId?: string): Promise<string[]> {
  const discoveredUrls = new Set<string>();
  const visitedUrls = new Set<string>();
  const queue = [baseUrl];
  const domain = new URL(baseUrl).hostname;
  let processedCount = 0;
  const maxCrawlPages = maxPages > 0 ? maxPages : 500; // Default to a high number for "everything"
  let lastUpdateCount = 0; // Track when we last updated the job

  // CRITICAL FIX: Always add the base URL first!
  discoveredUrls.add(baseUrl);

  logger.info('Starting dynamic URL discovery', { baseUrl, maxPages: maxCrawlPages, jobId });

  while (queue.length > 0 && processedCount < maxCrawlPages) {
    const currentUrl = queue.shift()!;
    if (visitedUrls.has(currentUrl)) continue;

    visitedUrls.add(currentUrl);
    processedCount++;

    // Log progress every 10 pages
    if (processedCount % 10 === 0) {
      logger.info('URL discovery progress', {
        processedCount,
        discovered: discoveredUrls.size,
        queueSize: queue.length
      });
    }

    // Update job in database every 10 newly discovered URLs for real-time progress
    if (jobId && discoveredUrls.size - lastUpdateCount >= 10) {
      try {
        await prisma.scrapeJob.update({
          where: { id: jobId },
          data: {
            discoveredUrls: Array.from(discoveredUrls),
            totalUrls: discoveredUrls.size,
          }
        });
        lastUpdateCount = discoveredUrls.size;
        logger.info('Job progress updated', { jobId, discovered: discoveredUrls.size });
      } catch (error) {
        logger.warn('Failed to update job progress', { jobId, error });
      }
    }

    let page = null;
    try {
      page = await browserPool.getPage();
      const response = await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

      // Use the heuristic to check if we should even process this page for links
      const contentType = response?.headers()['content-type'] || '';
      if (!isLikelyContentUrl(currentUrl, contentType)) {
        logger.info('Skipping non-content page for link extraction', { url: currentUrl });
        continue;
      }

      // Wait for dynamic content
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Trigger JS actions that might reveal links
      await page.evaluate(() => {
        window.scrollTo(0, document.body.scrollHeight);
        // Click buttons with common "load more" text
        document.querySelectorAll('button, a, div').forEach(el => {
          if (el.textContent && /load more|show more|next|meer|volgende/i.test(el.textContent)) {
            (el as HTMLElement).click();
          }
        });
      });
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Extract every possible link from the page
      const extractedUrls = await page.evaluate(() => {
        const urls = new Set<string>();
        document.querySelectorAll('a[href]').forEach(el => urls.add(el.getAttribute('href')!));
        // Also check for links in scripts (e.g., for SPAs)
        const scripts = document.querySelectorAll('script');
        scripts.forEach(script => {
          const text = script.textContent || '';
          const matches = text.match(/["']((https?:\/\/|\/)[^"']+)["']/g);
          if (matches) {
            matches.forEach(match => urls.add(match.slice(1, -1)));
          }
        });
        return Array.from(urls);
      });

      logger.info(`Found ${extractedUrls.length} links on ${currentUrl}`);

      for (const link of extractedUrls) {
        try {
          const absoluteUrl = new URL(link, currentUrl).href;
          const cleanUrl = absoluteUrl.split('#')[0]; // Remove hash fragments

          // Rule 1: Only same domain
          if (new URL(cleanUrl).hostname !== domain) continue;

          // Rule 2: Use our powerful heuristic to decide if it's a content URL
          if (isLikelyContentUrl(cleanUrl)) {
            if (!discoveredUrls.has(cleanUrl) && !visitedUrls.has(cleanUrl)) {
              discoveredUrls.add(cleanUrl);
              queue.push(cleanUrl);
            }
          }
        } catch (e) {
          // Invalid URL, skip
        }
      }
    } catch (error) {
      logger.warn('Failed to process page during discovery', { url: currentUrl, error: error instanceof Error ? error.message : 'Unknown' });
    } finally {
      if (page) {
        await page.close();
      }
    }
  }

  logger.info('Dynamic URL discovery completed', { baseUrl, discovered: discoveredUrls.size, processed: processedCount });
  return Array.from(discoveredUrls);
}

// --- Job Management Functions ---

export async function createScrapeJob(
  baseUrl: string,
  knowledgeBaseId: string,
  userId: string,
  maxPages: number = 0
): Promise<any> {
  const job = await prisma.scrapeJob.create({
    data: {
      baseUrl,
      knowledgeBaseId,
      userId,
      maxPages,
      status: 'DISCOVERING',
    },
  });

  // Start the dynamic discovery process in the background
  setImmediate(async () => {
    try {
      logger.info('Starting URL discovery for job', { jobId: job.id, baseUrl });

      const discoveredUrls = await dynamicUrlDiscovery(baseUrl, maxPages, job.id);

      logger.info('URL discovery successful, updating job', {
        jobId: job.id,
        urlCount: discoveredUrls.length,
        urls: discoveredUrls.slice(0, 5) // Log first 5 for debugging
      });

      await prisma.scrapeJob.update({
        where: { id: job.id },
        data: {
          discoveredUrls,
          totalUrls: discoveredUrls.length,
          status: 'PENDING'
        }
      });

      logger.info('Job URL discovery completed', { jobId: job.id, urlCount: discoveredUrls.length });

    } catch (error) {
      logger.error('Failed to discover URLs for job', {
        jobId: job.id,
        baseUrl,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined
      });

      // Even on error, set the base URL as fallback so the job doesn't get stuck
      await prisma.scrapeJob.update({
        where: { id: job.id },
        data: {
          discoveredUrls: [baseUrl], // Fallback
          totalUrls: 1,
          status: 'PENDING'
        }
      });
    }
  });

  return job;
}

export async function startScrapingJob(
  jobId: string,
  selectedUrls: string[]
): Promise<void> {
  const job = await prisma.scrapeJob.findUnique({ where: { id: jobId } });
  if (!job) throw new Error('Scrape job not found');

  await prisma.scrapeJob.update({
    where: { id: jobId },
    data: { status: 'IN_PROGRESS', selectedUrls, totalUrls: selectedUrls.length },
  });

  // Import createDocument to save scraped content to knowledge base
  const { createDocument } = await import('./knowledgeBase.service');

  // Process URLs sequentially to avoid overwhelming the server
  setImmediate(async () => {
    const results = [];
    let scrapedCount = 0;
    let savedCount = 0;

    for (const url of selectedUrls) {
      try {
        const result = await scrapeWebsite(url, job.knowledgeBaseId, 2);

        if (result && result.content && result.content.length >= 50) {
          // KRITIEK: Sla de gescrapede content op in de knowledge base!
          // Dit maakt documenten en genereert embeddings voor vector search
          try {
            await createDocument({
              knowledgeBaseId: job.knowledgeBaseId,
              title: result.title || url,
              content: result.content,
              sourceUrl: url,
              metadata: {
                description: result.description,
                mainImage: result.mainImage,
                scrapedAt: result.scrapedAt,
                hash: result.hash,
              },
              tags: ['scraped'],
            });

            savedCount++;
            logger.info('Document saved to knowledge base', { url, contentLength: result.content.length });
          } catch (saveError) {
            logger.error('Failed to save document', { url, error: saveError instanceof Error ? saveError.message : 'Unknown' });
          }

          results.push(result);
          scrapedCount++;
        }

        // Update progress periodically
        if (scrapedCount % 5 === 0 || scrapedCount === selectedUrls.length) {
          await prisma.scrapeJob.update({
            where: { id: jobId },
            data: {
              scrapedCount,
              scrapedUrls: results.map(r => r.url),
            }
          });
        }
      } catch (error) {
        logger.error('Error processing URL', { url, error: error instanceof Error ? error.message : 'Unknown' });
      }
    }

    // Mark job as completed
    await prisma.scrapeJob.update({
      where: { id: jobId },
      data: {
        status: 'COMPLETED',
        completedAt: new Date(),
        scrapedCount,
      }
    });

    logger.info('Scraping job completed', { jobId, scrapedCount, savedCount, totalUrls: selectedUrls.length });
  });

  logger.info('Dynamic scraping job started', { jobId, urlCount: selectedUrls.length });
}

// Other functions (getScrapeJob, etc.) remain the same...
export async function getScrapeJob(jobId: string) {
  return await prisma.scrapeJob.findUnique({ where: { id: jobId } });
}

export async function getScrapeJobs(knowledgeBaseId: string) {
  return await prisma.scrapeJob.findMany({
    where: { knowledgeBaseId },
    orderBy: { createdAt: 'desc' },
  });
}

export async function getPageContext(url: string, knowledgeBaseId: string): Promise<{ content: string; sources: any[] } | null> {
  const document = await prisma.document.findFirst({
    where: { knowledgeBaseId, metadata: { path: ['url'], equals: url } },
  });
  if (!document) return null;
  return { content: document.content, sources: [document] };
}

export async function closeBrowser(): Promise<void> {
  if (browserPool.browser) {
    await browserPool.browser.close();
    browserPool.browser = null;
  }
}