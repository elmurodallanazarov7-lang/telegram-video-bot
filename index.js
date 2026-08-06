process.env.NTBA_FIX_350 = 1;

require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

// ==========================================
// 1-QISM: ASOSIY MUSIQA/VIDEO BOT SOZLAMALARI
// ==========================================
const TOKEN = process.env.BOT_TOKEN;
if (!TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi! .env faylga tokeningizni qo'shing.");
  process.exit(1);
}
const bot = new TelegramBot(TOKEN, { polling: true });

// Render serverni uyg'oq saqlash
if (process.env.PORT) {
  const http = require('http');
  const https = require('https');

  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot ishlayapti ✅');
  }).listen(process.env.PORT, () => {
    console.log(`🌐 Server ${process.env.PORT}-portda ishga tushdi`);
    setInterval(() => {
      const RENDER_URL = 'https://telegram-video-bot-k1xp.onrender.com/'; 
      https.get(RENDER_URL, (res) => {}).on('error', (e) => {});
    }, 14 * 60 * 1000);
  });
}

// ==========================================
// 2-QISM: REAKSIYA BOTLAR TARMOG'I (BOTNET)
// ==========================================
const REACTION_TOKENS = process.env.REACTION_TOKENS ? process.env.REACTION_TOKENS.split(',') : [];
const EMOJIS = ["👍", "❤️", "🔥", "🥰", "👏", "🎉", "🤩", "💯", "⚡️", "🏆"];
const processedPosts = new Set(); // Bitta postga 2 marta kirishni oldini olish uchun Kesh

// Xotira to'lib ketmasligi uchun eski postlar keshini har 24 soatda tozalab turamiz
setInterval(() => { processedPosts.clear(); }, 1000 * 60 * 60 * 24);

if (REACTION_TOKENS.length > 0) {
  console.log(`🤖 Reaksiya tarmog'i ishga tushdi: ${REACTION_TOKENS.length} ta bot ulandi.`);
  
  REACTION_TOKENS.forEach((rToken) => {
    if (!rToken.trim()) return;
    const rBot = new TelegramBot(rToken.trim(), { polling: true });

    // YANGILIK: Bot o'z username'ini topadi va tugmaga qo'yadi
    rBot.getMe().then((botInfo) => {
      const botUsername = botInfo.username;
      
      rBot.onText(/^\/start/, (msg) => {
        const chatId = msg.chat.id;
        rBot.sendMessage(chatId,
          "Salom! 👋\n\n" +
          "Men kanallarga avtomatik tarzda chiroyli reaksiyalar yig'ib beruvchi yordamchi botman.\n\n" +
          "⚙️ **Qanday ishlatiladi?**\n" +
          "Pastdagi tugmani bosing, o'z kanalingizni tanlang va meni **Administrator** qilib qo'shing. Shundan so'ng barcha yangi postlarga reaksiya bosa boshlayman!",
          {
            parse_mode: 'Markdown',
            reply_markup: {
              inline_keyboard: [
                // To'g'ridan-to'g'ri kanal tanlash va admin qilish tugmasi
                [{ text: "➕ Kanalga qo'shish", url: `https://t.me/${botUsername}?startchannel=true`, style: 'primary' }]
              ]
            }
          }
        ).catch(() => {});
      });
    }).catch((err) => {
      console.error("Bot ma'lumotlarini olishda xatolik:", err);
    });

    rBot.on('channel_post', async (msg) => {
      const uniqueId = `${msg.chat.id}_${msg.message_id}`;
      if (processedPosts.has(uniqueId)) return;
      processedPosts.add(uniqueId); 

      // Post topilgach, botlar birin-ketin reaksiya bosadi
      REACTION_TOKENS.forEach((token, i) => {
        setTimeout(async () => {
          const randomEmoji = EMOJIS[Math.floor(Math.random() * EMOJIS.length)];
          try {
            await fetch(`https://api.telegram.org/bot${token.trim()}/setMessageReaction`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: msg.chat.id,
                message_id: msg.message_id,
                reaction: [{ type: 'emoji', emoji: randomEmoji }]
              })
            });
          } catch (e) {}
        }, i * 1500); // Har bir bot 1.5 soniya oraliq bilan bosadi (Tabiiy ko'rinishi uchun)
      });
    });
  });
}

// ==========================================
// 3-QISM: MUSIQA VA VIDEO YUKLASH MANTIG'I
// ==========================================
const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

const CACHE_FILE = path.join(DOWNLOAD_DIR, 'audio_cache.json');
let AUDIO_CACHE = {};
try {
  AUDIO_CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (e) {
  AUDIO_CACHE = {};
}
let cacheSaveTimer = null;
function saveAudioCache() {
  clearTimeout(cacheSaveTimer);
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(AUDIO_CACHE));
    if (!fs.existsSync(CACHE_FILE)) {
      console.error("⚠️ audio_cache.json yozildi, lekin diskda topilmadi!");
    }
  } catch (e) {
    console.error("❌ audio_cache.json ga yozishda xatolik:", e.message);
  }
}

const VIDEO_CACHE_FILE = path.join(DOWNLOAD_DIR, 'video_cache.json');
let VIDEO_CACHE = {};
try {
  VIDEO_CACHE = JSON.parse(fs.readFileSync(VIDEO_CACHE_FILE, 'utf8'));
} catch (e) {
  VIDEO_CACHE = {};
}
let videoCacheSaveTimer = null;
function saveVideoCache() {
  clearTimeout(videoCacheSaveTimer);
  videoCacheSaveTimer = setTimeout(() => {
    fs.writeFile(VIDEO_CACHE_FILE, JSON.stringify(VIDEO_CACHE), () => {});
  }, 500);
}

// ==========================================
// MONGODB ATLAS - DOIMIY CACHE BAZASI
// ==========================================
const MONGODB_URI = process.env.MONGODB_URI;
let audioCacheCollection = null;
let videoCacheCollection = null;

async function initMongoCache() {
  if (!MONGODB_URI) {
    console.log("⚠️ MONGODB_URI topilmadi — faqat lokal fayl cache ishlatiladi (server qayta ishga tushsa yo'qoladi).");
    return;
  }
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    const db = client.db('telegram_bot');
    audioCacheCollection = db.collection('audio_cache');
    videoCacheCollection = db.collection('video_cache');

    const audioDocs = await audioCacheCollection.find({}).toArray();
    audioDocs.forEach((doc) => {
      AUDIO_CACHE[doc._id] = doc.file_id;
    });
    saveAudioCache();

    const videoDocs = await videoCacheCollection.find({}).toArray();
    videoDocs.forEach((doc) => {
      VIDEO_CACHE[doc._id] = doc.file_id;
    });
    saveVideoCache();

    console.log(`🗄️ MongoDB Atlas'ga ulandi. ${audioDocs.length} ta audio, ${videoDocs.length} ta video keshi yuklandi.`);
  } catch (err) {
    console.error("❌ MongoDB Atlas'ga ulanishda xatolik:", err.message);
    audioCacheCollection = null;
    videoCacheCollection = null;
  }
}
initMongoCache();

async function setAudioCache(key, fileId) {
  if (!key) return;
  AUDIO_CACHE[key] = fileId;
  saveAudioCache();
  if (audioCacheCollection) {
    try {
      await audioCacheCollection.updateOne(
        { _id: key },
        { $set: { file_id: fileId, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error("❌ MongoDB'ga yozishda xatolik:", e.message);
    }
  }
}

async function deleteAudioCache(key) {
  if (!key) return;
  delete AUDIO_CACHE[key];
  saveAudioCache();
  if (audioCacheCollection) {
    try {
      await audioCacheCollection.deleteOne({ _id: key });
    } catch (e) {
      console.error("❌ MongoDB'dan o'chirishda xatolik:", e.message);
    }
  }
}

async function setVideoCache(key, fileId) {
  if (!key) return;
  VIDEO_CACHE[key] = fileId;
  saveVideoCache();
  if (videoCacheCollection) {
    try {
      await videoCacheCollection.updateOne(
        { _id: key },
        { $set: { file_id: fileId, updatedAt: new Date() } },
        { upsert: true }
      );
    } catch (e) {
      console.error("❌ MongoDB'ga (video) yozishda xatolik:", e.message);
    }
  }
}

async function deleteVideoCache(key) {
  if (!key) return;
  delete VIDEO_CACHE[key];
  saveVideoCache();
  if (videoCacheCollection) {
    try {
      await videoCacheCollection.deleteOne({ _id: key });
    } catch (e) {
      console.error("❌ MongoDB'dan (video) o'chirishda xatolik:", e.message);
    }
  }
}

function getVideoCacheKey(platform, url, quality) {
  let baseId = null;
  if (platform === 'YouTube') {
    const ytMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    if (ytMatch) baseId = ytMatch[1];
  }
  if (!baseId) {
    baseId = crypto.createHash('md5').update(url).digest('hex');
  }
  return `${baseId}_${quality}`;
}

const STORAGE_CHAT_ID = '-1004290504683'; 
const PENDING_PREFETCH = new Map();
const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function detectPlatform(url) {
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  return null;
}

const FORCE_SUB_CHANNELS = [];

async function getUnsubscribedChannels(userId) {
  const missing = [];
  for (const ch of FORCE_SUB_CHANNELS) {
    try {
      const member = await bot.getChatMember(ch.username, userId);
      const status = member.status;
      if (!['member', 'administrator', 'creator'].includes(status)) {
        missing.push(ch);
      }
    } catch (e) {
      missing.push(ch);
    }
  }
  return missing;
}

async function sendSubscriptionPrompt(chatId, missing) {
  const buttons = missing.map(ch => ([{ text: `➕ ${ch.title}`, url: ch.url, style: 'primary' }]));
  buttons.push([{ text: "✅ Obuna bo'ldim", callback_data: 'check_sub', style: 'success' }]);

  return bot.sendMessage(chatId,
    "⚠️ *Botdan foydalanish uchun quyidagi kanallarga obuna bo'ling:*\n\n" +
    missing.map(ch => `➕ ${ch.title}`).join('\n') +
    "\n\nObuna bo'lgach, pastdagi *\"✅ Obuna bo'ldim\"* tugmasini bosing.",
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: buttons } }
  );
}

bot.onText(/^\/start/, async (msg) => {
  const chatId = msg.chat.id;
  const userId = msg.from.id;

  const missing = await getUnsubscribedChannels(userId);
  if (missing.length > 0) {
    await sendSubscriptionPrompt(chatId, missing);
    return;
  }

  bot.sendMessage(chatId,
    "Salom! 👋\n\n" +
    "Men Instagram, TikTok va YouTube'dan video va musiqa yuklab beraman, shuningdek kanallaringizga reaksiya yig'ishda yordam beraman.\n\n" +
    "📥 *Yuklab olish uchun:* shunchaki havola yuboring.\n" +
    "🔎 *Musiqa qidirish uchun:* qo'shiq nomini yozing.",
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '⚡️ Kanalga reaksiya yig\'ish', callback_data: 'menu_reactions', style: 'primary' }],
          [{ text: '🤖 Yordam / Qo\'llanma', callback_data: 'menu_help', style: 'success' }]
        ]
      }
    }
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 Buyruqlar:\n" +
    "/start - Botni bosh sahifasi\n" +
    "/help - Yordam"
  );
});

bot.onText(/^\/mp3\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  await handleDownload(chatId, url, 'audio');
});

const LINK_CACHE = new Map();
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of LINK_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) LINK_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/')) return;

  const userId = msg.from.id;
  const missing = await getUnsubscribedChannels(userId);
  if (missing.length > 0) {
    await sendSubscriptionPrompt(chatId, missing);
    return;
  }

  const match = text.match(URL_REGEX);
  if (match) {
    const url = match[1];
    const platform = detectPlatform(url);
    if (!platform) {
      bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi. Instagram, TikTok yoki YouTube havolasini yuboring.");
      return;
    }

    if (platform === 'Instagram' || platform === 'TikTok') {
      await handleDownload(chatId, url, 'video');
      return;
    }

    const linkId = crypto.randomBytes(4).toString('hex');
    LINK_CACHE.set(linkId, { url, timestamp: Date.now() });

    bot.sendMessage(chatId, `Formatni tanlang:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: 'Video 360p', callback_data: `dl:${linkId}:360`, style: 'primary' },
            { text: 'Video 480p', callback_data: `dl:${linkId}:480`, style: 'primary' }
          ],
          [
            { text: 'Video 720p', callback_data: `dl:${linkId}:720`, style: 'primary' },
            { text: 'Video 1080p', callback_data: `dl:${linkId}:1080`, style: 'primary' }
          ],
          [
            { text: 'Audio MP3', callback_data: `dl:${linkId}:audio`, style: 'success' }
          ]
        ]
      }
    });
  } else {
    await handleMusicSearch(chatId, text.trim());
  }
});

const WRITABLE_COOKIES_PATH = path.join(DOWNLOAD_DIR, 'cookies.txt');
function getCookiesPath() {
  const secretPath = '/etc/secrets/cookies.txt';
  if (!fs.existsSync(secretPath)) return null;
  try {
    fs.copyFileSync(secretPath, WRITABLE_COOKIES_PATH);
    return WRITABLE_COOKIES_PATH;
  } catch (e) {
    return secretPath;
  }
}

const SPEED_FLAGS = '-4 -N 8 --no-update';

function buildYtDlpFlags(platform) {
  const cookiesPath = getCookiesPath();
  const cookiesArg = cookiesPath ? `--cookies "${cookiesPath}"` : '';

  const extractorArgs = (platform === 'YouTube' && !cookiesPath)
    ? `--extractor-args "youtube:player_client=android,web"`
    : '';

  return `${SPEED_FLAGS} ${cookiesArg} ${extractorArgs}`;
}

function prefetchAudio(videoId, title) {
  if (!STORAGE_CHAT_ID) return;
  if (AUDIO_CACHE[videoId] || PENDING_PREFETCH.has(videoId)) return;

  const promise = new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const fileKey = crypto.randomBytes(6).toString('hex');
    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileKey}.%(ext)s`);
    const flags = buildYtDlpFlags('YouTube');
    const cmd = `yt-dlp ${flags} -f "bestaudio/best" -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 2048 }, async (error, stdout, stderr) => {
      if (error) {
        resolve(null);
        return;
      }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileKey));
      if (files.length === 0) {
        resolve(null);
        return;
      }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      try {
        const sent = await bot.sendAudio(STORAGE_CHAT_ID, filePath, { title });
        if (sent && sent.audio && sent.audio.file_id) {
          await setAudioCache(videoId, sent.audio.file_id);
          resolve(sent.audio.file_id);
        } else {
          resolve(null);
        }
      } catch (e) {
        resolve(null);
      } finally {
        fs.unlink(filePath, () => {});
      }
    });
  }).finally(() => PENDING_PREFETCH.delete(videoId));

  PENDING_PREFETCH.set(videoId, promise);
}

async function handleDownload(chatId, url, quality) {
  const platform = detectPlatform(url);
  if (!platform) {
    bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi.");
    return;
  }

  const isAudio = quality === 'audio';

  let videoId = null;
  if (platform === 'YouTube') {
    const ytMatch = url.match(/(?:v=|\/)([0-9A-Za-z_-]{11}).*/);
    if (ytMatch) videoId = ytMatch[1];
  }

  if (isAudio && videoId && AUDIO_CACHE[videoId]) {
    const statusMsg = await bot.sendMessage(chatId, `⏳ Yuborilmoqda...`);
    try {
      await bot.sendAudio(chatId, AUDIO_CACHE[videoId]);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return;
    } catch (e) {
      await deleteAudioCache(videoId);
    }
  }

  const videoCacheKey = !isAudio ? getVideoCacheKey(platform, url, quality) : null;
  if (!isAudio && VIDEO_CACHE[videoCacheKey]) {
    const statusMsg = await bot.sendMessage(chatId, `⏳ Yuborilmoqda...`);
    try {
      await bot.sendVideo(chatId, VIDEO_CACHE[videoCacheKey]);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return;
    } catch (e) {
      await deleteVideoCache(videoCacheKey);
    }
  }

  const statusMsg = await bot.sendMessage(chatId, `⏳ Yuklanmoqda...`);

  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags(platform);

  let formatCmd = '';
  if (isAudio) {
    formatCmd = `-f "bestaudio/best" -x --audio-format mp3 --print-json`; 
  } else if (platform === 'Instagram' || platform === 'TikTok') {
    formatCmd = `-f "best/bestvideo+bestaudio" --merge-output-format mp4`;
  } else {
    formatCmd = `-f "bestvideo[height<=${quality}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${quality}][ext=mp4]/best" --merge-output-format mp4`;
  }

  const cmd = `yt-dlp ${flags} ${formatCmd} -o "${outputTemplate}" "${url}"`;

  if (isAudio) {
    const t0 = Date.now();
    return runAndSendAudioWithCache(cmd, chatId, statusMsg.message_id, fileId, videoId, t0);
  } else {
    return runAndSendVideoWithCache(cmd, chatId, statusMsg.message_id, fileId, videoCacheKey);
  }
}

function runAndSendAudioWithCache(cmd, chatId, statusMessageId, fileId, videoId, t0) {
  const startedAt = t0 || Date.now();

  exec(cmd, { maxBuffer: 1024 * 1024 * 2048 }, async (error, stdout, stderr) => {
    if (error) {
      bot.editMessageText("❌ Audio yuklab bo'lmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    let songTitle = "Musiqa";
    try {
      const lines = stdout.trim().split('\n');
      for (const line of lines) {
        if (line.startsWith('{')) {
          const info = JSON.parse(line);
          if (info.title) songTitle = info.title;
          break;
        }
      }
    } catch (e) {}

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);

    try {
      let sentToStorage = null;
      if (STORAGE_CHAT_ID) {
        sentToStorage = await bot.sendAudio(STORAGE_CHAT_ID, filePath, { title: songTitle });
      }

      if (sentToStorage && sentToStorage.audio && sentToStorage.audio.file_id) {
        await bot.sendAudio(chatId, sentToStorage.audio.file_id, { title: songTitle });
        if (videoId) {
          await setAudioCache(videoId, sentToStorage.audio.file_id);
        }
      } else {
        await bot.sendAudio(chatId, filePath, { title: songTitle });
      }

      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      bot.sendMessage(chatId, "❌ Audioni yuborishda xatolik yuz berdi.");
    } finally {
      fs.unlink(filePath, () => {});
    }
  });
}

const SEARCH_CACHE = new Map();
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of SEARCH_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) SEARCH_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

async function handleMusicSearch(chatId, query) {
  if (!query || query.length < 2) return;

  const statusMsg = await bot.sendMessage(chatId, `🔎 "${query}" qidirilmoqda...`);

  const safeQuery = query.replace(/"/g, '');
  const cmd = `yt-dlp -4 --no-update --extractor-args "youtube:player_client=android" --flat-playlist --skip-download --socket-timeout 8 --print "%(id)s|||%(title)s" "ytsearch10:${safeQuery}"`;

  exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, async (error, stdout) => {
    if (error || !stdout.trim()) {
      bot.editMessageText(`❌ "${query}" bo'yicha hech narsa topilmadi.`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const results = stdout.trim().split('\n').map(line => {
      const [id, ...titleParts] = line.split('|||');
      return { id: id.trim(), title: titleParts.join('|||').trim() || 'Nomsiz' };
    }).filter(r => r.id);

    if (results.length === 0) {
      bot.editMessageText(`❌ "${query}" bo'yicha hech narsa topilmadi.`, {
        chat_id: chatId,
        message_id: statusMsg.message_id
      }).catch(() => {});
      return;
    }

    const searchId = crypto.randomBytes(4).toString('hex');
    SEARCH_CACHE.set(searchId, { results, timestamp: Date.now() });

    const listText = `🔎 *"${query}"* bo'yicha natijalar:\n\n` +
      results.map((r, i) => `${i + 1}. ${r.title}`).join('\n');

    const buttons = results.map((r, i) => ({
      text: `🎵 ${i + 1}`,
      callback_data: `pick:${searchId}:${i}`,
      style: 'primary'
    }));
    const keyboard = [];
    for (let i = 0; i < buttons.length; i += 5) {
      keyboard.push(buttons.slice(i, i + 5));
    }

    bot.editMessageText(listText, {
      chat_id: chatId,
      message_id: statusMsg.message_id,
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: keyboard }
    }).catch(() => {});

    prefetchAudio(results[0].id, results[0].title);
  });
}

bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const messageId = query.message.message_id;
  const data = query.data || '';
  const userId = query.from.id;

  if (data === 'check_sub') {
    const missing = await getUnsubscribedChannels(userId);
    if (missing.length > 0) {
      bot.answerCallbackQuery(query.id, { text: "❌ Hali barcha kanallarga obuna bo'lmadingiz.", show_alert: true }).catch(() => {});
      return;
    }
    bot.answerCallbackQuery(query.id, { text: '✅ Obuna tasdiqlandi!' }).catch(() => {});
    bot.deleteMessage(chatId, messageId).catch(() => {});
    bot.sendMessage(chatId,
      "✅ Rahmat! Endi botdan to'liq foydalanishingiz mumkin.\n\n" +
      "📥 Video/musiqa havolasini yuboring yoki qo'shiq nomini yozing."
    );
    return;
  }

  if (['dl:', 'pick:'].some(prefix => data.startsWith(prefix))) {
    const missing = await getUnsubscribedChannels(userId);
    if (missing.length > 0) {
      bot.answerCallbackQuery(query.id, { text: '⚠️ Avval kanallarga obuna bo\'ling.', show_alert: true }).catch(() => {});
      await sendSubscriptionPrompt(chatId, missing);
      return;
    }
  }

  if (data === 'menu_reactions') {
    bot.answerCallbackQuery(query.id).catch(() => {});
    const reactionText = 
      "⚡️ **Reaksiya xizmati**\n\n" +
      "Kanal va guruhlaringizga avtomatik reaksiya yig'ish uchun quyidagi botlarni kanalingizga to'liq administrator qilib qo'shing:\n\n" +
      "1️⃣ @reaksiyachi001bot\n" +
      "2️⃣ @reaksiyachi002bot\n" +
      "3️⃣ @reaksiyachi003bot\n" +
      "4️⃣ @reaksiyachi004bot\n" +
      "5️⃣ @reaksiyachi005bot\n" +
      "6️⃣ @reaksiyachi006bot\n\n" +
      "💡 *Barcha botlar admin qilingandan so'ng xizmat avtomatik ishlay boshlaydi.*";

    bot.editMessageText(reactionText, {
      chat_id: chatId,
      message_id: messageId,
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🔙 Orqaga', callback_data: 'menu_back', style: 'danger' }]
        ]
      }
    }).catch(() => {});
    return;
  }

  if (data === 'menu_help') {
    bot.answerCallbackQuery(query.id).catch(() => {});
    bot.editMessageText(
      "🤖 **Qo'llanma:**\n\n" +
      "• Instagram, TikTok yoki YouTube havolasini yuboring — video yuklab beraman.\n" +
      "• Qo'shiq nomini yozing — musiqalarni qidirib topib beraman.",
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔙 Orqaga', callback_data: 'menu_back', style: 'danger' }]
          ]
        }
      }
    ).catch(() => {});
    return;
  }

  if (data === 'menu_back') {
    bot.answerCallbackQuery(query.id).catch(() => {});
    bot.editMessageText(
      "Salom! 👋\n\n" +
      "Men Instagram, TikTok va YouTube'dan video va musiqa yuklab beraman, shuningdek kanallaringizga reaksiya yig'ishda yordam beraman.\n\n" +
      "📥 *Yuklab olish uchun:* shunchaki havola yuboring.\n" +
      "🔎 *Musiqa qidirish uchun:* qo'shiq nomini yozing.",
      {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚡️ Kanalga reaksiya yig\'ish', callback_data: 'menu_reactions', style: 'primary' }],
            [{ text: '🤖 Yordam / Qo\'llanma', callback_data: 'menu_help', style: 'success' }]
          ]
        }
      }
    ).catch(() => {});
    return;
  }

  if (data.startsWith('dl:')) {
    const [, linkId, quality] = data.split(':');
    const cached = LINK_CACHE.get(linkId);

    if (!cached) {
      bot.answerCallbackQuery(query.id, { text: '⏱ Havola muddati tugagan, qayta yuboring.', show_alert: true }).catch(() => {});
      return;
    }

    const textMap = {
      '360': '⏳ Video (360p) yuklanmoqda...',
      '480': '⏳ Video (480p) yuklanmoqda...',
      '720': '⏳ Video (720p) yuklanmoqda...',
      '1080': '⏳ Video (1080p) yuklanmoqda...',
      'audio': '⏳ Audio (MP3) yuklanmoqda...'
    };

    bot.answerCallbackQuery(query.id, { text: textMap[quality] || '⏳ Yuklanmoqda...' }).catch(() => {});
    bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

    await handleDownload(chatId, cached.url, quality);
  }

  if (data.startsWith('pick:')) {
    const [, searchId, indexStr] = data.split(':');
    const cached = SEARCH_CACHE.get(searchId);

    if (!cached) {
      bot.answerCallbackQuery(query.id, { text: '⏱ Bu qidiruv muddati tugagan, qayta qidiring.', show_alert: true }).catch(() => {});
      return;
    }

    const index = parseInt(indexStr, 10);
    const chosen = cached.results[index];
    if (!chosen) {
      bot.answerCallbackQuery(query.id, { text: '❌ Topilmadi.', show_alert: true }).catch(() => {});
      return;
    }

    const cachedFileId = AUDIO_CACHE[chosen.id];
    if (cachedFileId) {
      bot.answerCallbackQuery(query.id, { text: `✅ ${chosen.title}` }).catch(() => {});
      const statusMsg = await bot.sendMessage(chatId, `📤 "${chosen.title}" yuborilmoqda...`);
      try {
        await bot.sendAudio(chatId, cachedFileId, { title: chosen.title });
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return;
      } catch (e) {
        await deleteAudioCache(chosen.id);
      }
    }

    if (PENDING_PREFETCH.has(chosen.id)) {
      bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} deyarli tayyor...` }).catch(() => {});
      const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" tayyorlanmoqda...`);
      const fid = await PENDING_PREFETCH.get(chosen.id);
      if (fid) {
        try {
          await bot.sendAudio(chatId, fid, { title: chosen.title });
          await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
          return;
        } catch (e) { }
      }
      return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
    }

    bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} yuklanmoqda...` }).catch(() => {});

    const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" yuklanmoqda...`);
    return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
  }
});

function downloadAndSendPick(chatId, chosen, statusMessageId) {
  const url = `https://www.youtube.com/watch?v=${chosen.id}`;
  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags('YouTube');
  const cmd = `yt-dlp ${flags} -f "bestaudio/best" -x --audio-format mp3 -o "${outputTemplate}" "${url}"`;

  const t0 = Date.now();
  return runAndSendPickAudio(cmd, chatId, statusMessageId, fileId, chosen.id, chosen.title, t0);
}

function runAndSendPickAudio(cmd, chatId, statusMessageId, fileId, cacheKey, cacheTitle, t0) {
  const startedAt = t0 || Date.now();
  
  exec(cmd, { maxBuffer: 1024 * 1024 * 2048 }, async (error, stdout, stderr) => {
    if (error) {
      bot.editMessageText("❌ Yuklab bo'lmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);

    try {
      let sentToStorage = null;
      if (STORAGE_CHAT_ID) {
        sentToStorage = await bot.sendAudio(STORAGE_CHAT_ID, filePath, { title: cacheTitle });
      }

      if (sentToStorage && sentToStorage.audio && sentToStorage.audio.file_id) {
        await bot.sendAudio(chatId, sentToStorage.audio.file_id, { title: cacheTitle });
        if (cacheKey) {
          await setAudioCache(cacheKey, sentToStorage.audio.file_id);
        }
      } else {
        await bot.sendAudio(chatId, filePath, { title: cacheTitle });
      }

      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      bot.sendMessage(chatId, "❌ Faylni yuborishda xatolik yuz berdi.");
    } finally {
      fs.unlink(filePath, () => {}); 
    }
  });
}

function runAndSendVideoWithCache(cmd, chatId, statusMessageId, fileId, cacheKey) {
  exec(cmd, { maxBuffer: 1024 * 1024 * 2048 }, async (error, stdout, stderr) => {
    if (error) {
      bot.editMessageText("❌ Videoni yuklab bo'lmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);

    try {
      let sentToStorage = null;
      if (STORAGE_CHAT_ID) {
        sentToStorage = await bot.sendVideo(STORAGE_CHAT_ID, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
      }

      if (sentToStorage && sentToStorage.video && sentToStorage.video.file_id) {
        await bot.sendVideo(chatId, sentToStorage.video.file_id);
        if (cacheKey) {
          await setVideoCache(cacheKey, sentToStorage.video.file_id);
        }
      } else {
        await bot.sendVideo(chatId, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
      }

      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      bot.sendMessage(chatId, "❌ Videoni yuborishda xatolik yuz berdi.");
    } finally {
      fs.unlink(filePath, () => {}); 
    }
  });
}

bot.on('polling_error', (error) => {});
console.log("🤖 Bot ishga tushdi...");
