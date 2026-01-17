const express = require('express');
const { fork } = require('child_process');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json());
const PORT = 3000;

// Load config
const configPath = path.resolve('./config.json');
const accountsConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

const workers = new Map();

// Run workers
for (const [alias, cookie] of Object.entries(accountsConfig)) {
    const worker = fork(path.resolve('./src/account.cjs'), [], {
        env: { ...process.env, ROBLOX_COOKIE: cookie, ACCOUNT_ALIAS: alias },
        stdio: 'inherit'
    });
    workers.set(alias, worker);
}

const thumbnailWorker = fork(path.resolve('./src/thumbnail.cjs'), [], {
    stdio: 'inherit'
});

// === Routes ===
app.post('/friend/:action/:alias/:username', (req, res) => {
    const { action, alias, username } = req.params;

    if (!['accept', 'delete'].includes(action)) {
        return res.status(400).json({ error: 'Invalid action. Use "accept" or "delete".' });
    }

    const worker = workers.get(alias);
    if (!worker) {
        return res.status(404).json({ error: `Account alias "${alias}" not found` });
    }

    const requestId = Date.now() + '-' + Math.random().toString(36).substring(2, 10);
    worker.send({ type: action, username, requestId });

    const timeout = setTimeout(() => {
        worker.removeListener('message', onMessage);
        res.status(504).json({ error: 'Worker did not respond in time' });
    }, 10000);

    const onMessage = (msg) => {
        if (msg.requestId === requestId) {
            clearTimeout(timeout);
            worker.removeListener('message', onMessage);
            if (msg.success) {
                res.json({
                    success: true,
                    action,
                    username,
                    userId: msg.userId,
                    message: msg.message
                });
            } else {
                res.status(msg.status || 500).json({ error: msg.message });
            }
        }
    };

    worker.on('message', onMessage);
});

app.get('/thumbnail/:identifier', (req, res) => {
    const { identifier } = req.params;
    const { size, type, format, circle } = req.query;

    const parsedIdentifier = isNaN(identifier) ? identifier : Number(identifier);

    const thumbnailParams = {
        size: typeof size === 'string' ? size : '48x48',
        cropType: typeof type === 'string' ? type : 'headshot',
        format: typeof format === 'string' ? format : 'png',
        isCircular: circle === 'true' || circle === '1'
    };

    const requestId = Date.now() + '-' + Math.random().toString(36).substring(2, 10);
    thumbnailWorker.send({ identifier: parsedIdentifier, ...thumbnailParams, requestId });

    const timeout = setTimeout(() => {
        thumbnailWorker.removeListener('message', onMessage);
        res.status(504).json({ error: 'Thumbnail service timeout' });
    }, 5000);

    const onMessage = (msg) => {
        if (msg.requestId === requestId) {
            clearTimeout(timeout);
            thumbnailWorker.removeListener('message', onMessage);
            if (msg.success) {
                res.json({ thumbnail: msg.thumbnail });
            } else {
                res.status(404).json({ error: msg.message });
            }
        }
    };

    thumbnailWorker.on('message', onMessage);
});

app.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});