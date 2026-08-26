const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Toplam 100.000 Piksel (400 x 250 Grid)
const CANVAS_WIDTH = 400;
const CANVAS_HEIGHT = 250;
const PIXEL_SIZE = 4;
const COOLDOWN_MS = 5000; // 5 Saniye Cooldown (1 Hak)
const MAX_ACCUMULATION_MS = 60000; // Maksimum 60 Saniye Biriktirme (12 Hak)

// Veri Yapıları
const pixels = {};
const userBanks = {}; // userId bazlı süre takibi (Sayfa yenilense de silinmez)
const userStats = {}; // isme göre istatistik takibi { username: { placedCount: 0 } }
let chatHistory = [];
let onlineCount = 0;

// Kalıcı Dosya Yolları
const PIXELS_FILE = path.join(__dirname, 'pixels.json');
const USERS_FILE = path.join(__dirname, 'users.json');
const CHAT_FILE = path.join(__dirname, 'chat.json');
const STATS_FILE = path.join(__dirname, 'stats.json');

// Verileri Diskten Yükleme Fonksiyonu
function loadData() {
    if (fs.existsSync(PIXELS_FILE)) {
        try { Object.assign(pixels, JSON.parse(fs.readFileSync(PIXELS_FILE, 'utf8'))); } catch (e) { console.error('Pixels okuma hatası:', e); }
    }
    if (fs.existsSync(USERS_FILE)) {
        try { Object.assign(userBanks, JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))); } catch (e) { console.error('Users okuma hatası:', e); }
    }
    if (fs.existsSync(CHAT_FILE)) {
        try { chatHistory = JSON.parse(fs.readFileSync(CHAT_FILE, 'utf8')); } catch (e) { console.error('Chat okuma hatası:', e); }
    }
    if (fs.existsSync(STATS_FILE)) {
        try { Object.assign(userStats, JSON.parse(fs.readFileSync(STATS_FILE, 'utf8'))); } catch (e) { console.error('Stats okuma hatası:', e); }
    }
}
loadData();

// Verileri Diske Otomatik Kaydetme
let saveTimeout = null;
function saveDataToDisk() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        try {
            fs.writeFile(PIXELS_FILE, JSON.stringify(pixels), () => {});
            fs.writeFile(USERS_FILE, JSON.stringify(userBanks), () => {});
            fs.writeFile(CHAT_FILE, JSON.stringify(chatHistory), () => {});
            fs.writeFile(STATS_FILE, JSON.stringify(userStats), () => {});
        } catch (err) {
            console.error('Veri kaydetme hatası:', err);
        }
    }, 500);
}

function syncSaveOnExit() {
    try {
        fs.writeFileSync(PIXELS_FILE, JSON.stringify(pixels));
        fs.writeFileSync(USERS_FILE, JSON.stringify(userBanks));
        fs.writeFileSync(CHAT_FILE, JSON.stringify(chatHistory));
        fs.writeFileSync(STATS_FILE, JSON.stringify(userStats));
        console.log('Tüm veriler diske başarıyla kaydedildi.');
    } catch (err) {
        console.error('Kapanış kaydında hata:', err);
    }
}
process.on('SIGINT', () => { syncSaveOnExit(); process.exit(); });
process.on('SIGTERM', () => { syncSaveOnExit(); process.exit(); });

// Kullanıcının Anlık Süre / Hak Hesabı (Kusursuz Zaman Hesabı)
function getUpdatedUserBank(userId) {
    const now = Date.now();
    if (!userBanks[userId]) {
        userBanks[userId] = {
            storedTime: MAX_ACCUMULATION_MS,
            lastUpdate: now
        };
    } else {
        const elapsed = now - userBanks[userId].lastUpdate;
        userBanks[userId].storedTime = Math.min(MAX_ACCUMULATION_MS, userBanks[userId].storedTime + elapsed);
        userBanks[userId].lastUpdate = now;
    }
    return userBanks[userId];
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Pixel Tuvali - Kalıcı Enerji & Çizim Modu</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: sans-serif; user-select: none; }
        body, html { width: 100%; height: 100%; overflow: hidden; background-color: #cccccc; }
        #canvas { display: block; cursor: crosshair; touch-action: none; }

        .top-left-menu { position: absolute; top: 15px; left: 15px; z-index: 10; display: flex; flex-direction: column; gap: 8px; }
        .icon-btn { width: 40px; height: 40px; background: #fff; border: 1px solid #555; font-size: 20px; cursor: pointer; border-radius: 4px; display: flex; align-items: center; justify-content: center; box-shadow: 0 2px 5px rgba(0,0,0,0.15); transition: all 0.2s; }
        .icon-btn:active { background: #e0e0e0; }
        .icon-btn.active { background: #2ecc71; color: white; border-color: #27ae60; box-shadow: 0 0 8px rgba(46,204,113,0.6); }

        .bottom-left-panel { position: absolute; bottom: 20px; left: 15px; display: flex; flex-direction: column; gap: 5px; z-index: 10; }
        .box { background: #e0e0e0; border: 1px solid #555; padding: 6px 12px; font-size: 13px; min-width: 60px; text-align: center; border-radius: 4px; box-shadow: 0 2px 5px rgba(0,0,0,0.15); font-weight: bold; }
        .cooldown-active { background: #ff4d4d; color: white; }
        .cooldown-ready { background: #2ecc71; color: white; }

        .bottom-right-panel { position: absolute; bottom: 20px; right: 15px; display: flex; gap: 8px; z-index: 10; }

        .right-palette {
            position: absolute; right: 15px; bottom: 70px;
            display: grid; grid-template-columns: repeat(4, 30px); gap: 2px;
            border: 1px solid #333; background: #fff; z-index: 10;
            max-height: 60vh; overflow-y: auto; box-shadow: 2px 2px 8px rgba(0,0,0,0.25);
            border-radius: 4px; padding: 4px;
            transition: opacity 0.3s ease, transform 0.3s ease, visibility 0.3s;
            opacity: 1; transform: translateY(0); visibility: visible;
        }
        .right-palette.hidden { opacity: 0; transform: translateY(15px); visibility: hidden; pointer-events: none; }
        .color-btn { width: 30px; height: 30px; border: 1px solid rgba(0,0,0,0.15); cursor: pointer; box-sizing: border-box; border-radius: 3px; }
        .color-btn.selected { border: 3px solid #000; transform: scale(1.1); z-index: 1; }

        .chat-container {
            position: absolute; bottom: 70px; right: 15px; width: 290px; height: 320px;
            background: rgba(255, 255, 255, 0.95); border: 1px solid #555;
            display: flex; flex-direction: column; z-index: 10; border-radius: 6px;
            box-shadow: 0 4px 12px rgba(0,0,0,0.25);
            transition: opacity 0.3s ease, transform 0.3s ease, visibility 0.3s;
            opacity: 1; transform: translateY(0); visibility: visible; overflow: hidden;
        }
        .chat-container.hidden { opacity: 0; transform: translateY(15px); visibility: hidden; pointer-events: none; }
        .chat-header { background: #333; color: #fff; padding: 8px 12px; font-size: 13px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; }
        .chat-messages { flex: 1; padding: 8px; overflow-y: auto; font-size: 12px; display: flex; flex-direction: column; gap: 6px; }
        .chat-msg { word-break: break-word; line-height: 1.3; }
        .chat-msg .sender { font-weight: bold; color: #0066cc; }
        .chat-msg .flag { margin-right: 4px; }
        .chat-input-area { display: flex; border-top: 1px solid #ccc; background: #fff; }
        .chat-input-area input { flex: 1; border: none; padding: 8px 10px; font-size: 12px; outline: none; }
        .chat-input-area button { background: #0066cc; color: white; border: none; padding: 0 12px; cursor: pointer; font-weight: bold; }

        .modal { position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); z-index: 100; display: flex; align-items: center; justify-content: center; }
        .modal.hidden { display: none; }
        .modal-content { background: #fff; padding: 20px; border-radius: 8px; width: 340px; max-height: 90vh; overflow-y: auto; box-shadow: 0 4px 15px rgba(0,0,0,0.3); position: relative; }
        .modal-header { font-size: 16px; font-weight: bold; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center; }
        .modal-close { cursor: pointer; font-size: 18px; font-weight: bold; }
        .modal-body { font-size: 13px; color: #333; display: flex; flex-direction: column; gap: 10px; }
        .form-group { display: flex; flex-direction: column; gap: 4px; }
        .form-group label { font-weight: bold; font-size: 11px; color: #555; }
        .form-group input, .form-group select { padding: 6px 8px; border: 1px solid #ccc; border-radius: 4px; font-size: 12px; outline: none; }
        .btn-submit { background: #0066cc; color: #fff; border: none; padding: 8px; border-radius: 4px; cursor: pointer; font-weight: bold; margin-top: 5px; }
        .stats-section { border-top: 1px solid #eee; pt: 10px; margin-top: 10px; }
        .stats-title { font-weight: bold; font-size: 13px; margin-bottom: 6px; color: #111; }
        .leaderboard-list { list-style: none; font-size: 12px; display: flex; flex-direction: column; gap: 4px; }
        .leaderboard-item { display: flex; justify-content: space-between; padding: 4px 6px; background: #f8f9fa; border-radius: 4px; }
    </style>
</head>
<body>

    <div class="top-left-menu">
        <button class="icon-btn" id="settings-btn" title="Ayarlar">⚙️</button>
        <button class="icon-btn" id="profile-btn" title="Profil & İstatistikler">👤</button>
        <button class="icon-btn" id="pencil-btn" title="Kalem / Sürükleyerek Çizim Modu">✏️</button>
    </div>

    <div class="modal hidden" id="settings-modal">
        <div class="modal-content">
            <div class="modal-header">
                <span>Ayarlar</span>
                <span class="modal-close" id="settings-close">✕</span>
            </div>
            <div class="modal-body">
                <label style="cursor:pointer;"><input type="checkbox" id="grid-toggle" checked /> Izgara Çizgilerini Göster</label>
                <div><strong>Tuval Boyutu:</strong> 400 x 250 (100.000 Piksel)</div>
                <div><strong>Bekleme Süresi:</strong> 5 Saniye</div>
                <div><strong>Maks. Biriktirme:</strong> 60 Saniye (12 Hak)</div>
                <div><strong>Sunucu Durumu:</strong> Aktif</div>
            </div>
        </div>
    </div>

    <div class="modal hidden" id="profile-modal">
        <div class="modal-content">
            <div class="modal-header">
                <span>Oyuncu Profili & İstatistikler</span>
                <span class="modal-close" id="profile-close">✕</span>
            </div>
            <form id="profile-form" class="modal-body">
                <div class="form-group">
                    <label>Kullanıcı Adı</label>
                    <input type="text" id="prof-username" placeholder="Örn: PixelMaster" maxlength="15" required />
                </div>
                <div class="form-group">
                    <label>E-Posta</label>
                    <input type="email" id="prof-email" placeholder="ornek@mail.com" />
                </div>
                <div class="form-group">
                    <label>Milliyet</label>
                    <select id="prof-nat">
                        <option value="🇹🇷 Türkiye">🇹🇷 Türkiye</option>
                        <option value="🇦🇿 Azerbaycan">🇦🇿 Azerbaycan</option>
                        <option value="🇩🇪 Almanya">🇩🇪 Almanya</option>
                        <option value="🇬🇧 İngiltere">🇬🇧 İngiltere</option>
                        <option value="🇺🇸 ABD">🇺🇸 ABD</option>
                        <option value="🌍 Diğer">🌍 Diğer</option>
                    </select>
                </div>
                <button type="submit" class="btn-submit">Profili Kaydet</button>

                <div class="stats-section">
                    <div class="stats-title">📊 Kişisel İstatistikler</div>
                    <div>Bu Kullanıcı Adıyla Koyulan Piksel: <strong id="user-stats-count">0</strong></div>
                </div>

                <div class="stats-section">
                    <div class="stats-title">🏆 En Çok Piksel Koyanlar</div>
                    <ul class="leaderboard-list" id="leaderboard">
                        <li class="leaderboard-item"><span>Yükleniyor...</span></li>
                    </ul>
                </div>
            </form>
        </div>
    </div>

    <div class="chat-container hidden" id="chat-box">
        <div class="chat-header">
            <span>Canlı Sohbet</span>
            <span style="cursor:pointer;" id="chat-close-btn">✕</span>
        </div>
        <div class="chat-messages" id="chat-messages"></div>
        <form class="chat-input-area" id="chat-form">
            <input type="text" id="chat-input" placeholder="Mesaj yazın..." maxlength="100" autocomplete="off" />
            <button type="submit">Gönder</button>
        </form>
    </div>

    <div class="bottom-left-panel">
        <div class="box cooldown-ready" id="cooldown-box">⏱️ 60s (12 Hak)</div>
        <div class="box" id="user-count">1 👤</div>
        <div class="box coords" id="coords">(0, 0)</div>
    </div>

    <div class="right-palette hidden" id="palette"></div>

    <div class="bottom-right-panel">
        <button class="icon-btn" id="chat-toggle-btn" title="Sohbet">💬</button>
        <button class="icon-btn" id="palette-toggle-btn" title="Renk Paleti">🎨</button>
    </div>

    <canvas id="canvas"></canvas>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        // Kalıcı Cihaz Kimliği (UserId) - Sayfa yenilense de sürenin silinmemesini sağlar
        let userId = localStorage.getItem('rplace_user_id');
        if (!userId) {
            userId = 'u_' + Math.random().toString(36).substring(2, 11) + Date.now();
            localStorage.setItem('rplace_user_id', userId);
        }

        const socket = io();
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const coordsEl = document.getElementById('coords');
        const userCountEl = document.getElementById('user-count');
        const paletteEl = document.getElementById('palette');
        const paletteToggleBtn = document.getElementById('palette-toggle-btn');
        const chatBox = document.getElementById('chat-box');
        const chatToggleBtn = document.getElementById('chat-toggle-btn');
        const chatCloseBtn = document.getElementById('chat-close-btn');
        const chatForm = document.getElementById('chat-form');
        const chatInput = document.getElementById('chat-input');
        const chatMessages = document.getElementById('chat-messages');

        const pencilBtn = document.getElementById('pencil-btn');
        const settingsBtn = document.getElementById('settings-btn');
        const settingsModal = document.getElementById('settings-modal');
        const settingsClose = document.getElementById('settings-close');
        const gridToggle = document.getElementById('grid-toggle');

        const profileBtn = document.getElementById('profile-btn');
        const profileModal = document.getElementById('profile-modal');
        const profileClose = document.getElementById('profile-close');
        const profileForm = document.getElementById('profile-form');
        const profUsername = document.getElementById('prof-username');
        const profEmail = document.getElementById('prof-email');
        const profNat = document.getElementById('prof-nat');
        const userStatsCount = document.getElementById('user-stats-count');
        const leaderboardEl = document.getElementById('leaderboard');

        const cooldownBox = document.getElementById('cooldown-box');

        const CANVAS_WIDTH = 400;
        const CANVAS_HEIGHT = 250;
        const PIXEL_SIZE = 4;
        const COOLDOWN_MS = 5000;
        const MAX_ACCUMULATION_MS = 60000;

        let selectedColor = '#000000';
        let isPencilMode = false;
        let lastPlacedGridCoords = { x: -1, y: -1 };

        // Biriktirme Süresi Takibi
        let clientStoredTime = MAX_ACCUMULATION_MS;
        let clientLastUpdate = Date.now();

        const loadedPixels = {};
        let scale = 1;
        let offsetX = (window.innerWidth - CANVAS_WIDTH * PIXEL_SIZE) / 2;
        let offsetY = (window.innerHeight - CANVAS_HEIGHT * PIXEL_SIZE) / 2;

        let isDragging = false;
        let hasDragged = false;
        let startX = 0, startY = 0;
        let startOffsetX = 0, startOffsetY = 0;
        let currentPointerX = window.innerWidth / 2;
        let currentPointerY = window.innerHeight / 2;

        const colors = [
            '#ffffff', '#d4d7d9', '#898d90', '#515252', '#000000',
            '#3690ea', '#0044aa', '#00a368', '#00cc78', '#7eed56',
            '#ff4500', '#ffa800', '#ffd635', '#fff8b8', '#6d001a',
            '#be0039', '#ff3881', '#ff99aa', '#de107f', '#b44ac0',
            '#811e9f', '#493ac1', '#6a5cff', '#94b3ff', '#009eaa',
            '#00ccc0', '#51e9f4', '#6d482f', '#9c6926', '#ffb470',
            '#ab5236', '#3f3f74'
        ];

        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            redraw();
        }
        window.addEventListener('resize', resizeCanvas);

        colors.forEach(function(color) {
            const btn = document.createElement('div');
            btn.className = 'color-btn' + (color === '#000000' ? ' selected' : '');
            btn.style.backgroundColor = color;
            btn.onclick = function() {
                document.querySelectorAll('.color-btn').forEach(function(b) { b.classList.remove('selected'); });
                btn.classList.add('selected');
                selectedColor = color;
            };
            paletteEl.appendChild(btn);
        });

        paletteToggleBtn.onclick = function() { paletteEl.classList.toggle('hidden'); };
        chatToggleBtn.onclick = function() { chatBox.classList.toggle('hidden'); };
        chatCloseBtn.onclick = function() { chatBox.classList.add('hidden'); };

        pencilBtn.onclick = function() {
            isPencilMode = !isPencilMode;
            pencilBtn.classList.toggle('active', isPencilMode);
        };

        settingsBtn.onclick = function() { settingsModal.classList.remove('hidden'); };
        settingsClose.onclick = function() { settingsModal.classList.add('hidden'); };
        gridToggle.onchange = function() { redraw(); };

        profileBtn.onclick = function() {
            profileModal.classList.remove('hidden');
            socket.emit('getStats');
        };
        profileClose.onclick = function() { profileModal.classList.add('hidden'); };

        profileForm.onsubmit = function(e) {
            e.preventDefault();
            const profileData = {
                username: profUsername.value.trim(),
                email: profEmail.value.trim(),
                nationality: profNat.value
            };
            socket.emit('updateProfile', profileData);
            profileModal.classList.add('hidden');
        };

        // Bağlantı Kurulunca Oturum Başlat
        socket.on('connect', function() {
            const savedUsername = localStorage.getItem('rplace_username') || ('Oyuncu#' + socket.id.substring(0, 4));
            profUsername.value = savedUsername;
            socket.emit('initSession', { userId: userId, username: savedUsername });
        });

        // 60 Saniyelik Havuz ve Cooldown Sayacı
        setInterval(function() {
            const now = Date.now();
            const elapsed = now - clientLastUpdate;
            clientLastUpdate = now;
            
            clientStoredTime = Math.min(MAX_ACCUMULATION_MS, clientStoredTime + elapsed);
            const availablePixels = Math.floor(clientStoredTime / COOLDOWN_MS);
            
            if (clientStoredTime >= COOLDOWN_MS) {
                const totalSec = Math.floor(clientStoredTime / 1000);
                cooldownBox.innerText = '⏱️ ' + totalSec + 's (' + availablePixels + ' Hak)';
                cooldownBox.className = 'box cooldown-ready';
            } else {
                const neededSec = ((COOLDOWN_MS - clientStoredTime) / 1000).toFixed(1);
                cooldownBox.innerText = '⏱️ ' + neededSec + 's';
                cooldownBox.className = 'box cooldown-active';
            }
        }, 100);

        // Sohbet Gönderme
        chatForm.onsubmit = function(e) {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (text) {
                socket.emit('sendChatMessage', text);
                chatInput.value = '';
            }
        };

        function addChatMessage(data) {
            const msgEl = document.createElement('div');
            msgEl.className = 'chat-msg';
            const flag = data.nationality ? data.nationality.split(' ')[0] : '🌐';
            msgEl.innerHTML = '<span class="flag">' + flag + '</span><span class="sender">' + escapeHtml(data.sender) + ':</span> ' + escapeHtml(data.text);
            chatMessages.appendChild(msgEl);
            chatMessages.scrollTop = chatMessages.scrollHeight;
        }

        socket.on('chatHistory', function(history) {
            chatMessages.innerHTML = '';
            history.forEach(addChatMessage);
        });

        socket.on('newChatMessage', function(data) {
            addChatMessage(data);
        });

        function escapeHtml(string) {
            return String(string).replace(/[&<>"']/g, function(s) {
                return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s];
            });
        }

        function updateCoords(clientX, clientY) {
            currentPointerX = clientX;
            currentPointerY = clientY;
            const coords = getPixelCoords(clientX, clientY);
            if (coords.x >= 0 && coords.x < CANVAS_WIDTH && coords.y >= 0 && coords.y < CANVAS_HEIGHT) {
                coordsEl.innerText = '(' + coords.x + ', ' + coords.y + ')';
            } else {
                coordsEl.innerText = '(-, -)';
            }
        }

        function redraw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            
            ctx.translate(offsetX, offsetY);
            ctx.scale(scale, scale);

            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, CANVAS_WIDTH * PIXEL_SIZE, CANVAS_HEIGHT * PIXEL_SIZE);

            Object.keys(loadedPixels).forEach(function(key) {
                const parts = key.split(',');
                const x = Number(parts[0]);
                const y = Number(parts[1]);
                ctx.fillStyle = loadedPixels[key];
                ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
            });

            if (gridToggle.checked && scale >= 1.5) {
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
                ctx.lineWidth = 0.5 / scale;
                ctx.beginPath();

                for (let x = 0; x <= CANVAS_WIDTH; x++) {
                    ctx.moveTo(x * PIXEL_SIZE, 0);
                    ctx.lineTo(x * PIXEL_SIZE, CANVAS_HEIGHT * PIXEL_SIZE);
                }
                for (let y = 0; y <= CANVAS_HEIGHT; y++) {
                    ctx.moveTo(0, y * PIXEL_SIZE);
                    ctx.lineTo(CANVAS_WIDTH * PIXEL_SIZE, y * PIXEL_SIZE);
                }
                ctx.stroke();
            }

            ctx.restore();
            updateCoords(currentPointerX, currentPointerY);
        }

        function getPixelCoords(clientX, clientY) {
            const canvasX = (clientX - offsetX) / scale;
            const canvasY = (clientY - offsetY) / scale;
            return { x: Math.floor(canvasX / PIXEL_SIZE), y: Math.floor(canvasY / PIXEL_SIZE) };
        }

        function tryPlacePixel(clientX, clientY) {
            if (clientStoredTime < COOLDOWN_MS) return;

            const coords = getPixelCoords(clientX, clientY);
            if (coords.x >= 0 && coords.x < CANVAS_WIDTH && coords.y >= 0 && coords.y < CANVAS_HEIGHT) {
                if (coords.x === lastPlacedGridCoords.x && coords.y === lastPlacedGridCoords.y) return;
                
                lastPlacedGridCoords = { x: coords.x, y: coords.y };
                socket.emit('placePixel', { userId: userId, x: coords.x, y: coords.y, color: selectedColor });
            }
        }

        // Fare ve Dokunmatik Etkileşimleri (Kalem ve Sürükleme Modu Entegrasyonu)
        canvas.addEventListener('wheel', function(e) {
            e.preventDefault();
            const zoomFactor = e.deltaY < 0 ? 1.15 : 0.87;
            if (scale * zoomFactor < 0.2 || scale * zoomFactor > 30) return;

            const mouseX = e.clientX;
            const mouseY = e.clientY;

            offsetX = mouseX - (mouseX - offsetX) * zoomFactor;
            offsetY = mouseY - (mouseY - mouseY) * zoomFactor;
            scale *= zoomFactor;

            redraw();
        }, { passive: false });

        canvas.addEventListener('mousedown', function(e) {
            isDragging = true;
            hasDragged = false;
            startX = e.clientX;
            startY = e.clientY;
            startOffsetX = offsetX;
            startOffsetY = offsetY;
            lastPlacedGridCoords = { x: -1, y: -1 };

            if (isPencilMode) {
                tryPlacePixel(e.clientX, e.clientY);
            }
        });

        canvas.addEventListener('mousemove', function(e) {
            if (isDragging) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (Math.hypot(dx, dy) > 5) hasDragged = true;

                if (isPencilMode) {
                    tryPlacePixel(e.clientX, e.clientY);
                } else {
                    offsetX = startOffsetX + dx;
                    offsetY = startOffsetY + dy;
                    redraw();
                }
            } else {
                updateCoords(e.clientX, e.clientY);
            }
        });

        canvas.addEventListener('mouseup', function(e) {
            if (!hasDragged && isDragging && !isPencilMode) {
                tryPlacePixel(e.clientX, e.clientY);
            }
            isDragging = false;
        });

        canvas.addEventListener('mouseleave', function() { isDragging = false; });

        let lastTouchDist = 0;

        canvas.addEventListener('touchstart', function(e) {
            if (e.touches.length === 1) {
                isDragging = true;
                hasDragged = false;
                startX = e.touches[0].clientX;
                startY = e.touches[0].clientY;
                startOffsetX = offsetX;
                startOffsetY = offsetY;
                lastPlacedGridCoords = { x: -1, y: -1 };
                updateCoords(startX, startY);

                if (isPencilMode) {
                    tryPlacePixel(startX, startY);
                }
            } else if (e.touches.length === 2) {
                isDragging = false;
                lastTouchDist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
            }
        });

        canvas.addEventListener('touchmove', function(e) {
            if (e.touches.length === 1 && isDragging) {
                const touchX = e.touches[0].clientX;
                const touchY = e.touches[0].clientY;
                const dx = touchX - startX;
                const dy = touchY - startY;
                if (Math.hypot(dx, dy) > 5) hasDragged = true;

                if (isPencilMode) {
                    tryPlacePixel(touchX, touchY);
                } else {
                    offsetX = startOffsetX + dx;
                    offsetY = startOffsetY + dy;
                    redraw();
                }
                updateCoords(touchX, touchY);
            } else if (e.touches.length === 2) {
                const dist = Math.hypot(
                    e.touches[0].clientX - e.touches[1].clientX,
                    e.touches[0].clientY - e.touches[1].clientY
                );
                const zoomFactor = dist / (lastTouchDist || dist);
                if (scale * zoomFactor >= 0.2 && scale * zoomFactor <= 30) {
                    const midX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
                    const midY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
                    offsetX = midX - (midX - offsetX) * zoomFactor;
                    offsetY = midY - (midY - offsetY) * zoomFactor;
                    scale *= zoomFactor;
                    redraw();
                }
                lastTouchDist = dist;
            }
        });

        canvas.addEventListener('touchend', function(e) {
            if (e.touches.length === 0 && !hasDragged && isDragging && !isPencilMode) {
                const touch = e.changedTouches[0];
                tryPlacePixel(touch.clientX, touch.clientY);
            }
            if (e.touches.length === 0) isDragging = false;
        });

        // Socket Olayları
        socket.on('initCanvas', function(pixels) {
            Object.assign(loadedPixels, pixels);
            redraw();
        });

        socket.on('pixelUpdate', function(data) {
            loadedPixels[data.x + ',' + data.y] = data.color;
            redraw();
        });

        socket.on('bankUpdate', function(data) {
            clientStoredTime = data.storedTime;
            clientLastUpdate = data.lastUpdate || Date.now();
        });

        socket.on('userCount', function(count) {
            userCountEl.innerText = count + ' 👤';
        });

        socket.on('statsData', function(data) {
            userStatsCount.innerText = data.userCount || 0;
            leaderboardEl.innerHTML = '';
            if (data.leaderboard && data.leaderboard.length > 0) {
                data.leaderboard.forEach(function(item, index) {
                    const li = document.createElement('li');
                    li.className = 'leaderboard-item';
                    li.innerHTML = '<span>' + (index + 1) + '. ' + escapeHtml(item.username) + '</span><strong>' + item.placedCount + ' px</strong>';
                    leaderboardEl.appendChild(li);
                });
            } else {
                leaderboardEl.innerHTML = '<li class="leaderboard-item">Henüz veri yok</li>';
            }
        });

        resizeCanvas();
    </script>
</body>
</html>
    `);
});

// Socket.io Sunucu Mantığı
io.on('connection', (socket) => {
    onlineCount++;
    io.emit('userCount', onlineCount);

    socket.profile = {
        username: 'Oyuncu#' + socket.id.substring(0, 4),
        nationality: '🇹🇷 Türkiye'
    };

    socket.emit('initCanvas', pixels);
    socket.emit('chatHistory', chatHistory);

    // Oturum Başlatma ve Süre/Kullanıcı Eşleştirme
    socket.on('initSession', ({ userId, username }) => {
        if (!userId) return;
        socket.userId = userId;

        if (username) {
            socket.profile.username = String(username).trim().substring(0, 15);
        }

        const bank = getUpdatedUserBank(userId);
        socket.emit('bankUpdate', { storedTime: bank.storedTime, lastUpdate: bank.lastUpdate });
    });

    socket.on('updateProfile', (data) => {
        if (data && data.username) {
            const oldName = socket.profile.username;
            const newName = String(data.username).trim().substring(0, 15);
            socket.profile.username = newName;
            socket.profile.nationality = String(data.nationality || '🇹🇷 Türkiye');

            // Eğer eski isimde istatistik varsa yeni isme aktar
            if (oldName !== newName && userStats[oldName]) {
                userStats[newName] = userStats[newName] || { placedCount: 0 };
                userStats[newName].placedCount += userStats[oldName].placedCount;
                delete userStats[oldName];
                saveDataToDisk();
            }
        }
    });

    // Piksel Koyma ve Kusursuz Süre Mantığı
    socket.on('placePixel', ({ userId, x, y, color }) => {
        const uId = userId || socket.userId;
        if (!uId) return;

        const bank = getUpdatedUserBank(uId);

        if (bank.storedTime >= COOLDOWN_MS) {
            if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT) {
                bank.storedTime -= COOLDOWN_MS; // 5 saniye harca
                const key = x + ',' + y;
                pixels[key] = color;

                // İstatistik Güncelleme (İsme Göre)
                const uname = socket.profile.username;
                userStats[uname] = userStats[uname] || { placedCount: 0 };
                userStats[uname].placedCount++;

                saveDataToDisk();

                io.emit('pixelUpdate', { x, y, color });
                socket.emit('bankUpdate', { storedTime: bank.storedTime, lastUpdate: bank.lastUpdate });
            }
        } else {
            socket.emit('bankUpdate', { storedTime: bank.storedTime, lastUpdate: bank.lastUpdate });
        }
    });

    // Sohbet Mesajı (Diske Kayıtlı)
    socket.on('sendChatMessage', (text) => {
        if (typeof text === 'string' && text.trim().length > 0) {
            const cleanText = text.trim().substring(0, 100);
            const msgObj = {
                sender: socket.profile.username,
                nationality: socket.profile.nationality,
                text: cleanText,
                time: Date.now()
            };
            chatHistory.push(msgObj);
            if (chatHistory.length > 100) chatHistory.shift(); // Son 100 mesajı tut

            saveDataToDisk();
            io.emit('newChatMessage', msgObj);
        }
    });

    // İstatistik İsteği
    socket.on('getStats', () => {
        const uname = socket.profile.username;
        const myCount = userStats[uname] ? userStats[uname].placedCount : 0;

        const leaderboard = Object.keys(userStats)
            .map(name => ({ username: name, placedCount: userStats[name].placedCount }))
            .sort((a, b) => b.placedCount - a.placedCount)
            .slice(0, 10);

        socket.emit('statsData', {
            userCount: myCount,
            leaderboard: leaderboard
        });
    });

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        io.emit('userCount', onlineCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('Sunucu başarıyla başlatıldı: http://localhost:' + PORT);
});

