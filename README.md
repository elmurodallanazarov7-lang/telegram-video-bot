# Telegram Video Downloader Bot

Instagram, TikTok va YouTube'dan video va musiqa yuklab beruvchi bot.

## O'rnatish

### 1. Node.js kutubxonalarini o'rnatish
```bash
npm install
```

### 2. yt-dlp'ni o'rnatish (majburiy!)
Bot video yuklash uchun `yt-dlp` dasturidan foydalanadi. Uni tizimingizga o'rnating:

**Windows:**
```bash
winget install yt-dlp
```
yoki https://github.com/yt-dlp/yt-dlp/releases sahifasidan `yt-dlp.exe` yuklab, PATH'ga qo'shing.

**macOS:**
```bash
brew install yt-dlp
```

**Linux:**
```bash
sudo apt install yt-dlp
# yoki
pip install yt-dlp
```

Tekshirish: `yt-dlp --version` buyrug'ini terminalda ishga tushiring — versiya raqami chiqishi kerak.

### 3. ffmpeg'ni o'rnatish (musiqa/mp3 uchun kerak)
```bash
# Windows
winget install ffmpeg

# macOS
brew install ffmpeg

# Linux
sudo apt install ffmpeg
```

### 4. Bot tokenini olish
1. Telegram'da [@BotFather](https://t.me/BotFather) ga yozing
2. `/newbot` buyrug'ini yuboring va ko'rsatmalarga amal qiling
3. Sizga beriladigan tokenni nusxalab oling

### 5. Tokenni sozlash
`.env.example` faylini `.env` deb nomlang va o'zingizning tokeningizni yozing:
```
BOT_TOKEN=123456789:AAAbbbCCCdddEEEfffGGGhhh
```

### 6. Botni ishga tushirish
```bash
npm start
```

## Foydalanish

- `/start` — botni ishga tushirish
- `/help` — yordam
- Video havolasini yuborish — video yuklab beradi
- `/mp3 <havola>` — faqat musiqa (audio) yuklab beradi

## Render'da deploy qilish

Bu loyihada `Dockerfile` bor, shuning uchun Render avtomatik ravishda uni aniqlab, yt-dlp va ffmpeg'ni o'zi o'rnatadi.

1. Loyihani GitHub'ga yuklang (repo yarating va push qiling)
2. [render.com](https://render.com) ga kiring → **New** → **Web Service**
   - Agar tarifingiz **Background Worker**'ni qo'llab-quvvatlasa, o'sha turni tanlang (undan yaxshirog'i yo'q, chunki bot HTTP so'rov qabul qilmaydi)
   - Bepul tarifda faqat **Web Service** mavjud bo'lsa, xavotir olmang — kod ichida avtomatik health-check server bor
3. Repo'ni ulang
4. **Environment** bo'limida:
   - `Runtime`: Docker (avtomatik aniqlanadi, Dockerfile borligi sababli)
5. **Environment Variables** bo'limiga qo'shing:
   - `BOT_TOKEN` = BotFather'dan olgan tokeningiz
6. **Deploy** tugmasini bosing

Deploy tugagach, loglarda `🤖 Bot ishga tushdi...` yozuvini ko'rasiz — bot ishlay boshlagan bo'ladi.

### Muhim eslatmalar (Render uchun)
- **Free tarif uyquga ketadi**: agar bepul Web Service ishlatsangiz, 15 daqiqa faolsizlikdan keyin server "uxlab qoladi" va Telegram polling to'xtaydi. Doimiy ishlashi uchun pullik tarif yoki Background Worker kerak.
- **Disk vaqtinchalik**: Render'dagi fayl tizimi doimiy emas (har deploy'da tozalanadi), lekin bu muammo emas — bot video/audio faylni yuklab, yuborib, so'ng darhol o'chirib tashlaydi.

## "Sign in to confirm you're not a bot" xatosi chiqsa

Bu YouTube (ba'zan Instagram) ning server IP-manzillaridan kelayotgan so'rovlarni bloklashi. Buni **cookies.txt** yordamida hal qilamiz — bu YouTube hisobingizning login ma'lumotlarini o'z ichiga oladi, shuning uchun uni **hech qachon GitHub'ga (ayniqsa Public repo'ga) yuklamang**. Render'ning "Secret Files" funksiyasidan foydalanamiz — bu fayl faqat serverga yuklanadi, kodga qo'shilmaydi.

### 1-qadam: cookies.txt faylini olish
1. Brauzeringizga **"Get cookies.txt LOCALLY"** kengaytmasini o'rnating (Chrome yoki Firefox uchun bor)
2. YouTube'ga (asosiy shaxsiy hisobingiz emas, zaxira/ikkinchi hisob tavsiya etiladi — bloklanish xavfi bo'lishi mumkin) kiring
3. youtube.com sahifasida turib, kengaytma orqali cookies'ni **cookies.txt** formatida eksport qiling

### 2-qadam: Render'ga qo'shish
1. Render dashboard'da o'z service'ingizni oching
2. **Environment** bo'limiga o'ting
3. **"Secret Files"** qismini toping → **"Add Secret File"**
4. **Filename**: `cookies.txt`
5. **Contents**: eksport qilingan faylning butun matnini joylashtiring
6. Saqlang — Render avtomatik ravishda qayta deploy qiladi

Bot kodida bu fayl avtomatik ravishda `/etc/secrets/cookies.txt` manzilidan topiladi va ishlatiladi.

## Eslatma

- Telegram bot orqali fayl yuborish limiti — **50MB**. Undan katta videolar yuborilmasligi mumkin.
- Yuklab olingan kontentdan mualliflik huquqiga rioya qilgan holda foydalaning — ba'zi platformalar video yuklab olishni o'z shartlarida cheklashi mumkin.
