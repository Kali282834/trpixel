const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e6 });

// Tuval Yapılandırması (400 x 250 = 100.000 Piksel)
const CANVAS_WIDTH = 400;
const CANVAS_HEIGHT = 250;
const PIXEL_SIZE = 4;
const COOLDOWN_MS = 5000; // Her 1 piksel hakkı = 5 Saniye
const MAX_ACCUMULATION_MS = 60000; // Maksimum 60 Saniye (12 Hak)

// Bellek İçi Veri Depoları
const pixels = {}; // { "x,y": { color, placedBy, flag, timestamp } }
const userStates = {}; // { userId: { storedTimeMs, lastUpdate, placedCount, profile } }
let onlineCount = 0;

// Disk Kalıcılığı
const PIXELS_FILE = path.join(__dirname, 'pixels.json');
const USERS_FILE = path.join(__dirname, 'users.json');

// Piksel Verilerini Yükle
if (fs.existsSync(PIXELS_FILE)) {
    try {
        const data = fs.readFileSync(PIXELS_FILE, 'utf8');
        Object.assign(pixels, JSON.parse(data));
        console.log('[Sistem] Kayıtlı piksel verisi yüklendi. Toplam:', Object.keys(pixels).length);
    } catch (err) {
        console.error('[Hata] Piksel verisi okunamadı:', err);
    }
}

// Kullanıcı Verilerini Yükle
if (fs.existsSync(USERS_FILE)) {
    try {
        const data = fs.readFileSync(USERS_FILE, 'utf8');
        Object.assign(userStates, JSON.parse(data));
        console.log('[Sistem] Kayıtlı kullanıcı verisi yüklendi.');
    } catch (err) {
        console.error('[Hata] Kullanıcı verisi okunamadı:', err);
    }
}

let saveTimeout = null;
function saveDataToDisk() {
    clearTimeout(saveTimeout);
    saveTimeout = setTimeout(() => {
        fs.writeFile(PIXELS_FILE, JSON.stringify(pixels), (err) => {
            if (err) console.error('[Hata] Pikseller kaydedilemedi:', err);
        });
        fs.writeFile(USERS_FILE, JSON.stringify(userStates), (err) => {
            if (err) console.error('[Hata] Kullanıcılar kaydedilemedi:', err);
        });
    }, 1000);
}

function syncSaveOnExit() {
    try {
        fs.writeFileSync(PIXELS_FILE, JSON.stringify(pixels));
        fs.writeFileSync(USERS_FILE, JSON.stringify(userStates));
        console.log('[Sistem] Tüm veriler diske başarıyla kaydedildi.');
    } catch (err) {
        console.error('[Hata] Kapanış kaydı hatası:', err);
    }
}
process.on('SIGINT', () => { syncSaveOnExit(); process.exit(); });
process.on('SIGTERM', () => { syncSaveOnExit(); process.exit(); });

// Yardımcı Fonksiyon: Enerji Hesaplama
function calculateUserEnergy(userId) {
    const now = Date.now();
    if (!userStates[userId]) {
        userStates[userId] = {
            storedTimeMs: MAX_ACCUMULATION_MS,
            lastUpdate: now,
            placedCount: 0,
            profile: { username: 'Oyuncu#' + Math.floor(1000 + Math.random() * 9000), nationality: '🇹🇷 Türkiye' }
        };
    }
    const user = userStates[userId];
    const elapsed = now - user.lastUpdate;
    user.storedTimeMs = Math.min(MAX_ACCUMULATION_MS, user.storedTimeMs + elapsed);
    user.lastUpdate = now;
    return user;
}

app.get('/', (req, res) => {
    res.send(`
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
    <title>Pixel Tuvali Pro</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; user-select: none; }
        body, html { width: 100%; height: 100%; overflow: hidden; background-color: #1e1e24; color: #fff; }
        #canvas { display: block; cursor: crosshair; touch-action: none; }

        .top-left-menu { position: absolute; top: 15px; left: 15px; z-index: 10; display: flex; flex-direction: column; gap: 8px; }
        .icon-btn { width: 42px; height: 42px; background: rgba(30, 30, 30, 0.85); border: 1px solid rgba(255,255,255,0.2); font-size: 18px; cursor: pointer; border-radius: 8px; display: flex; align-items: center; justify-content: center; box-shadow: 0 4px 10px rgba(0,0,0,0.3); backdrop-filter: blur(5px); color: #fff; transition: all 0.2s ease; }
        .icon-btn:hover { background: rgba(50, 50, 50, 0.95); transform: translateY(-2px); }
        .icon-btn.active { border-color: #3b82f6; background: #2563eb; }

        .bottom-left-panel { position: absolute; bottom: 20px; left: 15px; display: flex; flex-direction: column; gap: 8px; z-index: 10; }
        .box { background: rgba(20, 20, 20, 0.85); border: 1px solid rgba(255,255,255,0.15); padding: 8px 14px; font-size: 13px; min-width: 130px; text-align: center; border-radius: 8px; box-shadow: 0 4px 10px rgba(0,0,0,0.3); backdrop-filter: blur(5px); font-weight: 600; }
        
        .energy-container { display: flex; flex-direction: column; gap: 4px; }
        .energy-bar-bg { width: 100%; height: 6px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; }
        .energy-bar-fill { height: 100%; width: 0%; background: #22c55e; transition: width 0.1s linear; }

        .bottom-right-panel { position: absolute; bottom: 20px; right: 15px; display: flex; gap: 8px; z-index: 10; }

        .zoom-controls { position: absolute; right: 15px; top: 15px; display: flex; flex-direction: column; gap: 8px; z-index: 10; }

        .right-palette {
            position: absolute; right: 15px; bottom: 75px;
            display: grid; grid-template-columns: repeat(4, 32px); gap: 4px;
            border: 1px solid rgba(255,255,255,0.2); background: rgba(20, 20, 20, 0.9); z-index: 10;
            max-height: 55vh; overflow-y: auto; box-shadow: 0 8px 25px rgba(0,0,0,0.5);
            border-radius: 10px; padding: 6px; backdrop-filter: blur(8px);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }
        .right-palette.hidden { opacity: 0; transform: translateY(15px) scale(0.9); visibility: hidden; pointer-events: none; }
        .color-btn { width: 32px; height: 32px; border: 1px solid rgba(255,255,255,0.2); cursor: pointer; border-radius: 6px; transition: transform 0.1s ease; }
        .color-btn:hover { transform: scale(1.1); }
        .color-btn.selected { border: 2px solid #ffffff; transform: scale(1.15); box-shadow: 0 0 8px rgba(255,255,255,0.8); }
        
        .custom-color-wrapper { grid-column: span 4; display: flex; gap: 4px; margin-top: 4px; }
        .custom-color-input { width: 100%; height: 32px; border: none; border-radius: 6px; cursor: pointer; background: transparent; }

        .chat-container {
            position: absolute; bottom: 75px; right: 15px; width: 300px; height: 360px;
            background: rgba(20, 20, 20, 0.9); border: 1px solid rgba(255,255,255,0.2);
            display: flex; flex-direction: column; z-index: 10; border-radius: 10px;
            box-shadow: 0 8px 25px rgba(0,0,0,0.5); backdrop-filter: blur(8px);
            transition: all 0.3s ease;
        }
        .chat-container.hidden { opacity: 0; transform: translateY(15px); visibility: hidden; pointer-events: none; }
        .chat-header { background: rgba(255,255,255,0.05); color: #fff; padding: 10px 14px; font-size: 13px; font-weight: bold; display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid rgba(255,255,255,0.1); }
        .chat-messages { flex: 1; padding: 10px; overflow-y: auto; font-size: 12px; display: flex; flex-direction: column; gap: 8px; }
        .chat-msg { word-break: break-word; line-height: 1.4; background: rgba(255,255,255,0.03); padding: 6px 8px; border-radius: 6px; }
        .chat-msg .sender { font-weight: bold; color: #60a5fa; }
        .chat-input-area { display: flex; border-top: 1px solid rgba(255,255,255,0.1); background: transparent; }
        .chat-input-area input { flex: 1; border: none; padding: 10px; font-size: 12px; outline: none; background: transparent; color: #fff; }
        .chat-input-area button { background: #2563eb; color: white; border: none; padding: 0 14px; cursor: pointer; font-weight: bold; border-radius: 0 0 10px 0; }

        .modal {
            position: fixed; top: 0; left: 0; width: 100%; height: 100%;
            background: rgba(0,0,0,0.6); z-index: 100; display: flex;
            align-items: center; justify-content: center; backdrop-filter: blur(4px);
        }
        .modal.hidden { display: none; }
        .modal-content {
            background: #18181b; border: 1px solid rgba(255,255,255,0.15); padding: 22px; border-radius: 12px; width: 340px;
            box-shadow: 0 10px 30px rgba(0,0,0,0.5); position: relative; color: #f4f4f5;
        }
        .modal-header { font-size: 16px; font-weight: bold; margin-bottom: 14px; display: flex; justify-content: space-between; align-items: center; }
        .modal-close { cursor: pointer; font-size: 18px; color: #a1a1aa; transition: color 0.2s; }
        .modal-close:hover { color: #fff; }
        .modal-body { font-size: 13px; display: flex; flex-direction: column; gap: 12px; }
        .form-group { display: flex; flex-direction: column; gap: 6px; }
        .form-group label { font-weight: 600; font-size: 11px; color: #a1a1aa; }
        .form-group input, .form-group select { padding: 8px 10px; border: 1px solid rgba(255,255,255,0.15); background: #27272a; color: #fff; border-radius: 6px; font-size: 12px; outline: none; }
        .btn-action { background: #2563eb; color: #fff; border: none; padding: 10px; border-radius: 6px; cursor: pointer; font-weight: bold; margin-top: 5px; transition: background 0.2s; text-align: center; }
        .btn-action:hover { background: #1d4ed8; }

        /* Mini Map Widget */
        .minimap-container {
            position: absolute; top: 15px; right: 70px; width: 120px; height: 75px;
            background: rgba(0,0,0,0.8); border: 1px solid rgba(255,255,255,0.2);
            border-radius: 6px; overflow: hidden; z-index: 10; box-shadow: 0 4px 10px rgba(0,0,0,0.3);
        }
        #minimapCanvas { width: 100%; height: 100%; display: block; }
        .minimap-viewport { position: absolute; border: 1px solid #ff4d4d; background: rgba(255, 77, 77, 0.2); pointer-events: none; }

        /* Inspector Popup */
        .inspector-card {
            position: absolute; top: 70px; left: 15px; background: rgba(20, 20, 20, 0.95);
            border: 1px solid #3b82f6; border-radius: 8px; padding: 10px 14px; font-size: 12px;
            z-index: 10; display: flex; flex-direction: column; gap: 4px; backdrop-filter: blur(5px); box-shadow: 0 4px 15px rgba(0,0,0,0.4);
        }
        .inspector-card.hidden { display: none; }

        .leaderboard-list { display: flex; flex-direction: column; gap: 6px; max-height: 200px; overflow-y: auto; }
        .leaderboard-item { display: flex; justify-content: space-between; padding: 6px; background: rgba(255,255,255,0.05); border-radius: 4px; font-size: 12px; }
    </style>
</head>
<body>

    <div class="top-left-menu">
        <button class="icon-btn" id="settings-btn" title="Ayarlar">⚙️</button>
        <button class="icon-btn" id="profile-btn" title="Profil">👤</button>
        <button class="icon-btn" id="leaderboard-btn" title="Liderlik Tablosu">🏆</button>
        <button class="icon-btn" id="inspect-btn" title="Piksel İnceleme Modu">🔍</button>
        <button class="icon-btn" id="eyedropper-btn" title="Renk Damlalığı">🧪</button>
    </div>

    <div class="zoom-controls">
        <button class="icon-btn" id="zoom-in-btn" title="Yakınlaştır">➕</button>
        <button class="icon-btn" id="zoom-out-btn" title="Uzaklaştır">➖</button>
        <button class="icon-btn" id="center-view-btn" title="Merkezle">🎯</button>
    </div>

    <div class="minimap-container">
        <canvas id="minimapCanvas" width="400" height="250"></canvas>
        <div class="minimap-viewport" id="minimapViewport"></div>
    </div>

    <div class="inspector-card hidden" id="inspector-card">
        <div style="font-weight:bold; color:#60a5fa;" id="inspect-coords">Piksel (0,0)</div>
        <div>Yazan: <span id="inspect-user">-</span></div>
        <div>Tarih: <span id="inspect-time">-</span></div>
    </div>

    <!-- Ayarlar Modalı -->
    <div class="modal hidden" id="settings-modal">
        <div class="modal-content">
            <div class="modal-header">
                <span>Ayarlar</span>
                <span class="modal-close" id="settings-close">✕</span>
            </div>
            <div class="modal-body">
                <label style="cursor:pointer; display:flex; align-items:center; gap:8px;">
                    <input type="checkbox" id="grid-toggle" checked /> Izgara Çizgilerini Göster
                </label>
                <label style="cursor:pointer; display:flex; align-items:center; gap:8px;">
                    <input type="checkbox" id="sound-toggle" checked /> Ses Efektleri
                </label>
                <button class="btn-action" id="download-canvas-btn">🖼️ Tuvali Resmi Olarak İndir (PNG)</button>
            </div>
        </div>
    </div>

    <!-- Profil Modalı -->
    <div class="modal hidden" id="profile-modal">
        <div class="modal-content">
            <div class="modal-header">
                <span>Oyuncu Profili</span>
                <span class="modal-close" id="profile-close">✕</span>
            </div>
            <form id="profile-form" class="modal-body">
                <div class="form-group">
                    <label>Kullanıcı Adı</label>
                    <input type="text" id="prof-username" maxlength="15" required />
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
                <div>Toplanan/Koyulan Piksel: <strong id="placed-count">0</strong></div>
                <button type="submit" class="btn-action">Profili Güncelle</button>
            </form>
        </div>
    </div>

    <!-- Liderlik Modalı -->
    <div class="modal hidden" id="leaderboard-modal">
        <div class="modal-content">
            <div class="modal-header">
                <span>🏆 En İyiler Tablosu</span>
                <span class="modal-close" id="leaderboard-close">✕</span>
            </div>
            <div class="modal-body">
                <div class="leaderboard-list" id="leaderboard-list">
                    <!-- Dinamik İçerik -->
                </div>
            </div>
        </div>
    </div>

    <!-- Canlı Sohbet -->
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
        <div class="box energy-container">
            <div id="cooldown-box">⏱️ 60s (12 Hak)</div>
            <div class="energy-bar-bg"><div class="energy-bar-fill" id="energy-fill"></div></div>
        </div>
        <div class="box" id="user-count">1 👤 Online</div>
        <div class="box" id="coords">(0, 0)</div>
    </div>

    <div class="right-palette hidden" id="palette">
        <div class="custom-color-wrapper">
            <input type="color" id="custom-color-picker" class="custom-color-input" value="#000000" title="Özel Renk Seç" />
        </div>
    </div>

    <div class="bottom-right-panel">
        <button class="icon-btn" id="chat-toggle-btn" title="Sohbet">💬</button>
        <button class="icon-btn" id="palette-toggle-btn" title="Renk Paleti">🎨</button>
    </div>

    <canvas id="canvas"></canvas>

    <script src="/socket.io/socket.io.js"></script>
    <script>
        // Web Audio API Sentezleyici Efektler
        const AudioCtx = new (window.AudioContext || window.webkitAudioContext)();
        function playSound(type) {
            if (!document.getElementById('sound-toggle').checked) return;
            try {
                const osc = AudioCtx.createOscillator();
                const gain = AudioCtx.createGain();
                osc.connect(gain);
                gain.connect(AudioCtx.destination);
                
                if (type === 'place') {
                    osc.frequency.setValueAtTime(440, AudioCtx.currentTime);
                    osc.frequency.exponentialRampToValueAtTime(880, AudioCtx.currentTime + 0.08);
                    gain.gain.setValueAtTime(0.15, AudioCtx.currentTime);
                    gain.gain.linearRampToValueAtTime(0.01, AudioCtx.currentTime + 0.08);
                    osc.start(); osc.stop(AudioCtx.currentTime + 0.08);
                } else if (type === 'chat') {
                    osc.frequency.setValueAtTime(600, AudioCtx.currentTime);
                    gain.gain.setValueAtTime(0.05, AudioCtx.currentTime);
                    gain.gain.linearRampToValueAtTime(0.01, AudioCtx.currentTime + 0.05);
                    osc.start(); osc.stop(AudioCtx.currentTime + 0.05);
                }
            } catch(e){}
        }

        // Kimlik Yönetimi (localStorage)
        let userId = localStorage.getItem('pixel_user_id');
        if (!userId) {
            userId = 'u_' + Math.random().toString(36).substr(2, 9) + Date.now();
            localStorage.setItem('pixel_user_id', userId);
        }

        const socket = io();
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const minimapCanvas = document.getElementById('minimapCanvas');
        const minimapCtx = minimapCanvas.getContext('2d');
        const minimapViewport = document.getElementById('minimapViewport');

        const coordsEl = document.getElementById('coords');
        const userCountEl = document.getElementById('user-count');
        const paletteEl = document.getElementById('palette');
        const customColorPicker = document.getElementById('custom-color-picker');

        const chatBox = document.getElementById('chat-box');
        const chatForm = document.getElementById('chat-form');
        const chatInput = document.getElementById('chat-input');
        const chatMessages = document.getElementById('chat-messages');

        const cooldownBox = document.getElementById('cooldown-box');
        const energyFill = document.getElementById('energy-fill');
        const inspectorCard = document.getElementById('inspector-card');

        const CANVAS_WIDTH = 400;
        const CANVAS_HEIGHT = 250;
        const PIXEL_SIZE = 4;
        const COOLDOWN_MS = 5000;
        const MAX_ACCUMULATION_MS = 60000;

        let selectedColor = '#000000';
        let isInspectMode = false;
        let isEyedropperMode = false;

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

        // Tıklama Ripple Animasyonları
        const ripples = [];

        const colors = [
            '#ffffff', '#d4d7d9', '#898d90', '#515252', '#000000',
            '#3690ea', '#0044aa', '#00a368', '#00cc78', '#7eed56',
            '#ff4500', '#ffa800', '#ffd635', '#fff8b8', '#6d001a',
            '#be0039', '#ff3881', '#ff99aa', '#de107f', '#b44ac0',
            '#811e9f', '#493ac1', '#6a5cff', '#94b3ff', '#009eaa',
            '#00ccc0', '#51e9f4', '#6d482f', '#9c6926', '#ffb470'
        ];

        colors.forEach(color => {
            const btn = document.createElement('div');
            btn.className = 'color-btn' + (color === '#000000' ? ' selected' : '');
            btn.style.backgroundColor = color;
            btn.onclick = () => selectColor(color, btn);
            paletteEl.appendChild(btn);
        });

        customColorPicker.onchange = (e) => selectColor(e.target.value, null);

        function selectColor(color, element) {
            selectedColor = color;
            document.querySelectorAll('.color-btn').forEach(b => b.classList.remove('selected'));
            if (element) element.classList.add('selected');
        }

        // Buton Dinleyicileri
        document.getElementById('palette-toggle-btn').onclick = () => paletteEl.classList.toggle('hidden');
        document.getElementById('chat-toggle-btn').onclick = () => chatBox.classList.toggle('hidden');
        document.getElementById('chat-close-btn').onclick = () => chatBox.classList.add('hidden');

        document.getElementById('settings-btn').onclick = () => document.getElementById('settings-modal').classList.remove('hidden');
        document.getElementById('settings-close').onclick = () => document.getElementById('settings-modal').classList.add('hidden');
        document.getElementById('grid-toggle').onchange = () => redraw();

        document.getElementById('profile-btn').onclick = () => document.getElementById('profile-modal').classList.remove('hidden');
        document.getElementById('profile-close').onclick = () => document.getElementById('profile-modal').classList.add('hidden');

        document.getElementById('leaderboard-btn').onclick = () => {
            socket.emit('getLeaderboard');
            document.getElementById('leaderboard-modal').classList.remove('hidden');
        };
        document.getElementById('leaderboard-close').onclick = () => document.getElementById('leaderboard-modal').classList.add('hidden');

        const inspectBtn = document.getElementById('inspect-btn');
        inspectBtn.onclick = () => {
            isInspectMode = !isInspectMode;
            isEyedropperMode = false;
            inspectBtn.classList.toggle('active', isInspectMode);
            document.getElementById('eyedropper-btn').classList.remove('active');
            if (!isInspectMode) inspectorCard.classList.add('hidden');
        };

        const eyedropperBtn = document.getElementById('eyedropper-btn');
        eyedropperBtn.onclick = () => {
            isEyedropperMode = !isEyedropperMode;
            isInspectMode = false;
            eyedropperBtn.classList.toggle('active', isEyedropperMode);
            inspectBtn.classList.remove('active');
            inspectorCard.classList.add('hidden');
        };

        document.getElementById('zoom-in-btn').onclick = () => applyZoom(1.25, window.innerWidth/2, window.innerHeight/2);
        document.getElementById('zoom-out-btn').onclick = () => applyZoom(0.8, window.innerWidth/2, window.innerHeight/2);
        document.getElementById('center-view-btn').onclick = () => centerCanvas();

        document.getElementById('download-canvas-btn').onclick = () => {
            const tempCanvas = document.createElement('canvas');
            tempCanvas.width = CANVAS_WIDTH * PIXEL_SIZE;
            tempCanvas.height = CANVAS_HEIGHT * PIXEL_SIZE;
            const tCtx = tempCanvas.getContext('2d');
            tCtx.fillStyle = '#ffffff';
            tCtx.fillRect(0, 0, tempCanvas.width, tempCanvas.height);
            Object.keys(loadedPixels).forEach(key => {
                const [x, y] = key.split(',').map(Number);
                tCtx.fillStyle = loadedPixels[key].color;
                tCtx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
            });
            const link = document.createElement('a');
            link.download = 'tuval-piksel.png';
            link.href = tempCanvas.toDataURL();
            link.click();
        };

        function centerCanvas() {
            scale = 1;
            offsetX = (window.innerWidth - CANVAS_WIDTH * PIXEL_SIZE) / 2;
            offsetY = (window.innerHeight - CANVAS_HEIGHT * PIXEL_SIZE) / 2;
            redraw();
        }

        // İlerleme ve Cooldown Döngüsü
        setInterval(() => {
            const now = Date.now();
            const elapsed = now - clientLastUpdate;
            clientLastUpdate = now;
            clientStoredTime = Math.min(MAX_ACCUMULATION_MS, clientStoredTime + elapsed);

            const availablePixels = Math.floor(clientStoredTime / COOLDOWN_MS);
            const currentChargeProgress = (clientStoredTime % COOLDOWN_MS) / COOLDOWN_MS;

            if (availablePixels >= 12) {
                cooldownBox.innerText = '⏱️ Tam Dolu (12 Hak)';
                energyFill.style.width = '100%';
            } else {
                const nextSec = ((COOLDOWN_MS - (clientStoredTime % COOLDOWN_MS)) / 1000).toFixed(1);
                cooldownBox.innerText = \`⏱️ \${nextSec}s (\${availablePixels}/12 Hak)\`;
                energyFill.style.width = (currentChargeProgress * 100) + '%';
            }
        }, 100);

        function resizeCanvas() {
            canvas.width = window.innerWidth;
            canvas.height = window.innerHeight;
            redraw();
        }
        window.addEventListener('resize', resizeCanvas);

        function redraw() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            ctx.save();
            ctx.translate(offsetX, offsetY);
            ctx.scale(scale, scale);

            // Arka Plan
            ctx.fillStyle = '#ffffff';
            ctx.fillRect(0, 0, CANVAS_WIDTH * PIXEL_SIZE, CANVAS_HEIGHT * PIXEL_SIZE);

            // Pikseller
            Object.keys(loadedPixels).forEach(key => {
                const [x, y] = key.split(',').map(Number);
                ctx.fillStyle = loadedPixels[key].color;
                ctx.fillRect(x * PIXEL_SIZE, y * PIXEL_SIZE, PIXEL_SIZE, PIXEL_SIZE);
            });

            // Izgara
            if (document.getElementById('grid-toggle').checked && scale >= 1.8) {
                ctx.strokeStyle = 'rgba(0, 0, 0, 0.12)';
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

            // Ripple Efektleri
            for (let i = ripples.length - 1; i >= 0; i--) {
                const r = ripples[i];
                ctx.strokeStyle = r.color;
                ctx.lineWidth = 2 / scale;
                ctx.beginPath();
                ctx.arc(r.x, r.y, r.radius, 0, Math.PI * 2);
                ctx.stroke();
                r.radius += 0.5;
                r.alpha -= 0.05;
                if (r.alpha <= 0) ripples.splice(i, 1);
            }

            ctx.restore();
            updateMiniMap();
        }

        function updateMiniMap() {
            minimapCtx.fillStyle = '#111';
            minimapCtx.fillRect(0, 0, 400, 250);
            Object.keys(loadedPixels).forEach(key => {
                const [x, y] = key.split(',').map(Number);
                minimapCtx.fillStyle = loadedPixels[key].color;
                minimapCtx.fillRect(x, y, 1, 1);
            });

            // Bakış Alanı Çerçevesi
            const vx = (-offsetX / scale) / PIXEL_SIZE;
            const vy = (-offsetY / scale) / PIXEL_SIZE;
            const vw = (window.innerWidth / scale) / PIXEL_SIZE;
            const vh = (window.innerHeight / scale) / PIXEL_SIZE;

            minimapViewport.style.left = Math.max(0, (vx / CANVAS_WIDTH) * 100) + '%';
            minimapViewport.style.top = Math.max(0, (vy / CANVAS_HEIGHT) * 100) + '%';
            minimapViewport.style.width = Math.min(100, (vw / CANVAS_WIDTH) * 100) + '%';
            minimapViewport.style.height = Math.min(100, (vh / CANVAS_HEIGHT) * 100) + '%';
        }

        function getPixelCoords(clientX, clientY) {
            const canvasX = (clientX - offsetX) / scale;
            const canvasY = (clientY - offsetY) / scale;
            return {
                x: Math.floor(canvasX / PIXEL_SIZE),
                y: Math.floor(canvasY / PIXEL_SIZE)
            };
        }

        function handleCanvasClick(clientX, clientY) {
            const coords = getPixelCoords(clientX, clientY);
            if (coords.x < 0 || coords.x >= CANVAS_WIDTH || coords.y < 0 || coords.y >= CANVAS_HEIGHT) return;

            const key = coords.x + ',' + coords.y;

            if (isInspectMode) {
                const px = loadedPixels[key];
                document.getElementById('inspect-coords').innerText = \`Piksel (\${coords.x}, \${coords.y})\`;
                if (px) {
                    document.getElementById('inspect-user').innerText = (px.flag || '') + ' ' + (px.placedBy || 'Anonim');
                    document.getElementById('inspect-time').innerText = px.timestamp ? new Date(px.timestamp).toLocaleTimeString() : '-';
                } else {
                    document.getElementById('inspect-user').innerText = 'Boş (Beyaz)';
                    document.getElementById('inspect-time').innerText = '-';
                }
                inspectorCard.classList.remove('hidden');
                return;
            }

            if (isEyedropperMode) {
                const px = loadedPixels[key];
                if (px) selectColor(px.color, null);
                isEyedropperMode = false;
                document.getElementById('eyedropper-btn').classList.remove('active');
                return;
            }

            // Piksel Koyma İşlemi
            if (clientStoredTime >= COOLDOWN_MS) {
                socket.emit('placePixel', { userId, x: coords.x, y: coords.y, color: selectedColor });
                ripples.push({ x: coords.x * PIXEL_SIZE + 2, y: coords.y * PIXEL_SIZE + 2, radius: 1, alpha: 1, color: selectedColor });
                playSound('place');
            }
        }

        function applyZoom(zoomFactor, mouseX, mouseY) {
            if (scale * zoomFactor < 0.2 || scale * zoomFactor > 35) return;
            offsetX = mouseX - (mouseX - offsetX) * zoomFactor;
            offsetY = mouseY - (mouseY - offsetY) * zoomFactor;
            scale *= zoomFactor;
            redraw();
        }

        canvas.addEventListener('wheel', e => {
            e.preventDefault();
            applyZoom(e.deltaY < 0 ? 1.15 : 0.85, e.clientX, e.clientY);
        }, { passive: false });

        canvas.addEventListener('mousedown', e => {
            isDragging = true;
            hasDragged = false;
            startX = e.clientX; startY = e.clientY;
            startOffsetX = offsetX; startOffsetY = offsetY;
        });

        canvas.addEventListener('mousemove', e => {
            const coords = getPixelCoords(e.clientX, e.clientY);
            if (coords.x >= 0 && coords.x < CANVAS_WIDTH && coords.y >= 0 && coords.y < CANVAS_HEIGHT) {
                coordsEl.innerText = \`(\${coords.x}, \${coords.y})\`;
            } else coordsEl.innerText = '(-, -)';

            if (isDragging) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                if (Math.hypot(dx, dy) > 5) hasDragged = true;
                offsetX = startOffsetX + dx;
                offsetY = startOffsetY + dy;
                redraw();
            }
        });

        canvas.addEventListener('mouseup', e => {
            if (!hasDragged && isDragging) handleCanvasClick(e.clientX, e.clientY);
            isDragging = false;
        });

        // Dokunmatik Ekran Desteği
        let lastTouchDist = 0;
        canvas.addEventListener('touchstart', e => {
            if (e.touches.length === 1) {
                isDragging = true; hasDragged = false;
                startX = e.touches[0].clientX; startY = e.touches[0].clientY;
                startOffsetX = offsetX; startOffsetY = offsetY;
            } else if (e.touches.length === 2) {
                isDragging = false;
                lastTouchDist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
            }
        });

        canvas.addEventListener('touchmove', e => {
            if (e.touches.length === 1 && isDragging) {
                const dx = e.touches[0].clientX - startX;
                const dy = e.touches[0].clientY - startY;
                if (Math.hypot(dx, dy) > 5) hasDragged = true;
                offsetX = startOffsetX + dx; offsetY = startOffsetY + dy;
                redraw();
            } else if (e.touches.length === 2) {
                const dist = Math.hypot(e.touches[0].clientX - e.touches[1].clientX, e.touches[0].clientY - e.touches[1].clientY);
                const zoomFactor = dist / (lastTouchDist || dist);
                applyZoom(zoomFactor, (e.touches[0].clientX + e.touches[1].clientX)/2, (e.touches[0].clientY + e.touches[1].clientY)/2);
                lastTouchDist = dist;
            }
        });

        canvas.addEventListener('touchend', e => {
            if (e.touches.length === 0 && !hasDragged && isDragging) {
                handleCanvasClick(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
            }
            if (e.touches.length === 0) isDragging = false;
        });

        // Socket Etkinlikleri
        socket.on('connect', () => {
            socket.emit('registerUser', { userId });
        });

        socket.on('initCanvas', pixels => {
            Object.assign(loadedPixels, pixels);
            redraw();
        });

        socket.on('userData', data => {
            clientStoredTime = data.storedTimeMs;
            clientLastUpdate = data.lastUpdate;
            document.getElementById('placed-count').innerText = data.placedCount || 0;
            if (data.profile) {
                document.getElementById('prof-username').value = data.profile.username || '';
                document.getElementById('prof-nat').value = data.profile.nationality || '🇹🇷 Türkiye';
            }
        });

        socket.on('pixelUpdate', data => {
            loadedPixels[data.x + ',' + data.y] = {
                color: data.color,
                placedBy: data.placedBy,
                flag: data.flag,
                timestamp: data.timestamp
            };
            redraw();
        });

        socket.on('userCount', count => {
            userCountEl.innerText = count + ' 👤 Online';
        });

        document.getElementById('profile-form').onsubmit = e => {
            e.preventDefault();
            const profileData = {
                username: document.getElementById('prof-username').value.trim(),
                nationality: document.getElementById('prof-nat').value
            };
            socket.emit('updateProfile', { userId, profile: profileData });
            document.getElementById('profile-modal').classList.add('hidden');
        };

        // Sohbet
        chatForm.onsubmit = e => {
            e.preventDefault();
            const text = chatInput.value.trim();
            if (text) {
                socket.emit('sendChatMessage', { userId, text });
                chatInput.value = '';
            }
        };

        socket.on('newChatMessage', data => {
            const msgEl = document.createElement('div');
            msgEl.className = 'chat-msg';
            const flag = data.nationality ? data.nationality.split(' ')[0] : '🌐';
            msgEl.innerHTML = \`<span class="flag">\${flag}</span><span class="sender">\${escapeHtml(data.sender)}:</span> \${escapeHtml(data.text)}\`;
            chatMessages.appendChild(msgEl);
            chatMessages.scrollTop = chatMessages.scrollHeight;
            playSound('chat');
        });

        socket.on('leaderboardData', list => {
            const container = document.getElementById('leaderboard-list');
            container.innerHTML = '';
            list.forEach((item, index) => {
                const div = document.createElement('div');
                div.className = 'leaderboard-item';
                div.innerHTML = \`<span>#\${index + 1} \${item.flag} \${escapeHtml(item.username)}</span><strong>\${item.placedCount} Px</strong>\`;
                container.appendChild(div);
            });
        });

        function escapeHtml(str) {
            return String(str).replace(/[&<>"']/g, s => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[s]));
        }

        centerCanvas();
    </script>
</body>
</html>
    `);
});

// Socket.io Sunucu İşleyicisi
io.on('connection', (socket) => {
    onlineCount++;
    io.emit('userCount', onlineCount);

    socket.emit('initCanvas', pixels);

    socket.on('registerUser', ({ userId }) => {
        if (!userId) return;
        socket.userId = userId;
        const user = calculateUserEnergy(userId);
        socket.emit('userData', {
            storedTimeMs: user.storedTimeMs,
            lastUpdate: user.lastUpdate,
            placedCount: user.placedCount,
            profile: user.profile
        });
    });

    socket.on('updateProfile', ({ userId, profile }) => {
        if (!userId || !profile) return;
        const user = calculateUserEnergy(userId);
        user.profile.username = String(profile.username || 'Oyuncu').substring(0, 15);
        user.profile.nationality = String(profile.nationality || '🇹🇷 Türkiye');
        saveDataToDisk();
    });

    socket.on('placePixel', ({ userId, x, y, color }) => {
        if (!userId) return;
        const user = calculateUserEnergy(userId);

        if (user.storedTimeMs >= COOLDOWN_MS) {
            if (x >= 0 && x < CANVAS_WIDTH && y >= 0 && y < CANVAS_HEIGHT) {
                user.storedTimeMs -= COOLDOWN_MS;
                user.placedCount = (user.placedCount || 0) + 1;

                const flag = user.profile.nationality ? user.profile.nationality.split(' ')[0] : '🌐';
                const pixelData = {
                    color: String(color),
                    placedBy: user.profile.username,
                    flag: flag,
                    timestamp: Date.now()
                };

                pixels[\`\${x},\${y}\`] = pixelData;
                saveDataToDisk();

                io.emit('pixelUpdate', { x, y, ...pixelData });
                socket.emit('userData', {
                    storedTimeMs: user.storedTimeMs,
                    lastUpdate: user.lastUpdate,
                    placedCount: user.placedCount,
                    profile: user.profile
                });
            }
        }
    });

    socket.on('sendChatMessage', ({ userId, text }) => {
        if (!userId || typeof text !== 'string') return;
        const user = calculateUserEnergy(userId);
        const cleanText = text.trim().substring(0, 100);
        if (cleanText.length > 0) {
            io.emit('newChatMessage', {
                sender: user.profile.username,
                nationality: user.profile.nationality,
                text: cleanText
            });
        }
    });

    socket.on('getLeaderboard', () => {
        const sorted = Object.values(userStates)
            .map(u => ({
                username: u.profile ? u.profile.username : 'Oyuncu',
                flag: u.profile && u.profile.nationality ? u.profile.nationality.split(' ')[0] : '🌐',
                placedCount: u.placedCount || 0
            }))
            .sort((a, b) => b.placedCount - a.placedCount)
            .slice(0, 10);

        socket.emit('leaderboardData', sorted);
    });

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        io.emit('userCount', onlineCount);
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log('[Sistem] Sunucu aktif: http://localhost:' + PORT);
});

