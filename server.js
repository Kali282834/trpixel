const http = require('http');
const WebSocket = require('ws');

// 1. STATİK HTML & FRONTEND KODU
const htmlContent = `
<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Pixel Canvas MMO</title>
    <style>
        * { box-sizing: border-box; margin: 0; padding: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; user-select: none; }
        body { background-color: #09090b; color: #fff; overflow: hidden; height: 100vh; width: 100vw; }
        #canvas-container { width: 100vw; height: 100vh; cursor: grab; position: relative; }
        #canvas-container:active { cursor: grabbing; }
        canvas { background: #ffffff; image-rendering: pixelated; position: absolute; }
        
        .hud { position: absolute; z-index: 10; pointer-events: none; }
        .interactive { pointer-events: auto; }
        
        .top-bar { top: 20px; left: 50%; transform: translateX(-50%); }
        .card { background: rgba(18, 18, 20, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); padding: 10px 20px; border-radius: 99px; display: flex; align-items: center; gap: 12px; font-weight: 600; font-size: 14px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
        .stock-count { color: #10b981; font-weight: 800; font-size: 15px; }
        .timer { color: #a1a1aa; font-variant-numeric: tabular-nums; }
        
        .bottom-bar { bottom: 25px; left: 50%; transform: translateX(-50%); }
        .palette { background: rgba(18, 18, 20, 0.85); backdrop-filter: blur(12px); border: 1px solid rgba(255,255,255,0.1); padding: 8px 12px; border-radius: 16px; display: flex; gap: 6px; box-shadow: 0 8px 32px rgba(0,0,0,0.5); }
        .color-dot { width: 28px; height: 28px; border-radius: 50%; cursor: pointer; border: 2px solid transparent; transition: transform 0.15s ease, border-color 0.15s ease; }
        .color-dot:hover { transform: scale(1.15); }
        .color-dot.active { border-color: #ffffff; transform: scale(1.2); }
    </style>
</head>
<body>
    <div class="hud top-bar">
        <div class="card">
            <span>STOK: <span id="stock" class="stock-count">1</span>/5</span>
            <span style="color: rgba(255,255,255,0.15)">|</span>
            <span id="timer" class="timer">01:00</span>
        </div>
    </div>

    <div id="canvas-container">
        <canvas id="board"></canvas>
    </div>

    <div class="hud bottom-bar interactive">
        <div class="palette" id="palette"></div>
    </div>

    <script>
        const colors = ['#000000', '#FFFFFF', '#7E7E7E', '#BEBEBE', '#6D001A', '#BE0039', '#FF4500', '#FFA800', '#FFD635', '#00A368', '#00CC78', '#7EED56', '#00756F', '#009EAA', '#2450A4', '#3690EA', '#51E9F4', '#493AC1', '#6A5CFF', '#811E9F', '#B44AC0', '#FF3881', '#FF99AA', '#6D482F', '#9C6926'];
        let selectedColor = colors[0];
        let stock = 1;
        let cooldownSeconds = 60;
        let canvasSize = 100;
        let pixelData = [];

        let scale = 6;
        let panX = 0, panY = 0;
        let isDragging = false, startX, startY;

        const canvas = document.getElementById('board');
        const ctx = canvas.getContext('2d');
        const container = document.getElementById('canvas-container');

        const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(\`\${protocol}//\${location.host}\`);

        ws.onmessage = (event) => {
            const msg = JSON.parse(event.data);
            if (msg.type === 'INIT') {
                canvasSize = msg.size;
                pixelData = msg.data;
                initCanvas();
            } else if (msg.type === 'UPDATE_PIXEL') {
                const index = msg.y * canvasSize + msg.x;
                pixelData[index] = msg.color;
                render();
            } else if (msg.type === 'STATUS') {
                stock = msg.stock;
                document.getElementById('stock').innerText = stock;
                if (stock < 5 && cooldownSeconds <= 0) cooldownSeconds = 60;
            }
        };

        function initCanvas() {
            canvas.width = canvasSize;
            canvas.height = canvasSize;
            panX = (window.innerWidth - canvasSize * scale) / 2;
            panY = (window.innerHeight - canvasSize * scale) / 2;
            render();
        }

        function render() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            for (let i = 0; i < pixelData.length; i++) {
                const x = i % canvasSize;
                const y = Math.floor(i / canvasSize);
                ctx.fillStyle = pixelData[i];
                ctx.fillRect(x, y, 1, 1);
            }
            canvas.style.transform = \`translate(\${panX}px, \${panY}px) scale(\${scale})\`;
            canvas.style.transformOrigin = '0 0';
        }

        const paletteEl = document.getElementById('palette');
        colors.forEach((c, i) => {
            const dot = document.createElement('div');
            dot.className = \`color-dot \${i === 0 ? 'active' : ''}\`;
            dot.style.backgroundColor = c;
            dot.onclick = () => {
                document.querySelectorAll('.color-dot').forEach(d => d.classList.remove('active'));
                dot.classList.add('active');
                selectedColor = c;
            };
            paletteEl.appendChild(dot);
        });

        container.onmousedown = (e) => {
            if (e.button === 0 && !e.target.closest('.interactive')) {
                isDragging = true;
                startX = e.clientX - panX;
                startY = e.clientY - panY;
            }
        };

        window.onmousemove = (e) => {
            if (isDragging) {
                panX = e.clientX - startX;
                panY = e.clientY - startY;
                render();
            }
        };

        window.onmouseup = () => isDragging = false;

        container.onwheel = (e) => {
            e.preventDefault();
            const zoomFactor = 1.15;
            if (e.deltaY < 0) scale = Math.min(scale * zoomFactor, 50);
            else scale = Math.max(scale / zoomFactor, 1);
            render();
        };

        canvas.onclick = (e) => {
            const rect = canvas.getBoundingClientRect();
            const x = Math.floor((e.clientX - rect.left) / scale);
            const y = Math.floor((e.clientY - rect.top) / scale);

            if (x >= 0 && x < canvasSize && y >= 0 && y < canvasSize) {
                ws.send(JSON.stringify({ type: 'PLACE_PIXEL', x, y, color: selectedColor }));
            }
        };

        setInterval(() => {
            if (stock < 5) {
                cooldownSeconds--;
                if (cooldownSeconds <= 0) cooldownSeconds = 60;
                const m = String(Math.floor(cooldownSeconds / 60)).padStart(2, '0');
                const s = String(cooldownSeconds % 60).padStart(2, '0');
                document.getElementById('timer').innerText = \`\${m}:\${s}\`;
            } else {
                document.getElementById('timer').innerText = 'MAX STOK';
            }
        }, 1000);
    </script>
</body>
</html>
`;

// 2. BACKEND & WEBSOCKET SUNUCUSU
const CANVAS_SIZE = 100;
const canvasData = new Array(CANVAS_SIZE * CANVAS_SIZE).fill('#FFFFFF');
const clients = new Map();
const COOLDOWN_TIME = 60 * 1000; // 60 saniye
const MAX_STOCK = 5;

// HTTP Sunucusu (HTML Arayüzünü sunar)
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(htmlContent);
});

// WebSocket Sunucusu (Canlı piksel iletişimini yönetir)
const wss = new WebSocket.Server({ server });

wss.on('connection', (ws) => {
    const clientData = {
        lastPixelTime: 0,
        stock: 1
    };
    clients.set(ws, clientData);

    ws.send(JSON.stringify({ type: 'INIT', data: canvasData, size: CANVAS_SIZE }));

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);
            if (data.type === 'PLACE_PIXEL') {
                const now = Date.now();
                const elapsed = now - clientData.lastPixelTime;

                // 60 saniyelik stok mantığı
                if (elapsed >= COOLDOWN_TIME) {
                    const earnedStock = Math.floor(elapsed / COOLDOWN_TIME);
                    clientData.stock = Math.min(MAX_STOCK, clientData.stock + earnedStock);
                    clientData.lastPixelTime = now;
                }

                if (clientData.stock > 0) {
                    const { x, y, color } = data;
                    if (x >= 0 && x < CANVAS_SIZE && y >= 0 && y < CANVAS_SIZE) {
                        const index = y * CANVAS_SIZE + x;
                        canvasData[index] = color;
                        clientData.stock -= 1;

                        const updateData = JSON.stringify({ type: 'UPDATE_PIXEL', x, y, color });
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN) {
                                client.send(updateData);
                            }
                        });

                        ws.send(JSON.stringify({
                            type: 'STATUS',
                            stock: clientData.stock
                        }));
                    }
                }
            }
        } catch (e) {
            console.error('Mesaj işleme hatası:', e);
        }
    });

    ws.on('close', () => clients.delete(ws));
});

server.listen(3000, () => {
    console.log('PixelPlanet sunucusu yayında: http://localhost:3000');
});
