require('dotenv').config();
const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const DBManager = require('./db');
const { Downloader, sanitizeFilename } = require('./downloader');
const { getStorageRoot } = require('./storage');
const UrlHelper = require('./utils/url');

const app = express();
const port = process.env.PORT || 8080;
const bindHost = process.env.MEDIA_DROP_BIND_HOST || '127.0.0.1';
const allowPublicMedia = process.env.MEDIA_DROP_ALLOW_PUBLIC_MEDIA === 'true';
const envAdminPassword = process.env.MEDIA_DROP_ADMIN_PASSWORD || 'change-me';
const envAiProvider = process.env.MEDIA_DROP_AI_PROVIDER || 'none';
const envTtsProvider = process.env.MEDIA_DROP_TTS_PROVIDER || 'none';
const envAiApiKey = process.env.MEDIA_DROP_AI_API_KEY || '';
const envTtsApiKey = process.env.MEDIA_DROP_TTS_API_KEY || '';
const envWeatherProvider = process.env.MEDIA_DROP_WEATHER_PROVIDER || 'open_meteo';
const envWeatherApiKey = process.env.MEDIA_DROP_WEATHER_API_KEY || '';
const envWeatherLocation = process.env.MEDIA_DROP_WEATHER_LOCATION || 'Omaha, NE';
const envWeatherLat = process.env.MEDIA_DROP_WEATHER_LAT || '41.2565';
const envWeatherLon = process.env.MEDIA_DROP_WEATHER_LON || '-95.9345';
const envMarketProvider = process.env.MEDIA_DROP_MARKET_PROVIDER || 'coingecko_yahoo';
const envMarketApiKey = process.env.MEDIA_DROP_MARKET_API_KEY || '';
const ALLOWED_AI_PROVIDERS = new Set(['none', 'gemini', 'openai', 'anthropic', 'groq', 'grok']);
const ALLOWED_TTS_PROVIDERS = new Set(['none', 'gemini', 'openai', 'elevenlabs']);
const ALLOWED_WEATHER_PROVIDERS = new Set(['open_meteo', 'weatherapi']);
const ALLOWED_MARKET_PROVIDERS = new Set(['coingecko_yahoo', 'finnhub']);

// Initialize DB and Downloader
const db = new DBManager();
const downloader = new Downloader(db);
let adminPassword = db.getSetting('admin_password', envAdminPassword) || envAdminPassword;

if (!db.getSetting('admin_password') && envAdminPassword) {
  db.setSetting('admin_password', envAdminPassword);
}

// Middleware
app.use(express.json());
app.use(cookieParser());
app.set('trust proxy', 1);

// 🔦 Lighthouse Logger (Spotlight for all requests)
app.use((req, res, next) => {
    const ip = req.headers['cf-connecting-ip'] || req.ip;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} from ${ip}`);
    next();
});

const limiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  limit: parseInt(process.env.MEDIA_DROP_RATE_LIMIT_PER_HOUR || '1200', 10),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  validate: { xForwardedForHeader: false },
  skip: (req) => {
    const requestPath = req.path || '';
    if (req.method === 'GET' && (
      requestPath === '/health' ||
      requestPath === '/api/session' ||
      requestPath === '/api/downloads' ||
      requestPath === '/api/events' ||
      requestPath === '/api/home/weather' ||
      requestPath === '/api/home/market' ||
      requestPath === '/api/home/verse' ||
      requestPath.startsWith('/media/')
    )) {
      return true;
    }
    return false;
  },
  message: { error: 'Too many requests, please try again later.' }
});

app.use(express.static(path.join(__dirname, 'public')));
app.use(limiter);

const getLibraryRoot = () => path.join(getStorageRoot(), 'library');
const getRequestIp = (req) => req.headers['cf-connecting-ip'] || req.ip;
const getRequestUserAgent = (req) => req.headers['user-agent'];

const normalizeProvider = (value, allowedValues, fallback) => {
  const raw = String(value || '').trim().toLowerCase();
  const candidate = raw === 'xai' ? 'grok' : raw;
  if (allowedValues.has(candidate)) return candidate;
  return fallback;
};

const getServerSettings = () => {
  const aiProvider = normalizeProvider(
    db.getSetting('ai_provider', envAiProvider),
    ALLOWED_AI_PROVIDERS,
    'none'
  );
  const ttsProvider = normalizeProvider(
    db.getSetting('tts_provider', envTtsProvider),
    ALLOWED_TTS_PROVIDERS,
    'none'
  );
  const aiApiKey = db.getSetting('ai_api_key', envAiApiKey) || '';
  const ttsApiKey = db.getSetting('tts_api_key', envTtsApiKey) || '';
  const weatherProvider = normalizeProvider(
    db.getSetting('weather_provider', envWeatherProvider),
    ALLOWED_WEATHER_PROVIDERS,
    'open_meteo'
  );
  const marketProvider = normalizeProvider(
    db.getSetting('market_provider', envMarketProvider),
    ALLOWED_MARKET_PROVIDERS,
    'coingecko_yahoo'
  );
  const weatherApiKey = db.getSetting('weather_api_key', envWeatherApiKey) || '';
  const marketApiKey = db.getSetting('market_api_key', envMarketApiKey) || '';
  const weatherLocation = String(
    db.getSetting('weather_location', envWeatherLocation) || envWeatherLocation
  ).trim() || 'Omaha, NE';
  const weatherLat = String(
    db.getSetting('weather_lat', envWeatherLat) || envWeatherLat
  ).trim() || '41.2565';
  const weatherLon = String(
    db.getSetting('weather_lon', envWeatherLon) || envWeatherLon
  ).trim() || '-95.9345';

  return {
    ai_provider: aiProvider,
    tts_provider: ttsProvider,
    weather_provider: weatherProvider,
    market_provider: marketProvider,
    weather_location: weatherLocation,
    weather_lat: weatherLat,
    weather_lon: weatherLon,
    has_ai_api_key: Boolean(String(aiApiKey).trim()),
    has_tts_api_key: Boolean(String(ttsApiKey).trim()),
    has_weather_api_key: Boolean(String(weatherApiKey).trim()),
    has_market_api_key: Boolean(String(marketApiKey).trim()),
  };
};

const normalizeText = (value) =>
  String(value || '')
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'with', 'this', 'from', 'your', 'you', 'are', 'was', 'have', 'has',
  'will', 'into', 'just', 'what', 'when', 'where', 'which', 'their', 'there', 'they', 'them', 'then',
  'about', 'after', 'before', 'while', 'would', 'could', 'should', 'also', 'more', 'most', 'some',
  'very', 'over', 'under', 'onto', 'than', 'been', 'being', 'were', 'had', 'did', 'does', 'its', 'it',
  'our', 'out', 'off', 'any', 'all', 'new', 'now', 'not', 'too', 'can', 'his', 'her', 'she', 'him',
  'how', 'why', 'who', 'use', 'using', 'used', 'via', 'app', 'video', 'videos', 'news', 'article',
  'watch', 'watching', 'download', 'downloads', 'http', 'https', 'www', 'com', 'org', 'net'
]);

const tokenize = (value) =>
  normalizeText(value)
    .split(' ')
    .map((token) => token.trim())
    .filter((token) => token.length >= 3)
    .filter((token) => !STOP_WORDS.has(token))
    .filter((token) => !/^\d+$/.test(token));

const scoreTerms = (terms, weight, signalMap) => {
  terms.forEach((term) => {
    signalMap[term] = (signalMap[term] || 0) + weight;
  });
};

const getTopInterests = () => {
  const signalMap = {};
  const jobs = db.getAllJobs().slice(0, 200);
  jobs.forEach((job) => {
    scoreTerms(tokenize(`${job.filename || ''} ${job.source_domain || ''}`), 1.5, signalMap);
    if (job.view_count > 0) {
      scoreTerms(tokenize(job.filename || ''), Math.min(4, 1 + Number(job.view_count || 0) * 0.2), signalMap);
    }
  });

  const logs = db.getAuditLogs(120);
  logs.forEach((entry) => {
    if (entry.action === 'AI_SEARCH' && entry.details) {
      try {
        const details = JSON.parse(entry.details);
        scoreTerms(tokenize(details.prompt || ''), 2.2, signalMap);
      } catch {
        // Ignore malformed details payload
      }
    }
  });

  return Object.entries(signalMap)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([term]) => term);
};

const DEFAULT_DISCOVER_TOPICS = [
  'artificial intelligence',
  'fintech',
  'ethereum',
  'crypto regulation',
  'machine learning',
];

const BASE_DISCOVER_FEEDS = [
  'https://www.theverge.com/rss/index.xml',
  'https://www.engadget.com/rss.xml',
  'https://feeds.bbci.co.uk/news/technology/rss.xml',
  'https://www.wired.com/feed/rss',
  'https://www.coindesk.com/arc/outboundfeeds/rss/',
];

const decodeEntities = (value) =>
  String(value || '')
    .replace(/<!\[CDATA\[/g, '')
    .replace(/\]\]>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x2F;/g, '/');

const stripHtml = (value) => decodeEntities(value).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

const tagValue = (input, tag) => {
  const match = input.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i'));
  return match ? decodeEntities(match[1]).trim() : '';
};

const getFirstMatch = (input, patterns) => {
  for (const pattern of patterns) {
    const match = input.match(pattern);
    if (match && match[1]) {
      return decodeEntities(match[1]).trim();
    }
  }
  return '';
};

const extractLinkFromFeedItem = (itemXml) => {
  const rssLink = tagValue(itemXml, 'link');
  if (rssLink && /^https?:\/\//i.test(rssLink)) return rssLink;

  const atomAlternateLink = getFirstMatch(itemXml, [
    /<link[^>]*rel=["']alternate["'][^>]*href=["']([^"']+)["'][^>]*\/?>/i,
  ]);
  if (atomAlternateLink) return atomAlternateLink;

  return getFirstMatch(itemXml, [
    /<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i,
  ]);
};

const extractImageFromFeedItem = (itemXml) => {
  const directImage = getFirstMatch(itemXml, [
    /<media:thumbnail[^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    /<media:content[^>]*type=["']image\/[^"']+["'][^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    /<media:content[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']+["'][^>]*\/?>/i,
    /<enclosure[^>]*type=["']image\/[^"']+["'][^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']image\/[^"']+["'][^>]*\/?>/i,
    /<img[^>]*src=["']([^"']+)["'][^>]*>/i,
  ]);
  if (directImage) return directImage;

  const contentEncoded = tagValue(itemXml, 'content:encoded') || tagValue(itemXml, 'description');
  if (!contentEncoded) return '';
  return getFirstMatch(contentEncoded, [/<img[^>]*src=["']([^"']+)["'][^>]*>/i]);
};

const extractVideoFromFeedItem = (itemXml) =>
  getFirstMatch(itemXml, [
    /<media:content[^>]*type=["']video\/[^"']+["'][^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    /<media:content[^>]*url=["']([^"']+)["'][^>]*type=["']video\/[^"']+["'][^>]*\/?>/i,
    /<enclosure[^>]*type=["']video\/[^"']+["'][^>]*url=["']([^"']+)["'][^>]*\/?>/i,
    /<enclosure[^>]*url=["']([^"']+)["'][^>]*type=["']video\/[^"']+["'][^>]*\/?>/i,
    /<iframe[^>]*src=["']([^"']+)["'][^>]*>/i,
  ]);

const parseFeedItems = (xml) => {
  const rssItems = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  const atomEntries = xml.match(/<entry[\s\S]*?<\/entry>/gi) || [];
  const blocks = [...rssItems, ...atomEntries];

  return blocks
    .map((itemXml, index) => {
      const title = stripHtml(tagValue(itemXml, 'title')) || 'Untitled';
      const link = extractLinkFromFeedItem(itemXml);
      if (!link) return null;

      const summary =
        stripHtml(tagValue(itemXml, 'description')) ||
        stripHtml(tagValue(itemXml, 'summary')) ||
        stripHtml(tagValue(itemXml, 'content:encoded')) ||
        title;

      const publishedRaw = tagValue(itemXml, 'pubDate') || tagValue(itemXml, 'published') || tagValue(itemXml, 'updated');
      const publishedAt = Number.isNaN(Date.parse(publishedRaw || '')) ? new Date().toISOString() : new Date(publishedRaw).toISOString();

      const source = tagValue(itemXml, 'source') || tagValue(itemXml, 'dc:creator') || (() => {
        try {
          return new URL(link).hostname.replace(/^www\./i, '');
        } catch {
          return 'News';
        }
      })();

      return {
        id: `${link}-${index}`,
        title,
        summary,
        link,
        imageUrl: extractImageFromFeedItem(itemXml) || undefined,
        videoUrl: extractVideoFromFeedItem(itemXml) || undefined,
        source,
        publishedAt,
      };
    })
    .filter(Boolean);
};

const scoreDiscoverArticle = (article, interests) => {
  const haystack = normalizeText(`${article.title} ${article.summary} ${article.source}`);
  let score = 0;
  const matchedInterests = [];

  interests.forEach((interest) => {
    const normalized = normalizeText(interest);
    if (!normalized) return;
    if (haystack.includes(normalized)) {
      score += 8;
      matchedInterests.push(normalized);
      return;
    }
    const tokenHits = tokenize(normalized).filter((token) => haystack.includes(token)).length;
    if (tokenHits > 0) {
      score += tokenHits * 2;
      if (tokenHits >= 2) matchedInterests.push(normalized);
    }
  });

  const ageHours = Math.max(
    0,
    (Date.now() - new Date(article.publishedAt).getTime()) / (1000 * 60 * 60)
  );
  score += Math.max(0, 5 - ageHours / 12);

  return {
    ...article,
    score,
    matchedInterests: Array.from(new Set(matchedInterests)).slice(0, 3),
  };
};

const tryParseStructuredAiResponse = (rawText) => {
  const text = String(rawText || '').trim();
  if (!text) return null;
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      answer: String(parsed.answer || '').trim(),
      query: String(parsed.query || '').trim(),
      suggested_url: String(parsed.suggested_url || '').trim(),
    };
  } catch {
    return null;
  }
};

const buildFallbackAiResponse = (prompt) => {
  const query = tokenize(prompt).slice(0, 8).join(' ');
  return {
    answer: 'AI provider is not configured yet. I can still suggest a search query you can queue immediately.',
    query: query || String(prompt || '').trim(),
    suggested_url: query || String(prompt || '').trim(),
  };
};

const buildAiInstruction = (prompt) => {
  return [
    'You are FinchWire assistant.',
    'Return only JSON with keys: answer, query, suggested_url.',
    'answer: short helpful response.',
    'query: concise media search query.',
    'suggested_url: plain query text that can be passed to yt-dlp search, or a direct URL when high confidence.',
    `User prompt: ${String(prompt || '').trim()}`,
  ].join('\n');
};

const callGemini = async (apiKey, prompt) => {
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${encodeURIComponent(apiKey)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ parts: [{ text: buildAiInstruction(prompt) }] }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Gemini request failed (${response.status})`);
  }
  const payload = await response.json();
  return payload?.candidates?.[0]?.content?.parts?.[0]?.text || '';
};

const callOpenAI = async (apiKey, prompt) => {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'gpt-4.1-mini',
      input: buildAiInstruction(prompt),
      temperature: 0.2,
    }),
  });
  if (!response.ok) {
    throw new Error(`OpenAI request failed (${response.status})`);
  }
  const payload = await response.json();
  return payload?.output_text || '';
};

const callAnthropic = async (apiKey, prompt) => {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-3-5-haiku-latest',
      max_tokens: 400,
      temperature: 0.2,
      messages: [{ role: 'user', content: buildAiInstruction(prompt) }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Anthropic request failed (${response.status})`);
  }
  const payload = await response.json();
  const firstTextBlock = Array.isArray(payload?.content)
    ? payload.content.find((item) => item?.type === 'text')
    : null;
  return firstTextBlock?.text || '';
};

const callGroq = async (apiKey, prompt) => {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'llama-3.1-8b-instant',
      temperature: 0.2,
      messages: [{ role: 'user', content: buildAiInstruction(prompt) }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Groq request failed (${response.status})`);
  }
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || '';
};

const callGrok = async (apiKey, prompt) => {
  const response = await fetch('https://api.x.ai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: process.env.MEDIA_DROP_GROK_MODEL || 'grok-2-latest',
      temperature: 0.2,
      messages: [{ role: 'user', content: buildAiInstruction(prompt) }],
    }),
  });
  if (!response.ok) {
    throw new Error(`Grok request failed (${response.status})`);
  }
  const payload = await response.json();
  return payload?.choices?.[0]?.message?.content || '';
};

const requestAiResponse = async (provider, apiKey, prompt) => {
  if (!provider || provider === 'none' || !apiKey) {
    return buildFallbackAiResponse(prompt);
  }

  let rawText = '';
  if (provider === 'gemini') rawText = await callGemini(apiKey, prompt);
  else if (provider === 'openai') rawText = await callOpenAI(apiKey, prompt);
  else if (provider === 'anthropic') rawText = await callAnthropic(apiKey, prompt);
  else if (provider === 'groq') rawText = await callGroq(apiKey, prompt);
  else if (provider === 'grok') rawText = await callGrok(apiKey, prompt);
  else return buildFallbackAiResponse(prompt);

  const structured = tryParseStructuredAiResponse(rawText);
  if (structured) {
    return {
      answer: structured.answer || 'Here is a suggestion.',
      query: structured.query || tokenize(prompt).slice(0, 8).join(' '),
      suggested_url: structured.suggested_url || structured.query || tokenize(prompt).slice(0, 8).join(' '),
    };
  }

  const fallback = buildFallbackAiResponse(prompt);
  return {
    answer: rawText || fallback.answer,
    query: fallback.query,
    suggested_url: fallback.suggested_url,
  };
};

const WEATHER_CODE_MAP = {
  0: 'Clear',
  1: 'Mostly Clear',
  2: 'Partly Cloudy',
  3: 'Overcast',
  45: 'Fog',
  48: 'Fog',
  51: 'Light Drizzle',
  53: 'Drizzle',
  55: 'Heavy Drizzle',
  61: 'Light Rain',
  63: 'Rain',
  65: 'Heavy Rain',
  66: 'Freezing Rain',
  67: 'Heavy Freezing Rain',
  71: 'Light Snow',
  73: 'Snow',
  75: 'Heavy Snow',
  80: 'Rain Showers',
  81: 'Rain Showers',
  82: 'Heavy Rain Showers',
  95: 'Thunderstorm',
  96: 'Thunderstorm',
  99: 'Thunderstorm',
};

const CRYPTO_SYMBOL_TO_ID = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  SOL: 'solana',
  DOGE: 'dogecoin',
  XRP: 'ripple',
  AVAX: 'avalanche-2',
};

const weatherCache = new Map();
const marketCache = new Map();
let verseCache = null;

const toNumberOrNull = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const roundOrNull = (value, digits = 1) => {
  const numberValue = toNumberOrNull(value);
  if (numberValue === null) return null;
  return Number(numberValue.toFixed(digits));
};

const cToF = (value) => {
  const numberValue = toNumberOrNull(value);
  if (numberValue === null) return null;
  return Number(((numberValue * 9) / 5 + 32).toFixed(1));
};

const getCachedValue = (cacheMap, key, ttlMs) => {
  const entry = cacheMap.get(key);
  if (!entry) return null;
  if ((Date.now() - entry.cachedAt) > ttlMs) return null;
  return entry.value;
};

const setCachedValue = (cacheMap, key, value) => {
  cacheMap.set(key, { cachedAt: Date.now(), value });
  return value;
};

const getHomeWeatherSnapshot = async (settings, unit = 'f') => {
  const provider = settings.weather_provider || 'open_meteo';
  const weatherLocation = String(settings.weather_location || 'Omaha, NE').trim() || 'Omaha, NE';
  const weatherLat = toNumberOrNull(settings.weather_lat);
  const weatherLon = toNumberOrNull(settings.weather_lon);
  const weatherApiKey = String(db.getSetting('weather_api_key', envWeatherApiKey) || '').trim();

  const cacheKey = `${provider}:${weatherLocation}:${weatherLat}:${weatherLon}:${unit}`;
  const cached = getCachedValue(weatherCache, cacheKey, 10 * 60 * 1000);
  if (cached) return cached;

  if (provider === 'weatherapi') {
    if (!weatherApiKey) {
      throw new Error('Weather API key is required when weather provider is weatherapi.');
    }
    const weatherApiUrl = new URL('https://api.weatherapi.com/v1/forecast.json');
    weatherApiUrl.searchParams.set('key', weatherApiKey);
    weatherApiUrl.searchParams.set('q', weatherLocation);
    weatherApiUrl.searchParams.set('days', '1');
    weatherApiUrl.searchParams.set('aqi', 'no');
    weatherApiUrl.searchParams.set('alerts', 'no');

    const response = await fetch(weatherApiUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Weather provider request failed (${response.status}).`);
    }
    const payload = await response.json();
    const current = payload?.current || {};
    const forecastDay = payload?.forecast?.forecastday?.[0]?.day || {};
    const temperatureC = roundOrNull(current?.temp_c);
    const highC = roundOrNull(forecastDay?.maxtemp_c);
    const lowC = roundOrNull(forecastDay?.mintemp_c);

    return setCachedValue(weatherCache, cacheKey, {
      locationLabel: String(payload?.location?.name || weatherLocation),
      temperatureC,
      temperatureF: roundOrNull(current?.temp_f),
      condition: String(current?.condition?.text || 'Unknown'),
      highC,
      lowC,
      highF: cToF(highC),
      lowF: cToF(lowC),
      observedAt: String(current?.last_updated || new Date().toISOString()),
    });
  }

  if (weatherLat === null || weatherLon === null) {
    throw new Error('Weather latitude/longitude are not configured correctly.');
  }

  const openMeteoUrl = new URL('https://api.open-meteo.com/v1/forecast');
  openMeteoUrl.searchParams.set('latitude', String(weatherLat));
  openMeteoUrl.searchParams.set('longitude', String(weatherLon));
  openMeteoUrl.searchParams.set('current', 'temperature_2m,weather_code');
  openMeteoUrl.searchParams.set('daily', 'temperature_2m_max,temperature_2m_min');
  openMeteoUrl.searchParams.set('forecast_days', '1');
  openMeteoUrl.searchParams.set('timezone', 'auto');

  const response = await fetch(openMeteoUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Weather provider request failed (${response.status}).`);
  }
  const payload = await response.json();
  const current = payload?.current || {};
  const daily = payload?.daily || {};

  const temperatureC = roundOrNull(current?.temperature_2m);
  const weatherCode = Number(current?.weather_code || 0);
  const highC = roundOrNull(Array.isArray(daily?.temperature_2m_max) ? daily.temperature_2m_max[0] : null);
  const lowC = roundOrNull(Array.isArray(daily?.temperature_2m_min) ? daily.temperature_2m_min[0] : null);

  return setCachedValue(weatherCache, cacheKey, {
    locationLabel: weatherLocation,
    temperatureC,
    temperatureF: cToF(temperatureC),
    condition: WEATHER_CODE_MAP[weatherCode] || 'Unknown',
    highC,
    lowC,
    highF: cToF(highC),
    lowF: cToF(lowC),
    observedAt: String(current?.time || new Date().toISOString()),
  });
};

const getHomeMarketQuote = async (symbol, assetType, settings) => {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  const normalizedAssetType = String(assetType || '').trim().toLowerCase();
  if (!normalizedSymbol) throw new Error('symbol is required');
  if (!['stock', 'crypto'].includes(normalizedAssetType)) throw new Error('assetType must be stock or crypto');

  const provider = settings.market_provider || 'coingecko_yahoo';
  const marketApiKey = String(db.getSetting('market_api_key', envMarketApiKey) || '').trim();
  const cacheKey = `${provider}:${normalizedAssetType}:${normalizedSymbol}`;
  const cached = getCachedValue(marketCache, cacheKey, 90 * 1000);
  if (cached) return cached;

  if (provider === 'finnhub') {
    if (!marketApiKey) {
      throw new Error('Market API key is required when market provider is finnhub.');
    }
    const finnhubSymbol = normalizedAssetType === 'crypto'
      ? `BINANCE:${normalizedSymbol}USDT`
      : normalizedSymbol;
    const finnhubUrl = new URL('https://finnhub.io/api/v1/quote');
    finnhubUrl.searchParams.set('symbol', finnhubSymbol);
    finnhubUrl.searchParams.set('token', marketApiKey);

    const response = await fetch(finnhubUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Market provider request failed (${response.status}).`);
    }
    const payload = await response.json();
    const price = toNumberOrNull(payload?.c);
    if (price === null) {
      throw new Error(`No market price found for ${normalizedSymbol}.`);
    }
    return setCachedValue(marketCache, cacheKey, {
      symbol: normalizedSymbol,
      assetType: normalizedAssetType,
      displayName: normalizedAssetType === 'crypto'
        ? `${normalizedSymbol}/USDT (BINANCE)`
        : normalizedSymbol,
      price: Number(price.toFixed(price < 1 ? 4 : 2)),
      currency: 'USD',
      change24h: roundOrNull(payload?.d, 2),
      changePercent24h: roundOrNull(payload?.dp, 2),
      updatedAt: String(payload?.t || Math.floor(Date.now() / 1000)),
    });
  }

  if (normalizedAssetType === 'crypto') {
    const coinId = CRYPTO_SYMBOL_TO_ID[normalizedSymbol] || normalizedSymbol.toLowerCase();
    const coingeckoUrl = new URL('https://api.coingecko.com/api/v3/simple/price');
    coingeckoUrl.searchParams.set('ids', coinId);
    coingeckoUrl.searchParams.set('vs_currencies', 'usd');
    coingeckoUrl.searchParams.set('include_24hr_change', 'true');

    const response = await fetch(coingeckoUrl, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`Crypto quote request failed (${response.status}).`);
    }
    const payload = await response.json();
    const row = payload?.[coinId];
    const price = toNumberOrNull(row?.usd);
    if (price === null) {
      throw new Error(`No crypto quote found for ${normalizedSymbol}.`);
    }
    return setCachedValue(marketCache, cacheKey, {
      symbol: normalizedSymbol,
      assetType: 'crypto',
      displayName: String(coinId).replace(/-/g, ' '),
      price: Number(price.toFixed(price < 1 ? 4 : 2)),
      currency: 'USD',
      change24h: null,
      changePercent24h: roundOrNull(row?.usd_24h_change, 2),
      updatedAt: String(Date.now()),
    });
  }

  const yahooUrl = new URL('https://query1.finance.yahoo.com/v7/finance/quote');
  yahooUrl.searchParams.set('symbols', normalizedSymbol);
  const response = await fetch(yahooUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Stock quote request failed (${response.status}).`);
  }
  const payload = await response.json();
  const row = payload?.quoteResponse?.result?.[0];
  const price = toNumberOrNull(row?.regularMarketPrice);
  if (price === null) {
    throw new Error(`No stock quote found for ${normalizedSymbol}.`);
  }
  return setCachedValue(marketCache, cacheKey, {
    symbol: normalizedSymbol,
    assetType: 'stock',
    displayName: String(row?.shortName || row?.longName || normalizedSymbol),
    price: Number(price.toFixed(2)),
    currency: String(row?.currency || 'USD'),
    change24h: roundOrNull(row?.regularMarketChange, 2),
    changePercent24h: roundOrNull(row?.regularMarketChangePercent, 2),
    updatedAt: String(row?.regularMarketTime || Date.now()),
  });
};

const getVerseOfDay = async () => {
  if (verseCache && ((Date.now() - verseCache.cachedAt) <= (6 * 60 * 60 * 1000))) {
    return verseCache.value;
  }

  const verseUrl = new URL('https://beta.ourmanna.com/api/v1/get/');
  verseUrl.searchParams.set('format', 'json');
  const response = await fetch(verseUrl, { method: 'GET' });
  if (!response.ok) {
    throw new Error(`Verse provider request failed (${response.status}).`);
  }
  const payload = await response.json();
  const details = payload?.verse?.details || {};
  const reference = String(details?.reference || '').trim();
  const text = String(details?.text || '').trim();
  if (!reference || !text) {
    throw new Error('Verse provider returned an empty payload.');
  }

  const verse = {
    reference,
    text,
    translation: String(details?.version || '').trim() || null,
    fetchedAt: new Date().toISOString(),
  };
  verseCache = {
    cachedAt: Date.now(),
    value: verse,
  };
  return verse;
};

const normalizeRelativePath = (value) => {
  if (!value) return '';
  return String(value)
    .replace(/\\/g, '/')
    .replace(/^\.?\//, '')
    .replace(/\/{2,}/g, '/')
    .trim();
};

const toSafeRelativePath = (absolutePath) => {
  const libraryRoot = getLibraryRoot();
  const relative = path.relative(libraryRoot, absolutePath);
  if (relative.startsWith('..')) return '';
  return normalizeRelativePath(relative);
};

const resolveMediaPath = (requestedPath) => {
  const libraryRoot = getLibraryRoot();
  const normalized = normalizeRelativePath(decodeURIComponent(String(requestedPath || '')));
  if (!normalized) return null;

  const candidate = path.resolve(libraryRoot, normalized);
  if (!candidate.startsWith(libraryRoot + path.sep) && candidate !== libraryRoot) {
    return null;
  }

  if (fs.existsSync(candidate)) {
    return {
      absolutePath: candidate,
      relativePath: toSafeRelativePath(candidate)
    };
  }

  const parsed = path.parse(candidate);
  if (parsed.ext) {
    return null;
  }

  if (!fs.existsSync(parsed.dir)) {
    return null;
  }

  try {
    const matches = fs.readdirSync(parsed.dir)
      .filter((entry) => {
        const entryPath = path.join(parsed.dir, entry);
        if (!fs.existsSync(entryPath)) return false;
        const stat = fs.statSync(entryPath);
        if (!stat.isFile()) return false;
        return path.parse(entry).name === parsed.name;
      })
      .sort();

    if (matches.length === 0) {
      return null;
    }

    const resolvedAbsolute = path.join(parsed.dir, matches[0]);
    return {
      absolutePath: resolvedAbsolute,
      relativePath: toSafeRelativePath(resolvedAbsolute)
    };
  } catch {
    return null;
  }
};

const getPlaybackPathForJob = (job) => {
  const candidates = [
    normalizeRelativePath(job.relative_path),
    normalizeRelativePath(job.safe_filename),
  ].filter(Boolean);

  for (const candidate of candidates) {
    const resolved = resolveMediaPath(candidate);
    if (resolved?.relativePath) {
      return resolved.relativePath;
    }
  }

  if (job.absolute_path && fs.existsSync(job.absolute_path)) {
    const relativePath = toSafeRelativePath(job.absolute_path);
    if (relativePath) return relativePath;
  }

  return candidates[0] || '';
};

const isValidAuthToken = (value) => {
  return typeof value === 'string' && value.length > 0 && value === adminPassword;
};

const getBearerToken = (authorizationHeader) => {
  if (typeof authorizationHeader !== 'string') return null;
  if (!authorizationHeader.toLowerCase().startsWith('bearer ')) return null;
  return authorizationHeader.slice(7).trim();
};

const isAuthenticated = (req, { allowQueryToken = false } = {}) => {
  const sessionToken = req.cookies.session;
  const bearerToken = getBearerToken(req.headers.authorization);
  const finchwireToken = req.headers['x-finchwire-token'];
  const queryToken = allowQueryToken ? req.query.token : null;

  return (
    isValidAuthToken(sessionToken) ||
    isValidAuthToken(bearerToken) ||
    isValidAuthToken(finchwireToken) ||
    isValidAuthToken(queryToken)
  );
};

// Authentication middleware (API)
const auth = (req, res, next) => {
  if (isAuthenticated(req)) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// Media auth middleware.
// Allows query token so external players (e.g., VLC) can open protected media URLs.
const mediaAuth = (req, res, next) => {
  if (allowPublicMedia) {
    return next();
  }
  if (isAuthenticated(req, { allowQueryToken: true })) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
};

// SSE Clients
let sseClients = [];

// API Routes
app.post('/api/login', (req, res) => {
  const { password } = req.body || {};
  if (adminPassword && password === adminPassword) {
    res.cookie('session', password, { httpOnly: true, secure: true, sameSite: 'strict' });
    res.json({ success: true });
  } else {
    res.status(401).json({ error: 'Invalid password' });
  }
});

app.post('/api/logout', (req, res) => {
  res.clearCookie('session');
  res.json({ success: true });
});

app.get('/api/session', (req, res) => {
  const sessionToken = req.cookies.session;
  res.json({ authenticated: Boolean(adminPassword) && sessionToken === adminPassword });
});

app.post('/api/account/password', auth, (req, res) => {
  const { current_password, new_password } = req.body || {};
  const ip = getRequestIp(req);
  const userAgent = getRequestUserAgent(req);

  if (typeof current_password !== 'string' || typeof new_password !== 'string') {
    return res.status(400).json({ error: 'current_password and new_password are required' });
  }

  const nextPassword = new_password.trim();
  if (nextPassword.length < 8) {
    return res.status(400).json({ error: 'New password must be at least 8 characters' });
  }

  if (current_password !== adminPassword) {
    db.logAction('PASSWORD_CHANGE_FAILED', {
      ip,
      user_agent: userAgent,
      status: 'failed',
      details: { reason: 'invalid_current_password' },
    });
    return res.status(401).json({ error: 'Current password is incorrect' });
  }

  adminPassword = nextPassword;
  db.setSetting('admin_password', nextPassword);
  db.logAction('PASSWORD_CHANGED', {
    ip,
    user_agent: userAgent,
    status: 'success',
  });

  // Keep current session valid with new credential.
  res.cookie('session', nextPassword, { httpOnly: true, secure: true, sameSite: 'strict' });
  return res.json({ success: true });
});

app.get('/api/settings', auth, (req, res) => {
  return res.json({
    success: true,
    settings: getServerSettings(),
  });
});

app.patch('/api/settings', auth, (req, res) => {
  const payload = req.body || {};
  const ip = getRequestIp(req);
  const userAgent = getRequestUserAgent(req);
  const updates = {};

  if (Object.prototype.hasOwnProperty.call(payload, 'ai_provider')) {
    if (typeof payload.ai_provider !== 'string') {
      return res.status(400).json({ error: 'ai_provider must be a string' });
    }
    const normalized = normalizeProvider(payload.ai_provider, ALLOWED_AI_PROVIDERS, '');
    if (!normalized) {
      return res.status(400).json({ error: 'Unsupported ai_provider value' });
    }
    updates.ai_provider = normalized;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'tts_provider')) {
    if (typeof payload.tts_provider !== 'string') {
      return res.status(400).json({ error: 'tts_provider must be a string' });
    }
    const normalized = normalizeProvider(payload.tts_provider, ALLOWED_TTS_PROVIDERS, '');
    if (!normalized) {
      return res.status(400).json({ error: 'Unsupported tts_provider value' });
    }
    updates.tts_provider = normalized;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'ai_api_key')) {
    if (typeof payload.ai_api_key !== 'string') {
      return res.status(400).json({ error: 'ai_api_key must be a string' });
    }
    updates.ai_api_key = payload.ai_api_key.trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'tts_api_key')) {
    if (typeof payload.tts_api_key !== 'string') {
      return res.status(400).json({ error: 'tts_api_key must be a string' });
    }
    updates.tts_api_key = payload.tts_api_key.trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'weather_provider')) {
    if (typeof payload.weather_provider !== 'string') {
      return res.status(400).json({ error: 'weather_provider must be a string' });
    }
    const normalized = normalizeProvider(payload.weather_provider, ALLOWED_WEATHER_PROVIDERS, '');
    if (!normalized) {
      return res.status(400).json({ error: 'Unsupported weather_provider value' });
    }
    updates.weather_provider = normalized;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'market_provider')) {
    if (typeof payload.market_provider !== 'string') {
      return res.status(400).json({ error: 'market_provider must be a string' });
    }
    const normalized = normalizeProvider(payload.market_provider, ALLOWED_MARKET_PROVIDERS, '');
    if (!normalized) {
      return res.status(400).json({ error: 'Unsupported market_provider value' });
    }
    updates.market_provider = normalized;
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'weather_api_key')) {
    if (typeof payload.weather_api_key !== 'string') {
      return res.status(400).json({ error: 'weather_api_key must be a string' });
    }
    updates.weather_api_key = payload.weather_api_key.trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'market_api_key')) {
    if (typeof payload.market_api_key !== 'string') {
      return res.status(400).json({ error: 'market_api_key must be a string' });
    }
    updates.market_api_key = payload.market_api_key.trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'weather_location')) {
    if (typeof payload.weather_location !== 'string') {
      return res.status(400).json({ error: 'weather_location must be a string' });
    }
    updates.weather_location = payload.weather_location.trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'weather_lat')) {
    if (typeof payload.weather_lat !== 'string') {
      return res.status(400).json({ error: 'weather_lat must be a string' });
    }
    updates.weather_lat = payload.weather_lat.trim();
  }

  if (Object.prototype.hasOwnProperty.call(payload, 'weather_lon')) {
    if (typeof payload.weather_lon !== 'string') {
      return res.status(400).json({ error: 'weather_lon must be a string' });
    }
    updates.weather_lon = payload.weather_lon.trim();
  }

  const keys = Object.keys(updates);
  if (keys.length === 0) {
    return res.status(400).json({ error: 'No valid settings supplied' });
  }

  keys.forEach((key) => {
    db.setSetting(key, updates[key]);
  });

  db.logAction('APP_SETTINGS_UPDATED', {
    ip,
    user_agent: userAgent,
    status: 'success',
    details: { updated_keys: keys },
  });

  return res.json({
    success: true,
    settings: getServerSettings(),
  });
});

app.get('/api/home/weather', auth, async (req, res) => {
  const unit = String(req.query?.unit || 'f').trim().toLowerCase();
  if (!['f', 'c'].includes(unit)) {
    return res.status(400).json({ error: 'unit must be f or c' });
  }
  try {
    const snapshot = await getHomeWeatherSnapshot(getServerSettings(), unit);
    return res.json({
      success: true,
      snapshot,
    });
  } catch (error) {
    return res.status(503).json({
      error: `Weather provider unavailable: ${error.message}`,
    });
  }
});

app.get('/api/home/market', auth, async (req, res) => {
  const symbol = String(req.query?.symbol || '').trim();
  const assetType = String(req.query?.assetType || 'crypto').trim().toLowerCase();
  if (!symbol) {
    return res.status(400).json({ error: 'symbol is required' });
  }
  if (!['stock', 'crypto'].includes(assetType)) {
    return res.status(400).json({ error: 'assetType must be stock or crypto' });
  }
  try {
    const quote = await getHomeMarketQuote(symbol, assetType, getServerSettings());
    return res.json({
      success: true,
      quote,
    });
  } catch (error) {
    return res.status(503).json({
      error: `Market provider unavailable: ${error.message}`,
    });
  }
});

app.get('/api/home/verse', auth, async (_req, res) => {
  try {
    const verse = await getVerseOfDay();
    return res.json({
      success: true,
      verse,
    });
  } catch (error) {
    return res.status(503).json({
      error: `Verse provider unavailable: ${error.message}`,
    });
  }
});

app.post('/api/ai/search', auth, async (req, res) => {
  const prompt = String(req.body?.prompt || '').trim();
  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' });
  }

  const settings = getServerSettings();
  const aiApiKey = db.getSetting('ai_api_key', envAiApiKey) || '';

  try {
    const aiResult = await requestAiResponse(settings.ai_provider, aiApiKey, prompt);
    db.logAction('AI_SEARCH', {
      status: 'success',
      details: {
        prompt,
        provider: settings.ai_provider,
        query: aiResult.query || '',
      },
    });

    return res.json({
      success: true,
      provider: settings.ai_provider,
      ...aiResult,
    });
  } catch (error) {
    db.logAction('AI_SEARCH', {
      status: 'error',
      details: {
        prompt,
        provider: settings.ai_provider,
        error: error.message,
      },
    });
    return res.status(502).json({ error: `AI request failed: ${error.message}` });
  }
});

app.get('/api/discover/news', auth, async (_req, res) => {
  const interests = getTopInterests();
  const topicCandidates = [...DEFAULT_DISCOVER_TOPICS, ...interests.slice(0, 6)];
  const normalizedTopics = Array.from(
    new Set(topicCandidates.map((topic) => normalizeText(topic)).filter(Boolean))
  );
  const topicFeeds = normalizedTopics
    .slice(0, 6)
    .map((topic) => `https://news.google.com/rss/search?q=${encodeURIComponent(topic)}&hl=en-US&gl=US&ceid=US:en`);
  const feedUrls = Array.from(new Set([...BASE_DISCOVER_FEEDS, ...topicFeeds]));

  try {
    const feedResults = await Promise.allSettled(
      feedUrls.map(async (url) => {
        const response = await fetch(url);
        if (!response.ok) {
          throw new Error(`Feed request failed (${response.status})`);
        }
        const xml = await response.text();
        return parseFeedItems(xml);
      })
    );

    const merged = feedResults.flatMap((result) => (result.status === 'fulfilled' ? result.value : []));
    const scored = merged.map((article) => scoreDiscoverArticle(article, interests));

    const dedupedMap = new Map();
    scored.forEach((item) => {
      const previous = dedupedMap.get(item.link);
      if (!previous || item.score > previous.score) {
        dedupedMap.set(item.link, item);
      }
    });

    const articles = Array.from(dedupedMap.values())
      .sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime();
      })
      .slice(0, 30);

    return res.json({
      success: true,
      interests: interests.slice(0, 10),
      articles,
    });
  } catch (error) {
    return res.status(502).json({ error: `Discover feed failed: ${error.message}` });
  }
});

app.get('/api/downloads', auth, (req, res) => {
  const jobs = db.getAllJobs().map((job) => {
    const playbackPath = getPlaybackPathForJob(job);
    const normalizedRelative = normalizeRelativePath(job.relative_path);
    const expectedSafeFilename = playbackPath ? path.basename(playbackPath) : job.safe_filename;

    // Opportunistically heal stale DB rows (older downloads without extension/path corrections).
    if (
      playbackPath &&
      (
        normalizedRelative !== playbackPath ||
        normalizeRelativePath(job.safe_filename) !== expectedSafeFilename ||
        (job.absolute_path && !normalizeRelativePath(job.absolute_path).endsWith(playbackPath))
      )
    ) {
      db.updateJob(job.id, {
        relative_path: playbackPath,
        safe_filename: expectedSafeFilename,
        absolute_path: path.join(getLibraryRoot(), playbackPath),
      });
    }

    return {
      ...job,
      relative_path: playbackPath,
      safe_filename: expectedSafeFilename,
      media_url: UrlHelper.buildMediaUrl(playbackPath),
      share_url: UrlHelper.buildMediaUrlWithToken(playbackPath, adminPassword),
      vlc_url: UrlHelper.buildVlcUrl(playbackPath),
    };
  });
  res.json(jobs);
});

app.get('/api/downloads/:id/share', auth, (req, res) => {
  const { id } = req.params;
  const job = db.getJob(id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  const playbackPath = getPlaybackPathForJob(job);
  if (!playbackPath) {
    return res.status(404).json({ error: 'Media file not found for this job' });
  }

  return res.json({
    success: true,
    media_url: UrlHelper.buildMediaUrl(playbackPath),
    share_url: UrlHelper.buildMediaUrlWithToken(playbackPath, adminPassword),
  });
});

app.post('/api/downloads', auth, async (req, res) => {
  const { url, filename, subfolder, is_audio } = req.body;
  const ip = req.headers['cf-connecting-ip'] || req.ip;
  const userAgent = req.headers['user-agent'];

  try {
    const requestedInput = String(url || '').trim();
    if (!requestedInput) {
      throw new Error('URL or search query is required');
    }

    const resolvedUrl = await downloader.resolveSearchQuery(requestedInput);

    // Validate subfolder to prevent path traversal
    let safeSubfolder = '';
    if (subfolder) {
      safeSubfolder = sanitizeFilename(subfolder.replace(/\//g, '_').replace(/\\/g, '_'));
    }

    const parsedUrl = await downloader.validateURL(resolvedUrl);
    const domain = parsedUrl.hostname;

    // Log intent
    db.logAction('DOWNLOAD_SUBMIT', {
      url: resolvedUrl,
      ip,
      user_agent: userAgent,
      status: 'pending',
      details: requestedInput !== resolvedUrl ? { input: requestedInput } : undefined
    });

    // Fetch metadata if no filename provided
    let finalTitle = filename;
    if (!finalTitle) {
        finalTitle = await downloader.getMetadata(resolvedUrl);
    }

    // Determine filename
    let finalFilename = finalTitle || 'download';
    if (!path.extname(finalFilename) && path.extname(parsedUrl.pathname)) {
        finalFilename += path.extname(parsedUrl.pathname);
    }

    const safeName = sanitizeFilename(finalFilename);
    const id = uuidv4();

    const storageRoot = getStorageRoot();
    const relativePath = safeSubfolder ? path.join(safeSubfolder, safeName) : safeName;
    const absolutePath = path.join(storageRoot, 'library', relativePath);

    const job = db.createJob({
      id,
      url: resolvedUrl,
      original_url: requestedInput,
      filename: finalFilename,
      safe_filename: safeName,
      relative_path: relativePath,
      absolute_path: absolutePath,
      source_domain: domain,
      is_audio: !!is_audio
    });

    // Start download in background
    downloader.startDownload(id);

    res.json(job);
  } catch (error) {
    db.logAction('DOWNLOAD_ERROR', { url, ip, user_agent: userAgent, status: 'error', details: { message: error.message } });
    res.status(400).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        uptime: process.uptime(),
        storage: getStorageRoot()
    });
});

app.post('/api/downloads/:id/retry', auth, (req, res) => {
  const { id } = req.params;
  const job = db.getJob(id);
  if (job) {
    db.updateJob(id, { 
      status: 'queued', 
      progress_percent: 0, 
      error_message: null,
      updated_at: new Date().toISOString() 
    });
    downloader.startDownload(id);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: 'Job not found' });
  }
});

app.delete('/api/downloads/:id', auth, (req, res) => {
  const { id } = req.params;
  downloader.cancelDownload(id);
  db.deleteJob(id);
  res.json({ success: true });
});

app.patch('/api/downloads/:id/keep', auth, (req, res) => {
  const { id } = req.params;
  const { keep_forever } = req.body || {};

  if (typeof keep_forever !== 'boolean') {
    return res.status(400).json({ error: 'keep_forever must be boolean' });
  }

  const job = db.getJob(id);
  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  db.setKeepForever(id, keep_forever);
  const updated = db.getJob(id);
  res.json({ success: true, job: updated });
});

// SSE for progress
app.get('/api/events', auth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Crucial for Cloudflare/NGINX
  res.flushHeaders();

  const clientId = Date.now();
  const newClient = { id: clientId, res };
  sseClients.push(newClient);

  req.on('close', () => {
    sseClients = sseClients.filter(c => c.id !== clientId);
  });
});

// Broadcaster for SSE — sends progress for active jobs + triggers refresh on status change
const _prevJobStatuses = new Map();
let lastHeartbeat = Date.now();

setInterval(() => {
  if (sseClients.length === 0) return;
  
  const now = Date.now();
  const allJobs = db.getAllJobs();
  const activeJobs = allJobs.filter(j => j.status === 'downloading' || j.status === 'queued');

  // Detect jobs that changed status since last tick (e.g., completed/failed)
  let statusChanged = false;
  for (const job of allJobs) {
    const prev = _prevJobStatuses.get(job.id);
    if (prev !== undefined && prev !== job.status) {
      statusChanged = true;
    }
    _prevJobStatuses.set(job.id, job.status);
  }

  // Send data if active jobs
  if (activeJobs.length > 0) {
    const data = JSON.stringify({ type: 'progress', jobs: activeJobs });
    sseClients.forEach(c => c.res.write(`data: ${data}\n\n`));
  } else if (now - lastHeartbeat > 15000) {
    // Send heartbeat (ping) every 15s if no jobs to keep Cloudflare happy
    sseClients.forEach(c => c.res.write(`: ping\n\n`));
    lastHeartbeat = now;
  }

  if (statusChanged) {
    // Tell the dashboard to do a full reload
    sseClients.forEach(c => c.res.write(`data: ${JSON.stringify({ type: 'refresh' })}\n\n`));
  }
}, 1000);

const MIME_TYPES = {
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg; codecs=opus',
};

// Media Streaming with Range support — supports subfolders via wildcard
app.get('/media/*', mediaAuth, (req, res) => {
  const requestedPath = req.params[0];
  
  // 🛰️ CORS and Range Access (Crucial for in-app players)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Range, x-finchwire-token');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');
  
  if (req.method === 'OPTIONS') {
    return res.status(204).end();
  }

  const resolved = resolveMediaPath(requestedPath);
  const libraryRoot = getLibraryRoot();

  if (!resolved) {
    return res.status(404).send('File not found');
  }

  const filePath = resolved.absolutePath;
  const relativePath = resolved.relativePath;

  if (fs.existsSync(filePath)) {
    const stats = fs.statSync(filePath);
    const ext = path.extname(relativePath).toLowerCase();
    const contentType = MIME_TYPES[ext] || 'application/octet-stream';
    
    // View Tracking (debounced)
    const debounceHours = parseInt(process.env.MEDIA_VIEW_DEBOUNCE_HOURS, 10) || 6;
    const job =
      db.getJobByFilename(relativePath) ||
      db.getJobByFilename(path.basename(relativePath));
    if (job) {
        db.updateView(job.id, debounceHours);
    }

    const range = req.headers.range;
    const download = req.query.download === 'true';

    if (range && !download) {
      const parts = range.replace(/bytes=/, "").split("-");
      const start = parseInt(parts[0], 10);
      const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1;
      const chunksize = (end - start) + 1;
      const file = fs.createReadStream(filePath, {start, end});
      const head = {
        'Content-Range': `bytes ${start}-${end}/${stats.size}`,
        'Accept-Ranges': 'bytes',
        'Content-Length': chunksize,
        'Content-Type': contentType,
      };
      res.writeHead(206, head);
      file.pipe(res);
    } else {
      const head = {
        'Content-Length': stats.size,
        'Content-Type': contentType,
        'Accept-Ranges': 'bytes',
        'Content-Disposition': download
          ? `attachment; filename="${encodeURIComponent(path.basename(relativePath))}"`
          : 'inline'
      };
      res.writeHead(200, head);
      fs.createReadStream(filePath).pipe(res);
    }
  } else {
    res.status(404).send('File not found');
  }
});

app.get('/api/files', auth, (req, res) => {
  const storageRoot = getStorageRoot();
  const libraryDir = path.join(storageRoot, 'library');
  
  if (!fs.existsSync(libraryDir)) {
    return res.json([]);
  }

  const files = fs.readdirSync(libraryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => entry.name)
    .filter((file) => {
      if (!file || file.startsWith('.') || file.startsWith('._')) return false;
      const ext = path.extname(file).toLowerCase();
      return Boolean(MIME_TYPES[ext]);
    })
    .map((file) => {
      const relativePath = normalizeRelativePath(file);
      const filePath = path.join(libraryDir, relativePath);
      const stats = fs.statSync(filePath);
      return {
        name: file,
        size: stats.size,
        mtime: stats.mtime,
        relative_path: relativePath,
        url: UrlHelper.buildMediaUrl(relativePath)
      };
    })
    .sort((a, b) => new Date(b.mtime).getTime() - new Date(a.mtime).getTime());
  
  res.json(files);
});

app.delete('/api/files', auth, (req, res) => {
  const relativePath = normalizeRelativePath(req.body?.relative_path || req.body?.name);
  if (!relativePath) {
    return res.status(400).json({ error: 'relative_path is required' });
  }

  const resolved = resolveMediaPath(relativePath);
  if (!resolved) {
    return res.status(404).json({ error: 'File not found' });
  }

  try {
    fs.unlinkSync(resolved.absolutePath);
  } catch (error) {
    return res.status(500).json({ error: `Failed to delete file: ${error.message}` });
  }

  const normalizedTarget = normalizeRelativePath(resolved.relativePath);
  const targetBasename = path.basename(normalizedTarget);
  const matchingJobs = db.getAllJobs().filter((job) => {
    const jobRelative = normalizeRelativePath(job.relative_path);
    const jobSafe = normalizeRelativePath(job.safe_filename);
    const jobAbsoluteRelative = toSafeRelativePath(job.absolute_path || '');
    return jobRelative === normalizedTarget || jobSafe === targetBasename || jobAbsoluteRelative === normalizedTarget;
  });

  matchingJobs.forEach((job) => db.deleteJob(job.id));

  db.logAction('FILE_DELETE', {
    status: 'success',
    details: {
      relative_path: normalizedTarget,
      removed_jobs: matchingJobs.map((job) => job.id),
    },
  });

  return res.json({ success: true });
});

// Periodic Cleanup Job
async function runCleanup() {
  if (process.env.MEDIA_RETENTION_ENABLED === 'false') return;
  
  const retentionDays = parseInt(process.env.MEDIA_RETENTION_DAYS, 10) || 30;
  console.log(`[Cleanup] Running daily retention check (Threshold: ${retentionDays} days)...`);
  
  const expiredJobs = db.getExpiredJobs(retentionDays);
  let deletedCount = 0;

  for (const job of expiredJobs) {
    if (job.absolute_path && fs.existsSync(job.absolute_path)) {
      try {
        fs.unlinkSync(job.absolute_path);
        db.markJobDeleted(job.id);
        db.logAction('CLEANUP_DELETE', { 
            url: job.url, 
            status: 'success', 
            details: { id: job.id, filename: job.filename, path: job.absolute_path } 
        });
        deletedCount++;
        console.log(`[Cleanup] Deleted expired media: ${job.filename} (ID: ${job.id})`);
      } catch (err) {
        console.error(`[Cleanup] Failed to delete file ${job.absolute_path}:`, err);
      }
    } else {
        // Even if file is missing, mark as expired to keep DB clean
        db.markJobDeleted(job.id);
    }
  }
  
  if (deletedCount > 0) {
    console.log(`[Cleanup] Successfully removed ${deletedCount} expired items.`);
  }
}

// Run cleanup every 24 hours
const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000;
setInterval(runCleanup, CLEANUP_INTERVAL);

// Also run once on startup (after 1 minute to avoid heavy load)
setTimeout(runCleanup, 60 * 1000);

app.listen(port, bindHost, () => {
  console.log('---------------------------------------------------------');
  console.log(`🚀 FinchWire server starting...`);
  console.log(`📍 Local Address: http://${bindHost}:${port}`);
  console.log(`📂 Storage Root:  ${getStorageRoot()}`);
  console.log(`🛡️  Admin Auth:    ENABLED`);
  console.log(`🎞️  Public Media:  ${allowPublicMedia ? 'ENABLED' : 'DISABLED'}`);
  console.log(`🔥 Rate Limiting:  ENABLED (${process.env.MEDIA_DROP_RATE_LIMIT_PER_HOUR || '1200'}/hr for non-streaming endpoints)`);
  console.log('---------------------------------------------------------');
  
  // Log tool versions for debugging
  const { execSync } = require('child_process');
  try {
    const aria2Version = execSync(`${downloader.getToolPath('aria2c')} --version | head -n 1`).toString().trim();
    console.log(`[System] ${aria2Version}`);
  } catch (e) { console.error(`[System] aria2c not found at ${downloader.getToolPath('aria2c')}`); }
  
  try {
    const ytdlVersion = execSync(`${downloader.getToolPath('yt-dlp')} --version`).toString().trim();
    console.log(`[System] yt-dlp version: ${ytdlVersion}`);
  } catch (e) { console.error(`[System] yt-dlp not found at ${downloader.getToolPath('yt-dlp')}`); }

  // Resume interrupted downloads on startup
  const interruptedJobs = db.getAllJobs().filter(j => j.status === 'downloading' || j.status === 'queued');
  if (interruptedJobs.length > 0) {
    console.log(`[Startup] Resuming ${interruptedJobs.length} interrupted/queued jobs...`);
    interruptedJobs.forEach(job => {
      downloader.startDownload(job.id);
    });
  }
});
