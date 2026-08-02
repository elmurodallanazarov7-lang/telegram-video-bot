require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { exec } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TOKEN = process.env.BOT_TOKEN;

if (!TOKEN) {
  console.error("❌ BOT_TOKEN topilmadi! .env faylga tokeningizni qo'shing.");
  process.exit(1);
}

const bot = new TelegramBot(TOKEN, { polling: true });

// Render "Web Service" sifatida deploy qilinsa, portga ulanish talab qilinadi.
// Agar PORT o'zgaruvchisi mavjud bo'lsa, oddiy health-check server ochamiz.
if (process.env.PORT) {
  const http = require('http');
  http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Bot ishlayapti ✅');
  }).listen(process.env.PORT, () => {
    console.log(`🌐 Health-check server ${process.env.PORT}-portda ishga tushdi`);
  });
}

const DOWNLOAD_DIR = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR);

// --- Audio kesh: YouTube video ID -> Telegram file_id -------------------
// Bir marta yuklangan qo'shiq ikkinchi so'ralganda qayta yuklanmaydi,
// Telegramning o'z serveridagi faylga file_id orqali darhol havola qilinadi.
const CACHE_FILE = path.join(DOWNLOAD_DIR, 'audio_cache.json');
let AUDIO_CACHE = {};
try {
  AUDIO_CACHE = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
} catch (e) {
  AUDIO_CACHE = {};
}
let cacheSaveTimer = null;
function saveAudioCache() {
  // Debounce qilib yozamiz — ketma-ket yuklashlarda diskga ortiqcha yozmaslik uchun
  clearTimeout(cacheSaveTimer);
  cacheSaveTimer = setTimeout(() => {
    fs.writeFile(CACHE_FILE, JSON.stringify(AUDIO_CACHE), () => {});
  }, 500);
}

// Yashirin "ombor" chat/kanal — fon jarayonida (prefetch) yuklangan fayllar shu yerga
// jo'natiladi va undan file_id olinadi (foydalanuvchi buni ko'rmaydi).
// .env fayliga qo'shing: STORAGE_CHAT_ID=-1001234567890
// (bot shu kanalga/gruhga ADMIN sifatida qo'shilgan bo'lishi kerak)
const STORAGE_CHAT_ID = process.env.STORAGE_CHAT_ID || null;

// videoId -> Promise<file_id|null> — hozir fonda yuklanayotgan qo'shiqlar
const PENDING_PREFETCH = new Map();

// Havolani matndan topish uchun regex
const URL_REGEX = /(https?:\/\/[^\s]+)/i;

function detectPlatform(url) {
  if (/instagram\.com/i.test(url)) return 'Instagram';
  if (/tiktok\.com/i.test(url)) return 'TikTok';
  if (/youtube\.com|youtu\.be/i.test(url)) return 'YouTube';
  return null;
}

bot.onText(/^\/start/, (msg) => {
  const chatId = msg.chat.id;
  bot.sendMessage(chatId,
    "Salom! 👋\n\n" +
    "Men Instagram, TikTok va YouTube'dan video va musiqa yuklab beraman.\n\n" +
    "📥 *Video/audio yuklash:* shunchaki havolani yuboring — Video yoki Audio tugmasini tanlaysiz\n" +
    "🔎 *Qo'shiq nomi bilan qidirish:* shunchaki qo'shiq/ijrochi nomini yozing\n\n" +
    "Masalan:\n" +
    "`https://www.tiktok.com/@user/video/123456`\n" +
    "`Ummon guruhi - Sensiz`",
    { parse_mode: 'Markdown' }
  );
});

bot.onText(/^\/help/, (msg) => {
  bot.sendMessage(msg.chat.id,
    "🤖 Buyruqlar:\n" +
    "/start - Botni ishga tushirish\n" +
    "/help - Yordam\n\n" +
    "📥 Video havolasini yuboring — Video yoki Audio tugmasini tanlaysiz.\n" +
    "🔎 Havola o'rniga qo'shiq nomini yozsangiz, bot uni o'zi qidirib topib beradi."
  );
});

// /mp3 <link> — faqat audio (musiqa) yuklab olish
bot.onText(/^\/mp3\s+(.+)/i, async (msg, match) => {
  const chatId = msg.chat.id;
  const url = match[1].trim();
  await handleDownload(chatId, url, true);
});

// Havola yuborilganda "Video / Audio" tanlovi ko'rsatilguncha vaqtincha saqlanadi
const LINK_CACHE = new Map(); // linkId -> { url, timestamp }
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of LINK_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) LINK_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

// Oddiy xabar — link bo'lsa "Video/Audio" tanlash tugmalarini ko'rsatadi,
// aks holda qo'shiq nomi sifatida qidiradi
bot.on('message', async (msg) => {
  const chatId = msg.chat.id;
  const text = msg.text || '';

  if (text.startsWith('/')) return; // buyruqlar yuqorida alohida ishlanadi

  const match = text.match(URL_REGEX);
  if (match) {
    const url = match[1];
    const platform = detectPlatform(url);
    if (!platform) {
      bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi. Instagram, TikTok yoki YouTube havolasini yuboring.");
      return;
    }

    const linkId = crypto.randomBytes(4).toString('hex');
    LINK_CACHE.set(linkId, { url, timestamp: Date.now() });

    bot.sendMessage(chatId, `${platform} havolasi aniqlandi. Nimani yuklab olay?`, {
      reply_markup: {
        inline_keyboard: [[
          // Bot API 9.4: "style" maydoni faqat "danger", "primary", "success" qiymatlarini qabul qiladi.
          { text: '🎥 Video', callback_data: `dl:${linkId}:video`, style: 'primary' },
          { text: '🎵 Audio', callback_data: `dl:${linkId}:audio`, style: 'success' }
        ]]
      }
    });
  } else {
    await handleMusicSearch(chatId, text.trim());
  }
});

// Render'ning Secret Files papkasi (/etc/secrets/) faqat o'qish uchun — yt-dlp esa
// cookies faylini yangilab qayta yozishga urinadi. Shu sabab uni yoziladigan joyga nusxalaymiz.
const WRITABLE_COOKIES_PATH = path.join(DOWNLOAD_DIR, 'cookies.txt');
function getCookiesPath() {
  const secretPath = '/etc/secrets/cookies.txt';
  if (!fs.existsSync(secretPath)) return null;
  try {
    fs.copyFileSync(secretPath, WRITABLE_COOKIES_PATH);
    return WRITABLE_COOKIES_PATH;
  } catch (e) {
    console.error('cookies.txt nusxalashda xatolik:', e);
    return secretPath; // fallback, lekin write xatosi chiqishi mumkin
  }
}

// Tezlik uchun umumiy flaglar:
// -4                    IPv6 timeoutlarining oldini olish (cloud hostinglarda odatiy sabab)
// -N 8                  fragmentlarni (DASH) parallel yuklash
// --no-update           avtomatik versiya tekshiruvini o'chirish
// --external-downloader aria2c -- aria2c orqali bir nechta ulanish bilan yuklash (Dockerfile'da o'rnatilgan)
const SPEED_FLAGS = '-4 -N 8 --no-update --external-downloader aria2c --external-downloader-args "-x 16 -s 16 -k 1M"';

function buildYtDlpFlags(platform) {
  const cookiesPath = getCookiesPath();
  const cookiesArg = cookiesPath ? `--cookies "${cookiesPath}"` : '';

  // Cookies mavjud bo'lsa, standart web client yetarli va formatlar to'liq keladi.
  // Cookies bo'lmasa, android client bot-tekshiruvini chetlab o'tishga yordam berishi mumkin.
  const extractorArgs = (platform === 'YouTube' && !cookiesPath)
    ? `--extractor-args "youtube:player_client=android,web"`
    : '';

  return `${SPEED_FLAGS} ${cookiesArg} ${extractorArgs}`;
}

// Berilgan videoId'ni fonda yuklab, yashirin ombor chatga jo'natib file_id oladi
// va AUDIO_CACHE'ga yozadi. Foydalanuvchi hali tugma bosmagan bo'lsa ham, ro'yxat
// ko'rsatilgan zahoti eng mos natija tayyorlana boshlaydi — Shazam botlar kabi
// "tayyor turadigan" his beradi. STORAGE_CHAT_ID sozlanmagan bo'lsa, hech narsa qilmaydi.
function prefetchAudio(videoId, title) {
  if (!STORAGE_CHAT_ID) return; // ombor sozlanmagan — prefetch imkonsiz, jim o'tkazib yuboramiz
  if (AUDIO_CACHE[videoId] || PENDING_PREFETCH.has(videoId)) return; // allaqachon keshda yoki yuklanmoqda

  const promise = new Promise((resolve) => {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const fileKey = crypto.randomBytes(6).toString('hex');
    const outputTemplate = path.join(DOWNLOAD_DIR, `${fileKey}.%(ext)s`);
    const flags = buildYtDlpFlags('YouTube');
    const cmd = `yt-dlp ${flags} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a -o "${outputTemplate}" "${url}"`;

    exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
      if (error) {
        console.error(`[prefetch] "${title}" yuklashda xatolik:`, stderr || error.message);
        resolve(null);
        return;
      }
      const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileKey));
      if (files.length === 0) {
        console.error(`[prefetch] "${title}" — fayl topilmadi`);
        resolve(null);
        return;
      }
      const filePath = path.join(DOWNLOAD_DIR, files[0]);
      try {
        const sent = await bot.sendAudio(STORAGE_CHAT_ID, filePath, { title });
        if (sent && sent.audio && sent.audio.file_id) {
          AUDIO_CACHE[videoId] = sent.audio.file_id;
          saveAudioCache();
          console.log(`[prefetch] "${title}" omborga saqlandi ✅`);
          resolve(sent.audio.file_id);
        } else {
          console.error(`[prefetch] "${title}" — sendAudio javobida file_id topilmadi`);
          resolve(null);
        }
      } catch (e) {
        console.error(`[prefetch] "${title}" — STORAGE_CHAT_ID'ga yuborishda xatolik:`, e.message);
        resolve(null);
      } finally {
        fs.unlink(filePath, () => {});
      }
    });
  }).finally(() => PENDING_PREFETCH.delete(videoId));

  PENDING_PREFETCH.set(videoId, promise);
}

async function handleDownload(chatId, url, audioOnly) {
  const platform = detectPlatform(url);
  if (!platform) {
    bot.sendMessage(chatId, "❌ Bu havolani tanib bo'lmadi. Instagram, TikTok yoki YouTube havolasini yuboring.");
    return;
  }

  const statusMsg = await bot.sendMessage(chatId, `⏳ ${platform}'dan ${audioOnly ? 'musiqa' : 'video'} yuklanmoqda...`);

  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags(platform);

  const cmd = audioOnly
    ? `yt-dlp ${flags} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a -o "${outputTemplate}" "${url}"`
    : `yt-dlp ${flags} -f "mp4/best" -o "${outputTemplate}" "${url}"`;

  // MUHIM TUZATISH: avval bu yerda "audioOnly" o'rniga doim "true" yuborilar edi —
  // ya'ni video tanlansa ham runAndSend uni AUDIO sifatida yuborishga urinardi.
  runAndSend(cmd, chatId, statusMsg.message_id, fileId, audioOnly, `❌ Yuklab bo'lmadi. Havola noto'g'ri yoki video mavjud emas bo'lishi mumkin.`);
}

// Qidiruv natijalarini vaqtincha saqlash (tugma bosilganda foydalanish uchun)
const SEARCH_CACHE = new Map(); // searchId -> [{id, title}, ...]
setInterval(() => {
  const THIRTY_MIN = 30 * 60 * 1000;
  const now = Date.now();
  for (const [key, val] of SEARCH_CACHE) {
    if (now - val.timestamp > THIRTY_MIN) SEARCH_CACHE.delete(key);
  }
}, 10 * 60 * 1000);

// Qo'shiq nomi bo'yicha YouTube'dan 10 ta natija topib, tugmalar bilan ko'rsatish
async function handleMusicSearch(chatId, query) {
  if (!query || query.length < 2) return;

  const statusMsg = await bot.sendMessage(chatId, `🔎 "${query}" qidirilmoqda...`);

  const safeQuery = query.replace(/"/g, '');
  // Qidiruv bosqichida ham -4 va android client ishlatamiz — bu YouTube javobini
  // sezilarli tezlashtiradi (kamroq metama'lumot, kamroq cheklov, IPv6 timeout yo'q).
  const cmd = `yt-dlp -4 --no-update --extractor-args "youtube:player_client=android" --flat-playlist --skip-download --socket-timeout 8 --print "%(id)s|||%(title)s" "ytsearch10:${safeQuery}"`;

  const searchT0 = Date.now();
  exec(cmd, { maxBuffer: 1024 * 1024 * 20 }, async (error, stdout) => {
    console.log(`[TIMING] Qidiruv "${query}": ${((Date.now() - searchT0) / 1000).toFixed(1)}s`);
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

    // Tugmalarni 5 tadan qatorlarga bo'lib joylashtirish
    const buttons = results.map((r, i) => ({
      text: `🎵 ${i + 1}`,
      callback_data: `pick:${searchId}:${i}`
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

    // Ro'yxat ko'rsatilishi bilan eng mos (1-) natijani fonda oldindan yuklashni boshlaymiz.
    // Foydalanuvchi odatda birinchi natijani tanlaydi va ro'yxatni o'qish uchun ham
    // bir necha soniya sarflaydi — shu vaqt ichida fayl allaqachon tayyor bo'lishi mumkin.
    prefetchAudio(results[0].id, results[0].title);
  });
}

// Tugma bosilganda — havoladan Video yoki Audio tanlangan bo'lsa, shuni yuklab yuborish
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!data.startsWith('dl:')) return;

  const [, linkId, kind] = data.split(':');
  const cached = LINK_CACHE.get(linkId);

  if (!cached) {
    bot.answerCallbackQuery(query.id, { text: '⏱ Havola muddati tugagan, qayta yuboring.', show_alert: true }).catch(() => {});
    return;
  }

  bot.answerCallbackQuery(query.id, { text: kind === 'audio' ? '⏳ Audio yuklanmoqda...' : '⏳ Video yuklanmoqda...' }).catch(() => {});
  bot.deleteMessage(chatId, query.message.message_id).catch(() => {});

  await handleDownload(chatId, cached.url, kind === 'audio');
});

// Tugma bosilganda — tanlangan qo'shiqni yuklab yuborish
bot.on('callback_query', async (query) => {
  const chatId = query.message.chat.id;
  const data = query.data || '';

  if (!data.startsWith('pick:')) return;

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

  // Kesh bo'lsa — qayta yuklamasdan, Telegram'ning o'zidagi faylni darhol jo'natamiz
  const cachedFileId = AUDIO_CACHE[chosen.id];
  if (cachedFileId) {
    bot.answerCallbackQuery(query.id, { text: `✅ ${chosen.title}` }).catch(() => {});
    const statusMsg = await bot.sendMessage(chatId, `📤 "${chosen.title}" yuborilmoqda...`);
    try {
      await bot.sendAudio(chatId, cachedFileId);
      await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
      return;
    } catch (e) {
      // file_id eskirgan/yaroqsiz bo'lsa, keshdan o'chirib qayta yuklaymiz
      delete AUDIO_CACHE[chosen.id];
      saveAudioCache();
    }
  }

  // Bu qo'shiq hozir fonda oldindan yuklanayotgan bo'lsa (prefetch), yangi yuklashni
  // boshlamasdan o'sha jarayon tugashini kutamiz — resurslarni ikki marta sarflamaslik uchun
  if (PENDING_PREFETCH.has(chosen.id)) {
    bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} deyarli tayyor...` }).catch(() => {});
    const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" tayyorlanmoqda...`);
    const fid = await PENDING_PREFETCH.get(chosen.id);
    if (fid) {
      try {
        await bot.sendAudio(chatId, fid);
        await bot.deleteMessage(chatId, statusMsg.message_id).catch(() => {});
        return;
      } catch (e) { /* fallback pastga — oddiy yuklashga o'tamiz */ }
    }
    // prefetch muvaffaqiyatsiz bo'lsa, statusMsg'ni qayta ishlatib oddiy yuklashga tushamiz
    return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
  }

  bot.answerCallbackQuery(query.id, { text: `⏳ ${chosen.title} yuklanmoqda...` }).catch(() => {});

  const statusMsg = await bot.sendMessage(chatId, `⏳ "${chosen.title}" yuklanmoqda...`);
  return await downloadAndSendPick(chatId, chosen, statusMsg.message_id);
});

function downloadAndSendPick(chatId, chosen, statusMessageId) {
  const url = `https://www.youtube.com/watch?v=${chosen.id}`;
  const fileId = crypto.randomBytes(6).toString('hex');
  const outputTemplate = path.join(DOWNLOAD_DIR, `${fileId}.%(ext)s`);
  const flags = buildYtDlpFlags('YouTube');
  const cmd = `yt-dlp ${flags} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format m4a -o "${outputTemplate}" "${url}"`;

  console.log(`[TIMING] "${chosen.title}" yuklash boshlandi...`);
  const t0 = Date.now();

  return runAndSend(cmd, chatId, statusMessageId, fileId, true, `❌ "${chosen.title}" yuklab bo'lmadi.`, chosen.id, chosen.title, t0);
}

function runAndSend(cmd, chatId, statusMessageId, fileId, audioOnly, errorText, cacheKey, cacheTitle, t0) {
  const startedAt = t0 || Date.now();
  exec(cmd, { maxBuffer: 1024 * 1024 * 50 }, async (error, stdout, stderr) => {
    const downloadMs = Date.now() - startedAt;
    console.log(`[TIMING] yt-dlp jarayoni: ${(downloadMs / 1000).toFixed(1)}s (${cacheTitle || fileId})`);

    if (error) {
      console.error(`[TIMING] XATOLIK (${(downloadMs / 1000).toFixed(1)}s dan keyin):`, stderr || error.message);
      bot.editMessageText(errorText, {
        chat_id: chatId,
        message_id: statusMessageId
      }).catch(() => {});
      return;
    }

    const files = fs.readdirSync(DOWNLOAD_DIR).filter(f => f.startsWith(fileId));
    if (files.length === 0) {
      bot.editMessageText("❌ Fayl topilmadi.", { chat_id: chatId, message_id: statusMessageId }).catch(() => {});
      return;
    }

    const filePath = path.join(DOWNLOAD_DIR, files[0]);
    const sizeMb = (fs.statSync(filePath).size / 1024 / 1024).toFixed(2);
    console.log(`[TIMING] Fayl hajmi: ${sizeMb} MB, Telegram'ga yuklanmoqda...`);
    const t1 = Date.now();

    try {
      if (audioOnly) {
        const sent = await bot.sendAudio(chatId, filePath, cacheTitle ? { title: cacheTitle } : {});
        const uploadMs = Date.now() - t1;
        console.log(`[TIMING] Telegram'ga yuklash: ${(uploadMs / 1000).toFixed(1)}s | JAMI: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        // Keyingi safar shu qo'shiq so'ralganda qayta yuklamasdan darhol jo'natish uchun saqlaymiz
        if (cacheKey && sent && sent.audio && sent.audio.file_id) {
          AUDIO_CACHE[cacheKey] = sent.audio.file_id;
          saveAudioCache();
        }
      } else {
        await bot.sendVideo(chatId, filePath, {}, { filename: files[0], contentType: 'video/mp4' });
        console.log(`[TIMING] JAMI: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
      }
      await bot.deleteMessage(chatId, statusMessageId).catch(() => {});
    } catch (sendErr) {
      console.error(sendErr);
      bot.sendMessage(chatId, "❌ Faylni yuborishda xatolik yuz berdi (fayl juda katta bo'lishi mumkin, Telegram limiti 50MB).");
    } finally {
      fs.unlink(filePath, () => {}); // vaqtinchalik faylni tozalash
    }
  });
}

console.log("🤖 Bot ishga tushdi...");
if (STORAGE_CHAT_ID) {
  console.log(`📦 Ombor kanali sozlangan: ${STORAGE_CHAT_ID}`);
} else {
  console.log("⚠️ STORAGE_CHAT_ID sozlanmagan — prefetch (oldindan yuklash) o'chirilgan.");
}
