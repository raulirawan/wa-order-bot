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

            const from = msg.key.remoteJid;
            const text = msg.message.conversation?.trim().toUpperCase();
            if (!text) continue;

            const match = text.match(/^(APPROVE|REJECT)\s+(\S+)$/);
            if (!match) continue;

            const action = match[1];
            const orderId = match[2];

            const order = pendingOrders.get(orderId);
            if (!order) {
                await sock.sendMessage(from, { text: `❌ Order ${orderId} tidak ditemukan` });
                continue;
            }

            if (!(from in order.recipients)) continue;
            if (order.recipients[from] !== null) continue;

            order.recipients[from] = action === "APPROVE" ? "yes" : "no";

            await sock.sendMessage(from, {
                text:
                    action === "APPROVE"
                        ? `✅ Anda menyetujui order #${orderId}`
                        : `❌ Anda menolak order #${orderId}`,
            });

            // 🧹 Bersihkan JID menjadi nomor saja
            const cleanNumber = from.replace(/@s\.whatsapp\.net$/, "");

            // 🔁 Callback ke Laravel (nomor tanpa suffix)
            if (order.callbackUrl) {
                try {
                    await axios.post(order.callbackUrl, {
                        orderId,
                        user: cleanNumber, // ← kirim nomor bersih di sini
                        status: order.recipients[from],
                    });
                } catch (e) {
                    console.error("Callback error:", e.message);
                }
            }
            // ✅ Cek status semua recipients
            const allApproved = Object.values(order.recipients).every((v) => v === "yes");
            const anyRejected = Object.values(order.recipients).some((v) => v === "no");

            if (allApproved) {
                order.status = "approved";
                console.log(`🎉 Order ${orderId} disetujui semua`);
                pendingOrders.delete(orderId);
            } else if (anyRejected) {
                order.status = "rejected";
                console.log(`❌ Order ${orderId} ditolak salah satu user`);
                pendingOrders.delete(orderId);
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
    const { orderId, recipients, message, callbackUrl } = req.body;
    if (!orderId || !recipients || !message)
        return res.status(400).send({ error: "orderId, recipients, message wajib" });

    try {
        if (!isConnected) return res.status(500).send({ error: "WA belum connect" });

        const recipientsStatus = {};
        for (const r of recipients) {
            const jid = r.includes("@s.whatsapp.net") ? r : `${r}@s.whatsapp.net`;
            recipientsStatus[jid] = null;
            await sock.sendMessage(jid, { text: message });
        }

        pendingOrders.set(orderId, { recipients: recipientsStatus, callbackUrl, status: "pending" });
        saveOrders(); // 💾 simpan order baru

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