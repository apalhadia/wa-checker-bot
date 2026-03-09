const { default: makeWASocket, DisconnectReason, useMultiFileAuthState } = require('@whiskeysockets/baileys')
const TelegramBot = require('node-telegram-bot-api')
const qrcode = require('qrcode')
const pino = require('pino')

// ─── CONFIG ─────────────────────────────────────────────────────────────────
const BOT_TOKEN  = process.env.BOT_TOKEN  || 'ISI_BOT_TOKEN'
const OWNER_ID   = process.env.OWNER_ID   ? Number(process.env.OWNER_ID) : null
const ALLOWED_IDS = process.env.ALLOWED_IDS
    ? process.env.ALLOWED_IDS.split(',').map(Number)
    : []

const AUTH_FOLDER = './auth_info'

// ─── STATE ──────────────────────────────────────────────────────────────────
let waSocket    = null
let isConnected = false
let ownerChatId = OWNER_ID

// ─── TELEGRAM BOT ───────────────────────────────────────────────────────────
const bot = new TelegramBot(BOT_TOKEN, { polling: true })

function isAllowed(userId) {
    if (ALLOWED_IDS.length === 0) return true
    return ALLOWED_IDS.includes(userId)
}

// ─── WHATSAPP CONNECT ───────────────────────────────────────────────────────
async function connectWA() {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER)

    const sock = makeWASocket({
        auth: state,
        printQRInTerminal: true,
        logger: pino({ level: 'silent' }),
        browser: ['WA Checker', 'Chrome', '120.0'],
    })

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update

        if (qr && ownerChatId) {
            try {
                const qrBuffer = await qrcode.toBuffer(qr, { scale: 8 })
                await bot.sendPhoto(ownerChatId, qrBuffer, {
                    caption:
                        '📱 *Scan QR ini dengan WhatsApp!*\n\n' +
                        '1. Buka WhatsApp di HP kamu\n' +
                        '2. Ketuk ⋮ Menu → *Perangkat Tertaut*\n' +
                        '3. Ketuk *Tautkan Perangkat*\n' +
                        '4. Scan QR di atas\n\n' +
                        '⏳ QR berlaku ~60 detik',
                    parse_mode: 'Markdown',
                })
            } catch (e) {
                console.error('Gagal kirim QR:', e.message)
            }
        }

        if (connection === 'close') {
            const code = lastDisconnect?.error?.output?.statusCode
            const shouldReconnect = code !== DisconnectReason.loggedOut
            console.log('WA terputus, kode:', code, '| Reconnect:', shouldReconnect)

            if (shouldReconnect) {
                setTimeout(connectWA, 3000)
            } else {
                isConnected = false
                if (ownerChatId) {
                    bot.sendMessage(ownerChatId, '⚠️ WhatsApp logout!\nKetik /connect untuk scan QR lagi.')
                }
            }
        }

        if (connection === 'open') {
            isConnected = true
            console.log('✅ WhatsApp terhubung!')
            if (ownerChatId) {
                bot.sendMessage(ownerChatId,
                    '✅ *WhatsApp berhasil terhubung!*\n\nBot siap cek nomor. Kirim list nomor untuk mulai.',
                    { parse_mode: 'Markdown' }
                )
            }
        }
    })

    sock.ev.on('creds.update', saveCreds)
    waSocket = sock
}

// ─── COMMANDS ────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
    if (!isAllowed(msg.from.id)) return
    ownerChatId = msg.chat.id

    const status = isConnected
        ? '✅ WhatsApp: *Terhubung* — siap cek nomor!'
        : '❌ WhatsApp: *Belum terhubung*\nKetik /connect untuk scan QR'

    await bot.sendMessage(msg.chat.id,
        `🔍 *WA Checker Bot*\n\n${status}\n\n` +
        `*Cara pakai:*\nKirim list nomor (satu per baris) atau satu nomor langsung.\n\n` +
        `*Format nomor:*\n` +
        `\`628123456789\` (tanpa + dan spasi)\n\n` +
        `*Hasil:*\n` +
        `✅ = Belum daftar WA → bisa dipakai\n` +
        `❌ = Sudah terdaftar WA\n\n` +
        `*/connect* — Hubungkan WhatsApp\n` +
        `*/status* — Cek status koneksi\n` +
        `*/myid* — Lihat Telegram ID kamu`,
        { parse_mode: 'Markdown' }
    )
})

bot.onText(/\/connect/, async (msg) => {
    if (!isAllowed(msg.from.id)) return
    ownerChatId = msg.chat.id

    if (isConnected) {
        bot.sendMessage(msg.chat.id, '✅ WhatsApp sudah terhubung!')
        return
    }

    await bot.sendMessage(msg.chat.id, '⏳ Menghubungkan ke WhatsApp...\nQR akan dikirim sebentar lagi.')
    await connectWA()
})

bot.onText(/\/status/, (msg) => {
    if (!isAllowed(msg.from.id)) return
    const status = isConnected
        ? '✅ WhatsApp terhubung dan siap digunakan!'
        : '❌ WhatsApp belum terhubung.\nKetik /connect untuk scan QR.'
    bot.sendMessage(msg.chat.id, status)
})

bot.onText(/\/myid/, (msg) => {
    bot.sendMessage(msg.chat.id,
        `🆔 *Telegram ID kamu:*\n\n\`${msg.from.id}\`\n\nNama: ${msg.from.first_name}`,
        { parse_mode: 'Markdown' }
    )
})

// ─── CEK NOMOR ───────────────────────────────────────────────────────────────

bot.on('message', async (msg) => {
    if (!isAllowed(msg.from.id)) return
    if (!msg.text || msg.text.startsWith('/')) return

    if (!isConnected || !waSocket) {
        bot.sendMessage(msg.chat.id,
            '❌ WhatsApp belum terhubung.\nKetik /connect dulu!'
        )
        return
    }

    // Parse semua nomor dari pesan
    const numbers = msg.text
        .split(/[\n,;\s]+/)
        .map(n => n.replace(/[^0-9]/g, ''))
        .filter(n => n.length >= 9 && n.length <= 15)

    if (numbers.length === 0) {
        bot.sendMessage(msg.chat.id,
            '❌ Tidak ada nomor valid.\n\nFormat: `628123456789`\n(awali dengan kode negara, tanpa +)',
            { parse_mode: 'Markdown' }
        )
        return
    }

    const statusMsg = await bot.sendMessage(msg.chat.id,
        `⏳ Mengecek *${numbers.length}* nomor...`,
        { parse_mode: 'Markdown' }
    )

    const results   = []
    const available = []
    const registered = []

    for (const num of numbers) {
        try {
            const jid = `${num}@s.whatsapp.net`
            const [result] = await waSocket.onWhatsApp(jid)

            if (result && result.exists) {
                results.push(`❌ \`+${num}\` — Sudah terdaftar WA`)
                registered.push(num)
            } else {
                results.push(`✅ \`+${num}\` — Belum daftar (bisa dipakai!)`)
                available.push(num)
            }
        } catch (e) {
            results.push(`⚠️ \`+${num}\` — Gagal cek`)
        }

        // Delay kecil biar tidak rate-limit
        await new Promise(r => setTimeout(r, 600))
    }

    const summary =
        `📊 *Ringkasan:*\n` +
        `✅ Belum daftar: *${available.length}*\n` +
        `❌ Sudah daftar: *${registered.length}*\n\n`

    const detail = `🔍 *Detail:*\n${results.join('\n')}`

    // Kalau ada nomor available, tampilkan juga list bersihnya
    let cleanList = ''
    if (available.length > 0) {
        cleanList = `\n\n📋 *List nomor tersedia (copy):*\n\`\`\`\n${available.join('\n')}\n\`\`\``
    }

    const fullText = summary + detail + cleanList

    // Telegram max 4096 chars, split kalau perlu
    if (fullText.length <= 4096) {
        await bot.editMessageText(fullText, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown',
        })
    } else {
        await bot.editMessageText(summary + `Total ${numbers.length} nomor dicek.`, {
            chat_id: msg.chat.id,
            message_id: statusMsg.message_id,
            parse_mode: 'Markdown',
        })
        // Kirim detail dalam chunks
        const chunkSize = 50
        for (let i = 0; i < results.length; i += chunkSize) {
            const chunk = results.slice(i, i + chunkSize).join('\n')
            await bot.sendMessage(msg.chat.id, chunk, { parse_mode: 'Markdown' })
        }
        if (available.length > 0) {
            await bot.sendMessage(msg.chat.id,
                `📋 *Nomor tersedia:*\n\`\`\`\n${available.join('\n')}\n\`\`\``,
                { parse_mode: 'Markdown' }
            )
        }
    }
})

// ─── START ───────────────────────────────────────────────────────────────────
console.log('🔍 WA Checker Bot aktif!')
connectWA()
