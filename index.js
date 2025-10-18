const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const pino = require("pino");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason } = require("@whiskeysockets/baileys");
const app = express();
const axios = require('axios');
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
    },
    pingTimeout: 60000,
    pingInterval: 25000,
});

require("dotenv").config();

app.use(express.json());
app.use(express.static("public")); // serve frontend dari folder public

// === 🔒 API Key Middleware ===
function verifyApiKey(req, res, next) {
    const apiKey = req.headers["x-api-key"];
    if (!apiKey || apiKey !== process.env.API_KEY) {
        return res.status(401).json({ error: "Unauthorized: Invalid API key" });
    }
    next();
}

// === Load & Save Orders JSON ===
function loadOrders() {
    if (fs.existsSync(ORDER_FILE)) {
        try {
            const data = JSON.parse(fs.readFileSync(ORDER_FILE, "utf8"));
            for (const [id, order] of Object.entries(data)) {
                pendingOrders.set(id, order);
            }
            console.log(`📦 Loaded ${pendingOrders.size} pending orders`);
        } catch (err) {
            console.error("❌ Error loading orders.json:", err.message);
        }
    }
}

function saveOrders() {
    const data = Object.fromEntries(pendingOrders);
    fs.writeFileSync(ORDER_FILE, JSON.stringify(data, null, 2));
}
const pendingOrders = new Map();

let sock;
let isConnected = false;
let lastQr = null; // simpan QR terakhir
const AUTH_FOLDER = path.join(__dirname, "auth_info");
const ORDER_FILE = path.join(__dirname, "orders.json");

function deleteAuthFolder() {
    if (fs.existsSync(AUTH_FOLDER)) {
        fs.rm(AUTH_FOLDER, { recursive: true, force: true }, (err) => {
            if (err) console.error(err);
            else console.log("🗑️ auth_info folder dihapus (auto reset)");
        });
    }
}

let isReconnecting = false;

async function connectWA() {
    if (isReconnecting) return;
    isReconnecting = true;

    const { state, saveCreds } = await useMultiFileAuthState(AUTH_FOLDER);
    sock = makeWASocket({ logger: pino({ level: "silent" }), auth: state, printQRInTerminal: false });

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr && lastQr !== qr) {
            setImmediate(async () => {
                lastQr = await qrcode.toDataURL(qr);
                io.emit("qr", lastQr);
            });
        }

        if (connection === "open") {
            isConnected = true;
            lastQr = null;
            io.emit("connected", true);
            isReconnecting = false; // reset flag
        }

        if (connection === "close") {
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            isConnected = false;
            io.emit("connected", false);

            if (statusCode === DisconnectReason.loggedOut) {
                deleteAuthFolder();
            }

            setTimeout(() => {
                isReconnecting = false;
                connectWA();
            }, 2000);
        }
    });

    sock.ev.on("messages.upsert", async (m) => {
        for (const msg of m.messages) {
            if (!msg.message || msg.key.fromMe) continue;

            // 🔧 Normalisasi JID (kadang beda format)
            const normalizeJid = (jid) =>
                jid
                    ?.replace(/^(\+)?/, "")
                    ?.replace(/@c\.us$/, "@s.whatsapp.net")
                    ?.replace(/@whatsapp\.net$/, "@s.whatsapp.net")
                    ?.trim();

            const fromRaw = msg.key.remoteJid;
            const from = normalizeJid(fromRaw);

            // Ambil isi pesan (conversation, extendedTextMessage, caption)
            const text =
                msg.message.conversation?.trim() ||
                msg.message.extendedTextMessage?.text?.trim() ||
                msg.message.imageMessage?.caption?.trim() ||
                "";

            const upperText = text.toUpperCase();
            if (!upperText) continue;

            // Format pesan "APPROVE INV-XXXX" atau "REJECT INV-XXXX alasan"
            const match = upperText.match(/^(APPROVE|REJECT)\s+(\S+)(?:\s+(.*))?$/);
            if (!match) {
                console.log("⚠️ Format pesan tidak sesuai, diabaikan:", upperText);
                continue;
            }

            const action = match[1];
            const orderId = match[2];
            const rejectReason = match[3]?.trim() || null;

            // Ambil data order
            const order = pendingOrders.get(orderId);
            if (!order) {
                await sock.sendMessage(from, { text: `❌ Order ${orderId} tidak ditemukan.` });
                console.log(`❌ Order ${orderId} tidak ditemukan untuk ${from}`);
                continue;
            }

            // Normalisasi recipients
            const normalizedRecipients = Object.keys(order.recipients).reduce((acc, key) => {
                acc[normalizeJid(key)] = order.recipients[key];
                return acc;
            }, {});

            if (!(from in normalizedRecipients)) {
                console.log(`🚫 ${from} bukan bagian dari recipients order ${orderId}`);
                continue;
            }

            if (normalizedRecipients[from] !== null) {
                console.log(`⚠️ ${from} sudah memberikan respon sebelumnya`);
                await sock.sendMessage(from, { text: `⚠️ Anda sudah merespon order #${orderId}.` });
                continue;
            }

            // Simpan hasil
            normalizedRecipients[from] = action === "APPROVE" ? "yes" : "no";

            let replyText =
                action === "APPROVE"
                    ? `✅ Anda menyetujui order #${orderId}`
                    : `❌ Anda menolak order #${orderId}`;
            if (rejectReason) replyText += `\n📝 Alasan: ${rejectReason}`;

            await sock.sendMessage(from, { text: replyText });

            // Update pendingOrders
            for (const jid of Object.keys(order.recipients)) {
                const norm = normalizeJid(jid);
                order.recipients[jid] = normalizedRecipients[norm];
            }

            // 🔁 Callback ke Laravel
            const cleanNumber = from.replace(/@.*$/, "");
            if (order.callbackUrl) {
                try {
                    await axios.post(order.callbackUrl, {
                        orderId,
                        user: cleanNumber,
                        status: order.recipients[from] ?? normalizedRecipients[from],
                        reject_reason: rejectReason,
                    });
                    console.log(`🔁 Callback terkirim ke Laravel untuk ${cleanNumber}`);
                } catch (e) {
                    console.error("❌ Callback error:", e.message);
                }
            }

            // ✅ Cek status semua recipients
            const recipients = Object.values(order.recipients);
            const allResponded = recipients.every((v) => v !== null);
            const allApproved = allResponded && recipients.every((v) => v === "yes");
            const allRejected = allResponded && recipients.every((v) => v === "no");

            console.log("📋 STATUS SEMENTARA:", order.recipients);

            if (allApproved) {
                order.status = "approved";
                console.log(`🎉 Semua user menyetujui order ${orderId}`);
                pendingOrders.delete(orderId);
            } else if (allRejected) {
                order.status = "rejected";
                console.log(`❌ Salah satu user menolak order ${orderId}`);
                pendingOrders.delete(orderId);
            } else {
                console.log(`🕐 Menunggu user lain untuk order ${orderId}...`);
            }

            saveOrders();
        }
    });




}

connectWA();
loadOrders();


// === Endpoint API kirim pesan ===
app.post("/send", verifyApiKey, async (req, res) => {
    const { to, text } = req.body;
    if (!to || !text) return res.status(400).send({ error: "to & text wajib" });

    try {
        if (!isConnected) return res.status(500).send({ error: "WA belum connect" });

        await sock.sendMessage(`${to}@s.whatsapp.net`, { text });
        res.send({ success: true, to, text });
    } catch (e) {
        console.error("Send error:", e);
        res.status(500).send({ error: e.message });
    }
});

// === Endpoint API kirim pesan order dengan tombol Yes/No ===
app.post("/send-order", verifyApiKey, async (req, res) => {
    const { orderId, recipients, message, callbackUrl, identity, flight_ticket, hotel_ticket } = req.body;

    if (!orderId || !recipients || !message)
        return res.status(400).send({ error: "orderId, recipients, message wajib" });

    try {
        if (!isConnected)
            return res.status(500).send({ error: "WA belum connect" });

        const recipientsStatus = {};
        const imageFields = [
            { key: "identity", value: identity, caption: "🪪 Passport" },
            { key: "flight_ticket", value: flight_ticket, caption: "✈️ Tiket Penerbangan" },
            { key: "hotel_ticket", value: hotel_ticket, caption: "🏨 Tiket Hotel" },
        ];

        for (const r of recipients) {
            const jid = r.includes("@s.whatsapp.net") ? r : `${r}@s.whatsapp.net`;
            recipientsStatus[jid] = null;

            // Kirim pesan utama
            await sock.sendMessage(jid, { text: message });

            // Kirim masing-masing gambar jika ada
            for (const img of imageFields) {
                if (!img.value) continue; // skip kalau kosong/null

                let imagePayload;

                if (img.value.startsWith("http")) {
                    imagePayload = { url: img.value };
                } else if (img.value.startsWith("data:image")) {
                    const base64Data = img.value.split(",")[1];
                    imagePayload = Buffer.from(base64Data, "base64");
                } else {
                    // asumsikan path lokal
                    imagePayload = { url: img.value };
                }

                await sock.sendMessage(jid, {
                    image: imagePayload,
                    caption: img.caption,
                });
            }
        }

        // Simpan order
        pendingOrders.set(orderId, {
            recipients: recipientsStatus,
            callbackUrl,
            status: "pending",
        });
        saveOrders();

        res.send({ success: true, orderId });
    } catch (e) {
        console.error("Send order error:", e);
        res.status(500).send({ error: e.message });
    }
});




// === Socket.io client connect ===
io.on("connection", (socket) => {
    console.log("🟢 Browser UI connected ke socket.io");
    socket.emit("connected", isConnected); // kirim status terakhir
    if (!isConnected && lastQr) {
        socket.emit("qr", lastQr); // kirim QR terakhir kalau ada
    }
});
app.get("/status", (req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ connected: isConnected }));
});

app.post("/logout", async (req, res) => {
    try {
        if (sock) {
            await sock.logout();
            deleteAuthFolder();
        }
        res.send({ success: true });
    } catch (e) {
        console.error("Logout error:", e);
        res.status(500).send({ error: e.message });
    }
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`🚀 Server running at http://localhost:${PORT}`);
});