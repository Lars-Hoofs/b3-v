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
 * VERBETERD: Minder agressieve filtering om meer content te behouden
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
    if (contentType && !contentType.includes('text/html') && !contentType.includes('text/plain')) {
      return false;
    }

    // Rule 2: Skip ALLEEN echte system/admin paths (niet content paden)
    // VERBETERD: Minder agressief - 'static', 'assets', 'media' verwijderd want die kunnen content bevatten
    const systemKeywords = [
      'wp-admin', 'wp-login', 'wp-includes', 'wp-json',  // WordPress admin
      'admin', 'login', 'logout', 'signin', 'signup',     // Auth pages
      'dashboard', 'panel', 'cpanel',                      // Admin panels
      'node_modules', '.git', '.env',                      // Dev files
      'cgi-bin', 'api/', 'rest/', 'graphql',              // API endpoints
      'feed', 'rss', 'atom',                               // Feeds
      'cart', 'checkout', 'payment',                       // E-commerce
      'search?', 'ajax', 'action='                         // Dynamic endpoints
    ];

    for (const keyword of systemKeywords) {
      if (path.includes(`/${keyword}`) || path.includes(`${keyword}/`) || path.endsWith(`/${keyword}`)) {
        return false;
      }
    }

    // Rule 3: Skip URLs with file extensions that are definitely not pages
    if (path.includes('.')) {
      const extension = path.split('.').pop();
      const nonPageExtensions = [
        'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp', // Images
        'css', 'scss', 'less',     // Stylesheets
        'js', 'mjs', 'ts', 'jsx',  // JavaScript
        'pdf', 'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', // Documents
        'zip', 'rar', 'tar', 'gz', '7z', // Archives
        'mp3', 'wav', 'ogg', 'mp4', 'avi', 'mov', 'webm', // Media
        'xml', 'json', 'txt', 'log', 'csv', // Data files
        'woff', 'woff2', 'ttf', 'otf', 'eot', // Fonts
        'map' // Source maps
      ];
      if (nonPageExtensions.includes(extension || '')) {
        return false;
      }
    }

    // Rule 4: Skip URLs with specific action parameters (MINDER agressief)
    const skipParams = ['action', 'ajax', 'callback', 'jsonp'];
    for (const param of skipParams) {
      if (searchParams.has(param)) {
        return false;
      }
    }

    // Rule 5: Skip URLs die te veel query parameters hebben (waarschijnlijk geen content)
    if (Array.from(searchParams.keys()).length > 5) {
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
 * VERBETERD: Minder agressieve filtering, betere tekst opschoning, meer content behoud
 * @param $ The Cheerio instance of the page.
 * @returns The extracted title, description, and main content.
 */
function dynamicExtractContent($: cheerio.CheerioAPI): { title: string; content: string; description: string } {
  // Maak een kopie zodat we de originele DOM niet wijzigen
  const $clone = cheerio.load($.html());

  // Verwijder ALLEEN echte boilerplate elementen (geen header/nav want die kunnen nuttige info bevatten)
  $clone('script, style, link, meta, noscript, iframe, .ad, .ads, .advertisement, .cookie-banner, .popup, .modal').remove();
  // Verwijder hidden elementen
  $clone('[style*="display: none"], [style*="display:none"], [hidden]').remove();

  // Extract title
  let title = $clone('title').text().trim() ||
    $clone('h1').first().text().trim() ||
    $clone('meta[property="og:title"]').attr('content') ||
    'Untitled';
  title = cleanText(title).substring(0, 200);

  // Extract description
  let description = $clone('meta[name="description"]').attr('content') ||
    $clone('meta[property="og:description"]').attr('content') || '';
  description = cleanText(description).substring(0, 500);

  // NIEUWE AANPAK: Verzamel content uit specifieke semantische elementen
  const contentParts: string[] = [];

  // 1. Voeg headers toe (belangrijk voor context)
  $clone('h1, h2, h3, h4, h5, h6').each((_, el) => {
    const text = $clone(el).text().trim();
    if (text.length > 3) {
      contentParts.push(`\n## ${text}\n`);
    }
  });

  // 2. Probeer de main content area te vinden
  const mainContentSelectors = [
    'main', 'article', '[role="main"]', '.content', '.main-content',
    '#content', '#main', '.post-content', '.entry-content', '.page-content',
    '.article-body', '.post-body', '.text-content'
  ];

  let mainContent = '';
  for (const selector of mainContentSelectors) {
    const $main = $clone(selector);
    if ($main.length > 0) {
      mainContent = $main.first().text().trim();
      if (mainContent.length > 200) {
        logger.info('Found main content using selector', { selector, length: mainContent.length });
        break;
      }
    }
  }

  // 3. Heuristic fallback: vind het element met de meeste tekst
  if (mainContent.length < 200) {
    let bestElement = $clone('body');
    let maxLength = 0;

    $clone('main, article, section, div').each((_, el) => {
      const $el = $clone(el);
      const text = $el.text().trim();
      const html = $el.html() || '';

      // Check text-to-HTML ratio voor kwaliteit
      const ratio = html.length > 0 ? text.length / html.length : 0;

      // Prefereer elementen met goede ratio EN veel tekst
      if (text.length > maxLength && ratio > 0.1) {
        maxLength = text.length;
        bestElement = $el;
      }
    });

    mainContent = bestElement.text().trim();
  }

  // 4. Voeg paragraph tekst toe voor extra context
  const paragraphs: string[] = [];
  $clone('p').each((_, el) => {
    const text = $clone(el).text().trim();
    if (text.length > 30) { // Alleen zinvolle paragraphs
      paragraphs.push(text);
    }
  });

  // 5. Voeg lijsten toe (vaak belangrijke informatie)
  $clone('ul, ol').each((_, el) => {
    const $list = $clone(el);
    const items: string[] = [];
    $list.find('li').each((_, li) => {
      const text = $clone(li).text().trim();
      if (text.length > 5) {
        items.push(`• ${text}`);
      }
    });
    if (items.length > 0) {
      paragraphs.push(items.join('\n'));
    }
  });

  // 6. Voeg tabellen toe (als markdown) - ALWAYS append these
  const tables: string[] = [];
  $clone('table').each((_, el) => {
    const $table = $clone(el);
    const rows: string[] = [];

    // Process headers
    const headers: string[] = [];
    $table.find('th').each((_, th) => {
      headers.push($clone(th).text().trim());
    });

    if (headers.length > 0) {
      rows.push(`| ${headers.join(' | ')} |`);
      rows.push(`| ${headers.map(() => '---').join(' | ')} |`);
    }

    // Process rows
    $table.find('tr').each((_, tr) => {
      const cells: string[] = [];
      $clone(tr).find('td').each((_, td) => {
        cells.push($clone(td).text().trim());
      });
      if (cells.length > 0) {
        if (rows.length === 0) {
          // Treating as data
        }
        rows.push(`| ${cells.join(' | ')} |`);
      }
    });

    if (rows.length > 0) {
      tables.push(`\n${rows.join('\n')}\n`);
    }
  });

  // Combineer alle content
  let content = mainContent;

  // Als de main content kort is, voeg paragraphs toe
  if (content.length < 500) {
    content = paragraphs.join('\n\n'); // Paragraphs include lists
  }

  // ALTIJD tabellen toevoegen als ze er zijn en niet al in de text zitten (simple check)
  // We voegen ze toe aan het einde voor de zekerheid
  if (tables.length > 0) {
    content += "\n\n" + tables.join("\n\n");
  }

  // Als er nog steeds weinig content is, gebruik body als fallback
  if (content.length < 100) {
    content = $clone('body').text().trim();
  }

  // Schoon de content op
  content = cleanText(content);

  // VERHOOGDE limiet: 50.000 karakters voor meer uitgebreide content
  content = content.substring(0, 50000);

  logger.info('Content extracted', {
    titleLength: title.length,
    descriptionLength: description.length,
    contentLength: content.length
  });

  return { title, content, description };
}

/**
 * Schoont tekst op: verwijdert extra witruimte, normaliseert, etc.
 */
function cleanText(text: string): string {
  return text
    .replace(/\s+/g, ' ')           // Normaliseer witruimte
    .replace(/\n\s*\n/g, '\n\n')    // Max 2 newlines
    .replace(/\t/g, ' ')            // Tabs naar spaties
    .replace(/\u00A0/g, ' ')        // Non-breaking spaces
    .replace(/\s{2,}/g, ' ')        // Dubbele spaties
    .trim();
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
      timeout: 20000 // Verhoogd timeout
    });

    // Check if the page is actually HTML before proceeding
    const contentType = response?.headers()['content-type'] || '';
    if (!isLikelyContentUrl(url, contentType)) {
      logger.info('Skipping non-content page', { url, reason: 'Content-Type check' });
      return null;
    }

    // VERBETERD: Meerdere scroll acties voor lazy-loaded content
    // Wacht eerst even voor initiele content
    await new Promise(resolve => setTimeout(resolve, 1500));

    // Scroll in stappen om lazy loading te triggeren
    await page.evaluate(async () => {
      const scrollStep = window.innerHeight;
      const maxScroll = document.body.scrollHeight;

      for (let pos = 0; pos < maxScroll; pos += scrollStep) {
        window.scrollTo(0, pos);
        await new Promise(r => setTimeout(r, 200));
      }
      // Scroll naar beneden en dan terug naar boven
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(r => setTimeout(r, 500));
      window.scrollTo(0, 0);
    });

    // Wacht op lazy-loaded content
    await new Promise(resolve => setTimeout(resolve, 1500));

    const html = await page.content();
    const $ = cheerio.load(html);

    const { title, content, description } = dynamicExtractContent($);

    // VERLAAGD: minimum content van 50 naar 20 karakters
    if (!content || content.length < 20) {
      logger.warn('Page has very little content, skipping', { url, contentLength: content?.length || 0 });
      return null;
    }

    const hash = crypto.createHash('md5').update(url + content.substring(0, 100)).digest('hex');

    // VERBETERD: Meer metadata extractie
    const result = {
      url,
      title,
      description,
      mainImage: $('meta[property="og:image"]').attr('content') ||
        $('meta[name="twitter:image"]').attr('content') ||
        $('img').first().attr('src') || '',
      author: $('meta[name="author"]').attr('content') ||
        $('meta[property="article:author"]').attr('content') || '',
      publishDate: $('meta[property="article:published_time"]').attr('content') ||
        $('time').first().attr('datetime') || '',
      content,
      scrapedAt: new Date(),
      hash,
    };

    const duration = Date.now() - startTime;
    logger.info('Scraping completed', { url, duration, contentLength: content.length, title });

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